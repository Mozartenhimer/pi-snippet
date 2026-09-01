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
 * Both paths are guarded with includes() so reloading the extension injects
 * the snippet exactly once.
 */
export function registerPromptSnippet(pi: any, isEnabled: () => boolean = () => true): void {
	pi.on(
		"before_agent_start",
		(event: { systemPrompt: string; systemPromptOptions?: { appendSystemPrompt?: string } }) => {
			const snippet = buildPromptSnippet();
			if (!isEnabled()) {
				// systemPromptOptions survives between turns, so a mode change to
				// one without layer 1 has to undo an earlier turn's mutation.
				const appended = event.systemPromptOptions?.appendSystemPrompt;
				if (event.systemPromptOptions && appended?.includes(snippet)) {
					// A conditional rather than `without || undefined`: a constant right
					// operand is never true, so neither side of that `||` can be shown to
					// drive it and MC/DC has no pair for either.
					const without = appended.replace(snippet, "").trim();
					event.systemPromptOptions.appendSystemPrompt = without ? without : undefined;
				}
				return undefined;
			}
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
