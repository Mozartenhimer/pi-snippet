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
	const menus: string[][] = [];
	// `pick` answers only the first `select` call that matches it; every call
	// after that returns undefined, as if the user dismissed. Without that,
	// the `/snippets` menu reopening after a change (it now loops until
	// dismissed) would see the same prefix match forever and never return.
	let pickUsed = false;
	return {
		notices,
		editorText: () => editorText,
		menu: () => menu,
		menus: () => menus,
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
					menus.push(options);
					if (overrides.pick === undefined || pickUsed) return undefined;
					const match = options.find((o) => o.startsWith(overrides.pick!));
					if (match !== undefined) pickUsed = true;
					return match;
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
	it("suggests both subcommands while nothing has been typed yet", async () => {
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		const items: any[] = await commands.get("snippets").getArgumentCompletions("");
		expect(items).toEqual([
			{ value: "model ", label: "model", description: "Set the second model" },
			{ value: "style ", label: "style", description: "Set the second model's reply style" },
		]);
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

describe("/snippets style completions", () => {
	it("offers both styles on a bare `style ` — only two ever exist, no catalogue to dump", async () => {
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		expect(await commands.get("snippets").getArgumentCompletions("style ")).toEqual([
			{ value: "style reemit", label: "reemit" },
			{ value: "style options", label: "options" },
		]);
	});

	it("filters by the typed prefix", async () => {
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		expect(await commands.get("snippets").getArgumentCompletions("style opt")).toEqual([
			{ value: "style options", label: "options" },
		]);
	});

	it("returns null when nothing matches", async () => {
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		expect(await commands.get("snippets").getArgumentCompletions("style bogus")).toBeNull();
	});
});

describe("/snippets style handler", () => {
	it("applies a valid style and persists it", async () => {
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		const seen = makeCtx();
		await commands.get("snippets").handler("style options", seen.ctx);

		expect(seen.notices[0]).toContain("Second model style: options list");
		expect(loadSettings(file).inferStyle).toBe("options");
	});

	it("rejects an unrecognised style without changing anything", async () => {
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		const seen = makeCtx();
		await commands.get("snippets").handler("style bogus", seen.ctx);

		expect(seen.notices[0]).toContain("not a second-model style");
		expect(loadSettings(file).inferStyle).toBe(DEFAULT_SETTINGS.inferStyle);
	});

	it("stays quiet when the style is the one already stored", async () => {
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		const seen = makeCtx();
		await commands.get("snippets").handler("style reemit", seen.ctx); // already the default
		expect(seen.notices.length).toBe(0);
	});

	it("bare `style`, with nothing after it, is rejected the same as an unknown value", async () => {
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		const seen = makeCtx();
		await commands.get("snippets").handler("style", seen.ctx);

		expect(seen.notices[0]).toContain("not a second-model style");
		expect(loadSettings(file).inferStyle).toBe(DEFAULT_SETTINGS.inferStyle);
	});
});

describe("/snippets menu: Second model style — change", () => {
	it("opens a picker offering both styles, marking the current one", async () => {
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		const seen = makeCtx({ pick: "Second model style:" });
		await commands.get("snippets").handler("", seen.ctx);

		// menus()[0] is the top-level menu, menus()[1] the nested style picker;
		// the top-level menu reopens after it (dismissed there, per `pickUsed`).
		expect(seen.menus()[1]).toEqual([
			"tag re-emit — rewrites the message with more <snippet> tags added (current)",
			"options list — lists bare reply lines; every match in the message lights up",
		]);
	});

	it("switching styles persists and rearms the second model", async () => {
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		const seen = makeCtx();
		let opened = 0;
		await commands.get("snippets").handler("", {
			...seen.ctx,
			ui: {
				...seen.ctx.ui,
				select: async (_t: string, options: string[]) =>
					opened++ === 0
						? options.find((o) => o.startsWith("Second model style:"))
						: options.find((o) => o.startsWith("options list")),
			},
		});

		expect(loadSettings(file).inferStyle).toBe("options");
	});

	it("changes nothing when the style picker is dismissed", async () => {
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		const seen = makeCtx();
		let opened = 0;
		await commands.get("snippets").handler("", {
			...seen.ctx,
			ui: {
				...seen.ctx.ui,
				select: async (_t: string, options: string[]) =>
					opened++ === 0 ? options.find((o) => o.startsWith("Second model style:")) : undefined,
			},
		});

		expect(loadSettings(file).inferStyle).toBe(DEFAULT_SETTINGS.inferStyle);
	});

	it("changes nothing when the style picker answers with something no label matches", async () => {
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		const seen = makeCtx();
		let opened = 0;
		await commands.get("snippets").handler("", {
			...seen.ctx,
			ui: {
				...seen.ctx.ui,
				select: async (_t: string, options: string[]) => {
					const call = opened++;
					if (call === 0) return options.find((o) => o.startsWith("Second model style:"));
					if (call === 1) return "not a style";
					return undefined; // dismiss the reopened top-level menu
				},
			},
		});

		expect(loadSettings(file).inferStyle).toBe(DEFAULT_SETTINGS.inferStyle);
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

	it("opens no menu for a scripted caller, which never came from one", async () => {
		// In the TUI the typed form is where the menu's prefilled
		// `/snippets model ` lands, so submitting it reopens the menu. An RPC or
		// print caller (docs/rpc.md) typed the command outright — there is no
		// menu behind it to come back to, and opening one would hang a caller
		// that has nothing to answer a `select` with.
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		const seen = makeCtx({ mode: "rpc" });
		await commands.get("snippets").handler("model mockllm/mock-large-reasoner", seen.ctx);

		expect(loadSettings(file).inferModel).toBe("mockllm/mock-large-reasoner");
		expect(seen.menus()).toEqual([]);
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
		// The first select picks "Suggestions:"; the second (the mode picker) is
		// answered with something no mode label matches; the third (the
		// reopened top-level menu) is dismissed to end the interaction.
		let opened = 0;
		await commands.get("snippets").handler("", {
			...seen.ctx,
			ui: {
				...seen.ctx.ui,
				select: async (_t: string, options: string[]) => {
					const call = opened++;
					if (call === 0) return options.find((o) => o.startsWith("Suggestions:"));
					if (call === 1) return "not a mode";
					return undefined;
				},
			},
		});
		expect(loadSettings(file).mode).toBe(DEFAULT_SETTINGS.mode);
	});

	it("stays open after applying a change, so more than one setting can be changed in one visit", async () => {
		const { pi, commands } = makeFakePi();
		piSnippetTui(pi);
		const seen = makeCtx();
		// Three visits to `select`, if the menu reopens: the top-level menu, the
		// nested mode picker, then the top-level menu again — dismissed there to
		// end the interaction. Today the handler returns as soon as `pickMode`
		// resolves, so this never sees a third call.
		const calls: string[][] = [];
		await commands.get("snippets").handler("", {
			...seen.ctx,
			ui: {
				...seen.ctx.ui,
				select: async (_t: string, options: string[]) => {
					calls.push(options);
					if (calls.length === 1) return options.find((o) => o.startsWith("Suggestions:"));
					if (calls.length === 2) return options.find((o) => o.startsWith("tags only"));
					return undefined;
				},
			},
		});

		expect(loadSettings(file).mode).toBe("tags");
		expect(calls.length).toBe(3);
		expect(calls[2]?.some((o) => o.startsWith("Suggestions:"))).toBe(true);
	});
});
