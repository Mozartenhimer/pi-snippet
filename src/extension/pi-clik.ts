/**
 * pi-clik extension for pi-coding-agent.
 *
 * Appends the suggested-replies contract (PRD §6) to the system prompt so the
 * model knows it may mark spans of its prose as suggested user replies with
 * <pi:suggest>...</pi:suggest>. Everything else — parsing, rendering,
 * insertion — happens client-side; the extension adds no tools and never
 * blocks the turn (PRD G4).
 *
 * Works in every pi mode (interactive, print, RPC). Loaded by the pi-clik
 * server via `pi --mode rpc -e <this file>`, but can equally be installed
 * standalone.
 */
import { buildPromptSnippet } from "../shared/prompt-snippet.js";

// Typed loosely on purpose: the extension is bundled self-contained and must
// not require pi-coding-agent to be resolvable at load time.
export default function piClik(pi: any): void {
	pi.on(
		"before_agent_start",
		(event: { systemPrompt: string; systemPromptOptions?: { appendSystemPrompt?: string } }) => {
			const snippet = buildPromptSnippet();
			// Two delivery paths, because provider bridges differ in what they
			// forward:
			//  - the chained systemPrompt return covers direct providers;
			//  - systemPromptOptions.appendSystemPrompt covers bridges (e.g.
			//    pi-claude-bridge) that rebuild their own prompt and forward
			//    only the portable parts of systemPromptOptions.
			if (event.systemPromptOptions && !event.systemPromptOptions.appendSystemPrompt?.includes(snippet)) {
				const current = event.systemPromptOptions.appendSystemPrompt;
				event.systemPromptOptions.appendSystemPrompt = current ? `${current}\n\n${snippet}` : snippet;
			}
			if (event.systemPrompt.includes(snippet)) return undefined;
			return { systemPrompt: `${event.systemPrompt}\n\n${snippet}` };
		},
	);
}
