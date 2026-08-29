import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_SETTINGS,
	loadSettings,
	saveSettings,
	settingsPath,
	type SnippetSettings,
} from "../src/extension/settings.js";

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-snippet-settings-test-"));
	file = join(dir, "settings.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("settings file", () => {
	it("round-trips every preference", () => {
		const settings: SnippetSettings = {
			mode: "infer",
			hotkeysEnabled: false,
			inferModel: "openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
		};
		expect(saveSettings(settings, file)).toBe(true);
		expect(loadSettings(file)).toEqual(settings);
	});

	it("keeps an inferModel only when it is a non-empty string", () => {
		writeFileSync(file, JSON.stringify({ inferModel: "  " }), "utf8");
		expect(loadSettings(file).inferModel).toBeUndefined();
		writeFileSync(file, JSON.stringify({ inferModel: 42 }), "utf8");
		expect(loadSettings(file).inferModel).toBeUndefined();
	});

	it("creates the directory it writes into", () => {
		const nested = join(dir, "deep", "deeper", "settings.json");
		expect(saveSettings({ ...DEFAULT_SETTINGS, mode: "off" }, nested)).toBe(true);
		expect(loadSettings(nested).mode).toBe("off");
	});

	it("defaults when there is no file at all", () => {
		expect(loadSettings(join(dir, "nothing-here.json"))).toEqual(DEFAULT_SETTINGS);
	});

	it("defaults — rather than throwing — on a corrupt file", () => {
		writeFileSync(file, "{ not json at all", "utf8");
		expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS);
	});

	it("keeps what it recognises and defaults the rest", () => {
		writeFileSync(file, JSON.stringify({ mode: "tags", hotkeysEnabled: "yes", junk: 1 }), "utf8");
		expect(loadSettings(file)).toEqual({
			...DEFAULT_SETTINGS,
			mode: "tags",
			hotkeysEnabled: true, // present but not a boolean
		});
	});

	it("defaults a mode it does not recognise", () => {
		writeFileSync(file, JSON.stringify({ mode: "sideways" }), "utf8");
		expect(loadSettings(file).mode).toBe(DEFAULT_SETTINGS.mode);
	});

	it("reads a boolean `enabled: false` from before the modes as `off`", () => {
		// The one legacy key worth carrying across: silently turning suggestions
		// back on for someone who had switched them off is the wrong default.
		writeFileSync(file, JSON.stringify({ enabled: false, hotkeysEnabled: false }), "utf8");
		expect(loadSettings(file)).toEqual({ ...DEFAULT_SETTINGS, mode: "off", hotkeysEnabled: false });
	});

	it("lets a real mode win over a stale `enabled`", () => {
		writeFileSync(file, JSON.stringify({ enabled: false, mode: "tags" }), "utf8");
		expect(loadSettings(file).mode).toBe("tags");
	});

	it("ignores a legacy `enabled: true`, which says nothing about which layers run", () => {
		writeFileSync(file, JSON.stringify({ enabled: true }), "utf8");
		expect(loadSettings(file).mode).toBe(DEFAULT_SETTINGS.mode);
	});

	it("ignores keys from settings written by older versions", () => {
		// clickEnabled/linkMode/magicEnabled/model used to live here; their
		// features are gone, and a stale file must not break the read. `model`
		// in particular is the removed 2026 layer's key — the live one is
		// `inferModel`, so a stale pin cannot hijack the new default.
		writeFileSync(
			file,
			JSON.stringify({ clickEnabled: false, linkMode: false, magicEnabled: true, model: "x/y" }),
			"utf8",
		);
		expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS);
	});

	it("writes only the keys it owns", () => {
		saveSettings(DEFAULT_SETTINGS, file);
		expect(Object.keys(JSON.parse(readFileSync(file, "utf8"))).sort()).toEqual([
			"hotkeysEnabled",
			"mode",
		]);
	});

	it("reports failure instead of throwing when the path is unwritable", () => {
		writeFileSync(join(dir, "blocked"), "not a directory", "utf8");
		expect(saveSettings(DEFAULT_SETTINGS, join(dir, "blocked", "settings.json"))).toBe(false);
	});

	it("leaves the previous settings in place when a write fails", () => {
		saveSettings({ ...DEFAULT_SETTINGS, mode: "off" }, file);
		// A directory where the temp file wants to go: the rename never happens.
		expect(saveSettings(DEFAULT_SETTINGS, join(file, "nope"))).toBe(false);
		expect(loadSettings(file).mode).toBe("off");
	});
});

/**
 * The file sits in pi's agent directory, next to pi's own `settings.json` and
 * the `presets.json` its shipped example extension writes — pi offers
 * extensions no settings API, so this is the convention to follow. Resolution
 * mirrors pi's `getAgentDir()`.
 */
describe("settings path", () => {
	it("honours an explicit override", () => {
		expect(settingsPath({ PI_SNIPPET_SETTINGS: "/tmp/x.json" } as NodeJS.ProcessEnv)).toBe(
			"/tmp/x.json",
		);
	});

	it("defaults to pi's agent directory", () => {
		expect(settingsPath({} as NodeJS.ProcessEnv)).toBe(join(homedir(), ".pi", "agent", "pi-snippet.json"));
	});

	it("follows PI_CODING_AGENT_DIR, as pi does", () => {
		expect(settingsPath({ PI_CODING_AGENT_DIR: "/agents/pi" } as NodeJS.ProcessEnv)).toBe(
			"/agents/pi/pi-snippet.json",
		);
	});

	it("expands a leading tilde in PI_CODING_AGENT_DIR, as pi does", () => {
		expect(settingsPath({ PI_CODING_AGENT_DIR: "~/alt-pi" } as NodeJS.ProcessEnv)).toBe(
			join(homedir(), "alt-pi", "pi-snippet.json"),
		);
		expect(settingsPath({ PI_CODING_AGENT_DIR: "~" } as NodeJS.ProcessEnv)).toBe(
			join(homedir(), "pi-snippet.json"),
		);
	});

	it("ignores empty environment values", () => {
		const path = settingsPath({
			PI_SNIPPET_SETTINGS: "",
			PI_CODING_AGENT_DIR: "",
		} as NodeJS.ProcessEnv);
		expect(path).toBe(join(homedir(), ".pi", "agent", "pi-snippet.json"));
	});
});
