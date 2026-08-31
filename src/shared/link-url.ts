/**
 * The URL a chip carries when the terminal is the one resolving the click
 * (docs/terminal-resolved-clicks.md §4).
 *
 * Where the terminal cannot resolve clicks (no OSC 8) the chip carries no URL
 * at all — the transformer paints the bare superscript label (`tui-markdown.ts`),
 * because pi-tui prints any href it cannot emit as OSC 8 in visible parens.
 * Where the terminal can, the href becomes load-bearing: pi-tui paints it into
 * an OSC 8 hyperlink (measured verbatim, §9a), the terminal resolves Ctrl+click
 * against it, and the OS hands it to our registered handler. The href is the
 * whole channel, so its shape is a contract between three processes that never
 * speak otherwise.
 *
 *     pisnip://<host>/<token>/<msg>/<id>
 *
 * Three rules the shape exists to enforce:
 *
 * **It names the machine the session is on.** A click is resolved by the
 * terminal in front of the user, which over SSH is not the machine that
 * painted the chip — so the URL says where to go rather than leaving the
 * handler to rediscover it from a config file the user had to write
 * (ADR 0001). A local session paints its own hostname too: one shape
 * everywhere, and the handler skips the network when the name is its own.
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

/** The one layer: a numbered chip. (`c1`..; kept in the URL for future kinds.) */
export interface ChipLink {
	/** The machine the session is on, as it named itself. */
	host: string;
	token: string;
	msg: string;
	/** One-based, as painted. */
	index: number;
}

/**
 * What may stand where the host goes — an ssh-config alias or a plain
 * hostname, and nothing else.
 *
 * This value now arrives from outside (it is the netloc of a URL anyone who
 * can put a link on screen could write) and it reaches an `ssh` argv, so the
 * shape is the guard rather than quoting around whatever turns up. Two things
 * it deliberately refuses:
 *
 * - **A leading `-`.** `ssh … -Jevil.com cmd url` makes ssh read the host slot
 *   as an option and shift the destination to the next argument. Harmless
 *   while only the user could write the string; remotely triggerable the
 *   moment it comes from a URL. The handler also passes `--` before the host,
 *   because one guard for this is not enough.
 * - **Anything a shell could act on.** `ssh host cmd arg` re-parses its
 *   command line in a remote shell, so a metacharacter here is a metacharacter
 *   there.
 *
 * What replaces the allowlist this used to be checked against is ssh's own:
 * the relay runs `BatchMode=yes`, so a host missing from `known_hosts` is
 * refused at the host-key check (ADR 0001).
 */
export function isLinkHost(host: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._@-]{0,254}$/.test(host);
}

/**
 * Is `host` a name for the machine asking?
 *
 * The URL carries one shape everywhere, so a local session's chips name this
 * host too — and a click on one must not ssh to ourselves to reach a socket
 * that is right here. Compared on the first label, case-insensitively, because
 * `hostname` and an `~/.ssh/config` alias routinely disagree about the domain
 * and agree about everything before it.
 */
export function isOwnHost(host: string, own: string): boolean {
	const label = (name: string) => name.toLowerCase().split("@").pop()!.split(".")[0] as string;
	return host.toLowerCase() === "localhost" || label(host) === label(own);
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
function fnv1a(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		// The 32-bit FNV prime, as shifts: Math.imul keeps this exact.
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

export function messageKey(text: string): string {
	return fnv1a(text);
}

/**
 * The socket's name, derived from pi's own session id rather than drawn
 * fresh per launch.
 *
 * A random token disambiguates concurrent sessions but dies with the process
 * that drew it, so a chip painted before a restart names a socket nothing
 * will ever bind again. The session id survives a resume (it is the `id`
 * field of the session file), so hashing it down to the same shape the random
 * token used — the handler script requires `isalnum()`, which a raw UUID's
 * hyphens fail — lets a resumed session rebind the very socket path its own
 * old scrollback already points to, while still keying two *different*
 * sessions in the same directory apart.
 */
export function sessionToken(sessionId: string): string {
	return fnv1a(sessionId);
}

/** `pisnip://mybox/a1b2c3d4/0f3e2a91/c3` */
export function buildChipUrl(host: string, token: string, msg: string, index: number): string {
	return `${LINK_SCHEME}://${host}/${token}/${msg}/c${index}`;
}

/**
 * The socket side: parse what the handler forwarded.
 *
 * Deliberately strict. Everything here arrives from outside the process, and a
 * malformed value must be a miss rather than a coerced index — `NaN`, a
 * negative, or a float would all index into `undefined` eventually, but only
 * by luck.
 *
 * The pattern is what enforces that: one to three digits can only produce a
 * whole number from 0 to 999, so `0` is the single remaining way to name a
 * chip that does not exist. A `Number.isSafeInteger` check stood beside it
 * and could not fail for anything the pattern admits.
 */
export function parseChipPath(path: string): { msg: string; index: number } | null {
	const match = /^\/?([0-9a-f]{1,16})\/c([0-9]{1,3})$/.exec(path.trim());
	if (!match) return null;
	const index = Number(match[2]);
	if (index < 1) return null;
	return { msg: match[1] as string, index };
}

/**
 * The whole URL, for the handler and for tests.
 *
 * The token moved out of the netloc and into the path when the host took its
 * place, so this peels two segments rather than one; `parseChipPath` still
 * parses exactly what goes on the wire to the socket, which is the part that
 * did not change.
 */
export function parseChipUrl(url: string): ChipLink | null {
	const match = new RegExp(`^${LINK_SCHEME}://([^/]{1,255})/([0-9a-z]{1,32})(/.*)$`).exec(url.trim());
	if (!match) return null;
	const host = match[1] as string;
	if (!isLinkHost(host)) return null;
	const rest = parseChipPath(match[3] as string);
	if (!rest) return null;
	return { host, token: match[2] as string, ...rest };
}
