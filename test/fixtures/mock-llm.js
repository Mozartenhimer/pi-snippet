/**
 * A mock LLM, registered as a real pi provider.
 *
 * `ProviderConfig.streamSimple` lets an extension serve completions from a
 * function instead of an HTTP endpoint, so this stands in for a model
 * *inside real pi* — same ModelRegistry, same message lifecycle, same
 * `ctx.modelRegistry.complete()` path the inference layer uses — with no
 * network, no credentials and no nondeterminism.
 *
 * It plays both parts of a pi-snippet session:
 *
 *  - the **primary model**, answering the user's prompt with whatever the
 *    script says next;
 *  - the **small model**, answering the inference layer's request with a
 *    canned anchor/reply payload.
 *
 * The two are told apart by the system prompt: the inference layer sends its
 * own contract, and the test passes a slice of it in `MOCK_LLM_INFER_MARKER`
 * so the fixture cannot drift out of sync with the real prompt.
 *
 * Every request is appended to `MOCK_LLM_LOG` as JSONL, which is what the
 * tests assert against — including the requests that should never happen.
 *
 * Configuration, all through the environment so the fixture stays a plain
 * file pi can load with `-e`:
 *
 *   MOCK_LLM_LOG           path to the JSONL request log
 *   MOCK_LLM_INFER_MARKER  substring identifying an inference request
 *   MOCK_LLM_SCRIPT        JSON array of primary-model replies, in order
 *                          (the last one repeats once the script runs out)
 *   MOCK_LLM_INFER         the small model's reply to an inference request
 */

import { appendFileSync } from "node:fs";

const LOG = process.env.MOCK_LLM_LOG;
const INFER_MARKER = process.env.MOCK_LLM_INFER_MARKER ?? "@@no-marker-configured@@";
const SCRIPT = JSON.parse(process.env.MOCK_LLM_SCRIPT ?? '["I am a mock."]');
const INFER_REPLY = process.env.MOCK_LLM_INFER ?? "[]";

/**
 * Minimal stand-in for pi-ai's `AssistantMessageEventStream`: an async
 * iterable of events that also resolves a final message. Hand-rolled rather
 * than imported so the fixture never pulls a second copy of pi-ai into the
 * process that is running pi.
 */
class MockEventStream {
	constructor() {
		this.queue = [];
		this.waiting = [];
		this.finished = false;
		this.final = new Promise((resolve) => {
			this.resolveFinal = resolve;
		});
	}
	push(event) {
		const waiter = this.waiting.shift();
		if (waiter) waiter({ value: event, done: false });
		else this.queue.push(event);
	}
	end(result) {
		this.finished = true;
		this.resolveFinal(result);
		for (const waiter of this.waiting.splice(0)) waiter({ value: undefined, done: true });
	}
	[Symbol.asyncIterator]() {
		return {
			next: () => {
				if (this.queue.length > 0) {
					return Promise.resolve({ value: this.queue.shift(), done: false });
				}
				if (this.finished) return Promise.resolve({ value: undefined, done: true });
				return new Promise((resolve) => this.waiting.push(resolve));
			},
		};
	}
	result() {
		return this.final;
	}
}

function record(entry) {
	if (LOG) appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
}

/** The text of the last user turn, however its content is shaped. */
function lastUserText(context) {
	const message = [...(context.messages ?? [])].reverse().find((m) => m.role === "user");
	if (!message) return "";
	const { content } = message;
	if (typeof content === "string") return content;
	return (content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

export default function mockLlm(pi) {
	let turn = 0;

	pi.registerProvider("mockllm", {
		name: "Mock LLM",
		baseUrl: "http://mock.invalid",
		apiKey: "mock",
		api: "openai-completions",
		models: [
			{
				id: "mock-small",
				name: "Mock Small",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 4096,
			},
		],
		streamSimple: (model, context) => {
			const systemPrompt = context.systemPrompt ?? "";
			const isInference = systemPrompt.includes(INFER_MARKER);
			const text = isInference
				? INFER_REPLY
				: (SCRIPT[Math.min(turn++, SCRIPT.length - 1)] ?? "I am a mock.");

			record({
				kind: isInference ? "infer" : "primary",
				model: model.id,
				// The whole prompt would bury the log; its head identifies it.
				systemPromptHead: systemPrompt.slice(0, 80),
				userText: lastUserText(context),
				reply: text,
			});

			const message = {
				role: "assistant",
				content: [{ type: "text", text }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "stop",
				usage: {
					input: 5,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 10,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};

			const stream = new MockEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: { ...message, content: [] } });
				stream.push({ type: "text_delta", delta: text, contentIndex: 0, partial: message });
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
			});
			return stream;
		},
	});
}
