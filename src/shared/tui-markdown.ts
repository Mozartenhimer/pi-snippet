/**
 * TUI rendering of suggestion nodes (PRD §12).
 *
 * Tagged chips — what the model wrapped in `<snippet>` — render as markdown
 * links led by a superscript number: `[¹rebuild](chip:1)` renders in the
 * theme's link color, and the number is what `Alt+N` addresses.
 *
 * The URL is inert in the inert case (`chip:1`, never navigated); it exists
 * only because link syntax requires one. When terminal-resolved clicking is
 * active the href becomes a real `pisnip://` URL instead (`link-url.ts`). pi's
 * renderer consumes the markdown markers, and consumes the URL too wherever
 * the terminal supports OSC 8 hyperlinks; where it does not (tmux and screen,
 * unless the client advertises `hyperlinks`) pi-tui falls back to printing the
 * URL in parentheses after the label. Either way the *label* is what appears
 * on screen, which is what clicking resolves against — so the fallback is
 * cosmetic.
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
	 * Session token for terminal-resolved clicking. When set, a chip's href
	 * stops being inert and becomes the channel the terminal dispatches on
	 * (`link-url.ts`); when absent, chips keep the `chip:N` placeholder.
	 *
	 * Passed in rather than read from module state so the function stays pure:
	 * the message key is derived from the very text being rendered, so the same
	 * input always paints the same URL, on every repaint and resize.
	 */
	linkToken?: string;
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
 * Parse the tagged chips and merge the inferred anchors in, in document order.
 *
 * This is the single source of truth for what a message's chips are and how
 * they are numbered — the transformer paints from it and the extension's
 * addressable set (Alt+N) and click targets are computed from the same call,
 * which is what keeps the number on screen, the number Alt+N addresses and the
 * number in a chip URL the same number.
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

	const tagged: LocatedAnchor[] = base.nodes
		.filter((n) => n.type === "suggestion")
		.map((n) => ({ text: n.text, start: n.start, end: n.start + n.text.length }));
	const located = locateAnchors(text, inferred, tagged);
	if (located.length === 0) return base;

	// Re-tile the text. An anchor always sits inside a run of ordinary text
	// (locateAnchors refused every overlap with a tagged chip), so the parse
	// nodes are walked again and each text node is split around the anchors it
	// contains. Indices are reassigned in document order, which for a
	// whole-message render is exactly the parser's own numbering.
	const acceptedSoFar = opts?.acceptedSoFar ?? 0;
	const nodes: SuggestNode[] = [];
	const suggestions: string[] = [];
	let index = acceptedSoFar;
	let nextAnchor = 0;
	for (const node of base.nodes) {
		if (node.type === "suggestion") {
			nodes.push({ type: "suggestion", text: node.text, index, start: node.start });
			suggestions.push(node.text);
			index++;
			continue;
		}
		const nodeEnd = node.start + node.text.length;
		let cursor = node.start;
		while (nextAnchor < located.length && located[nextAnchor]!.end <= nodeEnd) {
			const anchor = located[nextAnchor]!;
			nextAnchor++;
			if (anchor.start < cursor) continue; // cannot happen, but never double-paint
			const before = text.slice(cursor, anchor.start);
			if (before.length > 0) nodes.push({ type: "text", text: before, start: cursor });
			nodes.push({ type: "suggestion", text: anchor.text, index, start: anchor.start });
			suggestions.push(anchor.text);
			index++;
			cursor = anchor.end;
		}
		const rest = text.slice(cursor, nodeEnd);
		if (rest.length > 0) nodes.push({ type: "text", text: rest, start: cursor });
	}
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
			const href = opts.linkToken
				? buildChipUrl(opts.linkToken, messageKey(text), oneBased)
				: `chip:${oneBased}`;
			out += `[${escapeLinkLabel(chipLabel(oneBased, node.text))}](${href})`;
		}
	}
	return out;
}
