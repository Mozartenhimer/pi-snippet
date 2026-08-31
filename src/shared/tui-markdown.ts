/**
 * TUI rendering of suggestion nodes (PRD §12).
 *
 * Tagged chips — what the model wrapped in `<snippet>` — render as markdown
 * links led by a superscript number: `[¹rebuild](pisnip://…)` renders in the
 * theme's link color, and the number is what `Alt+N` addresses.
 *
 * There is one chip rendering, and the URL in it is always real (`link-url.ts`):
 * where the terminal supports OSC 8 hyperlinks, pi's renderer turns the href
 * into a clickable link the terminal itself resolves. Where it does not, the
 * extension paints no link at all — just the bare superscript label — because
 * pi-tui prints any href it cannot emit as OSC 8 in parentheses after the
 * label, and a URL the terminal cannot dispatch is noise, not a chip. The
 * superscript is the whole of the fallback: it is what `Alt+N` addresses, and
 * nothing else about a chip survives a terminal that paints no hyperlinks.
 *
 * Pure function: feeds pi's markdown transformer hook, which is display-only
 * (the stored message keeps its raw tags and never gains markup).
 */
import { buildChipUrl, messageKey } from "./link-url.js";
import { locateAnchors, type LocatedAnchor } from "./inferred.js";
import {
	parseSuggestions,
	type SuggestNode,
	type SuggestOptions,
	visibleStreamingPrefix,
} from "./suggestions.js";

export interface TuiRenderOptions {
	/** True for partial assistant updates: partial tags are buffered (C1). */
	isStreaming: boolean;
	/** When false, tags are stripped to plain text (H1 parity). */
	enabled: boolean;
	/**
	 * `parse.acceptedSoFar` offsets numbering for later text blocks of the
	 * same message: the parser bakes it into each suggestion's index.
	 */
	parse?: SuggestOptions;
	/**
	 * Where a click has to reach, for terminal-resolved clicking: the machine
	 * this session is on and the session's own token. When set, a chip's href
	 * stops being inert and becomes the channel the terminal dispatches on
	 * (`link-url.ts`); when absent, chips are painted as bare labels.
	 *
	 * One option rather than two, because a host without a token and a token
	 * without a host are both meaningless: they are the two halves of one URL,
	 * and asking about them separately would be one question asked twice.
	 *
	 * Passed in rather than read from module state so the function stays pure:
	 * the message key is derived from the very text being rendered, so the same
	 * input always paints the same URL, on every repaint and resize.
	 */
	link?: { host: string; token: string };
	/**
	 * Anchors the second model inferred for this message (`shared/inferred.ts`),
	 * painted as ordinary chips at their verbatim positions, numbered after the
	 * tagged ones. Nothing distinguishes them from layer-1 chips in the output.
	 */
	inferred?: readonly string[];
}

const SUPERSCRIPTS = ["⁰", "¹", "²", "³", "⁴", "⁵", "⁶", "⁷", "⁸", "⁹"] as const;

/** 1 → "¹", 10 → "¹⁰". */
export function superscript(n: number): string {
	return String(n)
		.split("")
		.map((d) => SUPERSCRIPTS[Number(d)])
		.join("");
}

/** The exact visible text of a rendered chip, e.g. `¹rebuild the solution`. */
export function chipLabel(oneBasedNumber: number, text: string): string {
	return `${superscript(oneBasedNumber)}${text}`;
}

/**
 * Parse the tagged chips and merge the inferred anchors in.
 *
 * This is the single source of truth for what a message's chips are and how
 * they are numbered — the transformer paints from it and the extension's
 * addressable set (Alt+N) and click targets are computed from the same call,
 * which is what keeps the number on screen, the number Alt+N addresses and the
 * number in a chip URL the same number.
 *
 * Numbering is by layer, then by arrival — never by document position. Layer-1
 * chips number first, in document order, which is also the order their tags
 * closed while streaming. Layer-2 anchors number after all of them, in the
 * order they were inferred, because they arrive one at a time after the
 * message is on screen: an anchor that lands *before* an existing chip in the
 * text must not push that chip's superscript off the number the user already
 * saw (and may already be reaching for). The painted order can therefore
 * differ from the numbered order — ³ may sit left of ² — and that is the
 * trade working as intended.
 *
 * An anchor that lands inside a tagged chip, inside code, or on top of an
 * earlier anchor is dropped by `locateAnchors`: the failure mode is a missing
 * chip, never a doubled or shifted one.
 */
export function mergeSuggestions(
	text: string,
	opts?: SuggestOptions,
	inferred?: readonly string[],
): { nodes: SuggestNode[]; suggestions: string[] } {
	const base = parseSuggestions(text, opts);
	if (!inferred || inferred.length === 0) return base;

	const tagged = base.nodes
		.filter((n) => n.type === "suggestion")
		.map((n) => ({ text: n.text, start: n.start, end: n.start + n.text.length }));
	// Document order, whatever order the anchors arrived in: `locateAnchors`
	// sorts by position and carries each anchor's arrival rank in `order`,
	// which is what the numbering below reads.
	const located = locateAnchors(text, inferred, tagged);
	if (located.length === 0) return base;

	// Re-tile the text. An anchor always sits inside a run of ordinary text
	// (locateAnchors refused every overlap with a tagged chip), so the parse
	// nodes are walked again and each text node is split around the anchors it
	// contains. Indices are reassigned in document order, which for a
	// whole-message render is exactly the parser's own numbering.
	const acceptedSoFar = opts?.acceptedSoFar ?? 0;
	// Layer 1 has first claim on the numbers: every tagged chip in this text,
	// however many anchors end up interleaved among them. The parser has
	// already baked `acceptedSoFar` into each node's index.
	const layer1Count = base.nodes.reduce((n, node) => (node.type === "suggestion" ? n + 1 : n), 0);
	const nodes: SuggestNode[] = [];
	const suggestions: string[] = [];
	// Anchors tile into the text between the layer-1 chips but number after
	// all of them, so their suggestion texts are collected here — keyed by
	// arrival rank, since the walk meets them in document order — and appended
	// in arrival order once the walk is done, keeping `suggestions` in
	// numbering order, which is the contract its consumers (the addressable
	// set, the click targets) rely on.
	const anchorSuggestions = new Map<number, string>();
	let nextAnchor = 0;
	for (const node of base.nodes) {
		if (node.type === "suggestion") {
			nodes.push({ type: "suggestion", text: node.text, index: node.index, start: node.start });
			suggestions.push(node.text);
			continue;
		}
		const nodeEnd = node.start + node.text.length;
		let cursor = node.start;
		while (nextAnchor < located.length && located[nextAnchor]!.end <= nodeEnd) {
			const anchor = located[nextAnchor]!;
			nextAnchor++;
			// No overlap check: `locateAnchors` returns anchors in document order
			// and refuses any that overlaps an earlier one or a tagged chip, so
			// each anchor starts at or after the cursor the last one left. The
			// guard that stood here could not fire.
			const before = text.slice(cursor, anchor.start);
			if (before.length > 0) nodes.push({ type: "text", text: before, start: cursor });
			const anchorIndex = acceptedSoFar + layer1Count + (anchor.order ?? 0);
			nodes.push({ type: "suggestion", text: anchor.text, index: anchorIndex, start: anchor.start });
			anchorSuggestions.set(anchor.order ?? 0, anchor.text);
			cursor = anchor.end;
		}
		const rest = text.slice(cursor, nodeEnd);
		if (rest.length > 0) nodes.push({ type: "text", text: rest, start: cursor });
	}
	suggestions.push(...[...anchorSuggestions.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t));
	return { nodes, suggestions };
}

/** Escapes the characters that would otherwise terminate a markdown link's label. */
function escapeLinkLabel(text: string): string {
	return text.replace(/[\\[\]]/g, (c) => "\\" + c);
}

export function toTuiMarkdown(rawText: string, opts: TuiRenderOptions): string {
	const text = opts.isStreaming ? visibleStreamingPrefix(rawText, opts.parse) : rawText;
	const { nodes } = mergeSuggestions(text, opts.parse, opts.inferred);
	let out = "";
	for (const node of nodes) {
		if (node.type === "text" || !opts.enabled) {
			out += node.text;
		} else {
			const oneBased = node.index + 1;
			const label = chipLabel(oneBased, node.text);
			if (opts.link) {
				const url = buildChipUrl(opts.link.host, opts.link.token, messageKey(text), oneBased);
				out += `[${escapeLinkLabel(label)}](${url})`;
			} else {
				// No hyperlinks here. A URL — real or placeholder — would come back
				// as visible parens and resolve no click; the bare label is the chip.
				out += label;
			}
		}
	}
	return out;
}
