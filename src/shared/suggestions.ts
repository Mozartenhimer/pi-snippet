/**
 * Pure parser for inline suggestion tags (`<pi:suggest>...</pi:suggest>`).
 *
 * Shared between surfaces (web renderer, tests, potential TUI transformer).
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

export const SUGGEST_TAG = "pi:suggest";
export const MAX_SUGGESTION_LENGTH = 120;
/**
 * Hard ceiling — a runaway-output guard, not a style rule. It matches what
 * two-digit `Alt` addressing can reach (see shared/digit-chord.ts); taste is
 * the prompt's job, via SUGGESTED_PER_MESSAGE.
 */
export const MAX_SUGGESTIONS_PER_MESSAGE = 99;
/** What the model is told to stay under. */
export const SUGGESTED_PER_MESSAGE = 10;

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

export interface TextNode {
	type: "text";
	text: string;
}

export interface SuggestionNode {
	type: "suggestion";
	/** Trimmed suggestion text: what is displayed and what is inserted. */
	text: string;
	/** Index among accepted suggestions in this message (0-based). */
	index: number;
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
		tagName: opts?.tagName ?? SUGGEST_TAG,
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
}

function tagPatterns(tagName: string): TagPatterns {
	const t = escapeRegExp(tagName);
	return {
		open: new RegExp(`^<${t}(?:\\s[^<>]*)?>`),
		close: new RegExp(`^</${t}\\s*>`),
		closeGlobal: () => new RegExp(`</${t}\\s*>`, "g"),
		openGlobal: () => new RegExp(`<${t}(?:\\s[^<>]*)?>`, "g"),
	};
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
 * Parse assistant markdown into text and suggestion nodes.
 * Pure function of its inputs.
 */
export function parseSuggestions(text: string, opts?: SuggestOptions): ParseResult {
	const { tagName, maxLength, maxPerMessage, acceptedSoFar } = resolveOpts(opts);
	const pat = tagPatterns(tagName);
	const fences = fencedRegions(text);

	const nodes: SuggestNode[] = [];
	const suggestions: string[] = [];
	let accepted = acceptedSoFar;
	let buf = "";
	let i = 0;

	const flush = () => {
		if (buf.length > 0) {
			nodes.push({ type: "text", text: buf });
			buf = "";
		}
	};

	while (i < text.length) {
		const fence = inRegion(fences, i);
		if (fence) {
			buf += text.slice(i, fence.end);
			i = fence.end;
			continue;
		}
		const ch = text[i]!;
		if (ch === "`") {
			const spanLen = codeSpanLength(text, i);
			if (spanLen > 0) {
				buf += text.slice(i, i + spanLen);
				i += spanLen;
			} else {
				// Literal backtick run.
				let n = 1;
				while (text[i + n] === "`") n++;
				buf += text.slice(i, i + n);
				i += n;
			}
			continue;
		}
		if (ch === "<") {
			const rest = text.slice(i);
			const closeM = pat.close.exec(rest);
			if (closeM) {
				// Close tag with no open: dropped silently.
				i += closeM[0].length;
				continue;
			}
			const openM = pat.open.exec(rest);
			if (openM) {
				const contentStart = i + openM[0].length;
				const closeAt = findClose(text, contentStart, pat, fences);
				if (!closeAt) {
					// Unclosed: drop the open tag, inner text flows as ordinary text.
					i = contentStart;
					continue;
				}
				let content = text.slice(contentStart, closeAt.start);
				// Nested opens are invalid: strip them from the content.
				content = content.replace(pat.openGlobal(), "");
				const trimmed = content.trim();
				const afterClose = closeAt.end;
				if (trimmed.length === 0) {
					// Empty or whitespace-only: dropped entirely.
					i = afterClose;
					continue;
				}
				const invalid =
					trimmed.length > maxLength || /\n[ \t]*\n/.test(content) || accepted >= maxPerMessage;
				if (invalid) {
					buf += content;
					i = afterClose;
					continue;
				}
				flush();
				nodes.push({ type: "suggestion", text: trimmed, index: accepted });
				suggestions.push(trimmed);
				accepted++;
				i = afterClose;
				continue;
			}
			buf += ch;
			i++;
			continue;
		}
		buf += ch;
		i++;
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
 *  - a trailing partial tag: `<pi`, `<pi:suggest`, `</pi:sug` …
 *  - a complete open tag whose close tag has not arrived yet
 *    (the whole construct is withheld until it resolves)
 *
 * A construct that can no longer become a valid chip (content way over the
 * length cap) resolves as ordinary text and is shown.
 */
export function visibleStreamingPrefix(text: string, opts?: SuggestOptions): string {
	const { tagName, maxLength } = resolveOpts(opts);
	const pat = tagPatterns(tagName);
	const fences = fencedRegions(text);
	const openPrefix = `<${tagName}`;
	const closePrefix = `</${tagName}`;

	let i = 0;
	while (i < text.length) {
		const fence = inRegion(fences, i);
		if (fence) {
			// Inside an (possibly still-open) fence: nothing to hide, it's code.
			i = fence.end;
			continue;
		}
		const ch = text[i]!;
		if (ch === "`") {
			const spanLen = codeSpanLength(text, i);
			if (spanLen > 0) {
				i += spanLen;
			} else {
				let n = 1;
				while (text[i + n] === "`") n++;
				i += n;
			}
			continue;
		}
		if (ch === "<") {
			const rest = text.slice(i);
			// Complete close tag with no matching open: skip past.
			const closeM = pat.close.exec(rest);
			if (closeM) {
				i += closeM[0].length;
				continue;
			}
			const openM = pat.open.exec(rest);
			if (openM) {
				const contentStart = i + openM[0].length;
				const closeAt = findClose(text, contentStart, pat, fences);
				if (closeAt) {
					i = closeAt.end;
					continue;
				}
				// Open tag, close not yet arrived.
				const pending = text.length - contentStart;
				if (pending > maxLength + STREAM_RESOLVE_SLACK) {
					// Can never be a valid chip; resolve as text and show it.
					i = contentStart;
					continue;
				}
				return text.slice(0, i);
			}
			// Partial tag at end of stream? Only a suffix with no `>` yet can
			// still grow into a tag.
			if (couldBecomeTag(rest, openPrefix, closePrefix)) {
				return text.slice(0, i);
			}
			i++;
			continue;
		}
		i++;
	}
	return text;
}

/**
 * True when `rest` (which starts with `<`) is a prefix of a possible open or
 * close tag that has not yet seen its terminating `>`.
 */
function couldBecomeTag(rest: string, openPrefix: string, closePrefix: string): boolean {
	for (const prefix of [openPrefix, closePrefix]) {
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
