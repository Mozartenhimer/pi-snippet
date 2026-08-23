import { describe, expect, it } from "vitest";
import piSnippetTui from "../src/extension/pi-snippet-tui.js";

/**
 * A fork/clone/resume rebinds the extension against a fresh `state`, but the
 * transcript it lands on can already end on an assistant message with
 * suggestion chips. Nothing fires `message_end` for history that was already
 * there when the session loaded, so `state.addressable` used to stay empty
 * and the chips rendered but did nothing (Alt+N, click).
 */
function makeFakePi() {
	const handlers = new Map<string, (event: any, ctx: any) => void>();
	const shortcuts = new Map<string, (ctx: any) => void>();
	const pi = {
		registerFlag: () => {},
		getFlag: () => undefined,
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerMarkdownTransformer: () => {},
		registerShortcut: (name: string, opts: any) => shortcuts.set(name, opts.handler),
		registerCommand: () => {},
	};
	return { pi, handlers, shortcuts };
}

function makeCtx(branch: any[], overrides: Partial<any> = {}) {
	let editorText = "";
	return {
		mode: "cli", // skip TUI mouse capture; we only exercise addressing state + hotkeys
		hasUI: true,
		sessionManager: { getBranch: () => branch },
		ui: {
			getEditorText: () => editorText,
			setEditorText: (t: string) => {
				editorText = t;
			},
			notify: () => {},
			setStatus: () => {},
			setFooter: () => {},
		},
		...overrides,
	};
}

describe("pi-snippet-tui: fork/resume rehydration", () => {
	it("restores addressable suggestions from the last assistant message on fork", () => {
		const { pi, handlers, shortcuts } = makeFakePi();
		piSnippetTui(pi);

		const branch = [
			{ type: "message", message: { role: "user", content: "which one?" } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Pick <pi:snippet>the first</pi:snippet>." }],
				},
			},
		];
		const ctx = makeCtx(branch);
		handlers.get("session_start")!({ reason: "fork" }, ctx);

		shortcuts.get("alt+1")!(ctx);
		expect(ctx.ui.getEditorText()).toBe("the first");
	});

	it("restores on resume too", () => {
		const { pi, handlers, shortcuts } = makeFakePi();
		piSnippetTui(pi);

		const branch = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Try <pi:snippet>rebuild</pi:snippet>?" }],
				},
			},
		];
		const ctx = makeCtx(branch);
		handlers.get("session_start")!({ reason: "resume" }, ctx);

		shortcuts.get("alt+1")!(ctx);
		expect(ctx.ui.getEditorText()).toBe("rebuild");
	});

	it("leaves nothing addressable when the branch doesn't end on an assistant message", () => {
		const { pi, handlers, shortcuts } = makeFakePi();
		piSnippetTui(pi);

		const branch = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Try <pi:snippet>rebuild</pi:snippet>?" }],
				},
			},
			{ type: "message", message: { role: "user", content: "ok, done" } },
		];
		const ctx = makeCtx(branch);
		handlers.get("session_start")!({ reason: "fork" }, ctx);

		shortcuts.get("alt+1")!(ctx);
		expect(ctx.ui.getEditorText()).toBe("");
	});

	it("rehydrates on /tree navigation, which never fires session_start", () => {
		const { pi, handlers, shortcuts } = makeFakePi();
		piSnippetTui(pi);

		// Session boots at the tip: a later assistant reply with no suggestions.
		const startupBranch = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Pick <pi:snippet>the first</pi:snippet>." }],
				},
			},
			{ type: "message", message: { role: "user", content: "the first, thanks" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
		];
		const ctx = makeCtx(startupBranch);
		handlers.get("session_start")!({ reason: "startup" }, ctx);
		shortcuts.get("alt+1")!(ctx);
		expect(ctx.ui.getEditorText()).toBe(""); // nothing addressable yet, correctly

		// /tree moves the active leaf back to the earlier assistant message.
		// This does NOT fire session_start, only session_tree.
		ctx.sessionManager.getBranch = () => [startupBranch[0]];
		handlers.get("session_tree")!({}, ctx);

		shortcuts.get("alt+1")!(ctx);
		expect(ctx.ui.getEditorText()).toBe("the first");
	});

	it("does not hydrate on a plain startup with no prior history", () => {
		const { pi, handlers, shortcuts } = makeFakePi();
		piSnippetTui(pi);

		const ctx = makeCtx([]);
		handlers.get("session_start")!({ reason: "startup" }, ctx);

		shortcuts.get("alt+1")!(ctx);
		expect(ctx.ui.getEditorText()).toBe("");
	});
});
