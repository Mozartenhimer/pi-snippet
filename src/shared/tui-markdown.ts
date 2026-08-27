/**
 * TUI rendering of suggestion nodes (PRD §12).
 *
 * Two layers render here, and they look deliberately different.
 *
 * **Tagged chips** — what the model wrapped in `<snippet>` — render as
 * markdown links led by a superscript number: `[¹rebuild](chip:1)` renders in
 * the theme's link color, and the number is what `Alt+N` addresses.
 *
 * **Inferred anchors** — spans a small model picked out of a message the
 * primary model never tagged (PRD §17) — render as the same inert link
 * *without* a number: link-styled, so the span reads as live, but carrying no
 * digit, because nothing addresses them but the mouse.
 *
 * The URL in both cases is inert (never navigated); it exists only because
 * link syntax requires one. The markdown markers and URL are consumed by pi's
 * renderer, the label is not, so the label is exactly what appears on screen —
 * which is what mouse hit-testing matches.
 *
 * Pure function: feeds pi's markdown transformer hook, which is display-only
 * (the stored message keeps its raw tags, and never gains markup for an
 * inferred anchor). `anchors` is an input, not state read from the extension:
 * rendering stays a pure function of (text, anchors), which is what keeps the
 * PRD §5.2 rule intact for a layer whose spans are not in the text itself.
 */
import { codeRegions } from "./inferred.js";
import { parseSuggestions, type SuggestOptions, visibleStreamingPrefix } from "./suggestions.js";

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
	 * Inferred anchor spans for *this* text, verbatim. Rendered as unnumbered
	 * links. Anchors that don't occur outside code are simply not found and so
	 * change nothing.
	 */
	anchors?: string[];
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

/** Escapes the characters that would otherwise terminate a markdown link's label. */
function escapeLinkLabel(text: string): string {
	return text.replace(/[\\[\]]/g, (c) => "\\" + c);
}

function inAnyRegion(regions: Array<{ start: number; end: number }>, pos: number): boolean {
	return regions.some((r) => pos >= r.start && pos < r.end);
}

/**
 * Wrap each anchor occurrence in an inert, unnumbered link.
 *
 * Scans left to right taking the earliest match, so anchors never overlap and
 * an anchor that contains another still renders once. Occurrences inside code
 * are skipped — the same rule the tag parser follows.
 */
export function linkifyAnchors(text: string, anchors: string[]): string {
	const wanted = anchors.filter((a) => a.length > 0);
	if (wanted.length === 0) return text;
	const regions = codeRegions(text);

	let out = "";
	let i = 0;
	while (i < text.length) {
		let bestAt = -1;
		let bestAnchor = "";
		for (const anchor of wanted) {
			for (let at = text.indexOf(anchor, i); at !== -1; at = text.indexOf(anchor, at + 1)) {
				if (inAnyRegion(regions, at)) continue;
				// Earliest wins; on a tie the longer span wins, so a nested
				// anchor never truncates the one containing it.
				if (bestAt === -1 || at < bestAt || (at === bestAt && anchor.length > bestAnchor.length)) {
					bestAt = at;
					bestAnchor = anchor;
				}
				break;
			}
		}
		if (bestAt === -1) {
			out += text.slice(i);
			break;
		}
		const n = wanted.indexOf(bestAnchor) + 1;
		out += text.slice(i, bestAt);
		out += `[${escapeLinkLabel(bestAnchor)}](infer:${n})`;
		i = bestAt + bestAnchor.length;
	}
	return out;
}

export function toTuiMarkdown(rawText: string, opts: TuiRenderOptions): string {
	const text = opts.isStreaming ? visibleStreamingPrefix(rawText, opts.parse) : rawText;
	const { nodes } = parseSuggestions(text, opts.parse);
	const anchors = opts.enabled ? (opts.anchors ?? []) : [];
	let out = "";
	for (const node of nodes) {
		if (node.type === "text" || !opts.enabled) {
			out += node.type === "text" ? linkifyAnchors(node.text, anchors) : node.text;
		} else {
			const oneBased = node.index + 1;
			out += `[${escapeLinkLabel(chipLabel(oneBased, node.text))}](chip:${oneBased})`;
		}
	}
	return out;
}
