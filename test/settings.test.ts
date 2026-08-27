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
	it("round-trips the three toggles", () => {
		const settings: SnippetSettings = { enabled: false, hotkeysEnabled: false, clickEnabled: true };
		expect(saveSettings(settings, file)).toBe(true);
		expect(loadSettings(file)).toEqual(settings);
	});

	it("creates the directory it writes into", () => {
		const nested = join(dir, "deep", "deeper", "settings.json");
		expect(saveSettings({ ...DEFAULT_SETTINGS, clickEnabled: true }, nested)).toBe(true);
		expect(loadSettings(nested).clickEnabled).toBe(true);
	});

	it("defaults when there is no file at all", () => {
		expect(loadSettings(join(dir, "nothing-here.json"))).toEqual(DEFAULT_SETTINGS);
	});

	it("defaults — rather than throwing — on a corrupt file", () => {
		writeFileSync(file, "{ not json at all", "utf8");
		expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS);
	});

	it("keeps known booleans and defaults the rest", () => {
		writeFileSync(file, JSON.stringify({ clickEnabled: true, hotkeysEnabled: "yes", junk: 1 }), "utf8");
		expect(loadSettings(file)).toEqual({
			enabled: true, // absent
			hotkeysEnabled: true, // present but not a boolean
			clickEnabled: true,
		});
	});

	it("writes only the keys it owns", () => {
		saveSettings({ ...DEFAULT_SETTINGS, clickEnabled: true }, file);
		expect(Object.keys(JSON.parse(readFileSync(file, "utf8"))).sort()).toEqual([
			"clickEnabled",
			"enabled",
			"hotkeysEnabled",
		]);
	});

	it("reports failure instead of throwing when the path is unwritable", () => {
		writeFileSync(join(dir, "blocked"), "not a directory", "utf8");
		expect(saveSettings(DEFAULT_SETTINGS, join(dir, "blocked", "settings.json"))).toBe(false);
	});

	it("leaves the previous settings in place when a write fails", () => {
		saveSettings({ ...DEFAULT_SETTINGS, clickEnabled: true }, file);
		// A directory where the temp file wants to go: the rename never happens.
		expect(saveSettings(DEFAULT_SETTINGS, join(file, "nope"))).toBe(false);
		expect(loadSettings(file).clickEnabled).toBe(true);
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
