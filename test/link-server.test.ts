/**
 * The socket a terminal-resolved click arrives on.
 *
 * These drive a real `AF_UNIX` socket rather than a stub, because the parts
 * worth testing are the ones a stub would paper over: that the file is bound
 * where the handler will look, that its permissions are what they claim, that
 * debris from a killed session does not stop the next one starting, and that
 * nothing arriving from outside the process can insert text of its own.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LinkServer, socketDirCandidates } from "../src/extension/link-server.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-snippet-sock-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Speak to the socket the way the generated handler does: one line, then go. */
function send(path: string, line: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = connect(path, () => {
			socket.end(`${line}\n`);
		});
		socket.on("close", () => resolve());
		socket.on("error", reject);
	});
}

function serverFor(options: {
	resolve?: (msg: string, kind: "c" | "a", index: number) => string | undefined;
	inserted: string[];
}): LinkServer {
	return new LinkServer({
		token: "a1b2c3d4",
		env: { PI_SNIPPET_SOCKET_DIR: dir },
		resolve: options.resolve ?? ((msg, kind, index) => (msg === "0f3e2a91" && kind === "c" ? `chip ${index}` : undefined)),
		onActivate: (text) => options.inserted.push(text),
	});
}

describe("the click socket", () => {
	it("binds where the handler will look, and only for this user", async () => {
		const inserted: string[] = [];
		const server = serverFor({ inserted });
		const path = server.start();
		try {
			expect(path).toBe(join(dir, "a1b2c3d4.sock"));
			// The directory is what actually keeps other users out: `listen()`
			// binds asynchronously, so the socket file cannot be locked down
			// the instant it exists.
			expect(statSync(dir).mode & 0o777).toBe(0o700);
			await new Promise((r) => setTimeout(r, 50));
			expect(statSync(path!).mode & 0o777).toBe(0o600);
		} finally {
			server.stop();
		}
		// And it cleans up after itself, so the next session starts clean.
		expect(existsSync(path!)).toBe(false);
	});

	it("inserts the suggestion a forwarded click names", async () => {
		const inserted: string[] = [];
		const server = serverFor({ inserted });
		const path = server.start()!;
		try {
			await send(path, "0f3e2a91/c2");
			await new Promise((r) => setTimeout(r, 50));
			expect(inserted).toEqual(["chip 2"]);
		} finally {
			server.stop();
		}
	});

	it("ignores a click naming a message it has never seen", async () => {
		const inserted: string[] = [];
		const server = serverFor({ inserted });
		const path = server.start()!;
		try {
			await send(path, "deadbeef/c1");
			await new Promise((r) => setTimeout(r, 50));
			expect(inserted).toEqual([]);
		} finally {
			server.stop();
		}
	});

	// The URL names a slot; it never carries words. Anything that arrives
	// claiming otherwise is a miss, not an insertion.
	it.each(["", "not a path", "0f3e2a91/c1; rm -rf /", "../../escape/c1", "0f3e2a91/c0"])(
		"refuses to act on %j",
		(line) => {
			const inserted: string[] = [];
			const server = serverFor({ inserted });
			try {
				expect(server.handle(line)).toBe(false);
				expect(inserted).toEqual([]);
			} finally {
				server.stop();
			}
		},
	);

	it("starts over debris from a killed session", () => {
		const inserted: string[] = [];
		const first = serverFor({ inserted });
		const path = first.start()!;
		// Simulate a hard kill: the process is gone, the socket file is not.
		(first as unknown as { server: null }).server = null;
		expect(existsSync(path)).toBe(true);

		const second = serverFor({ inserted });
		try {
			expect(second.start()).toBe(path);
		} finally {
			second.stop();
		}
	});

	it("leaves a regular file alone rather than deleting someone's data", () => {
		const path = join(dir, "a1b2c3d4.sock");
		writeFileSync(path, "not a socket", "utf8");
		const inserted: string[] = [];
		const server = serverFor({ inserted });
		try {
			// Cannot bind over it, so it falls through the candidate list.
			expect(server.start()).not.toBe(path);
			expect(existsSync(path)).toBe(true);
		} finally {
			server.stop();
		}
	});
});

describe("where the two sides agree to meet", () => {
	it("prefers an explicit override, so a confined build can be pointed somewhere shared", () => {
		const candidates = socketDirCandidates({
			PI_SNIPPET_SOCKET_DIR: "/shared/place",
			XDG_RUNTIME_DIR: "/run/user/1000",
		});
		expect(candidates[0]).toBe("/shared/place");
	});

	it("falls back through the runtime dir to a per-user temp dir", () => {
		const candidates = socketDirCandidates({ XDG_RUNTIME_DIR: "/run/user/1000" });
		expect(candidates[0]).toBe(join("/run/user/1000", "pi-snippet"));
		expect(candidates[candidates.length - 1]).toMatch(/pi-snippet-\d+$/);
	});

	it("still names a directory when the session has no runtime dir at all", () => {
		expect(socketDirCandidates({}).length).toBeGreaterThan(0);
	});
});
