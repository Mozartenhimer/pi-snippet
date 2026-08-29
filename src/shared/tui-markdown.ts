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
	 * Session token for terminal-resolved clicking. When set, a chip's href
	 * stops being inert and becomes the channel the terminal dispatches on
	 * (`link-url.ts`); when absent, chips keep the `chip:N` placeholder.
	 *
	 * Passed in rather than read from module state so the function stays pure:
	 * the message key is derived from the very text being rendered, so the same
	 * input always paints the same URL, on every repaint and resize.
	 */
	linkToken?: string;
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
			const href = opts.linkToken
				? buildChipUrl(opts.linkToken, messageKey(text), oneBased)
				: `chip:${oneBased}`;
			out += `[${escapeLinkLabel(chipLabel(oneBased, node.text))}](${href})`;
		}
	}
	return out;
}
