/**
 * `registerPromptSnippet` (src/extension/common.ts).
 *
 * Two independent delivery paths exist because provider bridges differ in
 * what they forward (see the doc comment on the function): the chained
 * `systemPrompt` return, and mutating `systemPromptOptions.appendSystemPrompt`
 * in place. Both must be guarded against double-injection independently,
 * since a bridge may reuse the same options object across repeated
 * `before_agent_start` events (e.g. on extension reload).
 */
import { describe, expect, it } from "vitest";
import { registerPromptSnippet } from "../src/extension/common.js";
import { buildPromptSnippet } from "../src/shared/prompt-snippet.js";

const SNIPPET = buildPromptSnippet();

function makeFakePi() {
	const handlers = new Map<string, (event: any) => any>();
	const pi = { on: (name: string, handler: any) => handlers.set(name, handler) };
	return { pi, handler: () => handlers.get("before_agent_start")! };
}

describe("registerPromptSnippet", () => {
	it("appends the snippet to systemPrompt via the chained return", () => {
		const { pi, handler } = makeFakePi();
		registerPromptSnippet(pi);
		const result = handler()({ systemPrompt: "You are pi." });
		expect(result).toEqual({ systemPrompt: `You are pi.\n\n${SNIPPET}` });
	});

	it("does not inject into systemPrompt a second time", () => {
		const { pi, handler } = makeFakePi();
		registerPromptSnippet(pi);
		const first = handler()({ systemPrompt: "You are pi." });
		const second = handler()({ systemPrompt: first!.systemPrompt });
		expect(second).toBeUndefined();
	});

	it("sets systemPromptOptions.appendSystemPrompt when empty", () => {
		const { pi, handler } = makeFakePi();
		registerPromptSnippet(pi);
		const event: any = { systemPrompt: "base", systemPromptOptions: {} };
		handler()(event);
		expect(event.systemPromptOptions.appendSystemPrompt).toBe(SNIPPET);
	});

	it("preserves a bridge's existing appendSystemPrompt content", () => {
		const { pi, handler } = makeFakePi();
		registerPromptSnippet(pi);
		const event: any = {
			systemPrompt: "base",
			systemPromptOptions: { appendSystemPrompt: "Existing bridge prompt." },
		};
		handler()(event);
		expect(event.systemPromptOptions.appendSystemPrompt).toBe(
			`Existing bridge prompt.\n\n${SNIPPET}`,
		);
	});

	it("does not inject into appendSystemPrompt a second time on the same options object", () => {
		const { pi, handler } = makeFakePi();
		registerPromptSnippet(pi);
		const event: any = { systemPrompt: "base", systemPromptOptions: {} };
		const h = handler();
		h(event);
		h(event);
		expect(event.systemPromptOptions.appendSystemPrompt).toBe(SNIPPET);
	});

	it("injects both paths independently in a single event", () => {
		const { pi, handler } = makeFakePi();
		registerPromptSnippet(pi);
		const event: any = { systemPrompt: "base", systemPromptOptions: {} };
		const result = handler()(event);
		expect(result).toEqual({ systemPrompt: `base\n\n${SNIPPET}` });
		expect(event.systemPromptOptions.appendSystemPrompt).toBe(SNIPPET);
	});

	it("skips the appendSystemPrompt path when a bridge never sets systemPromptOptions", () => {
		const { pi, handler } = makeFakePi();
		registerPromptSnippet(pi);
		const event: any = { systemPrompt: "base" };
		const result = handler()(event);
		expect(result).toEqual({ systemPrompt: `base\n\n${SNIPPET}` });
		expect(event.systemPromptOptions).toBeUndefined();
	});

	it("does nothing on either path when disabled", () => {
		const { pi, handler } = makeFakePi();
		registerPromptSnippet(pi, () => false);
		const event: any = { systemPrompt: "base", systemPromptOptions: {} };
		const result = handler()(event);
		expect(result).toBeUndefined();
		expect(event.systemPrompt).toBe("base");
		expect(event.systemPromptOptions.appendSystemPrompt).toBeUndefined();
	});

	it("defaults to enabled when no isEnabled callback is passed", () => {
		const { pi, handler } = makeFakePi();
		registerPromptSnippet(pi);
		const result = handler()({ systemPrompt: "base" });
		expect(result).toEqual({ systemPrompt: `base\n\n${SNIPPET}` });
	});
});
