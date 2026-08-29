import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import piSnippetTui from "../src/extension/pi-snippet-tui.js";
import { DEFAULT_SETTINGS, loadSettings } from "../src/extension/settings.js";

/**
 * The `/snippets` toggles are preferences, not session state: a choice made in
 * one session has to still be in force in the next one.
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
	it("turning suggestions off persists across a restart", async () => {
		const first = makeFakePi();
		piSnippetTui(first.pi);
		await first.commands.get("snippets")!("", makeCtx("Suggestions:").ctx);

		expect(loadSettings(file).enabled).toBe(false);
		expect(await readMenu(file)).toContainEqual(expect.stringContaining("Suggestions: off"));
	});

	it("carries the shortcut toggle as well", async () => {
		const shortcuts = makeFakePi();
		piSnippetTui(shortcuts.pi);
		await shortcuts.commands.get("snippets")!("", makeCtx("Alt+digit").ctx);

		expect(loadSettings(file)).toEqual({
			...DEFAULT_SETTINGS,
			hotkeysEnabled: false,
		});
		const menu = await readMenu(file);
		expect(menu).toContainEqual(expect.stringContaining("Alt+digit shortcuts: off"));
	});

	it("says so when the settings file cannot be written", async () => {
		writeFileSync(join(dir, "blocked"), "a file, not a directory", "utf8");
		process.env.PI_SNIPPET_SETTINGS = join(dir, "blocked", "settings.json");
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		const seen = makeCtx("Suggestions:");
		await commands.get("snippets")!("", seen.ctx);
		expect(seen.notices[0]).toContain("this session only");
	});

	it("a --no-suggestions session leaves the stored preference alone", async () => {
		// Turn suggestions off and persist it; the session-override test needs a
		// stored choice to stay clear of.
		const first = makeFakePi();
		piSnippetTui(first.pi);
		await first.commands.get("snippets")!("", makeCtx("Suggestions:").ctx);

		// Restart with the flag: the extension latches it on `before_agent_start`.
		const flagged = makeFakePi("no-suggestions");
		piSnippetTui(flagged.pi);
		flagged.handlers.get("before_agent_start")!(
			{ systemPrompt: "", systemPromptOptions: {} },
			makeCtx().ctx,
		);
		const seen = makeCtx("Suggestions:");
		await flagged.commands.get("snippets")!("", seen.ctx);
		expect(seen.notices[0]).toContain("--no-suggestions");

		expect(loadSettings(file).enabled).toBe(false);
		expect(await readMenu(file)).toContainEqual(expect.stringContaining("Suggestions: off"));
	});

	it("offers no click toggles — clicking is always on, by the terminal", async () => {
		const menu = await readMenu(file);
		expect(menu.join("\n")).not.toMatch(/Click to insert|Click method/);
		expect(menu.join("\n")).not.toMatch(/Infer untagged|Inference model/);
	});
});
