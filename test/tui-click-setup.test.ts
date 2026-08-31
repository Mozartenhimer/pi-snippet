/**
 * Setting clicking up, rather than using it: the two `/snippets` rows that
 * register the desktop handler and remove it again — which, since ADR 0001,
 * is the whole of the setup this feature has anywhere.
 *
 * None of it had ever run. `installClickHandler` is reachable only from a menu
 * row, the row is only offered on the platform and connection it wants, and it
 * then waits on a real click coming back through a real socket — so the whole
 * of the probe and its verdicts sat behind a door no test had opened. Same
 * trick as `tui-clicking.test.ts`: mock the one capability that gates the door.
 */
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { install } from "../src/extension/link-install.js";

vi.mock("@earendil-works/pi-tui", () => ({
	getCapabilities: () => ({ hyperlinks: true }),
}));

const { default: piSnippetTui } = await import("../src/extension/pi-snippet-tui.js");

let home: string;
const realEnv = { ...process.env };
const realPlatform = process.platform;
const realPath = process.env.PATH ?? "";

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "pi-snippet-setup-"));
	process.env.PI_SNIPPET_SOCKET_DIR = join(home, "sockets");
	process.env.XDG_DATA_HOME = join(home, "data");
	process.env.XDG_CONFIG_HOME = join(home, "config");
	delete process.env.SSH_TTY;
	delete process.env.SSH_CONNECTION;
});

afterEach(() => {
	for (const key of ["PI_SNIPPET_SOCKET_DIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "TMPDIR"]) {
		if (realEnv[key] === undefined) delete process.env[key];
		else process.env[key] = realEnv[key];
	}
	process.env.PATH = realPath;
	Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
	rmSync(home, { recursive: true, force: true });
});

/** Pretend to be another operating system for one test. */
function pretendPlatform(value: string): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

/**
 * A bin directory holding fakes, and `PATH` pointing at nothing else.
 *
 * Replacing `PATH` rather than prepending to it is the point: this container
 * has a real `gio` and a real `gdbus`, and a probe that reaches them dispatches
 * a live URL at whatever desktop is listening — which made the outcome depend
 * on the machine. With only these on `PATH`, every opener the probe tries is
 * either one of ours or genuinely absent.
 */
function fakeBin(files: Record<string, string>): void {
	const bin = join(home, "bin");
	mkdirSync(bin, { recursive: true });
	for (const [name, body] of Object.entries(files)) {
		writeFileSync(join(bin, name), body, "utf8");
		chmodSync(join(bin, name), 0o755);
	}
	process.env.PATH = bin;
}

/**
 * A fake `xdg-open`, with `gdbus` and `gio` left absent so the probe also walks
 * its "opener is not installed" arm.
 *
 * It records the URL and returns, which is what a real opener does: the
 * dispatch to the desktop is asynchronous, and the handler connects back long
 * after the opener process is gone. It matters that the fake behaves that way
 * too — `execFileSync` blocks this process's event loop, so a fake that
 * connected before returning would be talking to a server whose `listen()` had
 * not finished binding. The test plays the handler's part instead, once the
 * probe starts waiting.
 */
function fakeOpener(): string {
	const urlFile = join(home, "opened-url");
	fakeBin({ "xdg-open": `#!/bin/sh\nprintf '%s' "$1" > ${urlFile}\n` });
	return urlFile;
}

/** An `xdg-open` that succeeds and dispatches nowhere at all. */
function silentOpener(): void {
	fakeBin({ "xdg-open": "#!/bin/sh\nexit 0\n" });
}

/** Poll until `check` is true, or give up. */
async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await new Promise((r) => setTimeout(r, 20));
	}
}

/** Speak to the socket the way the generated handler does. */
function send(path: string, line: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = connect(path, () => socket.end(`${line}\n`));
		socket.on("close", () => resolve());
		socket.on("error", reject);
	});
}

/** Point every socket-directory candidate at something that cannot be a directory. */
function breakSocketDirs(): void {
	const blocker = join(home, "not-a-dir");
	writeFileSync(blocker, "", "utf8");
	process.env.PI_SNIPPET_SOCKET_DIR = join(blocker, "sockets");
	process.env.TMPDIR = join(blocker, "tmp");
	delete process.env.XDG_RUNTIME_DIR;
}

interface FakeTui {
	input: (data: string) => void;
	renders: number;
}

function makeFakePi() {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const shortcuts = new Map<string, (ctx: any) => void>();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const pi = {
		registerFlag: () => {},
		getFlag: () => undefined,
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerMarkdownTransformer: () => {},
		registerShortcut: (key: string, opts: any) => shortcuts.set(key, opts.handler),
		registerCommand: (name: string, opts: any) => commands.set(name, opts.handler),
	};
	piSnippetTui(pi);
	return {
		fire: (name: string, event: any, ctx: any) => handlers.get(name)!(event, ctx),
		press: (key: string, ctx: any) => shortcuts.get(key)!(ctx),
		run: (args: string, ctx: any) => commands.get("snippets")!(args, ctx),
		shutdown: () => handlers.get("session_shutdown")!({}, {}),
	};
}

/**
 * A ctx in TUI mode, so the footer factory runs and hands the extension a TUI
 * instance — which is the only way its input listener (the Alt-release watch)
 * gets installed.
 */
function makeCtx(
	choose: (options: string[]) => string | undefined = () => undefined,
	answer: (title: string) => string | undefined = () => undefined,
) {
	const notices: string[] = [];
	let text = "";
	const listeners: Array<(data: string) => void> = [];
	const tui: FakeTui = {
		input: (data: string) => {
			for (const listener of listeners) listener(data);
		},
		renders: 0,
	};
	const instance = {
		addInputListener: (fn: (data: string) => void) => {
			listeners.push(fn);
			return () => {};
		},
		requestRender: () => {
			tui.renders++;
		},
		invalidate: () => {},
	};
	return {
		notices,
		tui,
		editorText: () => text,
		ctx: {
			mode: "tui",
			hasUI: true,
			sessionManager: { getBranch: () => [], getSessionId: () => "a-session-id" },
			ui: {
				getEditorText: () => text,
				setEditorText: (next: string) => {
					text = next;
				},
				notify: (m: string) => notices.push(m),
				setStatus: () => {},
				setFooter: (factory?: (i: any) => any) => {
					factory?.(instance);
				},
				select: async (_title: string, options: string[]) => choose(options),
				input: async (title: string) => answer(title),
			},
		},
	};
}

const msg = (...texts: string[]) => ({
	role: "assistant",
	content: texts.map((text) => ({ type: "text", text })),
});

const REGISTER = "Register click handler — one-time desktop setup, needed before Ctrl+click works";
const MESSAGE = "Want me to <snippet>rebuild</snippet> or <snippet>wait</snippet>?";

describe("registering the click handler", () => {
	it("says so and stops off Linux", async () => {
		const pi = makeFakePi();
		const { ctx, notices } = makeCtx(() => REGISTER);
		pretendPlatform("darwin");
		await pi.run("", ctx);
		expect(notices.join(" ")).toContain("Linux-only");
		pi.shutdown();
	});

	it("sends you to the machine in front of you when you are over SSH", async () => {
		// Registering here would write into a desktop nobody is looking at. And
		// since the URL names this host, that is genuinely all that is left to
		// do — so the message says which host the chips already point at.
		process.env.SSH_CONNECTION = "10.0.0.1 22 10.0.0.2 22";
		const pi = makeFakePi();
		const { ctx, notices } = makeCtx(() => REGISTER);
		await pi.run("", ctx);
		const said = notices.join(" ");
		expect(said).toContain("register the handler there");
		expect(said).toContain("Chips here already name testbox");
		pi.shutdown();
	});

	it("says it could not open a socket when no candidate directory works", async () => {
		breakSocketDirs();
		const pi = makeFakePi();
		const { ctx, notices } = makeCtx(() => REGISTER);
		await pi.run("", ctx);
		expect(notices.join(" ")).toContain("Could not open a socket");
		pi.shutdown();
	});

	it("verifies the round trip against the live socket and names the opener", async () => {
		const urlFile = fakeOpener();
		const pi = makeFakePi();
		const { ctx, notices } = makeCtx(() => REGISTER);
		// No session_start: the server is not listening yet, so the probe is what
		// binds it.
		try {
			const running = pi.run("", ctx);
			await waitFor(() => existsSync(urlFile));
			const url = readFileSync(urlFile, "utf8");
			// scheme://host/token/msg/cN — the socket wants the last two.
			const rest = url.replace("pisnip://", "").split("/").slice(2);
			const dir = process.env.PI_SNIPPET_SOCKET_DIR!;
			await waitFor(() => readdirSync(dir).length > 0);
			await send(join(dir, readdirSync(dir)[0]!), rest.join("/"));
			await running;
			expect(url.startsWith("pisnip://")).toBe(true);
			expect(notices.join(" ")).toContain("installed and verified via xdg-open");
		} finally {
			pi.shutdown();
		}
	}, 20_000);

	it("reports the openers it tried when none completes the trip", async () => {
		silentOpener();
		const pi = makeFakePi();
		const { ctx, notices } = makeCtx(() => REGISTER);
		// session_start first, so the probe finds the socket already listening.
		pi.fire("session_start", { reason: "startup" }, ctx);
		try {
			await pi.run("", ctx);
			const said = notices.join(" ");
			expect(said).toContain("no opener completed the round trip");
			// The two absent openers are named as absent, the present one as a
			// dispatch that went nowhere.
			expect(said).toContain("gdbus (absent)");
			expect(said).toContain("xdg-open (no round trip)");
		} finally {
			pi.shutdown();
		}
	}, 20_000);
});

describe("removing the click handler", () => {
	it("reports an unclean removal, and cleans nothing when there was nothing to clean", async () => {
		// A desktop whose `xdg-mime` still names our handler afterwards, and an
		// install that never happened — so `removed` is empty and `clean` false,
		// the pair the happy-path test never produces. The row is asked for by
		// name rather than found in the menu, which is the only way to reach this
		// arm with nothing of ours on disk.
		fakeBin({
			"update-desktop-database": "#!/bin/sh\nexit 0\n",
			"xdg-mime": '#!/bin/sh\nif [ "$1" = "query" ]; then echo pi-snippet-open.desktop; fi\nexit 0\n',
		});
		const pi = makeFakePi();
		const { ctx, notices } = makeCtx(() => "Remove click handler — unregister pisnip:// from the desktop");
		try {
			await pi.run("", ctx);
			const said = notices.join(" ");
			expect(said).toContain("not cleanly");
			expect(said).not.toContain("files cleaned");
		} finally {
			pi.shutdown();
		}
	});
});

describe("the Alt-release watch", () => {
	/** Ten suggestions, so a first digit can still be extended into a second. */
	const TEN = Array.from({ length: 10 }, (_, i) => `<snippet>pick ${i + 1}</snippet>`).join(" ");

	it("settles a pending chord the moment the terminal reports Alt going up", () => {
		const pi = makeFakePi();
		const { ctx, tui, editorText } = makeCtx();
		pi.fire("session_start", { reason: "startup" }, ctx);
		try {
			pi.fire("message_end", { message: msg(TEN) }, ctx);
			pi.press("alt+1", ctx);
			expect(editorText()).toBe(""); // still waiting for a possible second digit
			tui.input("hello"); // ordinary input, no release in it
			expect(editorText()).toBe("");
			tui.input("\x1b[57443;1:3u");
			expect(editorText()).toBe("pick 1");
			// Nothing pending now, so the same bytes do nothing.
			tui.input("\x1b[57443;1:3u");
			expect(editorText()).toBe("pick 1");
		} finally {
			pi.shutdown();
		}
	});
});

describe("the registration hint", () => {
	it("is not offered off Linux, where there is no handler to register", () => {
		pretendPlatform("darwin");
		const pi = makeFakePi();
		const { ctx, notices } = makeCtx();
		pi.fire("session_start", { reason: "startup" }, ctx);
		try {
			pi.fire("message_end", { message: msg(MESSAGE) }, ctx);
			expect(notices.filter((n) => n.includes("one-time handler registration"))).toEqual([]);
		} finally {
			pi.shutdown();
		}
	});

	it("is offered on Linux with a handler that is not registered", () => {
		const pi = makeFakePi();
		const { ctx, notices } = makeCtx();
		pi.fire("session_start", { reason: "startup" }, ctx);
		try {
			pi.fire("message_end", { message: msg(MESSAGE) }, ctx);
			expect(notices.filter((n) => n.includes("one-time handler registration"))).toHaveLength(1);
		} finally {
			pi.shutdown();
		}
	});
});
