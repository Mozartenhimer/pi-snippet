/**
 * Extension-level tests for the inference layer (PRD §17).
 *
 * These drive the real handler wiring — `message_end`, the markdown
 * transformer, the click path — against a stand-in pi and a stand-in TUI, so
 * what is tested is the layering itself: when a call is spent, when it is not,
 * what gets underlined, and what a click on an underline actually inserts.
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import piSnippetTui from "../src/extension/pi-snippet-tui.js";

class FakeTui {
	lines: string[] = [];
	written: string[] = [];
	listeners: Array<(data: string) => { consume?: boolean } | undefined> = [];
	hardwareCursorRow = 0;
	cursorScreenRow: number | null = 1;
	renderRequests = 0;

	requestRender(): void {
		this.renderRequests++;
	}
	terminal = {
		columns: 80,
		rows: 24,
		write: (data: string) => {
			this.written.push(data);
			if (data.includes("\x1b[6n") && this.cursorScreenRow !== null) {
				this.send(`\x1b[${this.cursorScreenRow};1R`);
			}
		},
	};
	render(_width: number): string[] {
		return this.lines;
	}
	addInputListener(listener: (data: string) => { consume?: boolean } | undefined): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener);
		};
	}
	draw(lines: string[]): void {
		this.lines = lines;
		this.render(this.terminal.columns);
		this.hardwareCursorRow = Math.max(0, lines.length - 1);
		this.cursorScreenRow = Math.min(lines.length, this.terminal.rows);
	}
	send(data: string): { consume?: boolean } | undefined {
		let result: { consume?: boolean } | undefined;
		for (const listener of this.listeners) result = listener(data) ?? result;
		return result;
	}
	/** A left-button press at 0-based row/col, as SGR mouse reporting sends it. */
	click(row: number, col: number): void {
		this.send(`\x1b[<0;${col + 1};${row + 1}M`);
	}
}

const HAIKU = { id: "claude-haiku-4-5", provider: "anthropic", cost: { input: 1 } };

const ANSWER = '[{"anchor":"do you want to see it?","reply":"Show me the model."}]';

/**
 * These tests exercise the *mouse* delivery path — they drive `ClickableText`
 * directly — so they say so rather than inheriting the default, which is now
 * terminal-resolved links. Written before the extension loads, since that is
 * when the settings file is read.
 */
function writeSettings(click: boolean): void {
	writeFileSync(
		process.env.PI_SNIPPET_SETTINGS!,
		JSON.stringify({
			enabled: true,
			hotkeysEnabled: true,
			clickEnabled: click,
			linkMode: false,
			magicEnabled: true,
			model: null,
		}),
		"utf8",
	);
}

function setup(options: { answer?: string; complete?: any; click?: boolean } = {}) {
	writeSettings(options.click ?? true);
	const handlers = new Map<string, (event: any, ctx: any) => void>();
	let transformer: ((md: string, c: any) => string) | undefined;
	let command: ((args: string, ctx: any) => Promise<void>) | undefined;
	const pi = {
		registerFlag: () => {},
		getFlag: () => undefined,
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerMarkdownTransformer: (t: any) => {
			transformer = t;
		},
		registerShortcut: () => {},
		registerCommand: (_name: string, opts: any) => {
			command = opts.handler;
		},
	};
	piSnippetTui(pi as any);

	const tui = new FakeTui();
	const complete =
		options.complete ??
		vi.fn(async () => ({
			content: [{ type: "text", text: options.answer ?? ANSWER }],
			stopReason: "stop",
			usage: { input: 10, output: 4 },
		}));

	let editorText = "";
	let branch: any[] = [];
	const selections: string[] = [];
	const ctx: any = {
		mode: "tui",
		hasUI: true,
		model: HAIKU,
		modelRegistry: {
			getAvailable: () => [HAIKU],
			hasConfiguredAuth: () => true,
			complete,
		},
		sessionManager: { getBranch: () => branch },
		ui: {
			getEditorText: () => editorText,
			setEditorText: (t: string) => {
				editorText = t;
			},
			notify: () => {},
			setStatus: () => {},
			setFooter: (factory?: any) => {
				if (factory) factory(tui);
			},
			select: async (_title: string, choices: string[]) => {
				const want = selections.shift();
				return choices.find((c) => c.startsWith(want ?? "")) ?? undefined;
			},
		},
	};

	const message = (text: string) => ({
		role: "assistant",
		content: [{ type: "text", text }],
	});

	/** Run a message through the lifecycle and let the inference settle. */
	const say = async (text: string) => {
		const msg = message(text);
		branch = [{ type: "message", message: msg }];
		handlers.get("message_start")!({ message: msg }, ctx);
		handlers.get("message_end")!({ message: msg }, ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		return msg;
	};

	/** Toggle click-to-insert through the real `/snippets` command. */
	const toggleClicks = async () => {
		selections.push("Click to insert:");
		await command!("", ctx);
	};

	return {
		ctx,
		tui,
		complete,
		say,
		toggleClicks,
		render: (md: string) => transformer!(md, { messageType: "assistant", isStreaming: false }),
		editor: () => editorText,
		setBranch: (entries: any[]) => {
			branch = entries;
		},
		handlers,
		selections,
	};
}

describe("pi-snippet-tui: inferring untagged questions", () => {
	it("underlines a question the model never tagged", async () => {
		const h = setup();
		await h.say("I'm done the model, do you want to see it?");
		expect(h.complete).toHaveBeenCalledTimes(1);
		expect(h.render("I'm done the model, do you want to see it?")).toBe(
			"I'm done the model, [do you want to see it?](infer:1)",
		);
	});

	it("spends nothing on a message the model already tagged", async () => {
		const h = setup();
		await h.say("Want me to <snippet>rebuild</snippet>?");
		expect(h.complete).not.toHaveBeenCalled();
	});

	it("spends nothing on a message that asks nothing", async () => {
		const h = setup();
		await h.say("I've pushed the branch and CI is green.");
		expect(h.complete).not.toHaveBeenCalled();
	});

	it("spends nothing while click-to-insert is off, since nothing could reach it", async () => {
		const h = setup({ click: false });
		await h.say("I'm done the model, do you want to see it?");
		expect(h.complete).not.toHaveBeenCalled();
	});

	it("leaves other messages in the transcript untouched", async () => {
		const h = setup();
		await h.say("I'm done the model, do you want to see it?");
		const other = "Something else entirely, do you want to see it?";
		expect(h.render(other)).toBe(other);
	});

	it("clicking an underlined span inserts the inferred reply, not the words on screen", async () => {
		const h = setup();
		const text = "I'm done the model, do you want to see it?";
		await h.say(text);
		h.tui.draw([text]);
		h.tui.click(0, text.indexOf("do you want") + 3);
		expect(h.editor()).toBe("Show me the model.");
	});

	it("a click that lands off the span inserts nothing", async () => {
		const h = setup();
		const text = "I'm done the model, do you want to see it?";
		await h.say(text);
		h.tui.draw([text]);
		h.tui.click(0, 2);
		expect(h.editor()).toBe("");
	});

	it("drops an answer that arrives after the branch has moved on", async () => {
		let release: (value: any) => void = () => {};
		const complete = vi.fn(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const h = setup({ complete });
		const text = "I'm done the model, do you want to see it?";
		await h.say(text);
		// The user moved on before the small model answered.
		h.setBranch([
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
		]);
		release({ content: [{ type: "text", text: ANSWER }], stopReason: "stop" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(h.render(text)).toBe(text);
	});

	it("re-reading the same message costs nothing", async () => {
		const h = setup();
		const text = "I'm done the model, do you want to see it?";
		await h.say(text);
		await h.say(text);
		expect(h.complete).toHaveBeenCalledTimes(1);
	});

	it("an answer the message doesn't support underlines nothing", async () => {
		const h = setup({ answer: '[{"anchor":"a span that is not there","reply":"Sure."}]' });
		const text = "I'm done the model, do you want to see it?";
		await h.say(text);
		expect(h.render(text)).toBe(text);
	});
});
