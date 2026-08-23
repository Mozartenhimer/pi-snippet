/**
 * TUI rendering of suggestion nodes (PRD §12).
 *
 * Chips render as markdown links led by a superscript number:
 * `[¹rebuild](chip:1)` renders in the theme's link color — visually distinct
 * from prose, and the superscript keeps the number small. The URL is inert
 * (never navigated); it exists only because link syntax requires one. The
 * markdown markers and URL are consumed by pi's renderer, the superscript and
 * text are not, so `chipLabel()` is exactly what appears on screen (which is
 * what mouse hit-testing matches). Pure function: feeds pi's markdown
 * transformer hook, which is display-only (the stored message keeps its raw
 * tags).
 */
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

export function toTuiMarkdown(rawText: string, opts: TuiRenderOptions): string {
	const text = opts.isStreaming ? visibleStreamingPrefix(rawText, opts.parse) : rawText;
	const { nodes } = parseSuggestions(text, opts.parse);
	let out = "";
	for (const node of nodes) {
		if (node.type === "text" || !opts.enabled) {
			out += node.text;
		} else {
			const oneBased = node.index + 1;
			out += `[${escapeLinkLabel(chipLabel(oneBased, node.text))}](chip:${oneBased})`;
		}
	}
	return out;
}
