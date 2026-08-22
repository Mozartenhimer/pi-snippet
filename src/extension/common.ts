import { buildPromptSnippet } from "../shared/prompt-snippet.js";

/**
 * Register the suggested-replies prompt contract on `before_agent_start`.
 *
 * Injects via two delivery paths, because provider bridges differ in what
 * they forward:
 *  - the chained systemPrompt return covers direct providers;
 *  - systemPromptOptions.appendSystemPrompt covers bridges (e.g.
 *    pi-claude-bridge) that rebuild their own prompt and forward only the
 *    portable parts of systemPromptOptions.
 *
 * Both paths are guarded with includes() so loading more than one pi-clik
 * extension (web + TUI) injects the snippet exactly once.
 */
export function registerPromptSnippet(pi: any, isEnabled: () => boolean = () => true): void {
	pi.on(
		"before_agent_start",
		(event: { systemPrompt: string; systemPromptOptions?: { appendSystemPrompt?: string } }) => {
			if (!isEnabled()) return undefined;
			const snippet = buildPromptSnippet();
			if (
				event.systemPromptOptions &&
				!event.systemPromptOptions.appendSystemPrompt?.includes(snippet)
			) {
				const current = event.systemPromptOptions.appendSystemPrompt;
				event.systemPromptOptions.appendSystemPrompt = current
					? `${current}\n\n${snippet}`
					: snippet;
			}
			if (event.systemPrompt.includes(snippet)) return undefined;
			return { systemPrompt: `${event.systemPrompt}\n\n${snippet}` };
		},
	);
}
