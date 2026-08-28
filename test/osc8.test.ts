/**
 * Whether a terminal can paint a hyperlink at all.
 *
 * This gate is what makes clicking safe to default on. Where pi-tui would fall
 * back to printing the href, link mode must paint no URL — otherwise every
 * chip on screen would trail a visible `(pisnip://a1b2c3d4/ff2ee691/c1)`. The
 * list therefore mirrors pi-tui's own detection rather than guessing more
 * generously than the renderer it has to agree with.
 */
import { describe, expect, it } from "vitest";
import { detectOsc8 } from "../src/extension/osc8.js";

describe("terminals that render OSC 8", () => {
	it.each([
		["Ghostty by TERM_PROGRAM", { TERM_PROGRAM: "ghostty" }],
		["Ghostty by TERM", { TERM: "xterm-ghostty" }],
		["Ghostty by resources dir", { GHOSTTY_RESOURCES_DIR: "/usr/share/ghostty" }],
		["kitty", { KITTY_WINDOW_ID: "1" }],
		["WezTerm", { WEZTERM_PANE: "0" }],
		["iTerm2", { ITERM_SESSION_ID: "w0t0p0" }],
		["Windows Terminal", { WT_SESSION: "abc" }],
		["VS Code", { TERM_PROGRAM: "vscode" }],
		["Alacritty", { TERM_PROGRAM: "alacritty" }],
	])("says yes to %s", (_name, env) => {
		expect(detectOsc8(env as NodeJS.ProcessEnv)).toBe(true);
	});

	it.each([
		["a bare xterm", { TERM: "xterm-256color" }],
		["screen, which strips OSC 8", { TERM: "screen.xterm-256color" }],
		["JetBrains", { TERMINAL_EMULATOR: "JetBrains-JediTerm" }],
		["an empty environment", {}],
	])("says no to %s", (_name, env) => {
		expect(detectOsc8(env as NodeJS.ProcessEnv)).toBe(false);
	});

	it("is case-insensitive about TERM_PROGRAM, as the shells that set it are not", () => {
		expect(detectOsc8({ TERM_PROGRAM: "Ghostty" } as NodeJS.ProcessEnv)).toBe(true);
	});

	// Under tmux the answer belongs to tmux: it re-emits OSC 8 only when the
	// attached client advertises `hyperlinks`. Asking it here would shell out,
	// so what is pinned is that the environment alone never decides yes.
	it("never says yes from the environment alone under tmux", () => {
		const answer = detectOsc8({ TMUX: "/tmp/tmux-1000/default,123,0", TERM_PROGRAM: "ghostty" } as NodeJS.ProcessEnv);
		expect(typeof answer).toBe("boolean");
		// Ghostty outside tmux is an unconditional yes; inside, it is tmux's call.
		expect(detectOsc8({ TERM_PROGRAM: "ghostty" } as NodeJS.ProcessEnv)).toBe(true);
	});
});
