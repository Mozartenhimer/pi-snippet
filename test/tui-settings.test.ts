import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import piSnippetTui from "../src/extension/pi-snippet-tui.js";
import { DEFAULT_SETTINGS, loadSettings } from "../src/extension/settings.js";

/**
 * The `/snippets` toggles are preferences, not session state: a choice made in
 * one session has to still be in force in the next one. Click-to-insert is the
 * one that matters most — it is off by default, so before this it had to be
 * turned back on after every restart.
 *
 * Each test drives one extension instance through `/snippets`, then loads a
 * second instance against the same settings file — a restart, in effect — and
 * reads the toggle back out of the menu it renders.
 */
function makeFakePi(flag?: string) {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const pi = {
		registerFlag: () => {},
		getFlag: (name: string) => (name === flag ? true : undefined),
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerMarkdownTransformer: () => {},
		registerShortcut: () => {},
		registerCommand: (name: string, opts: any) => commands.set(name, opts.handler),
	};
	return { pi, handlers, commands };
}

/** A ctx whose `select` picks the first option starting with `pick`. */
function makeCtx(pick?: string) {
	const notices: string[] = [];
	let menu: string[] = [];
	return {
		notices,
		options: () => menu,
		ctx: {
			mode: "cli",
			hasUI: true,
			sessionManager: { getBranch: () => [] },
			ui: {
				getEditorText: () => "",
				setEditorText: () => {},
				notify: (m: string) => notices.push(m),
				setStatus: () => {},
				setFooter: () => {},
				select: async (_title: string, options: string[]) => {
					menu = options;
					return pick === undefined ? undefined : options.find((o) => o.startsWith(pick));
				},
			},
		},
	};
}

/** What the `/snippets` menu says about each toggle, without changing anything. */
async function readMenu(file: string): Promise<string[]> {
	const { pi, commands } = makeFakePi();
	piSnippetTui(pi);
	const seen = makeCtx(); // no pick: the menu is rendered and dismissed
	await commands.get("snippets")!("", seen.ctx);
	return seen.options();
}

let file: string;
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-snippet-tui-settings-"));
	file = join(dir, "settings.json");
	process.env.PI_SNIPPET_SETTINGS = file;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("pi-snippet-tui: /snippets choices persist", () => {
	it("click-to-insert stays on across a restart", async () => {
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		await commands.get("snippets")!("", makeCtx("Click to insert:").ctx);
		expect(loadSettings(file).clickEnabled).toBe(true);

		expect(await readMenu(file)).toContainEqual(expect.stringContaining("Click to insert: on"));
	});

	it("turning click back off persists too", async () => {
		const first = makeFakePi();
		piSnippetTui(first.pi);
		await first.commands.get("snippets")!("", makeCtx("Click to insert:").ctx);

		const second = makeFakePi();
		piSnippetTui(second.pi);
		await second.commands.get("snippets")!("", makeCtx("Click to insert:").ctx);

		expect(loadSettings(file).clickEnabled).toBe(false);
		expect(await readMenu(file)).toContainEqual(expect.stringContaining("Click to insert: off"));
	});

	it("carries the suggestions and shortcut toggles as well", async () => {
		const off = makeFakePi();
		piSnippetTui(off.pi);
		await off.commands.get("snippets")!("", makeCtx("Suggestions:").ctx);

		const shortcuts = makeFakePi();
		piSnippetTui(shortcuts.pi);
		await shortcuts.commands.get("snippets")!("", makeCtx("Alt+digit").ctx);

		expect(loadSettings(file)).toEqual({
			...DEFAULT_SETTINGS,
			enabled: false,
			hotkeysEnabled: false,
		});
		const menu = await readMenu(file);
		expect(menu).toContainEqual(expect.stringContaining("Suggestions: off"));
		expect(menu).toContainEqual(expect.stringContaining("Alt+digit shortcuts: off"));
	});

	it("says so when the settings file cannot be written", async () => {
		writeFileSync(join(dir, "blocked"), "a file, not a directory", "utf8");
		process.env.PI_SNIPPET_SETTINGS = join(dir, "blocked", "settings.json");
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		const seen = makeCtx("Click to insert:");
		await commands.get("snippets")!("", seen.ctx);
		expect(seen.notices[0]).toContain("this session only");
	});

	it("a --no-suggestions session leaves the stored preference alone", async () => {
		const on = makeFakePi();
		piSnippetTui(on.pi);
		await on.commands.get("snippets")!("", makeCtx("Click to insert:").ctx);

		// Restart with the flag: the extension latches it on `before_agent_start`.
		const flagged = makeFakePi("no-suggestions");
		piSnippetTui(flagged.pi);
		flagged.handlers.get("before_agent_start")!(
			{ systemPrompt: "", systemPromptOptions: {} },
			makeCtx().ctx,
		);
		const seen = makeCtx("Click to insert:");
		await flagged.commands.get("snippets")!("", seen.ctx);
		expect(seen.notices[0]).toContain("--no-suggestions");

		expect(loadSettings(file).clickEnabled).toBe(true);
		expect(await readMenu(file)).toContainEqual(expect.stringContaining("Click to insert: on"));
	});
});

/**
 * The inference layer's two preferences ride the same file (PRD §17.3): the
 * toggle, and the model it was told to use. Picking a small model once and
 * re-picking it every session would be the same friction the toggles fixed.
 */
describe("persisting the inference preferences", () => {
	it("carries the inference toggle across a restart", async () => {
		const first = makeFakePi();
		piSnippetTui(first.pi);
		await first.commands.get("snippets")!("", makeCtx("Infer untagged questions:").ctx);

		expect(loadSettings(file).magicEnabled).toBe(false);
		expect(await readMenu(file)).toContainEqual(
			expect.stringContaining("Infer untagged questions: off"),
		);
	});

	it("carries a model pin across a restart", async () => {
		/** A ctx that can answer model questions, choosing `picks` in order. */
		const modelCtx = (picks: string[]) => {
			const menus: string[][] = [];
			return {
				menus,
				ctx: {
					mode: "cli",
					hasUI: true,
					model: { id: "claude-opus-5", provider: "anthropic" },
					modelRegistry: {
						getAvailable: () => [
							{ id: "claude-haiku-4-5", provider: "anthropic", cost: { input: 1 } },
							{ id: "claude-opus-5", provider: "anthropic", cost: { input: 15 } },
						],
						hasConfiguredAuth: () => true,
						complete: async () => ({ content: [], stopReason: "stop" }),
					},
					sessionManager: { getBranch: () => [] },
					ui: {
						getEditorText: () => "",
						setEditorText: () => {},
						notify: () => {},
						setStatus: () => {},
						setFooter: () => {},
						select: async (_title: string, options: string[]) => {
							menus.push(options);
							const want = picks.shift();
							return want === undefined ? undefined : options.find((o) => o.startsWith(want));
						},
					},
				},
			};
		};

		const first = makeFakePi();
		piSnippetTui(first.pi);
		// Two selects: the menu, then the model picker it opens.
		await first.commands.get("snippets")!(
			"",
			modelCtx(["Inference model", "anthropic/claude-haiku-4-5"]).ctx,
		);
		expect(loadSettings(file).model).toBe("anthropic/claude-haiku-4-5");

		// A restart reads the pin back and names it in the menu.
		const second = makeFakePi();
		piSnippetTui(second.pi);
		const seen = modelCtx([]); // no pick: render the menu and dismiss it
		await second.commands.get("snippets")!("", seen.ctx);
		expect(seen.menus[0]).toContainEqual(
			expect.stringContaining("Infer untagged questions: on via claude-haiku-4-5"),
		);
	});
});

/**
 * `--snippet-click` turns clicking on for one session. It must not reach the
 * settings file: the stored value is what the user chose in `/snippets`, and a
 * flag-started session that toggles anything else would otherwise persist the
 * flag's answer as if it had been chosen.
 */
describe("--snippet-click stays a session override", () => {
	it("turns clicking on without storing it", async () => {
		const { pi, handlers, commands } = makeFakePi("snippet-click");
		piSnippetTui(pi);
		const started = makeCtx();
		handlers.get("session_start")!({ reason: "new" }, started.ctx);

		// On for this session …
		const seen = makeCtx();
		await commands.get("snippets")!("", seen.ctx);
		expect(seen.options()).toContainEqual(expect.stringContaining("Click to insert: on"));

		// … and nothing was written, so a plain restart is still off.
		expect(loadSettings(file).clickEnabled).toBe(false);
		expect(await readMenu(file)).toContainEqual(expect.stringContaining("Click to insert: off"));
	});

	it("does not leak into the file when another toggle is saved", async () => {
		const { pi, handlers, commands } = makeFakePi("snippet-click");
		piSnippetTui(pi);
		handlers.get("session_start")!({ reason: "new" }, makeCtx().ctx);
		await commands.get("snippets")!("", makeCtx("Alt+digit").ctx);

		const saved = loadSettings(file);
		expect(saved.hotkeysEnabled).toBe(false); // the toggle we actually made
		expect(saved.clickEnabled).toBe(false); // the flag, not a choice
	});

	it("an explicit toggle supersedes the flag", async () => {
		const { pi, handlers, commands } = makeFakePi("snippet-click");
		piSnippetTui(pi);
		handlers.get("session_start")!({ reason: "new" }, makeCtx().ctx);
		await commands.get("snippets")!("", makeCtx("Click to insert:").ctx);

		expect(loadSettings(file).clickEnabled).toBe(false);
		const after = makeCtx();
		await commands.get("snippets")!("", after.ctx);
		expect(after.options()).toContainEqual(expect.stringContaining("Click to insert: off"));
	});
});
