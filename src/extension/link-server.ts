/**
 * The socket the click comes back on (docs/terminal-resolved-clicks.md §5).
 *
 * In link mode the click leaves this process entirely: the terminal resolves
 * the hyperlink, the OS dispatches the URL, and a handler script — registered
 * once per machine, see `link-install.ts` — connects here and forwards the
 * path. This class is the far end of that trip.
 *
 * ## Where the socket lives, and why it is not simply XDG_RUNTIME_DIR
 *
 * The handler runs in the *desktop session*, this runs inside pi. When pi is a
 * strictly-confined snap those are not the same namespace: the snap gets its
 * own `XDG_RUNTIME_DIR` (and its own `/tmp`), so a socket bound at
 * `$XDG_RUNTIME_DIR/pi-snippet` would be invisible to the handler even though
 * both sides computed the "same" path. That is measured-unknown territory
 * (§9d), so rather than guess, both sides walk the same ordered list of
 * candidates and this one reports the path it actually bound. A mismatch then
 * shows up in `/snippets` as two different directories instead of as a click
 * that silently does nothing.
 *
 * `PI_SNIPPET_SOCKET_DIR` is first in that list precisely so a confined build
 * can be pointed at a directory both sides can see.
 *
 * ## Nothing here is allowed to be fatal
 *
 * The same rule `settings.ts` follows. An unwritable runtime directory, a
 * leftover socket from a killed session, a handler that connects and says
 * nothing — each degrades to "clicking does not work this session", never to a
 * dead extension.
 */
import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
	mkdirSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseChipPath } from "../shared/link-url.js";

/** Ordered candidates for the socket directory. Kept in sync with the handler. */
export function socketDirCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
	const candidates: string[] = [];
	const explicit = env.PI_SNIPPET_SOCKET_DIR;
	if (explicit) candidates.push(explicit);
	if (env.XDG_RUNTIME_DIR) candidates.push(join(env.XDG_RUNTIME_DIR, "pi-snippet"));
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	candidates.push(join(tmpdir(), `pi-snippet-${uid}`));
	return candidates;
}

export interface LinkServerOptions {
	token: string;
	/** Resolve a click to the text to insert, or null for a miss. */
	resolve: (msg: string, kind: "c" | "a", index: number) => string | undefined;
	onActivate: (text: string) => void;
	env?: NodeJS.ProcessEnv;
}

export class LinkServer {
	private server: Server | null = null;
	private path: string | null = null;
	private readonly options: LinkServerOptions;

	constructor(options: LinkServerOptions) {
		this.options = options;
	}

	get listening(): boolean {
		return this.server !== null;
	}

	/** The bound path, for `/snippets` to show beside the handler's guess. */
	get socketPath(): string | null {
		return this.path;
	}

	/** Bind the first candidate that works. Returns the path, or null. */
	start(): string | null {
		if (this.server) return this.path;
		for (const dir of socketDirCandidates(this.options.env)) {
			const path = join(dir, `${this.options.token}.sock`);
			try {
				mkdirSync(dir, { recursive: true, mode: 0o700 });
				// The directory is the real guard. `listen()` binds
				// asynchronously, so the socket file cannot be chmod-ed the
				// instant it appears — but nothing can reach it through a
				// directory only this user may traverse. `mode` above applies
				// only when mkdir creates it, so an existing directory with
				// looser permissions is tightened here.
				chmodSync(dir, 0o700);
				accessSync(dir, constants.W_OK);
				if (!clearStaleSocket(path)) continue;
				const server = createServer((socket) => {
					socket.setEncoding("utf8");
					let buffer = "";
					socket.on("data", (chunk: string) => {
						buffer += chunk;
						// One line per click; anything past the first is ignored
						// rather than trusted, and an unterminated write times
						// out with the socket rather than being acted on.
						const newline = buffer.indexOf("\n");
						if (newline === -1) {
							if (buffer.length > 512) socket.destroy();
							return;
						}
						this.handle(buffer.slice(0, newline));
						socket.end();
					});
					socket.on("error", () => socket.destroy());
					socket.setTimeout(2000, () => socket.destroy());
				});
				// `listen()` reports failure asynchronously, so a candidate that
				// cannot be bound cannot be detected here — which is why every
				// condition that can be checked synchronously is checked above.
				// If one still slips through, forget the server rather than
				// reporting a mode that is not actually listening.
				server.on("error", () => {
					this.server = null;
					this.path = null;
					try {
						server.close();
					} catch {
						/* never listened */
					}
				});
				server.listen(path);
				this.server = server;
				this.path = path;
				server.on("listening", () => {
					try {
						chmodSync(path, 0o600); // belt and braces, behind the 0700 directory
					} catch {
						/* the directory already prevents anyone else reaching it */
					}
				});
				return path;
			} catch {
				// Try the next candidate.
			}
		}
		return null;
	}

	stop(): void {
		if (!this.server) return;
		try {
			this.server.close();
		} catch {
			/* already gone */
		}
		if (this.path) {
			try {
				unlinkSync(this.path);
			} catch {
				/* already gone */
			}
		}
		this.server = null;
		this.path = null;
	}

	/** Exposed for tests: what one forwarded line does. */
	handle(line: string): boolean {
		const parsed = parseChipPath(line);
		if (!parsed) return false;
		const text = this.options.resolve(parsed.msg, parsed.kind, parsed.index);
		if (text === undefined) return false;
		try {
			this.options.onActivate(text);
		} catch {
			return false;
		}
		return true;
	}
}

/**
 * Remove a socket file left behind by a killed session, and say whether the
 * path is usable at all.
 *
 * Unlinking a socket here is safe *because the path carries a per-session
 * random token*: a file at this exact path is either debris from a dead
 * session of ours, or a live session that drew the same token out of 2^32 —
 * not a case worth probing for, and a probe would have to be asynchronous, so
 * its answer would arrive after the bind it was meant to inform.
 *
 * Anything that is not a socket belongs to someone else. Returning false sends
 * the caller to the next candidate directory rather than deleting it.
 */
function clearStaleSocket(path: string): boolean {
	try {
		if (!existsSync(path)) return true;
		if (!statSync(path).isSocket()) return false;
		unlinkSync(path);
		return true;
	} catch {
		return false;
	}
}
