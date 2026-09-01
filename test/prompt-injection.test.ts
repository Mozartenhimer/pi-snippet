/**
 * The prompt snippet is delivered by two mechanisms at once, because provider
 * bridges differ in what they forward (see `src/extension/common.ts`). Both
 * paths are guarded so that reloading the extension — or a bridge that hands
 * back the prompt it was already given — cannot inject the snippet twice.
 *
 * Those guards are the part with no visible failure mode: a doubled snippet
 * still works, it just costs tokens on every request forever. MC/DC found
 * every one of these arms untaken.
 */
import { describe, expect, it } from "vitest";
import { registerPromptSnippet } from "../src/extension/common.js";
import { buildPromptSnippet } from "../src/shared/prompt-snippet.js";

const SNIPPET = buildPromptSnippet();

interface StartEvent {
	systemPrompt: string;
	systemPromptOptions?: { appendSystemPrompt?: string };
}

/** A fake pi that keeps the one handler the extension registers. */
function register(isEnabled?: () => boolean) {
	let handler: ((event: StartEvent) => { systemPrompt: string } | undefined) | undefined;
	const pi = {
		on(name: string, fn: (event: StartEvent) => { systemPrompt: string } | undefined) {
			if (name === "before_agent_start") handler = fn;
		},
	};
	registerPromptSnippet(pi, isEnabled);
	return (event: StartEvent) => handler!(event);
}

describe("registerPromptSnippet — the appendSystemPrompt path", () => {
	it("does nothing to options that are not there", () => {
		const fire = register();
		const event: StartEvent = { systemPrompt: "base" };
		const result = fire(event);
		expect(event.systemPromptOptions).toBeUndefined();
		expect(result?.systemPrompt).toBe(`base\n\n${SNIPPET}`);
	});

	it("sets the snippet on options that carry nothing yet", () => {
		const fire = register();
		const event: StartEvent = { systemPrompt: "base", systemPromptOptions: {} };
		fire(event);
		expect(event.systemPromptOptions?.appendSystemPrompt).toBe(SNIPPET);
	});

	it("appends after an existing appendSystemPrompt rather than replacing it", () => {
		const fire = register();
		const event: StartEvent = {
			systemPrompt: "base",
			systemPromptOptions: { appendSystemPrompt: "someone else's rules" },
		};
		fire(event);
		expect(event.systemPromptOptions?.appendSystemPrompt).toBe(
			`someone else's rules\n\n${SNIPPET}`,
		);
	});

	it("injects once when the same event comes back", () => {
		const fire = register();
		const event: StartEvent = { systemPrompt: "base", systemPromptOptions: {} };
		fire(event);
		fire(event);
		expect(event.systemPromptOptions?.appendSystemPrompt).toBe(SNIPPET);
	});

	it("removes the snippet when layer 1 is switched off mid-session", () => {
		let on = true;
		const fire = register(() => on);
		const event: StartEvent = { systemPrompt: "base", systemPromptOptions: {} };
		fire(event);
		on = false;
		fire(event);
		expect(event.systemPromptOptions?.appendSystemPrompt).toBeUndefined();
	});

	it("leaves another extension's appendSystemPrompt behind when switched off", () => {
		let on = true;
		const fire = register(() => on);
		const event: StartEvent = {
			systemPrompt: "base",
			systemPromptOptions: { appendSystemPrompt: "someone else's rules" },
		};
		fire(event);
		on = false;
		fire(event);
		expect(event.systemPromptOptions?.appendSystemPrompt).toBe("someone else's rules");
	});
});

describe("registerPromptSnippet — the systemPrompt path", () => {
	it("returns nothing when the prompt already carries the snippet", () => {
		const fire = register();
		const event: StartEvent = { systemPrompt: `base\n\n${SNIPPET}` };
		expect(fire(event)).toBeUndefined();
	});

	it("returns nothing at all while suggestions are off", () => {
		const fire = register(() => false);
		const event: StartEvent = { systemPrompt: "base", systemPromptOptions: {} };
		expect(fire(event)).toBeUndefined();
		expect(event.systemPromptOptions?.appendSystemPrompt).toBeUndefined();
	});
});
