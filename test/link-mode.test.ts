/**
 * The guards that make click-to-insert safe to default on.
 *
 * Two properties matter, and neither is obvious from reading either delivery
 * path alone:
 *
 * **Link mode never falls back to mouse reporting.** Mouse mode takes the
 * wheel away from the terminal and makes selection need Shift. Nobody opted
 * into that by leaving a default alone, so a terminal that cannot paint a
 * hyperlink gets no clicking rather than a surprise change of input mode.
 *
 * **Link mode paints no URL where the href would be visible.** pi-tui prints
 * the href in parentheses when the terminal has no OSC 8, so a `pisnip://` URL
 * on such a terminal would trail every chip on screen.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import piSnippetTui from "../src/extension/pi-snippet-tui.js";
import { DEFAULT_SETTINGS } from "../src/extension/settings.js";
import { resetOsc8Cache } from "../src/extension/osc8.js";

/** DECSET 1000 — the byte that means "the wheel now belongs to pi". */
const MOUSE_ON = "\x1b[?1000h";

class FakeTui {
	written: string[] = [];
	lines: string[] = [];
	hardwareCursorRow = 0;
	requestRender(): void {}
	terminal = { columns: 80, rows: 24, write: (data: string) => this.written.push(data) };
	render(_width: number): string[] {
		return this.lines;
	}
	addInputListener(): () => void {
		return () => {};
	}
}

const original = { ...process.env };

afterEach(() => {
	process.env = { ...original };
	resetOsc8Cache();
});

function setup(settings: Partial<typeof DEFAULT_SETTINGS>, env: Record<string, string>) {
	writeFileSync(
		process.env.PI_SNIPPET_SETTINGS!,
		JSON.stringify({ ...DEFAULT_SETTINGS, ...settings }),
		"utf8",
	);
	// Every env var detectOsc8() checks, so a test never inherits the host
	// terminal's own identity (this suite failed under real Ghostty, which
	// left GHOSTTY_RESOURCES_DIR set, before this list grew to match).
	for (const key of [
		"TERM",
		"TERM_PROGRAM",
		"TMUX",
		"KITTY_WINDOW_ID",
		"GHOSTTY_RESOURCES_DIR",
		"WEZTERM_PANE",
		"WARP_SESSION_ID",
		"WARP_TERMINAL_SESSION_UUID",
		"ITERM_SESSION_ID",
		"WT_SESSION",
	]) {
		delete process.env[key];
	}
	// Keep `isInstalled()` off the developer's real ~/.local/share.
	process.env.XDG_DATA_HOME ??= mkdtempSync(join(tmpdir(), "pi-snippet-xdg-"));
	Object.assign(process.env, env);
	resetOsc8Cache();

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
	const offered: string[] = [];
	const ctx: any = {
		mode: "tui",
		hasUI: true,
		sessionManager: { getBranch: () => [] },
		ui: {
			getEditorText: () => "",
			setEditorText: () => {},
			notify: () => {},
			setStatus: () => {},
			select: async (_title: string, choices: string[]) => {
				offered.push(...choices);
				return undefined;
			},
			setFooter: (factory?: any) => {
				if (factory) factory(tui);
			},
		},
	};

	const say = (text: string) => {
		const message = { role: "assistant", content: [{ type: "text", text }] };
		handlers.get("message_end")!({ message }, ctx);
		return message;
	};

	return {
		tui,
		say,
		menu: async () => {
			offered.length = 0;
			await command!("", ctx);
			return [...offered];
		},
		render: (md: string) => transformer!(md, { messageType: "assistant", isStreaming: false }),
	};
}

const CHIPPED = "Want me to <snippet>rebuild the solution</snippet>?";

describe("clicking on by default", () => {
	it("engages no mouse mode on a terminal that cannot paint hyperlinks", () => {
		const h = setup({}, { TERM: "xterm-256color" });
		h.say(CHIPPED);
		expect(h.tui.written.join("")).not.toContain(MOUSE_ON);
	});

	it("paints no URL there either, so nothing trails the chip on screen", () => {
		const h = setup({}, { TERM: "xterm-256color" });
		h.say(CHIPPED);
		expect(h.render(CHIPPED)).toBe("Want me to [¹rebuild the solution](chip:1)?");
	});

	it("is not fooled by the host terminal's own identity leaking through", () => {
		// Regression: this suite ran fine in a container and failed under real
		// Ghostty, because GHOSTTY_RESOURCES_DIR survives from the outer shell
		// and setup() wasn't clearing it.
		process.env.GHOSTTY_RESOURCES_DIR = "/snap/ghostty/current/share/ghostty";
		const h = setup({}, { TERM: "xterm-256color" });
		h.say(CHIPPED);
		expect(h.render(CHIPPED)).toBe("Want me to [¹rebuild the solution](chip:1)?");
	});

	it("paints a dispatchable URL where the terminal does render hyperlinks", () => {
		const h = setup({}, { TERM_PROGRAM: "ghostty" });
		h.say(CHIPPED);
		expect(h.render(CHIPPED)).toMatch(/\]\(pisnip:\/\/[0-9a-f]{8}\/[0-9a-f]{8}\/c1\)/);
	});

	// The only route to a working Ctrl+click is this row, so its presence is
	// the feature. Switching the *method* and registering a handler are
	// different acts: with link mode already on by default, offering only the
	// method toggle would leave no way to install at all.
	it("offers registration while link mode is on and the handler is missing", async () => {
		process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "pi-snippet-xdg-"));
		const h = setup({}, { TERM_PROGRAM: "ghostty" });
		const choices = await h.menu();
		expect(choices).toContainEqual(expect.stringContaining("Register click handler"));
		expect(choices).toContainEqual(expect.stringContaining("not registered yet"));
	});

	it("does not offer registration to someone who chose the mouse path", async () => {
		process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "pi-snippet-xdg-"));
		const h = setup({ linkMode: false }, { TERM: "xterm-256color" });
		const choices = await h.menu();
		expect(choices).not.toContainEqual(expect.stringContaining("Register click handler"));
	});

	it("still engages mouse reporting for anyone who chose that path", () => {
		const h = setup({ linkMode: false }, { TERM: "xterm-256color" });
		h.say(CHIPPED);
		expect(h.tui.written.join("")).toContain(MOUSE_ON);
	});

	it("engages no mouse mode in link mode even where hyperlinks do work", () => {
		const h = setup({}, { TERM_PROGRAM: "ghostty" });
		h.say(CHIPPED);
		expect(h.tui.written.join("")).not.toContain(MOUSE_ON);
	});
});
