/**
 * pi-snippet extension for pi-coding-agent (web-server variant).
 *
 * Appends the suggested-replies contract (PRD §6) to the system prompt so the
 * model knows it may mark spans of its prose as suggested user replies with
 * <pi:snippet>...</pi:snippet>. Everything else — parsing, rendering,
 * insertion — happens client-side; the extension adds no tools and never
 * blocks the turn (PRD G4).
 *
 * Loaded by the pi-snippet server via `pi --mode rpc -e <this file>`. For
 * terminal sessions, use pi-snippet-tui.ts instead, which additionally renders
 * suggestions as numbered bracketed spans and binds Alt+1..9,0.
 */
import { registerPromptSnippet } from "./common.js";

// Typed loosely on purpose: the extension is bundled self-contained and must
// not require pi-coding-agent to be resolvable at load time.
export default function piSuggest(pi: any): void {
	registerPromptSnippet(pi);
}
