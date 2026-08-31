/**
 * What the extension does with events that are not the happy path.
 *
 * pi hands these handlers whatever the session has: a branch entry that is not
 * a message, a message whose content is not an array, a block that is not
 * text, a user turn where an assistant turn was expected. Every guard against
 * that shape returns quietly, so nothing here has a visible failure mode —
 * which is exactly why `npm run test:mcdc` found none of them had ever been
 * taken.
 */
import { describe, expect, it, vi } from "vitest";
import piSnippetTui from "../src/extension/pi-snippet-tui.js";

type Handler = (event: any, ctx: any) => any;

/** A fake pi that keeps everything the extension registers. */
function makeFakePi() {
	const handlers = new Map<string, Handler>();
	const shortcuts = new Map<string, (ctx: any) => void>();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	let transformer: ((markdown: string, ctx: any) => string) | undefined;
	const pi = {
		registerFlag: () => {},
		getFlag: () => undefined,
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerMarkdownTransformer: (fn: (markdown: string, ctx: any) => string) => {
			transformer = fn;
		},
		registerShortcut: (key: string, opts: any) => shortcuts.set(key, opts.handler),
		registerCommand: (name: string, opts: any) => commands.set(name, opts.handler),
	};
	piSnippetTui(pi);
	return {
		fire: (name: string, event: any, ctx: any) => handlers.get(name)!(event, ctx),
		press: (key: string, ctx: any) => shortcuts.get(key)!(ctx),
		run: (args: string, ctx: any) => commands.get("snippets")!(args, ctx),
		transform: (markdown: string, ctx: any) => transformer!(markdown, ctx),
	};
}

/** A ctx with a branch and an editor whose contents the test can read back. */
function makeCtx(branch: any[] = [], editor = "") {
	const notices: string[] = [];
	let text = editor;
	return {
		notices,
		editorText: () => text,
		ctx: {
			mode: "cli",
			hasUI: true,
			sessionManager: { getBranch: () => branch, getSessionId: () => "test-session-id" },
			ui: {
				getEditorText: () => text,
				setEditorText: (next: string) => {
					text = next;
				},
				notify: (m: string) => notices.push(m),
				setStatus: () => {},
				setFooter: () => {},
				select: async () => undefined,
			},
		},
	};
}

/** An assistant message, as `message_end` receives it. */
const msg = (...texts: string[]) => ({
	role: "assistant",
	content: texts.map((text) => ({ type: "text", text })),
});

/** The same, wrapped as a branch entry. */
const assistant = (...texts: string[]) => ({ type: "message", message: msg(...texts) });

describe("message shapes the handlers have to survive", () => {
	it("ignores a message_start that is not the assistant's", () => {
		const pi = makeFakePi();
		const { ctx } = makeCtx();
		expect(() => pi.fire("message_start", { message: { role: "user" } }, ctx)).not.toThrow();
		expect(() => pi.fire("message_start", {}, ctx)).not.toThrow();
	});

	it("ignores a message_update with no message, or a user's", () => {
		const pi = makeFakePi();
		const { ctx } = makeCtx();
		pi.fire("message_update", {}, ctx);
		pi.fire("message_update", { message: { role: "user", content: [] } }, ctx);
		pi.press("alt+1", ctx);
		expect(ctx.ui.getEditorText()).toBe("");
	});

	it("ignores a message_end with no message, or a user's", () => {
		const pi = makeFakePi();
		const { ctx } = makeCtx();
		pi.fire("message_end", {}, ctx);
		pi.fire("message_end", { message: { role: "user", content: [] } }, ctx);
		pi.press("alt+1", ctx);
		expect(ctx.ui.getEditorText()).toBe("");
	});

	it("addresses nothing for an assistant message whose content is not an array", () => {
		const pi = makeFakePi();
		const { ctx } = makeCtx();
		pi.fire("message_end", { message: { role: "assistant", content: undefined } }, ctx);
		pi.press("alt+1", ctx);
		expect(ctx.ui.getEditorText()).toBe("");
	});

	it("reads past blocks that are not text", () => {
		const pi = makeFakePi();
		const { ctx } = makeCtx();
		const message = {
			role: "assistant",
			content: [
				{ type: "thinking", text: "<snippet>not this one</snippet>" },
				{ type: "tool_use", id: "t1" },
				{ type: "text", text: "Want me to <snippet>rebuild</snippet>?" },
			],
		};
		pi.fire("message_update", { message }, ctx);
		pi.fire("message_end", { message }, ctx);
		pi.press("alt+1", ctx);
		expect(ctx.ui.getEditorText()).toBe("rebuild");
	});

	it("separates an insertion from what is already typed, but not twice", () => {
		const pi = makeFakePi();
		const withText = makeCtx([], "check this");
		pi.fire("message_end", { message: msg("Shall I <snippet>rebuild</snippet>?") }, withText.ctx);
		pi.press("alt+1", withText.ctx);
		expect(withText.editorText()).toBe("check this rebuild");

		const withSpace = makeCtx([], "check this ");
		pi.fire("message_end", { message: msg("Shall I <snippet>rebuild</snippet>?") }, withSpace.ctx);
		pi.press("alt+1", withSpace.ctx);
		expect(withSpace.editorText()).toBe("check this rebuild");
	});
});

describe("hydrating a branch that is not all assistant messages", () => {
	const branch = [
		{ type: "summary", text: "an entry that is not a message at all" },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
		{ type: "message", message: { role: "assistant", content: undefined } },
		assistant("Want me to <snippet>rebuild</snippet> or <snippet>wait</snippet>?"),
	];

	it("addresses the last assistant message and skips the rest", () => {
		const pi = makeFakePi();
		const { ctx } = makeCtx(branch);
		pi.fire("session_start", { reason: "resume" }, ctx);
		pi.press("alt+2", ctx);
		expect(ctx.ui.getEditorText()).toBe("wait");
	});

	it("hydrates on a reload as well as a resume", () => {
		const pi = makeFakePi();
		const { ctx } = makeCtx(branch);
		pi.fire("session_start", { reason: "reload" }, ctx);
		pi.press("alt+1", ctx);
		expect(ctx.ui.getEditorText()).toBe("rebuild");
	});

	it("addresses nothing on a session_start with no reason to hydrate", () => {
		const pi = makeFakePi();
		const { ctx } = makeCtx(branch);
		pi.fire("session_start", { reason: "new" }, ctx);
		pi.press("alt+1", ctx);
		expect(ctx.ui.getEditorText()).toBe("");
	});

	it("re-hydrates when the branch moves under it", () => {
		const pi = makeFakePi();
		const { ctx } = makeCtx(branch);
		pi.fire("session_tree", {}, ctx);
		pi.press("alt+1", ctx);
		expect(ctx.ui.getEditorText()).toBe("rebuild");
	});
});

describe("the markdown transformer", () => {
	it("leaves everything that is not an assistant message alone", () => {
		const pi = makeFakePi();
		const raw = "Want me to <snippet>rebuild</snippet>?";
		expect(pi.transform(raw, { messageType: "user", isStreaming: false })).toBe(raw);
	});

	it("paints an assistant message", () => {
		const pi = makeFakePi();
		expect(
			pi.transform("Want me to <snippet>rebuild</snippet>?", {
				messageType: "assistant",
				isStreaming: false,
			}),
		).toBe("Want me to ¹rebuild?");
	});
});

describe("the Alt+digit shortcuts", () => {
	it("does nothing without a UI to insert into", () => {
		const pi = makeFakePi();
		const { ctx } = makeCtx();
		pi.fire("message_end", { message: msg("Shall I <snippet>rebuild</snippet>?") }, ctx);
		pi.press("alt+1", { ...ctx, hasUI: false });
		expect(ctx.ui.getEditorText()).toBe("");
	});

	it("clears pending digits when the branch moves", () => {
		const pi = makeFakePi();
		const many = Array.from({ length: 25 }, (_, i) => `<snippet>reply ${i}</snippet>`).join(" ");
		const { ctx } = makeCtx();
		pi.fire("message_end", { message: msg(many) }, ctx);
		// 2 is held rather than committed: 20-25 are still reachable.
		pi.press("alt+2", ctx);
		pi.fire("session_tree", {}, ctx);
		expect(ctx.ui.getEditorText()).toBe("");
	});
});

describe("the /snippets menu", () => {
	it("does nothing at all without a UI", async () => {
		const pi = makeFakePi();
		const select = vi.fn();
		const { ctx } = makeCtx();
		await pi.run("", { ...ctx, hasUI: false, ui: { ...ctx.ui, select } });
		expect(select).not.toHaveBeenCalled();
	});

	it("reports how often the model offered suggestions", async () => {
		const pi = makeFakePi();
		let title = "";
		const branch = [
			{ type: "summary", text: "not a message" },
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
			assistant("Nothing to offer here."),
			assistant("Want me to <snippet>rebuild</snippet>?"),
		];
		const { ctx } = makeCtx(branch);
		await pi.run("", {
			...ctx,
			ui: {
				...ctx.ui,
				select: async (heading: string) => {
					title = heading;
					return undefined;
				},
			},
		});
		expect(title).toContain("1/2 messages had suggestions (50%), 1 total");
	});

	it("says so when the branch holds no assistant messages yet", async () => {
		const pi = makeFakePi();
		let title = "";
		const { ctx } = makeCtx([]);
		await pi.run("", {
			...ctx,
			ui: {
				...ctx.ui,
				select: async (heading: string) => {
					title = heading;
					return undefined;
				},
			},
		});
		expect(title).toContain("no assistant messages yet");
	});

	it("toggles the Alt+digit shortcuts off and back on", async () => {
		const pi = makeFakePi();
		const { ctx, notices } = makeCtx();
		const pick = (prefix: string) => ({
			...ctx,
			ui: {
				...ctx.ui,
				select: async (_t: string, options: string[]) => options.find((o) => o.startsWith(prefix)),
			},
		});
		await pi.run("", pick("Alt+digit"));
		expect(notices.at(-1)).toContain("disabled");

		// Off, the shortcut inserts nothing even with something addressable.
		pi.fire("message_end", { message: msg("Shall I <snippet>rebuild</snippet>?") }, ctx);
		pi.press("alt+1", ctx);
		expect(ctx.ui.getEditorText()).toBe("");

		await pi.run("", pick("Alt+digit"));
		expect(notices.at(-1)).toContain("enabled");
		pi.press("alt+1", ctx);
		expect(ctx.ui.getEditorText()).toBe("rebuild");
	});
});
