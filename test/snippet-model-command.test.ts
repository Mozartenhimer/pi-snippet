import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import piSnippetTui from "../src/extension/pi-snippet-tui.js";
import { DEFAULT_SETTINGS, loadSettings } from "../src/extension/settings.js";

/**
 * `/snippets model` exists because `ui.input()` (the old picker's dialog) has
 * no autocomplete in pi's `ExtensionUIContext` — only a slash command's own
 * `getArgumentCompletions` gets pi's tab-completing dropdown, the one
 * `/model` uses. It used to be its own top-level `/snippet-model` command;
 * folded into `/snippets` as a subcommand because two commands for one
 * feature was the annoyance. These tests drive it the same way pi's own
 * autocomplete engine would: ask for completions, then call the handler with
 * whatever text the user (or a Tab-completion) left in the editor.
 */

const SMALL = { id: "mock-small", provider: "mockllm" };
const MEDIUM = { id: "mock-medium", provider: "mockllm" };
const LARGE = { id: "mock-large-reasoner", provider: "mockllm" };

function makeFakePi() {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const commands = new Map<string, any>();
	const pi = {
		registerFlag: () => {},
		getFlag: () => undefined,
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerMarkdownTransformer: () => {},
		registerShortcut: () => {},
		registerCommand: (name: string, opts: any) => commands.set(name, opts),
	};
	return { pi, handlers, commands };
}

function makeCtx(overrides: { mode?: string; pick?: string; input?: string } = {}) {
	const notices: string[] = [];
	let editorText = "";
	let menu: string[] = [];
	return {
		notices,
		editorText: () => editorText,
		menu: () => menu,
		ctx: {
			mode: overrides.mode ?? "tui",
			hasUI: true,
			sessionManager: { getBranch: () => [] },
			modelRegistry: { getAvailable: () => [SMALL, MEDIUM, LARGE] },
			ui: {
				getEditorText: () => editorText,
				setEditorText: (t: string) => {
					editorText = t;
				},
				notify: (m: string) => notices.push(m),
				setStatus: () => {},
				setFooter: () => {},
				select: async (_title: string, options: string[]) => {
					menu = options;
					return overrides.pick === undefined ? undefined : options.find((o) => o.startsWith(overrides.pick!));
				},
				input: async () => overrides.input,
			},
		},
	};
}

let file: string;
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-snippet-model-cmd-"));
	file = join(dir, "settings.json");
	process.env.PI_SNIPPET_SETTINGS = file;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("/snippets model completions", () => {
	it("suggests the `model` subcommand itself while nothing has been typed yet", async () => {
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		const items: any[] = await commands.get("snippets").getArgumentCompletions("");
		expect(items).toEqual([{ value: "model ", label: "model", description: "Set the second model" }]);
	});

	it("filters the registry with pi's own fuzzy matcher, best match first", async () => {
		const { pi, handlers, commands } = makeFakePi();
		piSnippetTui(pi);
		handlers.get("session_start")!({}, makeCtx().ctx); // populates lastCtx.modelRegistry

		const items = await commands.get("snippets").getArgumentCompletions("model large");
		expect(items).toEqual([
			{ value: "model mockllm/mock-large-reasoner", label: "mock-large-reasoner", description: "mockllm" },
		]);
	});

	it("matches on provider too, not just id, and ranks the tightest match first", async () => {
		const { pi, handlers, commands } = makeFakePi();
		piSnippetTui(pi);
		handlers.get("session_start")!({}, makeCtx().ctx);

		const items: any[] = await commands.get("snippets").getArgumentCompletions("model mockllm/small");
		expect(items[0]?.value).toBe("model mockllm/mock-small");
	});

	it("returns null before any session has supplied a registry", async () => {
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		expect(await commands.get("snippets").getArgumentCompletions("model anything")).toBeNull();
	});

	it("returns null rather than an empty dropdown when nothing matches", async () => {
		const { pi, handlers, commands } = makeFakePi();
		piSnippetTui(pi);
		handlers.get("session_start")!({}, makeCtx().ctx);
		expect(await commands.get("snippets").getArgumentCompletions("model nonexistent-model-xyz")).toBeNull();
	});

	it("offers nothing for a subcommand that isn't model", async () => {
		const { pi, handlers, commands } = makeFakePi();
		piSnippetTui(pi);
		handlers.get("session_start")!({}, makeCtx().ctx);
		expect(await commands.get("snippets").getArgumentCompletions("bogus")).toBeNull();
		expect(await commands.get("snippets").getArgumentCompletions("bogus mockllm/small")).toBeNull();
	});

	it("stays quiet on a bare `model ` with nothing typed yet, rather than dumping the whole catalogue", async () => {
		const { pi, handlers, commands } = makeFakePi();
		piSnippetTui(pi);
		handlers.get("session_start")!({}, makeCtx().ctx);
		expect(await commands.get("snippets").getArgumentCompletions("model ")).toBeNull();
	});
});

describe("/snippets model handler", () => {
	it("applies a typed pin, validates it against the registry, and persists it", async () => {
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		const seen = makeCtx();
		await commands.get("snippets").handler("model mockllm/mock-large-reasoner", seen.ctx);

		expect(seen.notices[0]).toContain("Second model set to mockllm/mock-large-reasoner");
		expect(loadSettings(file).inferModel).toBe("mockllm/mock-large-reasoner");
	});

	it("rejects an unknown pin without changing anything", async () => {
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		const seen = makeCtx();
		await commands.get("snippets").handler("model mockllm/does-not-exist", seen.ctx);

		expect(seen.notices[0]).toContain("nothing changed");
		expect(loadSettings(file).inferModel).toBeUndefined();
	});

	it("bare `model`, with nothing after it, resets to the default", async () => {
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		const seen = makeCtx();
		await commands.get("snippets").handler("model mockllm/mock-large-reasoner", seen.ctx);
		await commands.get("snippets").handler("model", seen.ctx);

		expect(seen.notices.at(-1)).toContain("reset to the default");
		expect(loadSettings(file).inferModel).toBeUndefined();
	});

	it("bare `/snippets`, with no args at all, opens the toggle menu rather than touching the model", async () => {
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		const seen = makeCtx({ pick: undefined });
		await commands.get("snippets").handler("", seen.ctx);

		expect(seen.menu().some((o: string) => o.startsWith("Suggestions:"))).toBe(true);
		expect(loadSettings(file).inferModel).toBeUndefined();
	});
});

describe("/snippets menu: Second model — change", () => {
	it("in the TUI, prefills /snippets model instead of opening a blocking dialog", async () => {
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		const seen = makeCtx({ mode: "tui", pick: "Second model:" });
		await commands.get("snippets").handler("", seen.ctx);

		expect(seen.editorText()).toBe("/snippets model ");
		expect(seen.notices.some((n) => n.includes("Tab-completes"))).toBe(true);
	});

	it("elsewhere (RPC, print) falls back to the typed prompt", async () => {
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		const seen = makeCtx({ mode: "cli", pick: "Second model:", input: "mockllm/mock-medium" });
		await commands.get("snippets").handler("", seen.ctx);

		expect(loadSettings(file).inferModel).toBe("mockllm/mock-medium");
		expect(seen.editorText()).toBe(""); // no composer to prefill outside the TUI
	});

	it("stays blank even when a pin is already stored — you're about to replace it, not read it back", async () => {
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		const seen = makeCtx({ mode: "tui" });
		await commands.get("snippets").handler("model mockllm/mock-large-reasoner", seen.ctx);

		const seenAgain = makeCtx({ mode: "tui", pick: "Second model:" });
		await commands.get("snippets").handler("", seenAgain.ctx);

		expect(seenAgain.editorText()).toBe("/snippets model ");
	});
});

/**
 * The answers this command gives when nothing changes. Each of these returns
 * quietly or notifies and stops, so MC/DC is what showed they had never run.
 */
describe("/snippets model — the paths that change nothing", () => {
	it("says the default is already in force when there is nothing to reset", async () => {
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		const seen = makeCtx();
		await commands.get("snippets").handler("model", seen.ctx);
		expect(seen.notices.at(-1)).toContain("already the default");
		expect(loadSettings(file).inferModel).toBeUndefined();
	});

	it("stays quiet when the pin is the one already stored", async () => {
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		const seen = makeCtx();
		await commands.get("snippets").handler("model mockllm/mock-medium", seen.ctx);
		const said = seen.notices.length;
		await commands.get("snippets").handler("model mockllm/mock-medium", seen.ctx);
		expect(seen.notices.length).toBe(said);
	});

	it("accepts a pin it cannot validate when the registry lists nothing", async () => {
		// An empty catalogue is not evidence against a pin — refusing here
		// would make the setting unusable before a provider has loaded.
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		const seen = makeCtx();
		const ctx = { ...seen.ctx, modelRegistry: { getAvailable: () => [] } };
		await commands.get("snippets").handler("model someone/unlisted", ctx);
		expect(loadSettings(file).inferModel).toBe("someone/unlisted");
	});

	it("changes nothing when the model prompt is cancelled", async () => {
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		const seen = makeCtx({ mode: "cli", pick: "Second model:", input: undefined });
		await commands.get("snippets").handler("", seen.ctx);
		expect(loadSettings(file).inferModel).toBeUndefined();
	});

	it("names the environment override in the prompt it opens", async () => {
		process.env.PI_SNIPPET_MODEL = "mockllm/mock-large-reasoner";
		try {
			const { pi, commands } = makeFakePi();
			piSnippetTui(pi);
			let asked = "";
			const seen = makeCtx({ mode: "cli", pick: "Second model:" });
			await commands.get("snippets").handler("", {
				...seen.ctx,
				ui: {
					...seen.ctx.ui,
					input: async (title: string) => {
						asked = title;
						return undefined;
					},
				},
			});
			expect(asked).toContain("PI_SNIPPET_MODEL override");
		} finally {
			delete process.env.PI_SNIPPET_MODEL;
		}
	});

	it("offers no completions for a prefix `model` cannot grow into", async () => {
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		expect(commands.get("snippets").getArgumentCompletions("mo")).toEqual([
			{ value: "model ", label: "model", description: "Set the second model" },
		]);
		expect(commands.get("snippets").getArgumentCompletions("zz")).toBeNull();
	});
});

describe("/snippets — where chips come from", () => {
	it("changes nothing when the mode picker is dismissed", async () => {
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		const seen = makeCtx({ pick: "Suggestions:" });
		// The first select picks "Suggestions:"; the second (the mode picker)
		// is answered with something no mode label matches.
		let opened = 0;
		await commands.get("snippets").handler("", {
			...seen.ctx,
			ui: {
				...seen.ctx.ui,
				select: async (_t: string, options: string[]) =>
					opened++ === 0 ? options.find((o) => o.startsWith("Suggestions:")) : "not a mode",
			},
		});
		expect(loadSettings(file).mode).toBe(DEFAULT_SETTINGS.mode);
	});
});
