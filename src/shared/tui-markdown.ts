/**
 * TUI rendering of suggestion nodes (PRD §12).
 *
 * Chips become styled, numbered, bracketed spans: `**[1 rebuild]**` — the
 * emphasis markers are consumed by pi's markdown renderer, the brackets are
 * not. Pure function: feeds pi's markdown transformer hook, which is
 * display-only (the stored message keeps its raw tags).
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

export function toTuiMarkdown(rawText: string, opts: TuiRenderOptions): string {
	const text = opts.isStreaming ? visibleStreamingPrefix(rawText, opts.parse) : rawText;
	const { nodes } = parseSuggestions(text, opts.parse);
	let out = "";
	for (const node of nodes) {
		if (node.type === "text" || !opts.enabled) {
			out += node.text;
		} else {
			out += `**[${node.index + 1} ${node.text}]**`;
		}
	}
	return out;
}
