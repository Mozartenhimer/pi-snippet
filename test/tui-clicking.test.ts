/**
 * The click path, with a terminal that paints hyperlinks.
 *
 * Nothing in the suite reaches this code: `getCapabilities().hyperlinks` is
 * false without a real terminal, so `linkOn()` is false, the socket never
 * binds and every branch behind it — the chip URLs, the probe, the
 * registration hint — has never run. Mocking that one capability is what makes
 * the rest reachable, and MC/DC is how the hole was found.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-tui", () => ({
	getCapabilities: () => ({ hyperlinks: true }),
}));

const { default: piSnippetTui } = await import("../src/extension/pi-snippet-tui.js");
const { install } = await import("../src/extension/link-install.js");
const { messageKey } = await import("../src/shared/link-url.js");

let home: string;
const realEnv = { ...process.env };

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "pi-snippet-click-"));
	process.env.PI_SNIPPET_SOCKET_DIR = join(home, "sockets");
	process.env.XDG_DATA_HOME = join(home, "data");
	process.env.XDG_CONFIG_HOME = join(home, "config");
	delete process.env.SSH_TTY;
	delete process.env.SSH_CONNECTION;
});

afterEach(() => {
	for (const key of ["PI_SNIPPET_SOCKET_DIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME"]) {
		if (realEnv[key] === undefined) delete process.env[key];
		else process.env[key] = realEnv[key];
	}
	rmSync(home, { recursive: true, force: true });
});

function makeFakePi() {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	let transformer: ((markdown: string, ctx: any) => string) | undefined;
	const pi = {
		registerFlag: () => {},
		getFlag: () => undefined,
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerMarkdownTransformer: (fn: any) => {
			transformer = fn;
		},
		registerShortcut: () => {},
		registerCommand: (name: string, opts: any) => commands.set(name, opts.handler),
	};
	piSnippetTui(pi);
	return {
		fire: (name: string, event: any, ctx: any) => handlers.get(name)!(event, ctx),
		run: (args: string, ctx: any) => commands.get("snippets")!(args, ctx),
		transform: (markdown: string, ctx: any) => transformer!(markdown, ctx),
		shutdown: () => handlers.get("session_shutdown")!({}, {}),
	};
}

function makeCtx(editor = "", choose: (options: string[]) => string | undefined = () => undefined) {
	const notices: string[] = [];
	/** Every question put to the user, so "asked once" is a thing to assert. */
	const asked: string[] = [];
	let text = editor;
	return {
		notices,
		asked,
		editorText: () => text,
		ctx: {
			mode: "cli",
			hasUI: true,
			sessionManager: { getBranch: () => [], getSessionId: () => "a-session-id" },
			ui: {
				getEditorText: () => text,
				setEditorText: (next: string) => {
					text = next;
				},
				notify: (m: string) => notices.push(m),
				setStatus: () => {},
				setFooter: () => {},
				select: async (title: string, options: string[]) => {
					asked.push(title);
					return choose(options);
				},
			},
		},
	};
}

const msg = (...texts: string[]) => ({
	role: "assistant",
	content: texts.map((text) => ({ type: "text", text })),
});

/** Speak to the socket the way the generated handler does. */
function send(path: string, line: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = connect(path, () => socket.end(`${line}\n`));
		socket.on("close", () => resolve());
		socket.on("error", reject);
	});
}

const MESSAGE = "Want me to <snippet>rebuild</snippet> or <snippet>wait</snippet>?";

describe("a terminal that can paint hyperlinks", () => {
	it("paints chip URLs and inserts what a click on one names", async () => {
		const pi = makeFakePi();
		const { ctx, editorText } = makeCtx();
		pi.fire("session_start", { reason: "startup" }, ctx);
		pi.fire("message_end", { message: msg(MESSAGE) }, ctx);
		try {
			const painted = pi.transform(MESSAGE, { messageType: "assistant", isStreaming: false });
			expect(painted).toContain("pisnip://");

			const dir = process.env.PI_SNIPPET_SOCKET_DIR!;
			const { readdirSync } = await import("node:fs");
			const [sock] = readdirSync(dir);
			await send(join(dir, sock!), `${messageKey(MESSAGE)}/c2`);
			await new Promise((r) => setTimeout(r, 50));
			expect(editorText()).toBe("wait");
		} finally {
			pi.shutdown();
		}
	});

	it("inserts nothing for a probe click, which only proves the path", async () => {
		const pi = makeFakePi();
		const { ctx, editorText } = makeCtx();
		pi.fire("session_start", { reason: "startup" }, ctx);
		pi.fire("message_end", { message: msg(MESSAGE) }, ctx);
		try {
			const { readdirSync } = await import("node:fs");
			const dir = process.env.PI_SNIPPET_SOCKET_DIR!;
			const [sock] = readdirSync(dir);
			await send(join(dir, sock!), "00000000/c1");
			await new Promise((r) => setTimeout(r, 50));
			expect(editorText()).toBe("");
		} finally {
			pi.shutdown();
		}
	});

	it("asks about registration at the first chip, once, not on every message", () => {
		// The question is put where a Ctrl+click first becomes possible, because
		// the click that would have failed never reaches this process at all.
		const pi = makeFakePi();
		const { ctx, asked } = makeCtx();
		pi.fire("session_start", { reason: "startup" }, ctx);
		try {
			// No chips yet, so nothing to click and nothing to ask about.
			expect(asked).toEqual([]);
			pi.fire("message_end", { message: msg(MESSAGE) }, ctx);
			pi.fire("message_end", { message: msg(MESSAGE) }, ctx);
			expect(asked.filter((t) => t.includes("one-time pisnip:// handler"))).toHaveLength(1);
		} finally {
			pi.shutdown();
		}
	});

	it("does not ask once the handler is registered", () => {
		install(process.env);
		const pi = makeFakePi();
		const { ctx, asked } = makeCtx();
		pi.fire("session_start", { reason: "startup" }, ctx);
		try {
			pi.fire("message_end", { message: msg(MESSAGE) }, ctx);
			expect(asked).toEqual([]);
		} finally {
			pi.shutdown();
		}
	});

	it("just says where the setup belongs over SSH, and asks nothing", () => {
		// The desktop that resolves the click is the client's, so there is
		// nothing here to register and nothing to decide — only somewhere else
		// to point at.
		process.env.SSH_CONNECTION = "10.0.0.1 22 10.0.0.2 22";
		try {
			const pi = makeFakePi();
			const { ctx, notices, asked } = makeCtx();
			pi.fire("session_start", { reason: "startup" }, ctx);
			pi.fire("message_end", { message: msg(MESSAGE) }, ctx);
			expect(notices.join(" ")).toContain("lives on the machine in front of you");
			expect(notices.join(" ")).toContain("routes chips back to testbox");
			expect(asked).toEqual([]);
			pi.shutdown();
		} finally {
			delete process.env.SSH_CONNECTION;
		}
	});

	it("offers to remove the handler once it is registered, and says so when it goes", async () => {
		install(process.env);
		const pi = makeFakePi();
		const { ctx, notices } = makeCtx();
		pi.fire("session_start", { reason: "startup" }, ctx);
		try {
			await pi.run("", {
				...ctx,
				ui: {
					...ctx.ui,
					select: async (_t: string, options: string[]) =>
						options.find((o) => o.startsWith("Remove click handler")),
				},
			});
			expect(notices.join(" ")).toContain("unregistered");
			expect(notices.join(" ")).toContain("files cleaned");
		} finally {
			pi.shutdown();
		}
	});

	it("paints the same URL over SSH, and names the host it routes to", async () => {
		// Since ADR 0001 a remote session is indistinguishable from a local one
		// where painting is concerned: the URL says which machine to deliver to,
		// so there is nothing left to withhold chips over.
		process.env.SSH_CONNECTION = "10.0.0.1 22 10.0.0.2 22";
		try {
			const pi = makeFakePi();
			const { ctx } = makeCtx();
			pi.fire("session_start", { reason: "startup" }, ctx);
			pi.fire("message_end", { message: msg(MESSAGE) }, ctx);
			let heading = "";
			await pi.run("", {
				...ctx,
				ui: {
					...ctx.ui,
					select: async (title: string) => {
						heading = title;
						return undefined;
					},
				},
			});
			// The one thing this session still cannot answer is whether a handler
			// exists on the client, so it reports what it painted instead.
			expect(heading).toContain("chips route back to testbox");
			expect(pi.transform(MESSAGE, { messageType: "assistant", isStreaming: false })).toContain(
				"pisnip://testbox/",
			);
			pi.shutdown();
		} finally {
			delete process.env.SSH_CONNECTION;
		}
	});
});
