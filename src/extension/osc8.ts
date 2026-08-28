/**
 * Does this terminal turn a markdown link into a real hyperlink?
 *
 * Link mode is only viable where pi-tui emits OSC 8, and pi-tui decides that
 * from the environment (`getCapabilities()` in `@earendil-works/pi-tui`). Where
 * it decides no, it prints the href in parentheses after the label instead — so
 * a chip whose href is a long `pisnip://` URL would paint as
 * `¹rebuild the solution (pisnip://a1b2c3d4/ff2ee691/c1)` on every chip, on
 * every line. That is the reason this check exists: not to predict whether a
 * click would work, but to make sure we never *paint* a URL the user would end
 * up reading.
 *
 * The list mirrors pi-tui's own, deliberately. Guessing more generously than
 * the renderer does would produce exactly the paren fallback this avoids, and
 * guessing less generously would silently cost someone the feature. Verified
 * against the two regimes in `scripts/osc8-probe.py`.
 */
import { execSync } from "node:child_process";

/**
 * tmux re-emits OSC 8 only when the attached client advertises `hyperlinks`,
 * and strips them otherwise — so under tmux the answer depends on the outer
 * terminal, and only tmux can say. Any failure is a no: a wrong yes is visible
 * on screen, a wrong no is merely a missing feature.
 */
function tmuxForwardsHyperlinks(): boolean {
	try {
		return execSync("tmux display-message -p '#{client_termfeatures}'", {
			encoding: "utf8",
			timeout: 250,
			stdio: ["ignore", "pipe", "ignore"],
		})
			.split(",")
			.map((feature) => feature.trim())
			.includes("hyperlinks");
	} catch {
		return false;
	}
}

export function detectOsc8(env: NodeJS.ProcessEnv = process.env): boolean {
	const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();
	const term = (env.TERM ?? "").toLowerCase();

	if (env.TMUX || term.startsWith("tmux")) return tmuxForwardsHyperlinks();
	if (term.startsWith("screen")) return false; // screen does not forward OSC 8

	if (env.KITTY_WINDOW_ID || termProgram === "kitty") return true;
	if (termProgram === "ghostty" || term.includes("ghostty") || env.GHOSTTY_RESOURCES_DIR) {
		return true;
	}
	if (env.WEZTERM_PANE || termProgram === "wezterm") return true;
	if (termProgram === "warpterminal" || env.WARP_SESSION_ID || env.WARP_TERMINAL_SESSION_UUID) {
		return true;
	}
	if (env.ITERM_SESSION_ID || termProgram === "iterm.app") return true;
	if (env.WT_SESSION) return true;
	if (termProgram === "vscode" || termProgram === "alacritty") return true;

	// Unknown terminal: no. The cost of being wrong in this direction is a
	// feature that stays off; the other direction puts a URL on screen.
	return false;
}

let cached: boolean | undefined;

/** Drop the cache. Tests switch terminals mid-run; a real session cannot. */
export function resetOsc8Cache(): void {
	cached = undefined;
}

/** Cached per process: the environment does not change under a running pi. */
export function terminalSupportsOsc8(env?: NodeJS.ProcessEnv): boolean {
	if (env) return detectOsc8(env); // tests pass one explicitly
	if (cached === undefined) cached = detectOsc8();
	return cached;
}
