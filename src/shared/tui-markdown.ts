/**
 * TUI rendering of suggestion nodes (PRD §12).
 *
 * Chips become bold accent-colored spans led by a superscript number:
 * `` **`¹rebuild`** `` renders as bold text in the theme's inline-code accent
 * color — visually distinct from prose without brackets, and the superscript
 * keeps the number small. The markdown markers are consumed by pi's renderer;
 * the superscript and text are not, so `chipLabel()` is exactly what appears
 * on screen (which is what mouse hit-testing matches). Pure function: feeds
 * pi's markdown transformer hook, which is display-only (the stored message
 * keeps its raw tags).
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

/**
 * Wraps text in a markdown code span, using a backtick fence longer than any
 * run inside the text (code spans have no escapes).
 */
function codeSpan(text: string): string {
	const runs = text.match(/`+/g) ?? [];
	const fence = "`".repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
	// A code span cannot start or end with a backtick unless padded.
	const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
	return `${fence}${pad}${text}${pad}${fence}`;
}

export function toTuiMarkdown(rawText: string, opts: TuiRenderOptions): string {
	const text = opts.isStreaming ? visibleStreamingPrefix(rawText, opts.parse) : rawText;
	const { nodes } = parseSuggestions(text, opts.parse);
	let out = "";
	for (const node of nodes) {
		if (node.type === "text" || !opts.enabled) {
			out += node.text;
		} else {
			out += `**${codeSpan(chipLabel(node.index + 1, node.text))}**`;
		}
	}
	return out;
}
