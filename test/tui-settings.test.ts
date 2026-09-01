import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import piSnippetTui from "../src/extension/pi-snippet-tui.js";
import { DEFAULT_SETTINGS, loadSettings } from "../src/extension/settings.js";
import { SNIPPET_TAG } from "../src/shared/suggestions.js";

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

/**
 * A ctx whose `select` picks the first option starting with the next `pick`.
 *
 * A list, not one string: choosing where chips come from opens a second
 * `select` from inside the first one's handler, so a test needs to answer each
 * in turn. `options()` reports the last menu rendered, which is the mode
 * picker once one has been opened.
 */
function makeCtx(...picks: string[]) {
	const notices: string[] = [];
	let menu: string[] = [];
	const pending = [...picks];
	let captured = false;
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
					// Captures the menu shown once every configured pick is spent —
					// the picker being tested, or (with no picks at all) the
					// top-level menu itself. The top-level menu now reopens after a
					// change, so a later call must not overwrite this with itself.
					if (!captured && pending.length === 0) {
						menu = options;
						captured = true;
					}
					const pick = pending.shift();
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
		await first.commands.get("snippets")!("", makeCtx("Suggestions:", "off").ctx);

		expect(loadSettings(file).mode).toBe("off");
		expect(await readMenu(file)).toContainEqual(expect.stringContaining("Suggestions: off"));
	});

	it.each([
		["tags only", "tags"],
		["tags + second model", "both"],
		["second model only", "infer"],
		["off", "off"],
	] as const)("stores %s as mode %s", async (label, mode) => {
		// From a mode nothing else picks, so a stored default cannot pass for a
		// choice that never landed.
		writeFileSync(file, JSON.stringify({ mode: "off" }), "utf8");
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		await commands.get("snippets")!("", makeCtx("Suggestions:", label).ctx);

		expect(loadSettings(file).mode).toBe(mode);
		expect(await readMenu(file)).toContainEqual(expect.stringContaining(`Suggestions: ${label}`));
	});

	it("offers all four modes and marks the one in force", async () => {
		writeFileSync(file, JSON.stringify({ mode: "infer" }), "utf8");
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		const seen = makeCtx("Suggestions:"); // opens the picker, then dismisses it
		await commands.get("snippets")!("", seen.ctx);

		expect(seen.options()).toEqual([
			"off — no chips at all",
			"tags only — chips from the tags the model writes itself",
			"tags + second model — also chips a second model infers",
			"second model only — the primary model is never asked for tags (current)",
		]);
		expect(loadSettings(file).mode).toBe("infer"); // dismissed, so nothing changed
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

	/**
	 * Register and remove are one condition, not two — the menu offers exactly
	 * the one that applies. Both rows were untested while they were written as a
	 * pair of inverted `isInstalled()` checks, which is how they could have
	 * drifted into offering both at once or neither.
	 */
	it.skipIf(process.platform !== "linux").each([
		[true, "Remove click handler", "Register click handler"],
		[false, "Register click handler", "Remove click handler"],
	] as const)("with the handler installed=%s the menu offers %s", async (installed, offered, hidden) => {
		const xdg = mkdtempSync(join(tmpdir(), "pi-snippet-xdg-"));
		const previous = { data: process.env.XDG_DATA_HOME, ssh: process.env.SSH_TTY };
		process.env.XDG_DATA_HOME = join(xdg, "data");
		// Over SSH the menu offers the forward instead of either row, so this
		// has to be a local-looking session whichever machine runs the tests.
		delete process.env.SSH_TTY;
		try {
			if (installed) {
				mkdirSync(join(xdg, "data", "pi-snippet"), { recursive: true });
				mkdirSync(join(xdg, "data", "applications"), { recursive: true });
				writeFileSync(join(xdg, "data", "pi-snippet", "open-handler"), "#!/bin/sh\n", "utf8");
				writeFileSync(
					join(xdg, "data", "applications", "pi-snippet-open.desktop"),
					"[Desktop Entry]\n",
					"utf8",
				);
			}
			const menu = await readMenu(file);
			expect(menu).toContainEqual(expect.stringContaining(offered));
			expect(menu).not.toContainEqual(expect.stringContaining(hidden));
		} finally {
			if (previous.data === undefined) delete process.env.XDG_DATA_HOME;
			else process.env.XDG_DATA_HOME = previous.data;
			if (previous.ssh !== undefined) process.env.SSH_TTY = previous.ssh;
			rmSync(xdg, { recursive: true, force: true });
		}
	});

	it("says so when the settings file cannot be written", async () => {
		writeFileSync(join(dir, "blocked"), "a file, not a directory", "utf8");
		process.env.PI_SNIPPET_SETTINGS = join(dir, "blocked", "settings.json");
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		const seen = makeCtx("Suggestions:", "off");
		await commands.get("snippets")!("", seen.ctx);
		expect(seen.notices[0]).toContain("this session only");
	});

	it("a --no-suggestions session leaves the stored preference alone", async () => {
		// Turn suggestions off and persist it; the session-override test needs a
		// stored choice to stay clear of.
		const first = makeFakePi();
		piSnippetTui(first.pi);
		await first.commands.get("snippets")!("", makeCtx("Suggestions:", "off").ctx);

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

		expect(loadSettings(file).mode).toBe("off");
		expect(await readMenu(file)).toContainEqual(expect.stringContaining("Suggestions: off"));
	});

	/**
	 * The prompt injection *is* layer 1: `infer` mode's whole point is chips
	 * without anything added to the primary model's system prompt, and `off`
	 * adds nothing either. `tags` and `both` both ask for the tags.
	 */
	it.each([
		["both", true],
		["tags", true],
		["infer", false],
		["off", false],
	] as const)("mode %s injects the prompt contract: %s", async (mode, injected) => {
		writeFileSync(file, JSON.stringify({ mode }), "utf8");
		const { pi, handlers } = makeFakePi();
		piSnippetTui(pi);
		const event = { systemPrompt: "base", systemPromptOptions: {} as { appendSystemPrompt?: string } };
		const result = handlers.get("before_agent_start")!(event, makeCtx().ctx);

		expect(result?.systemPrompt?.includes(SNIPPET_TAG) ?? false).toBe(injected);
		expect(event.systemPromptOptions.appendSystemPrompt?.includes(SNIPPET_TAG) ?? false).toBe(injected);
	});

	it("offers no click toggles — clicking is always on, by the terminal", async () => {
		const menu = await readMenu(file);
		expect(menu.join("\n")).not.toMatch(/Click to insert|Click method/);
		expect(menu.join("\n")).not.toMatch(/Infer untagged|Inference model/);
	});
});
