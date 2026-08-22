/**
 * Stateless chip-aware markdown renderer (PRD §5.2, §7).
 *
 * Pipeline for one assistant text block:
 *   raw text
 *     -> (streaming only) visibleStreamingPrefix   — never paint partial tags
 *     -> parseSuggestions                          — pure token stream
 *     -> markdown string with sentinel chars where suggestions sit
 *     -> marked (raw HTML escaped)                 — sentinels survive inline
 *     -> DOM walk replacing sentinels with <button class="chip"> elements
 *
 * The renderer holds no state: visited/live/handlers all come from the caller.
 */
import { marked } from "marked";
import { parseSuggestions, type SuggestOptions, visibleStreamingPrefix } from "../shared/suggestions.js";

export interface ChipRenderOptions {
	/** False while the message is still streaming: chips render inert (PRD C3). */
	live: boolean;
	/** True while the message is still streaming: partial tags are buffered. */
	streaming: boolean;
	/** Chips feature toggle (PRD H1). When false, tags degrade to plain text. */
	chipsEnabled: boolean;
	/** Indices (within this message) of suggestions already inserted once. */
	visited?: ReadonlySet<number>;
	/** Called with the suggestion text when a live chip is activated. */
	onInsert?: (text: string, index: number) => void;
	parse?: SuggestOptions;
}

/** Sentinel pair marking a suggestion slot: U+E000 then (0xE100 + index). */
const SLOT_START = 0xe100;
const SENTINEL = "\uE000";
const SENTINEL_RE = /\uE000[\uE100-\uE1FF]/;
/** Any private-use chars in model output are stripped so they can't collide. */
const PUA_RE = /[\uE000-\uF8FF]/g;

const escapeHtml = (s: string): string =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let markedConfigured = false;
function configureMarked(): void {
	if (markedConfigured) return;
	markedConfigured = true;
	// Raw HTML in assistant prose is displayed, never executed (PRD E5).
	marked.use({
		gfm: true,
		renderer: {
			html(token: { text: string }) {
				return escapeHtml(token.text);
			},
		},
	});
}

/**
 * Render one assistant text block to a detached DOM element.
 */
export function renderAssistantMarkdown(rawText: string, opts: ChipRenderOptions): HTMLElement {
	configureMarked();
	let text = rawText.replace(PUA_RE, "");
	if (opts.streaming) text = visibleStreamingPrefix(text, opts.parse);

	const { nodes, suggestions } = parseSuggestions(text, opts.parse);

	let md = "";
	for (const node of nodes) {
		if (node.type === "text" || !opts.chipsEnabled) {
			md += node.text;
		} else {
			md += SENTINEL + String.fromCharCode(SLOT_START + node.index);
		}
	}

	const container = document.createElement("div");
	container.className = "message-markdown";
	container.innerHTML = marked.parse(md, { async: false }) as string;

	if (opts.chipsEnabled && suggestions.length > 0) {
		replaceSentinels(container, suggestions, opts);
	}
	// Belt and braces (PRD B2): no sentinel may survive rendering.
	stripLeftoverSentinels(container);
	return container;
}

/** Recursive text-node collection (TreeWalker SHOW_TEXT is buggy in some DOMs). */
function collectTextNodes(node: Node, out: Text[]): void {
	if (node.nodeType === 3 /* TEXT_NODE */) {
		out.push(node as Text);
		return;
	}
	for (let child = node.firstChild; child; child = child.nextSibling) {
		collectTextNodes(child, out);
	}
}

function replaceSentinels(root: HTMLElement, suggestions: string[], opts: ChipRenderOptions): void {
	const doc = root.ownerDocument;
	const textNodes: Text[] = [];
	collectTextNodes(root, textNodes);

	for (const textNode of textNodes) {
		if (!SENTINEL_RE.test(textNode.data)) continue;
		const inLink = hasAncestor(textNode, "a");
		const inCode = hasAncestor(textNode, "code") || hasAncestor(textNode, "pre");
		const frag = doc.createDocumentFragment();
		let rest = textNode.data;
		let m: RegExpExecArray | null;
		while ((m = SENTINEL_RE.exec(rest))) {
			if (m.index > 0) frag.appendChild(doc.createTextNode(rest.slice(0, m.index)));
			const index = m[0].charCodeAt(1) - SLOT_START;
			const suggestion = suggestions[index];
			if (suggestion === undefined) {
				// Unknown slot — drop the sentinel.
			} else if (inLink || inCode) {
				// Chip suppressed inside a link label (link wins) or code.
				frag.appendChild(doc.createTextNode(suggestion));
			} else {
				frag.appendChild(buildChip(doc, suggestion, index, opts));
			}
			rest = rest.slice(m.index + m[0].length);
		}
		if (rest.length > 0) frag.appendChild(doc.createTextNode(rest));
		textNode.parentNode?.replaceChild(frag, textNode);
	}
}

function buildChip(doc: Document, text: string, index: number, opts: ChipRenderOptions): HTMLElement {
	const chip = doc.createElement("button");
	chip.type = "button";
	chip.className = "chip";
	chip.textContent = text; // text content only, never markup (PRD §5.3.6)
	chip.dataset.suggestionIndex = String(index);
	chip.title = "Insert into message";
	chip.setAttribute("aria-describedby", "chip-hint");
	if (!opts.live) {
		chip.classList.add("chip-inert");
		chip.setAttribute("aria-disabled", "true");
	}
	if (opts.visited?.has(index)) chip.classList.add("chip-visited");
	if (opts.live && opts.onInsert) {
		chip.addEventListener("click", () => opts.onInsert?.(text, index));
	}
	return chip;
}

function hasAncestor(node: Node, tag: string): boolean {
	let p: Node | null = node.parentNode;
	const upper = tag.toUpperCase();
	while (p && p.nodeType === 1 /* ELEMENT_NODE */) {
		if ((p as Element).tagName === upper) return true;
		p = p.parentNode;
	}
	return false;
}

function stripLeftoverSentinels(root: HTMLElement): void {
	const textNodes: Text[] = [];
	collectTextNodes(root, textNodes);
	for (const t of textNodes) {
		PUA_RE.lastIndex = 0;
		if (PUA_RE.test(t.data)) {
			PUA_RE.lastIndex = 0;
			t.data = t.data.replace(PUA_RE, "");
		}
	}
}
