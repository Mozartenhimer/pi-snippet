/**
 * The second model's answers arriving back into a live session.
 *
 * `test/infer-engine.test.ts` drives the engine directly; this drives the
 * extension around it — the part that decides whether a reply is still worth
 * painting by the time it lands. Every one of those decisions is a race
 * (a newer message, a mode turned off mid-flight, a cache replay), so none of
 * them had ever been taken: the suite's other files answer instantly and in
 * order.
 */
import { describe, expect, it } from "vitest";
import piSnippetTui from "../src/extension/pi-snippet-tui.js";
import { MAX_SUGGESTIONS_PER_MESSAGE } from "../src/shared/suggestions.js";
import type { PiModel } from "../src/extension/infer.js";

const MODEL: PiModel = { id: "qwen/qwen3.7-flash", provider: "openrouter" };

type Handler = (event: any, ctx: any) => any;

function makeFakePi() {
	const handlers = new Map<string, Handler>();
	const shortcuts = new Map<string, (ctx: any) => void>();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const pi = {
		registerFlag: () => {},
		getFlag: () => undefined,
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerMarkdownTransformer: () => {},
		registerShortcut: (key: string, opts: any) => shortcuts.set(key, opts.handler),
		registerCommand: (name: string, opts: any) => commands.set(name, opts.handler),
	};
	piSnippetTui(pi);
	return {
		fire: (name: string, event: any, ctx: any) => handlers.get(name)!(event, ctx),
		press: (key: string, ctx: any) => shortcuts.get(key)!(ctx),
		run: (args: string, ctx: any) => commands.get("snippets")!(args, ctx),
	};
}

/**
 * A second model that streams what it is told to, one chunk at a time, and
 * (optionally) waits to be let through between them.
 */
function makeRegistry(chunks: string[], gate?: { open: Promise<void> }) {
	return {
		getAvailable: () => [MODEL],
		hasConfiguredAuth: () => true,
		getApiKeyAndHeaders: () => ({ apiKey: "test-key" }),
		getProvider: (provider: string) =>
			provider === "openrouter"
				? {
						async *streamSimple() {
							if (gate) await gate.open;
							for (const delta of chunks) yield { type: "text_delta", delta };
						},
					}
				: undefined,
	};
}

/** A promise the test opens by hand. */
function makeGate() {
	let release!: () => void;
	const open = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { open, release };
}

function makeCtx(registry: unknown, choose: (options: string[]) => string | undefined = () => undefined) {
	const statuses: string[] = [];
	let text = "";
	// Capped at two real answers — enough for a top-level pick plus the
	// nested picker it opens. The `/snippets` menu reopens after a change,
	// and `choose` here matches by content rather than call count, so
	// without the cap a matcher that (deliberately) matches the top-level
	// "Suggestions:" row again would reopen and re-pick forever.
	let calls = 0;
	return {
		statuses,
		editorText: () => text,
		ctx: {
			mode: "tui",
			hasUI: true,
			modelRegistry: registry,
			sessionManager: { getBranch: () => [], getSessionId: () => "infer-session" },
			ui: {
				getEditorText: () => text,
				setEditorText: (next: string) => {
					text = next;
				},
				notify: () => {},
				// pi's footer takes a key and the line; the line is what is asserted on.
				setStatus: (_key: string, line?: string) => statuses.push(line ?? ""),
				setFooter: () => {},
				select: async (_title: string, options: string[]) => (calls++ < 2 ? choose(options) : undefined),
			},
		},
	};
}

const msg = (...texts: string[]) => ({
	role: "assistant",
	content: texts.map((text) => ({ type: "text", text })),
});

/** Let every already-queued microtask and timer turn run. */
const settle = () => new Promise((r) => setTimeout(r, 10));

const ASKED = "Shall I rebuild or wait?";
/** The same message back with a tag around one of the two choices. */
const ANSWERED = "Shall I <snippet>rebuild</snippet> or wait?";

describe("an answer that arrives while the session has moved on", () => {
	it("does not paint or report a reply for a message that is no longer the latest", async () => {
		const gate = makeGate();
		const pi = makeFakePi();
		const { ctx, statuses } = makeCtx(makeRegistry([ANSWERED], gate));
		pi.fire("session_start", { reason: "startup" }, ctx);
		pi.fire("message_start", { message: { role: "assistant" } }, ctx);
		pi.fire("message_end", { message: msg(ASKED) }, ctx);
		expect(statuses.at(-1)).toContain("sent (waiting)");

		// A new turn begins before the second model gets a word in.
		pi.fire("message_start", { message: { role: "assistant" } }, ctx);
		const waitingLine = statuses.at(-1);
		gate.release();
		await settle();

		// The anchor was dropped and the footer still belongs to the new turn.
		expect(statuses.at(-1)).toBe(waitingLine);
		pi.press("alt+1", ctx);
		expect(ctx.ui.getEditorText()).toBe("");
	});

	it("replays a cached answer without counting its anchors twice", async () => {
		const pi = makeFakePi();
		const { ctx } = makeCtx(makeRegistry([ANSWERED]));
		pi.fire("session_start", { reason: "startup" }, ctx);
		pi.fire("message_start", { message: { role: "assistant" } }, ctx);
		pi.fire("message_end", { message: msg(ASKED) }, ctx);
		await settle();
		pi.press("alt+1", ctx);
		expect(ctx.ui.getEditorText()).toBe("rebuild");

		// The same message again: the engine answers from its cache and replays
		// the anchors, every one of which is already known.
		pi.fire("message_end", { message: msg(ASKED) }, ctx);
		await settle();
		pi.press("alt+1", ctx);
		expect(ctx.ui.getEditorText()).toBe("rebuild rebuild"); // two presses, one chip
	});

	it("drops an answer for a session whose chips were switched off mid-flight", async () => {
		const gate = makeGate();
		const pi = makeFakePi();
		const { ctx } = makeCtx(makeRegistry([ANSWERED], gate), (options) =>
			options.find((o) => o.startsWith("off") || o.startsWith("Suggestions:")),
		);
		pi.fire("session_start", { reason: "startup" }, ctx);
		pi.fire("message_start", { message: { role: "assistant" } }, ctx);
		pi.fire("message_end", { message: msg(ASKED) }, ctx);

		// `/snippets` → Suggestions → off, while the request is still out.
		await pi.run("", ctx);
		gate.release();
		await settle();

		pi.press("alt+1", ctx);
		expect(ctx.ui.getEditorText()).toBe("");
	});
});

describe("the runaway cap applies across both layers", () => {
	it("refuses an inferred anchor once the message's own tags fill the numbering", async () => {
		// One under the cap in layer-1 tags, so the second model's anchor is the
		// one that would cross it.
		const tags = Array.from(
			{ length: MAX_SUGGESTIONS_PER_MESSAGE },
			(_, i) => `<snippet>tag ${i + 1}</snippet>`,
		).join(" ");
		const asked = `${tags} — or shall I wait?`;
		const answered = `${tags} — or shall I <snippet>wait</snippet>?`;
		const pi = makeFakePi();
		const { ctx } = makeCtx(makeRegistry([answered]));
		pi.fire("session_start", { reason: "startup" }, ctx);
		pi.fire("message_start", { message: { role: "assistant" } }, ctx);
		pi.fire("message_end", { message: msg(asked) }, ctx);
		await settle();

		// The cap is what the keyboard can reach, so nothing past it is
		// addressable — and the anchor never joined the set.
		pi.press("alt+9", ctx);
		pi.press("alt+9", ctx);
		await new Promise((r) => setTimeout(r, 600)); // let the two-digit chord settle
		expect(ctx.ui.getEditorText()).toBe("tag 99");
	});
});

describe("a message with an empty text block", () => {
	it("indexes and paints the blocks that have text, and skips the one that has none", async () => {
		const pi = makeFakePi();
		const { ctx } = makeCtx(makeRegistry([ANSWERED]));
		pi.fire("session_start", { reason: "startup" }, ctx);
		pi.fire("message_start", { message: { role: "assistant" } }, ctx);
		pi.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "" }, { type: "text", text: ASKED }] } }, ctx);
		await settle();
		pi.press("alt+1", ctx);
		expect(ctx.ui.getEditorText()).toBe("rebuild");
	});
});
