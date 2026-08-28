/**
 * The URL a chip carries when the terminal is the one resolving the click
 * (docs/terminal-resolved-clicks.md §4).
 *
 * In mouse mode a chip's href is inert — `chip:1` exists only because markdown
 * link syntax requires a URL. In link mode it becomes load-bearing: pi-tui
 * paints it into an OSC 8 hyperlink (measured verbatim, §9a), the terminal
 * resolves Ctrl+click against it, and the OS hands it to our registered
 * handler. The href is the whole channel, so its shape is a contract between
 * three processes that never speak otherwise.
 *
 *     pisnip://<token>/<msg>/<id>
 *
 * Two rules the shape exists to enforce:
 *
 * **It carries an index, never text.** The URL names a slot the extension
 * looks up in its own state, so nothing that reaches the socket can put words
 * into the editor that the model did not already write.
 *
 * **It is keyed by message.** A bare `c3` would resolve against whatever is
 * addressable *now*, so clicking a chip in old scrollback would silently
 * insert some other message's third suggestion. `msg` is a hash of the exact
 * text the chip was rendered from, which makes the key a pure function of what
 * the transformer was handed — no state built during a render pass (PRD §5.2),
 * and no counter to keep in sync.
 */

export const LINK_SCHEME = "pisnip";

/** Layer tags, matching the ids `ClickableText` already uses for hit-testing. */
export type LinkKind = "c" | "a";

export interface ChipLink {
	token: string;
	msg: string;
	kind: LinkKind;
	/** One-based, as painted. */
	index: number;
}

/**
 * FNV-1a, 32 bits, hex.
 *
 * Not a checksum and not security: it names a message for a lookup table whose
 * entries this process wrote itself. A collision costs one wrong insertion out
 * of a bounded map of recent messages, which is why 32 bits is enough and why
 * the URL stays short — under tmux without hyperlinks pi-tui prints the whole
 * thing in parentheses after the label, so every character is one the user
 * might have to read.
 */
export function messageKey(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		// The 32-bit FNV prime, as shifts: Math.imul keeps this exact.
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/** `pisnip://a1b2c3d4/0f3e2a91/c3` */
export function buildChipUrl(token: string, msg: string, kind: LinkKind, index: number): string {
	return `${LINK_SCHEME}://${token}/${msg}/${kind}${index}`;
}

/**
 * The socket side: parse what the handler forwarded.
 *
 * Deliberately strict. Everything here arrives from outside the process, and a
 * malformed value must be a miss rather than a coerced index — `NaN`, a
 * negative, or a float would all index into `undefined` eventually, but only
 * by luck.
 */
export function parseChipPath(path: string): { msg: string; kind: LinkKind; index: number } | null {
	const match = /^\/?([0-9a-f]{1,16})\/([ca])([0-9]{1,3})$/.exec(path.trim());
	if (!match) return null;
	const index = Number(match[3]);
	if (!Number.isSafeInteger(index) || index < 1) return null;
	return { msg: match[1] as string, kind: match[2] as LinkKind, index };
}

/** The whole URL, for the handler and for tests. */
export function parseChipUrl(url: string): ChipLink | null {
	const match = new RegExp(`^${LINK_SCHEME}://([0-9a-z]{1,32})(/.*)$`).exec(url.trim());
	if (!match) return null;
	const rest = parseChipPath(match[2] as string);
	if (!rest) return null;
	return { token: match[1] as string, ...rest };
}
