import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
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
	let transformer: ((markdown: string, ctx: { messageType: string; isStreaming: boolean }) => string) | undefined;
	const pi = {
		registerFlag: () => {},
		getFlag: () => undefined,
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerMarkdownTransformer: (fn: typeof transformer) => {
			transformer = fn;
		},
		registerShortcut: (name: string, opts: any) => shortcuts.set(name, opts.handler),
		registerCommand: (name: string, opts: any) => commands.set(name, opts.handler),
	};
	return { pi, handlers, shortcuts, commands, transformer: () => transformer };
}

function makeCtx(branch: any[] = []) {
	let editorText = "";
	const statuses: Array<[string, string | undefined]> = [];
	return {
		mode: "cli", // skip TUI mouse capture; addressing state and hotkeys are the subject
		hasUI: true,
		sessionManager: { getBranch: () => branch },
		statuses,
		ui: {
			getEditorText: () => editorText,
			setEditorText: (t: string) => {
				editorText = t;
			},
			notify: () => {},
			setStatus: (key: string, text: string | undefined) => {
				statuses.push([key, text]);
			},
			// Real ANSI dim, matching pi's own theme.fg("dim", ...) — so a test
			// asserting the footer line is dimmed exercises the same escape the
			// terminal actually gets, not a stand-in marker.
			theme: { fg: (_color: string, text: string) => `\x1b[2m${text}\x1b[0m` },
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

/**
 * The second model (layer 2): when an assistant message ends, a small model
 * re-emits it with `<snippet>` tags around replies the primary model didn't
 * tag, and its chips light up one at a time as that reply streams in. These
 * tests drive the whole extension — lifecycle handlers, inference engine, and
 * the registered markdown transformer — because the render path is where the
 * layer has actually broken: the anchors are keyed by what the transformer is
 * handed (a trimmed text block, hashed), and any mismatch there leaves them
 * addressable but never painted.
 */
describe("pi-snippet-tui: the second model's chips render as they arrive", () => {
	/** A registry whose one model streams a scripted reply through `streamSimple`. */
	function makeInferRegistry(deltas: Array<string | { gate: Promise<void> }>) {
		const registry = {
			getAvailable: () => [{ provider: "testmock", id: "infer-model", name: "Infer Model" }],
			hasConfiguredAuth: () => true,
			getProvider: (provider: string) =>
				provider === "testmock"
					? {
							// eslint-disable-next-line require-yield
							streamSimple: async function* () {
								for (const delta of deltas) {
									if (typeof delta !== "string") await delta.gate;
									else yield { type: "text_delta", delta };
								}
							},
						}
					: undefined,
		};
		return { registry };
	}

	const MESSAGE = "Want me to fix it now, or <snippet>wait for CI</snippet>? I can also revert the commit.";
	// The second model's reply: tags preserved, two new spans wrapped.
	const REPLY_1 = "Want me to <snippet>fix it now</snippet>, or <snippet>wait for CI</snippet>";
	const REPLY_2 = "? I can also <snippet>revert the commit</snippet>.";

	it("paints inferred chips as the second model streams them, with stable superscripts", async () => {
		let releaseSecondDelta: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseSecondDelta = resolve;
		});
		const { registry } = makeInferRegistry([REPLY_1, { gate }, REPLY_2]);
		const { pi, handlers, shortcuts, transformer } = makeFakePi();
		piSnippetTui(pi);
		const ctx = makeCtx();
		(ctx as any).modelRegistry = registry;
		process.env.PI_SNIPPET_MODEL = "testmock/infer-model";
		try {
			handlers.get("session_start")!({ reason: "new" }, ctx);
			handlers.get("message_start")!({ message: partial("") }, ctx);
			// The primary model streams; its own tag closes and paints as ¹.
			handlers.get("message_update")!(
				{ message: partial("Want me to fix it now, or <snippet>wait for CI</snippet>?") },
				ctx,
			);
			handlers.get("message_end")!({ message: partial(MESSAGE) }, ctx);

			// Normalize the chip URL shape so the assertions hold whether this
			// environment paints inert `chip:N` hrefs or real `pisnip://` ones.
			const render = (text: string) =>
				transformer()!(text, { messageType: "assistant", isStreaming: false }).replace(
					/\(pisnip:\/\/[^)]*\/c(\d+)\)/g,
					"(chip:$1)",
				);

			// First anchor arrives while the second model is still writing. It
			// sits earlier in the text than the tagged chip but numbers after
			// it — the ¹ the user already saw must not move.
			await vi.waitFor(() => {
				expect(render(MESSAGE)).toContain("[\u00b2fix it now](chip:2)");
			});
			expect(render(MESSAGE)).toContain("[\u00b9wait for CI](chip:1)");
			expect(render(MESSAGE)).not.toContain("chip:3");

			// The addressable set matches what is painted.
			shortcuts.get("alt+2")!(ctx);
			expect(ctx.ui.getEditorText()).toBe("fix it now");

			// Second anchor arrives; earlier numbers stay put.
			releaseSecondDelta!();
			await vi.waitFor(() => {
				expect(render(MESSAGE)).toContain("[\u00b3revert the commit](chip:3)");
			});
			expect(render(MESSAGE)).toBe(
				"Want me to [\u00b2fix it now](chip:2), or [\u00b9wait for CI](chip:1)? I can also [\u00b3revert the commit](chip:3).",
			);
			shortcuts.get("alt+1")!(ctx);
			expect(ctx.ui.getEditorText()).toBe("fix it now wait for CI");
		} finally {
			delete process.env.PI_SNIPPET_MODEL;
		}
	});

	it("paints anchors for the trimmed per-block form the transformer is handed", async () => {
		const { registry } = makeInferRegistry([REPLY_1 + REPLY_2]);
		const { pi, handlers, transformer } = makeFakePi();
		piSnippetTui(pi);
		const ctx = makeCtx();
		(ctx as any).modelRegistry = registry;
		process.env.PI_SNIPPET_MODEL = "testmock/infer-model";
		try {
			handlers.get("session_start")!({ reason: "new" }, ctx);
			handlers.get("message_start")!({ message: partial("") }, ctx);
			handlers.get("message_end")!({ message: partial("\n" + MESSAGE + "\n") }, ctx);

			// Normalize the chip URL shape so the assertions hold whether this
			// environment paints inert `chip:N` hrefs or real `pisnip://` ones.
			const render = (text: string) =>
				transformer()!(text, { messageType: "assistant", isStreaming: false }).replace(
					/\(pisnip:\/\/[^)]*\/c(\d+)\)/g,
					"(chip:$1)",
				);
			// pi trims each block before transforming; the anchors must be found
			// under exactly that key, not only under the raw message text.
			await vi.waitFor(() => {
				expect(render(MESSAGE.trim())).toContain("[\u00b2fix it now](chip:2)");
			});
		} finally {
			delete process.env.PI_SNIPPET_MODEL;
		}
	});
});

/**
 * The footer line about the second model: not sent → sent (waiting) → how
 * many new chips it added. Painted through `ctx.ui.setStatus`, so the tests
 * watch the recorded calls — with `mode: "tui"`, since the status is one of
 * the things TUI mode is *for* (in cli/RPC mode the extension stays silent
 * rather than paint into a footer that is not there).
 */
describe("pi-snippet-tui: the footer reports the second model", () => {
	const MESSAGE = "Want me to fix it now, or <snippet>wait for CI</snippet>? I can also revert the commit.";

	function makeTuiCtx() {
		const ctx = makeCtx();
		(ctx as any).mode = "tui";
		return ctx;
	}

	// The dim wrapper (verified separately, below) would break every literal
	// string comparison in this suite if left in; stripped here so the rest of
	// the suite reads the text pi's footer actually renders that line as.
	const statusLine = (ctx: any) =>
		(ctx.statuses as Array<[string, string | undefined]>)
			.filter(([key]) => key === "pi-snippet")
			.map(([, text]) => text?.replace(/\x1b\[\d+m/g, ""));

	/** A registry whose one model streams a scripted reply through `streamSimple`. */
	function makeInferRegistry(deltas: Array<string | { gate: Promise<void> }>) {
		return {
			registry: {
				getAvailable: () => [{ provider: "testmock", id: "infer-model", name: "Infer Model" }],
				hasConfiguredAuth: () => true,
				getProvider: (provider: string) =>
					provider === "testmock"
						? {
								// eslint-disable-next-line require-yield
								streamSimple: async function* () {
									for (const delta of deltas) {
										if (typeof delta !== "string") await delta.gate;
										else yield { type: "text_delta", delta };
									}
								},
							}
						: undefined,
			},
		};
	}

	it("walks not sent → sent (waiting) → live chip counts as the layer runs", async () => {
		let releaseSecondDelta: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseSecondDelta = resolve;
		});
		const { registry } = makeInferRegistry([
			"Want me to <snippet>fix it now</snippet>, or <snippet>wait for CI</snippet>",
			{ gate },
			"? I can also <snippet>revert the commit</snippet>.",
		]);
		const { pi, handlers } = makeFakePi();
		piSnippetTui(pi);
		const ctx = makeTuiCtx();
		(ctx as any).modelRegistry = registry;
		process.env.PI_SNIPPET_MODEL = "testmock/infer-model";
		try {
			handlers.get("session_start")!({ reason: "new" }, ctx);
			expect(statusLine(ctx).at(-1)).toBeUndefined(); // nothing sent anywhere yet

			handlers.get("message_start")!({ message: partial("") }, ctx);
			expect(statusLine(ctx).at(-1)).toBe("snippet: not sent");

			// Still streaming the primary's answer: the layer has not been asked.
			handlers.get("message_update")!(
				{ message: partial("Want me to fix it now, or <snippet>wait for CI</snippet>?") },
				ctx,
			);
			expect(statusLine(ctx).at(-1)).toBe("snippet: not sent");

			handlers.get("message_end")!({ message: partial(MESSAGE) }, ctx);
			expect(statusLine(ctx).at(-1)).toBe("snippet: sent (waiting)");

			// The count is live while the reply streams in.
			await vi.waitFor(() => {
				expect(statusLine(ctx).at(-1)).toBe("snippet: 1 new chip");
			});
			releaseSecondDelta!();
			await vi.waitFor(() => {
				expect(statusLine(ctx).at(-1)).toBe("snippet: 2 new chips");
			});
		} finally {
			delete process.env.PI_SNIPPET_MODEL;
		}
	});

	it("reports zero rather than dangling on waiting when the reply adds nothing", async () => {
		// The reply keeps only the tag the primary already wrote: nothing new.
		const { registry } = makeInferRegistry([MESSAGE]);
		const { pi, handlers } = makeFakePi();
		piSnippetTui(pi);
		const ctx = makeTuiCtx();
		(ctx as any).modelRegistry = registry;
		process.env.PI_SNIPPET_MODEL = "testmock/infer-model";
		try {
			handlers.get("session_start")!({ reason: "new" }, ctx);
			handlers.get("message_start")!({ message: partial("") }, ctx);
			handlers.get("message_end")!({ message: partial(MESSAGE) }, ctx);
			await vi.waitFor(() => {
				expect(statusLine(ctx).at(-1)).toBe("snippet: 0 new chips");
			});
		} finally {
			delete process.env.PI_SNIPPET_MODEL;
		}
	});

	it("reverts to not sent when the layer could not run — no zero report for a failure", async () => {
		// No configured auth for the pinned model: nothing is ever sent, so the
		// footer must not claim a reply arrived ("0 new chips") — that would
		// make an unreachable layer indistinguishable from an empty one.
		const registry = { ...makeInferRegistry([MESSAGE]).registry, hasConfiguredAuth: () => false };
		const { pi, handlers } = makeFakePi();
		piSnippetTui(pi);
		const ctx = makeTuiCtx();
		(ctx as any).modelRegistry = registry;
		process.env.PI_SNIPPET_MODEL = "testmock/infer-model";
		try {
			handlers.get("session_start")!({ reason: "new" }, ctx);
			handlers.get("message_start")!({ message: partial("") }, ctx);
			handlers.get("message_end")!({ message: partial(MESSAGE) }, ctx);
			await vi.waitFor(() => {
				expect(statusLine(ctx).at(-1)).toBe("snippet: not sent");
			});
		} finally {
			delete process.env.PI_SNIPPET_MODEL;
		}
	});

	it("paints the same dim used by the rest of the footer, not plain text", () => {
		const { pi, handlers } = makeFakePi();
		piSnippetTui(pi);
		const ctx = makeTuiCtx();
		handlers.get("session_start")!({ reason: "new" }, ctx);
		handlers.get("message_start")!({ message: partial("") }, ctx);
		const raw = (ctx.statuses as Array<[string, string | undefined]>)
			.filter(([key]) => key === "pi-snippet")
			.at(-1)?.[1];
		expect(raw).toBe("\x1b[2msnippet: not sent\x1b[0m");
	});

	it.each([
		["tags", false],
		["infer", true],
	] as const)("mode %s asks the second model: %s", async (mode, asked) => {
		writeFileSync(process.env.PI_SNIPPET_SETTINGS!, JSON.stringify({ mode }), "utf8");
		let calls = 0;
		const { registry } = makeInferRegistry([MESSAGE]);
		const counting = {
			...registry,
			getProvider: (provider: string) => {
				calls++;
				return registry.getProvider(provider);
			},
		};
		const { pi, handlers } = makeFakePi();
		piSnippetTui(pi);
		const ctx = makeTuiCtx();
		(ctx as any).modelRegistry = counting;
		process.env.PI_SNIPPET_MODEL = "testmock/infer-model";
		try {
			handlers.get("session_start")!({ reason: "new" }, ctx);
			handlers.get("message_start")!({ message: partial("") }, ctx);
			handlers.get("message_end")!({ message: partial(MESSAGE) }, ctx);
			if (asked) {
				await vi.waitFor(() => {
					expect(statusLine(ctx).at(-1)).toBe("snippet: 0 new chips");
				});
			} else {
				// Layer 2 off means no line at all, not "not sent": there is
				// nothing pending for the footer to report on.
				expect(statusLine(ctx).at(-1)).toBeUndefined();
			}
			expect(calls > 0).toBe(asked);
		} finally {
			delete process.env.PI_SNIPPET_MODEL;
		}
	});

	it("keeps a statement at not sent — the gate never asks the second model", () => {
		const { pi, handlers } = makeFakePi();
		piSnippetTui(pi);
		const ctx = makeTuiCtx();
		handlers.get("session_start")!({ reason: "new" }, ctx);
		handlers.get("message_start")!({ message: partial("") }, ctx);
		handlers.get("message_end")!(
			{ message: partial("Build is green. Deployed at noon.") },
			ctx,
		);
		expect(statusLine(ctx).at(-1)).toBe("snippet: not sent");
	});

	it("clears the line when suggestions are toggled off", async () => {
		const { registry } = makeInferRegistry([MESSAGE]);
		const { pi, handlers, commands } = makeFakePi();
		piSnippetTui(pi);
		const ctx = makeTuiCtx();
		(ctx as any).modelRegistry = registry;
		process.env.PI_SNIPPET_MODEL = "testmock/infer-model";
		try {
			handlers.get("session_start")!({ reason: "new" }, ctx);
			handlers.get("message_start")!({ message: partial("") }, ctx);
			handlers.get("message_end")!({ message: partial(MESSAGE) }, ctx);
			await vi.waitFor(() => {
				expect(statusLine(ctx).at(-1)).toBe("snippet: 0 new chips");
			});

			// /snippets → toggle suggestions off: the line has nothing to say.
			await commands.get("snippets")!("", {
				...ctx,
				ui: { ...ctx.ui, select: async (_title: string, options: string[]) => options[0] },
			});
			expect(statusLine(ctx).at(-1)).toBeUndefined();
		} finally {
			delete process.env.PI_SNIPPET_MODEL;
		}
	});
});
