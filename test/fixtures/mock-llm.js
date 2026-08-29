/**
 * A mock LLM, registered as a real pi provider — the fixture for live
 * harnesses of the second-model layer (scripts/snippet-infer-tmux.py).
 *
 * `ProviderConfig.streamSimple` lets an extension serve completions from a
 * function instead of an HTTP endpoint, so this stands in for a model
 * *inside real pi* — same ModelRegistry, same message lifecycle, same
 * `registry.getProvider().streamSimple()` path the inference engine uses —
 * with no network, no credentials and no nondeterminism.
 *
 * It plays both parts of a pi-snippet session, told apart by the system
 * prompt (the inference engine sends its own contract, identified here by a
 * marker substring passed in the environment so the fixture cannot drift
 * from the real prompt):
 *
 *  - the **primary model**, answering the user's prompt with the next reply
 *    from `MOCK_LLM_SCRIPT`, streamed a few words at a time;
 *  - the **second model**, answering an inference request with the next
 *    reply from `MOCK_LLM_INFER` — a re-emission of the message with
 *    `<snippet>` tags added — streamed so each chunk completes exactly one
 *    more tag, which is what makes "chips light up one at a time" visible
 *    and assertable in a real terminal.
 *
 * Configuration, all through the environment so the fixture stays a plain
 * file pi can load with `-e`:
 *
 *   MOCK_LLM_INFER_MARKER  substring identifying an inference request
 *   MOCK_LLM_SCRIPT        JSON array of primary replies, in order
 *                          (the last one repeats once the script runs out)
 *   MOCK_LLM_INFER         JSON array of second-model replies, in order
 *                          (the last one repeats)
 *   MOCK_LLM_CHUNK_MS      delay between streamed chunks (default 40)
 */

const MARKER = process.env.MOCK_LLM_INFER_MARKER ?? "@@no-marker-configured@@";
const SCRIPT = JSON.parse(process.env.MOCK_LLM_SCRIPT ?? '["I am a mock."]');
const INFER_REPLIES = JSON.parse(process.env.MOCK_LLM_INFER ?? "[]");
const CHUNK_MS = Number(process.env.MOCK_LLM_CHUNK_MS ?? 40);
const LOG = process.env.MOCK_LLM_LOG;

import { appendFileSync } from "node:fs";

function record(entry) {
	if (LOG) appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Minimal stand-in for pi-ai's AssistantMessageEventStream: an async iterable
 * of events that terminates when `end` is called. Hand-rolled rather than
 * imported so the fixture never pulls a second copy of pi-ai into the
 * process that is running pi.
 */
class MockEventStream {
	constructor() {
		this.queue = [];
		this.waiting = [];
		this.finished = false;
	}
	push(event) {
		const waiter = this.waiting.shift();
		if (waiter) waiter({ value: event, done: false });
		else this.queue.push(event);
	}
	end() {
		this.finished = true;
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
}

/** Primary replies stream a few words at a time, the way a real model types. */
function primaryChunks(text) {
	const words = text.split(" ");
	const chunks = [];
	for (let i = 0; i < words.length; i += 3) {
		chunks.push(words.slice(i, i + 3).join(" ") + " ");
	}
	return chunks;
}

/**
 * Inference replies stream one completed tag per chunk: the second model
 * re-emits the message with tags added, and the engine extracts anchors from
 * each accumulated prefix, so this is the chunking that makes chips appear
 * one at a time.
 */
function inferChunks(text) {
	const cuts = [0];
	for (const m of text.matchAll(/<\/snippet>/g)) cuts.push(m.index + m[0].length);
	cuts.push(text.length);
	const chunks = [];
	for (let i = 0; i < cuts.length - 1; i++) {
		const piece = text.slice(cuts[i], cuts[i + 1]);
		if (piece.length > 0) chunks.push(piece);
	}
	return chunks.length > 0 ? chunks : [text];
}

export default function mockLlm(pi) {
	let primaryTurn = 0;
	let inferTurn = 0;

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
			const isInference = systemPrompt.includes(MARKER);
			record({ kind: isInference ? "infer" : "primary", model: model.id, systemPromptHead: systemPrompt.slice(0, 60) });
			const pool = isInference ? INFER_REPLIES : SCRIPT;
			const turn = isInference ? inferTurn++ : primaryTurn++;
			const text = pool[Math.min(turn, pool.length - 1)] ?? "I am a mock.";
			const chunks = isInference ? inferChunks(text) : primaryChunks(text);

			const stream = new MockEventStream();
			(async () => {
				const partial = {
					role: "assistant",
					content: [{ type: "text", text: "" }],
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
				stream.push({ type: "start", partial: { ...partial, content: [] } });
				for (const chunk of chunks) {
					await sleep(CHUNK_MS);
					partial.content[0].text += chunk;
					stream.push({
						type: "text_delta",
						delta: chunk,
						contentIndex: 0,
						partial: { ...partial, content: [{ type: "text", text: partial.content[0].text }] },
					});
				}
				await sleep(CHUNK_MS);
				stream.push({ type: "done", reason: "stop", message: partial });
				stream.end();
			})();
			return stream;
		},
	});
}
