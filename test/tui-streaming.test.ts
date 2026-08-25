import { describe, expect, it } from "vitest";
import piSnippetTui from "../src/extension/pi-snippet-tui.js";

/**
 * Suggestions become addressable while the model is still writing.
 *
 * A chip is accepted the moment its closing tag arrives — which is also the
 * moment it is painted — so `Alt+N` and click reach it without waiting for the
 * rest of the answer (or for a tool call that follows it) to finish.
 */
function makeFakePi() {
	const handlers = new Map<string, (event: any, ctx: any) => void>();
	const shortcuts = new Map<string, (ctx: any) => void>();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const pi = {
		registerFlag: () => {},
		getFlag: () => undefined,
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerMarkdownTransformer: () => {},
		registerShortcut: (name: string, opts: any) => shortcuts.set(name, opts.handler),
		registerCommand: (name: string, opts: any) => commands.set(name, opts.handler),
	};
	return { pi, handlers, shortcuts, commands };
}

function makeCtx(branch: any[] = []) {
	let editorText = "";
	return {
		mode: "cli", // skip TUI mouse capture; addressing state and hotkeys are the subject
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
	};
}

/** An assistant message as it looks partway through streaming. */
function partial(text: string) {
	return { role: "assistant", content: [{ type: "text", text }] };
}

describe("pi-snippet-tui: addressing while the model is still writing", () => {
	it("makes a suggestion addressable as soon as its closing tag arrives", () => {
		const { pi, handlers, shortcuts } = makeFakePi();
		piSnippetTui(pi);
		const ctx = makeCtx();
		handlers.get("session_start")!({ reason: "new" }, ctx);
		handlers.get("message_start")!({ message: partial("") }, ctx);

		handlers.get("message_update")!({ message: partial("Want me to <snippet>rebuild") }, ctx);
		shortcuts.get("alt+1")!(ctx);
		expect(ctx.ui.getEditorText()).toBe(""); // still open: nothing to insert

		handlers.get("message_update")!(
			{ message: partial("Want me to <snippet>rebuild</snippet> or") },
			ctx,
		);
		shortcuts.get("alt+1")!(ctx);
		expect(ctx.ui.getEditorText()).toBe("rebuild");
	});

	it("never exposes a suggestion whose closing tag has not arrived", () => {
		const { pi, handlers, shortcuts } = makeFakePi();
		piSnippetTui(pi);
		const ctx = makeCtx();
		handlers.get("message_start")!({ message: partial("") }, ctx);

		// The second construct is still open; only the first is addressable.
		handlers.get("message_update")!(
			{ message: partial("<snippet>rebuild</snippet> or <snippet>run the te") },
			ctx,
		);
		shortcuts.get("alt+2")!(ctx);
		expect(ctx.ui.getEditorText()).toBe("");
		shortcuts.get("alt+1")!(ctx);
		expect(ctx.ui.getEditorText()).toBe("rebuild");
	});

	it("keeps numbering stable as later suggestions stream in", () => {
		const { pi, handlers, shortcuts } = makeFakePi();
		piSnippetTui(pi);
		const ctx = makeCtx();
		handlers.get("message_start")!({ message: partial("") }, ctx);

		handlers.get("message_update")!({ message: partial("<snippet>rebuild</snippet>") }, ctx);
		handlers.get("message_update")!(
			{ message: partial("<snippet>rebuild</snippet> or <snippet>run the tests</snippet>?") },
			ctx,
		);

		shortcuts.get("alt+2")!(ctx);
		shortcuts.get("alt+1")!(ctx);
		expect(ctx.ui.getEditorText()).toBe("run the tests rebuild");
	});

	it("finalizing a message it already streamed changes nothing", () => {
		const { pi, handlers, shortcuts } = makeFakePi();
		piSnippetTui(pi);
		const ctx = makeCtx();
		handlers.get("message_start")!({ message: partial("") }, ctx);
		handlers.get("message_update")!({ message: partial("<snippet>rebuild</snippet> —") }, ctx);
		handlers.get("message_end")!({ message: partial("<snippet>rebuild</snippet> — your call.") }, ctx);

		shortcuts.get("alt+1")!(ctx);
		expect(ctx.ui.getEditorText()).toBe("rebuild");
	});

	it("ignores tags inside a code fence, closing tag or not", () => {
		const { pi, handlers, shortcuts } = makeFakePi();
		piSnippetTui(pi);
		const ctx = makeCtx();
		handlers.get("message_start")!({ message: partial("") }, ctx);
		handlers.get("message_update")!(
			{ message: partial("```html\n<snippet>option A</snippet>\n```\n") },
			ctx,
		);

		shortcuts.get("alt+1")!(ctx);
		expect(ctx.ui.getEditorText()).toBe("");
	});

	it("leaves the previous message's chips live until this one has its own", () => {
		const { pi, handlers, shortcuts } = makeFakePi();
		piSnippetTui(pi);
		const ctx = makeCtx();
		handlers.get("message_end")!({ message: partial("Try <snippet>rebuild</snippet>?") }, ctx);

		// A new assistant message starts and writes for a while without chips.
		handlers.get("message_start")!({ message: partial("") }, ctx);
		handlers.get("message_update")!({ message: partial("Looking into it now") }, ctx);
		shortcuts.get("alt+1")!(ctx);
		expect(ctx.ui.getEditorText()).toBe("rebuild");

		// Its own first chip takes over the numbering.
		handlers.get("message_update")!(
			{ message: partial("Looking into it. <snippet>run the tests</snippet>?") },
			ctx,
		);
		shortcuts.get("alt+1")!(ctx);
		expect(ctx.ui.getEditorText()).toBe("rebuild run the tests");
	});

	it("clears chips when the message finalizes without any", () => {
		const { pi, handlers, shortcuts } = makeFakePi();
		piSnippetTui(pi);
		const ctx = makeCtx();
		handlers.get("message_start")!({ message: partial("") }, ctx);
		handlers.get("message_update")!({ message: partial("Try <snippet>rebuild</snippet>") }, ctx);
		// The stream is cancelled mid-message: what finalizes has no closing tag.
		handlers.get("message_end")!({ message: partial("Try <snippet>rebuild") }, ctx);

		shortcuts.get("alt+1")!(ctx);
		expect(ctx.ui.getEditorText()).toBe("");
	});

	it("stays out of the way while suggestions are switched off", async () => {
		const { pi, handlers, shortcuts, commands } = makeFakePi();
		piSnippetTui(pi);
		const ctx = makeCtx();
		// `/snippets` → toggle suggestions off.
		await commands.get("snippets")!("", {
			...ctx,
			ui: { ...ctx.ui, select: async (_title: string, options: string[]) => options[0] },
		});

		handlers.get("message_start")!({ message: partial("") }, ctx);
		handlers.get("message_update")!({ message: partial("<snippet>rebuild</snippet>") }, ctx);
		shortcuts.get("alt+1")!(ctx);
		expect(ctx.ui.getEditorText()).toBe("");
	});

	it("ignores updates for non-assistant messages", () => {
		const { pi, handlers, shortcuts } = makeFakePi();
		piSnippetTui(pi);
		const ctx = makeCtx();
		handlers.get("message_update")!(
			{ message: { role: "user", content: [{ type: "text", text: "<snippet>nope</snippet>" }] } },
			ctx,
		);
		shortcuts.get("alt+1")!(ctx);
		expect(ctx.ui.getEditorText()).toBe("");
	});
});
