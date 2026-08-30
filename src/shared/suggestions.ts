/**
 * Pure parser for inline suggestion tags (`<snippet>...</snippet>`).
 *
 * Shared between the TUI transformer and tests.
 * No state, no DOM — takes raw assistant markdown, returns a token stream.
 *
 * Sanitization rules (PRD §5.3, §11):
 *  1. Content inside fenced code blocks is never parsed for tags.
 *  2. Content inside inline code spans is never parsed.
 *  3. Unclosed open tag: opening tag dropped, inner text is ordinary text.
 *  4. Close tag with no open: dropped silently.
 *  5. Nested tags: outer wins, inner open tags stripped.
 *  6. Empty / whitespace-only content: construct dropped entirely.
 *  7. Content over maxLength chars: tags dropped, content rendered plainly.
 *  8. Content spanning a blank line: tags dropped, content rendered plainly
 *     (a chip cannot cross a block boundary).
 *  9. More than maxPerMessage: first N are chips, the rest render plainly.
 */

export const SNIPPET_TAG = "snippet";
const MAX_SUGGESTION_LENGTH = 120;
/**
 * Hard ceiling — a runaway-output guard, not a style rule. It matches what
 * two-digit `Alt` addressing can reach (see shared/digit-chord.ts).
 */
export const MAX_SUGGESTIONS_PER_MESSAGE = 99;

export interface SuggestOptions {
	/** Tag name, configurable for rebranded distributions (PRD H3). */
	tagName?: string;
	maxLength?: number;
	maxPerMessage?: number;
	/**
	 * Number of suggestions already accepted in earlier text blocks of the
	 * same message, so the per-message cap holds across blocks.
	 */
	acceptedSoFar?: number;
}

interface TextNode {
	type: "text";
	text: string;
	/** Offset of this run within the text that was parsed. */
	start: number;
}

interface SuggestionNode {
	type: "suggestion";
	/** Trimmed suggestion text: what is displayed and what is inserted. */
	text: string;
	/** Index among accepted suggestions in this message (0-based). */
	index: number;
	/**
	 * Offset of the trimmed content within the text that was parsed, so
	 * callers can know which spans the message's chips already cover — how
	 * inferred anchors (shared/inferred.ts) avoid doubling up a chip the
	 * primary model already tagged.
	 */
	start: number;
}

export type SuggestNode = TextNode | SuggestionNode;

export interface ParseResult {
	nodes: SuggestNode[];
	/** Accepted suggestion texts, in document order. */
	suggestions: string[];
}

interface Region {
	start: number;
	end: number;
}

function resolveOpts(opts?: SuggestOptions) {
	return {
		tagName: opts?.tagName ?? SNIPPET_TAG,
		maxLength: opts?.maxLength ?? MAX_SUGGESTION_LENGTH,
		maxPerMessage: opts?.maxPerMessage ?? MAX_SUGGESTIONS_PER_MESSAGE,
		acceptedSoFar: opts?.acceptedSoFar ?? 0,
	};
}

/**
 * Compute fenced code block regions (``` / ~~~, up to 3 leading spaces).
 * An unclosed fence extends to end of input.
 */
export function fencedRegions(text: string): Region[] {
	const regions: Region[] = [];
	const lines = text.split("\n");
	let pos = 0;
	let fence: { char: string; len: number; start: number } | null = null;
	for (const line of lines) {
		const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
		if (m) {
			const marker = m[1]!;
			const char = marker[0]!;
			if (!fence) {
				// ``` fences may not have backticks in the info string
				const info = line.slice(m[0].length);
				if (!(char === "`" && info.includes("`"))) {
					fence = { char, len: marker.length, start: pos };
				}
			} else if (char === fence.char && marker.length >= fence.len && line.slice(m[0].length).trim() === "") {
				regions.push({ start: fence.start, end: pos + line.length });
				fence = null;
			}
		}
		pos += line.length + 1;
	}
	if (fence) regions.push({ start: fence.start, end: text.length });
	return regions;
}

function inRegion(regions: Region[], pos: number): Region | undefined {
	for (const r of regions) {
		if (pos >= r.start && pos < r.end) return r;
	}
	return undefined;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface TagPatterns {
	open: RegExp;
	close: RegExp;
	closeGlobal: () => RegExp;
	openGlobal: () => RegExp;
	/** `<tag` and `</tag`: what a still-growing tag looks like mid-stream. */
	openPrefix: string;
	closePrefix: string;
}

function tagPatterns(tagName: string): TagPatterns {
	const t = escapeRegExp(tagName);
	return {
		open: new RegExp(`^<${t}(?:\\s[^<>]*)?>`),
		close: new RegExp(`^</${t}\\s*>`),
		closeGlobal: () => new RegExp(`</${t}\\s*>`, "g"),
		openGlobal: () => new RegExp(`<${t}(?:\\s[^<>]*)?>`, "g"),
		openPrefix: `<${tagName}`,
		closePrefix: `</${tagName}`,
	};
}

/** Length of the run of backticks starting at `pos`. */
function backtickRunLength(text: string, pos: number): number {
	let n = 1;
	while (text[pos + n] === "`") n++;
	return n;
}

/** Length of the inline code span starting at `pos` (backtick run), or 0. */
function codeSpanLength(text: string, pos: number): number {
	if (text[pos] !== "`") return 0;
	let n = 1;
	while (text[pos + n] === "`") n++;
	// Find the next run of exactly n backticks.
	let i = pos + n;
	while (i < text.length) {
		if (text[i] === "`") {
			let m = 1;
			while (text[i + m] === "`") m++;
			if (m === n) return i + m - pos;
			i += m;
		} else {
			i++;
		}
	}
	return 0; // No closer: literal backticks, not a code span.
}

/**
 * One shape found while walking assistant markdown.
 *
 * The two readers of this file — the parser and the streaming gate — have to
 * walk the same things: fenced code, inline code spans, literal backtick runs,
 * and the states a tag can be in. They differ only in what they *do* at each
 * shape, so the walk lives in `scan` once and each caller decides what a token
 * means. Before this, both carried their own copy of the walk, and the three
 * copies of the backtick dance alone were the most duplicated logic in the
 * codebase.
 *
 * A generator rather than a callback per token, because the streaming gate's
 * whole job is to *stop* at the first thing it must hide: with a generator that
 * is a plain `break`, where a callback would need a sentinel return threaded
 * back out through the walker.
 */
type ScanToken =
	/**
	 * Ordinary text — plain characters, a fenced block, a code span, or a
	 * literal backtick run, coalesced into the longest run available. Never
	 * parsed for tags: the fence and code-span rules (§5.3 1–2) are applied
	 * here, once, so neither caller can disagree about them.
	 */
	| { kind: "text"; start: number; end: number }
	/** A close tag with no open before it. Rule 4: both callers drop it. */
	| { kind: "strayClose"; start: number; end: number }
	/** A complete construct. `end` is past the close tag. */
	| { kind: "chip"; start: number; end: number; contentStart: number; contentEnd: number }
	/**
	 * An open tag whose close never arrived. The scan resumes at `contentStart`,
	 * so the content comes back as ordinary tokens — which is exactly rule 3,
	 * "opening tag dropped, inner text is ordinary text", applied by the walk
	 * itself rather than by each caller.
	 */
	| { kind: "unclosed"; start: number; contentStart: number }
	/**
	 * A `<` that is not a tag. `couldBecomeTag` is true when more streamed input
	 * could still grow it into one — the single piece of information the
	 * streaming gate needs and the parser has no use for.
	 */
	| { kind: "stray"; start: number; end: number; couldBecomeTag: boolean };

function* scan(text: string, pat: TagPatterns): Generator<ScanToken> {
	const fences = fencedRegions(text);
	/** Start of the text run being coalesced, or -1 when there is none open. */
	let runStart = -1;
	let i = 0;

	while (i < text.length) {
		const fence = inRegion(fences, i);
		if (fence) {
			if (runStart === -1) runStart = i;
			i = fence.end;
			continue;
		}
		const ch = text[i]!;
		if (ch === "`") {
			// A span when something closes it, otherwise the literal run — either
			// way it is text, and the tags inside it are inert.
			if (runStart === -1) runStart = i;
			i += codeSpanLength(text, i) || backtickRunLength(text, i);
			continue;
		}
		if (ch !== "<") {
			if (runStart === -1) runStart = i;
			i++;
			continue;
		}
		const rest = text.slice(i);
		const closeM = pat.close.exec(rest);
		const openM = closeM ? null : pat.open.exec(rest);
		const closeAt = openM ? findClose(text, i + openM[0].length, pat, fences) : undefined;
		if (runStart !== -1) {
			yield { kind: "text", start: runStart, end: i };
			runStart = -1;
		}
		if (closeM) {
			yield { kind: "strayClose", start: i, end: i + closeM[0].length };
			i += closeM[0].length;
		} else if (openM) {
			const contentStart = i + openM[0].length;
			if (closeAt) {
				yield { kind: "chip", start: i, end: closeAt.end, contentStart, contentEnd: closeAt.start };
				i = closeAt.end;
			} else {
				yield { kind: "unclosed", start: i, contentStart };
				i = contentStart;
			}
		} else {
			yield { kind: "stray", start: i, end: i + 1, couldBecomeTag: couldBecomeTag(rest, pat) };
			i++;
		}
	}
	if (runStart !== -1) yield { kind: "text", start: runStart, end: i };
}

/**
 * Parse assistant markdown into text and suggestion nodes.
 * Pure function of its inputs.
 */
export function parseSuggestions(text: string, opts?: SuggestOptions): ParseResult {
	const { tagName, maxLength, maxPerMessage, acceptedSoFar } = resolveOpts(opts);
	const pat = tagPatterns(tagName);

	const nodes: SuggestNode[] = [];
	const suggestions: string[] = [];
	let accepted = acceptedSoFar;
	let buf = "";
	/** Where `buf` began in `text`; kept alongside it so text nodes carry offsets. */
	let bufStart = 0;

	const flush = () => {
		if (buf.length > 0) {
			nodes.push({ type: "text", text: buf, start: bufStart });
			buf = "";
		}
	};
	/**
	 * Append to the buffer, remembering where a fresh run began.
	 *
	 * Runs are concatenated across whatever was dropped between them (a stray
	 * close tag, an unclosed open tag), so a text node's `start` is where its
	 * first surviving character was, not where every later one is — which is
	 * what makes a dropped tag invisible in the offsets a chip is measured
	 * against.
	 */
	const keep = (chunk: string, from: number) => {
		if (buf.length === 0) bufStart = from;
		buf += chunk;
	};

	for (const token of scan(text, pat)) {
		switch (token.kind) {
			// A `<` that never became a tag is just text; the scan separates the
			// two only because the streaming gate has to tell them apart.
			case "text":
			case "stray":
				keep(text.slice(token.start, token.end), token.start);
				break;
			// Rules 3 and 4. Neither leaves anything behind: an unclosed tag's
			// content arrives as ordinary tokens right after this.
			case "strayClose":
			case "unclosed":
				break;
			case "chip": {
				// Nested opens are invalid (rule 5): strip them from the content.
				const content = text
					.slice(token.contentStart, token.contentEnd)
					.replace(pat.openGlobal(), "");
				const trimmed = content.trim();
				// Empty or whitespace-only: dropped entirely (rule 6).
				if (trimmed.length === 0) break;
				if (
					trimmed.length > maxLength ||
					/\n[ \t]*\n/.test(content) ||
					accepted >= maxPerMessage
				) {
					// Rules 7–9: the tags go, the content stays as ordinary text.
					keep(content, token.contentStart);
					break;
				}
				flush();
				// Offset of the trimmed content: skip the leading whitespace that
				// trimStart() removed from the raw slice.
				const lead = content.length - content.trimStart().length;
				nodes.push({
					type: "suggestion",
					text: trimmed,
					index: accepted,
					start: token.contentStart + lead,
				});
				suggestions.push(trimmed);
				accepted++;
				break;
			}
		}
	}
	flush();
	return { nodes, suggestions };
}

/** Find the first close tag at or after `from`, skipping fenced code regions. */
function findClose(
	text: string,
	from: number,
	pat: TagPatterns,
	fences: Region[],
): Region | undefined {
	const re = pat.closeGlobal();
	re.lastIndex = from;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		if (!inRegion(fences, m.index)) {
			return { start: m.index, end: m.index + m[0].length };
		}
		re.lastIndex = m.index + 1;
	}
	return undefined;
}

/**
 * How much extra content beyond maxLength we keep buffering while waiting for
 * a close tag during streaming, before giving up and resolving as plain text.
 */
const STREAM_RESOLVE_SLACK = 40;

/**
 * Return the prefix of a streaming message that is safe to render without
 * ever painting raw or partial suggestion markup (PRD §7 Streaming, 10.7).
 *
 * Hidden (buffered) cases:
 *  - a trailing partial tag: `<sn`, `<snippet`, `</snip` …
 *  - a complete open tag whose close tag has not arrived yet
 *    (the whole construct is withheld until it resolves)
 *
 * A construct that can no longer become a valid chip (content way over the
 * length cap) resolves as ordinary text and is shown.
 */
export function visibleStreamingPrefix(text: string, opts?: SuggestOptions): string {
	const { tagName, maxLength } = resolveOpts(opts);
	// Everything this function used to do itself — fences, code spans, backtick
	// runs, matching tags — is the scan's. What is left is the one decision that
	// is actually about streaming: where to cut.
	for (const token of scan(text, tagPatterns(tagName))) {
		if (token.kind === "unclosed") {
			// A construct grown past anything a chip could be can only ever
			// resolve as ordinary text, so show it and keep scanning — the scan
			// has already resumed inside it, where a later tag can still hide.
			if (text.length - token.contentStart <= maxLength + STREAM_RESOLVE_SLACK) {
				return text.slice(0, token.start);
			}
		} else if (token.kind === "stray" && token.couldBecomeTag) {
			// A partial tag at the end of the stream: `<sn`, `</snip` …
			return text.slice(0, token.start);
		}
		// Everything else is either finished markup or text: safe to paint.
	}
	return text;
}

/**
 * True when `rest` (which starts with `<`) is a prefix of a possible open or
 * close tag that has not yet seen its terminating `>`.
 */
function couldBecomeTag(rest: string, pat: TagPatterns): boolean {
	for (const prefix of [pat.openPrefix, pat.closePrefix]) {
		if (rest.length < prefix.length) {
			if (prefix.startsWith(rest)) return true;
		} else if (rest.startsWith(prefix)) {
			// Tag name seen in full; it's still a growing tag until `>` or an
			// impossible character appears.
			const tail = rest.slice(prefix.length);
			if (!tail.includes(">") && !tail.includes("<")) return true;
		}
	}
	return false;
}
