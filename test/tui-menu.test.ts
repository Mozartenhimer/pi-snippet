import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piSnippetTui from "../src/extension/pi-snippet-tui.js";
import { loadSettings } from "../src/extension/settings.js";

// The click handler touches the real desktop and socket namespace; the menu
// tests only need its answers to exist. install() never registers anything,
// and probe() reports an opener-less round trip so `installClickHandler`
// completes instead of waiting out its timeout window.
vi.mock("../src/extension/link-install.js", () => ({
	isInstalled: vi.fn(() => isInstalledNow),
	install: vi.fn(() => ({ warnings: [] })),
	uninstall: vi.fn(() => ({ clean: true, removed: ["x"], warnings: [] })),
	probe: vi.fn(async () => ({ opener: undefined, tried: ["test"] })),
}));

let isInstalledNow = false;

/**
 * The TUI menu is one `SettingsList` mounted in `ctx.ui.custom`, driven here
 * with the same raw key sequences a terminal sends. Its cursor persists
 * across changes because the component never unmounts — the property these
 * tests pin down.
 */
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";

function makeFakePi() {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const pi = {
		registerFlag: () => {},
		getFlag: () => undefined,
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerMarkdownTransformer: () => {},
		registerShortcut: () => {},
		registerCommand: (_name: string, opts: any) => commands.set(_name, opts.handler),
	};
	return { pi, handlers, commands };
}

function makeCustomCtx(notices: string[], edits: string[]) {
	const captured: { component?: any } = {};
	const ctx = {
		mode: "tui",
		hasUI: true,
		sessionManager: { getBranch: () => [] },
		modelRegistry: { getAvailable: () => [] },
		ui: {
			getEditorText: () => "",
			setEditorText: (text: string) => edits.push(text),
			notify: (m: string) => notices.push(m),
			setStatus: () => {},
			setFooter: () => {},
			// Never answered: a test that lands here has taken the wrong path.
			select: async () => undefined,
			custom: (factory: any) => {
				const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
				let resolve: (v?: string) => void;
				const promise = new Promise<string | undefined>((r) => (resolve = r));
				captured.component = factory({ requestRender: () => {} }, theme, undefined, resolve);
				return promise;
			},
		},
	};
	return { captured, ctx };
}

let file: string;
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-snippet-tui-menu-"));
	file = join(dir, "settings.json");
	process.env.PI_SNIPPET_SETTINGS = file;
	delete process.env.PI_SNIPPET_MODEL;
	delete process.env.SSH_CONNECTION;
	delete process.env.SSH_TTY;
	isInstalledNow = false;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("pi-snippet-tui: /snippets settings menu (TUI)", () => {
	/** Open the menu and return the mounted component plus the run to settle. */
	async function openMenu() {
		const { pi, handlers, commands } = makeFakePi();
		piSnippetTui(pi);
		const notices: string[] = [];
		const edits: string[] = [];
		const { captured, ctx } = makeCustomCtx(notices, edits);
		const running = commands.get("snippets")!("", ctx);
		return { handlers, running, notices, edits, component: captured.component };
	}

	it("mounts one menu whose title carries the stats and the click status", async () => {
		const { running, notices, component } = await openMenu();
		const text = component.render(100).join("\n");
		expect(text).toContain("Inline suggestions (no assistant messages yet)");
		expect(text).toContain("Ctrl+click:");
		expect(text).toContain("Suggestions");
		expect(text).toContain("Second model style");
		component.handleInput(ESC);
		await running;
		expect(notices).toEqual([]);
	});

	it("cycles Suggestions from the first row and persists the choice", async () => {
		writeFileSync(file, JSON.stringify({ mode: "off" }), "utf8");
		const { running, notices, component } = await openMenu();
		component.handleInput(ENTER);
		expect(notices.join("\n")).toContain("Suggestions: tags only");
		expect(loadSettings(file).mode).toBe("tags");
		// The row updated in place — no reopen, the menu is still mounted.
		expect(component.render(100).join("\n")).toContain("tags only");
		component.handleInput(ESC);
		await running;
	});

	it("cycles through all four modes in place", async () => {
		writeFileSync(file, JSON.stringify({ mode: "off" }), "utf8");
		const { running, notices, component } = await openMenu();
		for (const expected of ["tags only", "tags + second model", "second model only", "off"]) {
			component.handleInput(ENTER);
			expect(notices.at(-1)).toContain(`Suggestions: ${expected}`);
		}
		expect(loadSettings(file).mode).toBe("off");
		component.handleInput(ESC);
		await running;
	});

	it("toggles the Alt+digit shortcuts", async () => {
		const { running, notices, component } = await openMenu();
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		expect(notices.at(-1)).toContain("Suggestion shortcuts disabled");
		expect(loadSettings(file).hotkeysEnabled).toBe(false);
		component.handleInput(ENTER);
		expect(notices.at(-1)).toContain("Suggestion shortcuts enabled");
		component.handleInput(ESC);
		await running;
	});

	it("cycles the second model's reply style", async () => {
		const { running, notices, component } = await openMenu();
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		expect(notices.at(-1)).toContain("Second model style: options list");
		expect(loadSettings(file).inferStyle).toBe("options");
		component.handleInput(ESC);
		await running;
	});

	it("opens the Second model submenu and goes back with Escape, cursor intact", async () => {
		const { running, notices, component } = await openMenu();
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		const submenu = component.render(100).join("\n");
		expect(submenu).toContain("Type a provider/id — opens the composer (tab-completes)");
		expect(submenu).toContain("Reset to the default");
		component.handleInput(ESC);
		// Back on the list, selection restored to the row that opened it.
		const back = component.render(100).join("\n");
		expect(back).toContain("Alt+digit shortcuts");
		expect(back.indexOf("→ ")).toBeLessThan(back.indexOf("Second model"));
		expect(notices).toEqual([]);
		component.handleInput(ESC);
		await running;
	});

	it("resets the second model to the default from the submenu", async () => {
		const { running, notices, component } = await openMenu();
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		expect(notices.join("\n")).toContain("already the default");
		component.handleInput(ESC);
		await running;
	});

	it("hands a typed model pin to the composer and closes the menu", async () => {
		const { running, notices, edits, component } = await openMenu();
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		expect(component.render(100).join("\n")).toContain("Type a provider/id");
		component.handleInput(ENTER);
		await running;
		expect(edits).toEqual(["/snippets model "]);
		expect(notices.join("\n")).toContain("Tab-completes provider/id");
	});

	it("offers the click handler row on local Linux and drives both directions", async () => {
		const { running, notices, component } = await openMenu();
		expect(component.render(100).join("\n")).toContain("Click handler");
		// Register: the mocked install() reports success without touching a desktop.
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		component.handleInput(ENTER);
		expect(component.render(100).join("\n")).toContain("Click handler");
		// The row itself follows the change on the next open.
		isInstalledNow = true;
		component.handleInput(ESC); // back from the submenu
		component.handleInput(ENTER); // reopen it
		expect(component.render(100).join("\n")).toContain("Remove — unregister");
		isInstalledNow = false;
		component.handleInput(ESC);
		component.handleInput(ENTER);
		expect(component.render(100).join("\n")).toContain("Register — one-time desktop setup");
		component.handleInput(ESC); // back from the submenu
		component.handleInput(ESC); // close the menu
		await running;
		expect(notices.join("\n")).toContain("Registered, but no opener completed the round trip");
	});

	it("drops the click handler row over SSH but keeps the status in the title", async () => {
		process.env.SSH_CONNECTION = "10.0.0.1 22 10.0.0.2 22";
		const { running, component } = await openMenu();
		const text = component.render(100).join("\n");
		expect(text).not.toContain("Click handler");
		expect(text).toContain("Ctrl+click:");
		component.handleInput(ESC);
		await running;
	});

	it("keeps the status in the title off Linux, with no click row", async () => {
		const real = process.platform;
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		try {
			const { running, component } = await openMenu();
			const text = component.render(100).join("\n");
			expect(text).toContain("unavailable off Linux");
			expect(text).not.toContain("Click handler");
			component.handleInput(ESC);
			await running;
		} finally {
			Object.defineProperty(process, "platform", { value: real, configurable: true });
		}
	});

	it("falls back to the select menu when ui.custom is unavailable", async () => {
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		const optionsSeen: string[][] = [];
		const notices: string[] = [];
		const ctx = {
			mode: "tui",
			hasUI: true,
			sessionManager: { getBranch: () => [] },
			ui: {
				getEditorText: () => "",
				setEditorText: () => {},
				notify: (m: string) => notices.push(m),
				setStatus: () => {},
				setFooter: () => {},
				// Bounded: undefined once ends the reopen loop (see CLAUDE.md).
				select: async (_title: string, options: string[]) => {
					optionsSeen.push(options);
					return undefined;
				},
			},
		};
		await commands.get("snippets")!("", ctx);
		expect(optionsSeen).toHaveLength(1);
		expect(optionsSeen[0]!.some((o) => o.startsWith("Suggestions:"))).toBe(true);
	});
});
