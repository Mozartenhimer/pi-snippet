import { afterEach, describe, expect, it } from "vitest";
import {
	InferenceEngine,
	MODEL_ENV_VAR,
	DEFAULT_INFER_MODEL,
	modelCompletions,
	resolveInferenceModel,
	resolvePin,
	type PiModel,
} from "../src/extension/infer.js";

const MODEL: PiModel = { id: "qwen/qwen3.7-flash", provider: "openrouter" };
const SONNET: PiModel = { id: "claude-sonnet-5", provider: "anthropic" };

const MESSAGE = "Do you want to rebuild or commit?";
const REPLY = "Do you want to <snippet>rebuild</snippet> or <snippet>commit</snippet>?";

/** Split a string into text_delta events of the given size, like a provider does. */
function deltas(text: string, size = 12) {
	const chunks: string[] = [];
	for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
	return chunks;
}

function host(options: {
	available?: PiModel[];
	auth?: (m: PiModel) => boolean;
	credentials?: (m: PiModel) => any;
	stream?: (model: PiModel, context: any, callOptions?: any) => any;
	complete?: (model: PiModel, context: any, callOptions?: any) => any;
} = {}) {
	return {
		modelRegistry: {
			getAvailable: () => options.available ?? [MODEL, SONNET],
			hasConfiguredAuth: options.auth ?? (() => true),
			...(options.credentials ? { getApiKeyAndHeaders: options.credentials } : {}),
			getProvider: (provider: string) =>
				provider === "openrouter" && options.stream
					? {
							streamSimple: (model: PiModel, context: any, callOptions?: any) =>
								options.stream!(model, context, callOptions),
						}
					: undefined,
			complete: options.complete,
		},
	};
}

async function* eventStream(chunks: string[]) {
	for (const chunk of chunks) {
		yield { type: "text_delta", delta: chunk };
	}
}

afterEach(() => {
	delete process.env[MODEL_ENV_VAR];
});

describe("resolvePin", () => {
	it("matches provider/id and bare id, case-insensitively", () => {
		expect(resolvePin(DEFAULT_INFER_MODEL, [MODEL, SONNET])?.id).toBe(MODEL.id);
		expect(resolvePin("anthropic/CLAUDE-SONNET-5", [MODEL, SONNET])?.id).toBe("claude-sonnet-5");
		expect(resolvePin("claude-sonnet-5", [MODEL, SONNET])?.id).toBe("claude-sonnet-5");
	});

	it("is undefined for blank or unknown pins", () => {
		expect(resolvePin("  ", [MODEL])).toBeUndefined();
		expect(resolvePin("nope", [MODEL])).toBeUndefined();
	});
});

describe("resolveInferenceModel", () => {
	it("resolves the fixed OpenRouter model by default", () => {
		expect(resolveInferenceModel(host())?.id).toBe(MODEL.id);
	});

	it("refuses the default when auth is not configured for it", () => {
		expect(resolveInferenceModel(host({ auth: (m) => m.provider !== "openrouter" }))).toBeUndefined();
	});

	it("the stored /snippets choice beats the built-in default", () => {
		expect(resolveInferenceModel(host(), "anthropic/claude-sonnet-5")?.id).toBe("claude-sonnet-5");
	});

	it("PI_SNIPPET_MODEL beats the stored choice, for one session", () => {
		process.env[MODEL_ENV_VAR] = "anthropic/claude-sonnet-5";
		expect(resolveInferenceModel(host(), "openrouter/qwen/qwen3.7-flash")?.id).toBe(
			"claude-sonnet-5",
		);
	});

	it("an unresolvable stored choice falls back to the default", () => {
		expect(resolveInferenceModel(host(), "gpt-9000")?.id).toBe(MODEL.id);
	});

	it("a stored choice with no auth is refused rather than substituted", () => {
		expect(
			resolveInferenceModel(host({ auth: (m) => m.provider !== "anthropic" }), "anthropic/claude-sonnet-5"),
		).toBeUndefined();
	});
});

describe("InferenceEngine", () => {
	it("streams anchors out as the reply arrives, one chip per closed tag", async () => {
		const seen: string[] = [];
		const engine = new InferenceEngine();
		const h = host({
			stream: (_model, _context) => eventStream(deltas(REPLY, 10)),
		});
		const anchors = await engine.infer(MESSAGE, h, [], (anchor) => seen.push(anchor));
		expect(anchors).toEqual(["rebuild", "commit"]);
		expect(seen).toEqual(["rebuild", "commit"]);
	});

	it("never emits a chip before its closing tag has streamed in", async () => {
		const at: Array<{ anchor: string; afterChunk: number }> = [];
		const chunks = deltas(REPLY, 10);
		let chunkCount = 0;
		const engine = new InferenceEngine();
		const h = host({
			stream: () =>
				(async function* () {
					for (const chunk of chunks) {
						chunkCount++;
						yield { type: "text_delta", delta: chunk };
					}
				})(),
		});
		await engine.infer(MESSAGE, h, [], (anchor) => {
			at.push({ anchor, afterChunk: chunkCount });
		});
		// The first anchor can only be complete once the streamed prefix
		// contains its closing tag.
		const firstClose = chunks.findIndex((_, i) =>
			chunks.slice(0, i + 1).join("").includes("</snippet>"),
		);
		const rebuild = at.find((e) => e.anchor === "rebuild");
		expect(rebuild).toBeDefined();
		expect(rebuild!.afterChunk).toBeGreaterThanOrEqual(firstClose + 1);
	});

	it("passes the existing chips down, so an echoed tag is not re-emitted", async () => {
		// The message already carries layer 1's tag; the second model's reply
		// keeps it and adds one.
		const tagged = "Do you want to <snippet>rebuild</snippet> or commit?";
		const added = "Do you want to <snippet>rebuild</snippet> or <snippet>commit</snippet>?";
		const engine = new InferenceEngine();
		const h = host({ stream: () => eventStream(deltas(added)) });
		expect(await engine.infer(tagged, h, ["rebuild"])).toEqual(["commit"]);
	});

	it("caches by message text: a second ask pays nothing and still reports the anchors", async () => {
		let calls = 0;
		const engine = new InferenceEngine();
		const h = host({
			stream: () => {
				calls++;
				return eventStream(deltas(REPLY));
			},
		});
		const seen: string[] = [];
		await engine.infer(MESSAGE, h, []);
		const again = await engine.infer(MESSAGE, h, [], (a) => seen.push(a));
		expect(calls).toBe(1);
		expect(again).toEqual(["rebuild", "commit"]);
		expect(seen).toEqual(["rebuild", "commit"]);
	});

	it("sends the session's credentials with the call — the provider carries none", async () => {
		// `getProvider()` hands out a bare transport: called without a key it
		// fails with "No API key for provider", which this layer would swallow
		// like any other failure, leaving a working model looking silent.
		let callOptions: any;
		const engine = new InferenceEngine();
		const h = host({
			credentials: () => ({ ok: true, apiKey: "sk-test", headers: { "X-Title": "pi" } }),
			stream: (_model, _context, opts) => {
				callOptions = opts;
				return eventStream(deltas(REPLY));
			},
		});
		await engine.infer(MESSAGE, h, []);
		expect(callOptions.apiKey).toBe("sk-test");
		expect(callOptions.headers).toEqual({ "X-Title": "pi" });
		expect(callOptions.signal).toBeDefined(); // and still the timeout's
	});

	it("calls anyway when the registry offers no credentials — a mock needs none", async () => {
		let called = false;
		const engine = new InferenceEngine();
		const h = host({
			credentials: () => {
				throw new Error("no auth store here");
			},
			stream: () => {
				called = true;
				return eventStream(deltas(REPLY));
			},
		});
		expect(await engine.infer(MESSAGE, h, [])).toEqual(["rebuild", "commit"]);
		expect(called).toBe(true);
	});

	it("falls back to a single-shot complete when the provider cannot stream", async () => {
		const engine = new InferenceEngine();
		const h = host({
			complete: async () => ({
				content: [{ type: "text", text: REPLY }],
				stopReason: "stop",
			}),
		});
		expect(await engine.infer(MESSAGE, h, [])).toEqual(["rebuild", "commit"]);
	});

	it("reads the reply from the system prompt's contract, not the session's", async () => {
		let seen: string | undefined;
		const engine = new InferenceEngine();
		const h = host({
			stream: (_model, context) => {
				seen = context.systemPrompt;
				return eventStream([]);
			},
		});
		await engine.infer(MESSAGE, h, []);
		expect(seen).toBeDefined();
		expect(seen).not.toContain("<snippet>rebuild the solution");
	});

	it("an unanswered message resolves to [] and is cached as such", async () => {
		let calls = 0;
		const engine = new InferenceEngine();
		const h = host({
			stream: () => {
				calls++;
				return eventStream(deltas("Pushed the branch, CI is green."));
			},
		});
		expect(await engine.infer("Pushed the branch, CI is green.", h, [])).toEqual([]);
		expect(await engine.infer("Pushed the branch, CI is green.", h, [])).toEqual([]);
		expect(calls).toBe(1);
	});

	it("uses the stored /snippets choice supplied by the constructor", async () => {
		const seen: PiModel[] = [];
		const engine = new InferenceEngine(() => "anthropic/claude-sonnet-5");
		const h = host({
			complete: async (model) => {
				seen.push(model);
				return { content: [{ type: "text", text: REPLY }], stopReason: "stop" };
			},
		});
		expect(await engine.infer(MESSAGE, h, [])).toEqual(["rebuild", "commit"]);
		expect(seen[0]!.id).toBe("claude-sonnet-5");
	});

	it("stands down after three consecutive failures and re-arms on demand", async () => {
		let calls = 0;
		const engine = new InferenceEngine();
		const h = host({
			complete: async () => {
				calls++;
				throw new Error("403");
			},
		});
		for (let i = 0; i < 3; i++) {
			expect(await engine.infer(`question ${i}?`, h, [])).toBeNull();
		}
		expect(calls).toBe(3);
		expect(engine.stoodDown).toBe(true);
		expect(await engine.infer("question more?", h, [])).toBeNull();
		expect(calls).toBe(3); // stood down: nothing fired
		engine.rearm();
		expect(await engine.infer("question more?", h, [])).toBeNull();
		expect(calls).toBe(4);
	});

	it("a timeout or abort is one failure, not a crash", async () => {
		const engine = new InferenceEngine();
		const h = host({
			complete: async () => ({ content: [], stopReason: "error" }),
		});
		expect(await engine.infer("still asking?", h, [])).toBeNull();
		expect(engine.stoodDown).toBe(false); // one strike of three
	});
});

describe("modelCompletions", () => {
	const available: PiModel[] = [
		{ id: "mock-small", provider: "mockllm" },
		{ id: "claude-sonnet-5", provider: "anthropic" },
		{ id: "gpt-4o", provider: "openai", name: "GPT-4o" },
	];

	it("ranks a tighter id match first, `provider/id` as the value to insert", () => {
		const items = modelCompletions("sonnet", available);
		expect(items[0]).toEqual({ value: "anthropic/claude-sonnet-5", label: "claude-sonnet-5", description: "anthropic" });
	});

	it("matches a model's display name too", () => {
		const items = modelCompletions("4o", available);
		expect(items.map((i) => i.value)).toContain("openai/gpt-4o");
	});

	it("an empty query returns every model, unfiltered", () => {
		expect(modelCompletions("", available)).toHaveLength(3);
	});

	it("no match is an empty list, not a thrown error", () => {
		expect(modelCompletions("zzzzzz-nonexistent", available)).toEqual([]);
	});
});

/**
 * The paths a second model can fail down, none of which is visible from
 * outside: every one of these ends as a silent null, so the only evidence
 * they behave is a test. MC/DC found each of these arms untaken.
 */
describe("InferenceEngine — reaching the model", () => {
	it("ignores a blank pin and falls through to the next source", () => {
		// A `/snippets model` value that is only whitespace is not a pin.
		expect(resolveInferenceModel(host(), "   ")).toEqual(MODEL);
	});

	it("returns nothing at all when the host has no model registry", async () => {
		const engine = new InferenceEngine();
		expect(await engine.infer(MESSAGE, {} as any, [])).toBeNull();
	});

	it("returns nothing when no model in the catalogue can be reached", async () => {
		const engine = new InferenceEngine();
		expect(await engine.infer(MESSAGE, host({ available: [] }), [])).toBeNull();
	});

	it("shares one in-flight call between concurrent asks for the same message", async () => {
		let calls = 0;
		const engine = new InferenceEngine();
		const h = host({
			complete: async () => {
				calls++;
				await new Promise((r) => setTimeout(r, 5));
				return { content: [{ type: "text", text: REPLY }], stopReason: "stop" };
			},
		});
		const [a, b] = await Promise.all([engine.infer(MESSAGE, h, []), engine.infer(MESSAGE, h, [])]);
		expect(a).toEqual(["rebuild", "commit"]);
		expect(b).toBe(a);
		expect(calls).toBe(1);
	});
});

describe("InferenceEngine — credentials the registry does not have", () => {
	const captured: any[] = [];
	const streaming = (credentials: () => any) =>
		host({
			credentials,
			stream: (_m, _c, callOptions) => {
				captured.push(callOptions);
				return eventStream(deltas(REPLY, 10));
			},
		});

	it("sends no apiKey when the registry reports none", async () => {
		captured.length = 0;
		const engine = new InferenceEngine();
		await engine.infer(MESSAGE, streaming(() => ({ headers: { "x-title": "pi" } })), []);
		expect(captured[0]).not.toHaveProperty("apiKey");
		expect(captured[0].headers).toEqual({ "x-title": "pi" });
	});

	it("sends no headers when the registry reports none", async () => {
		captured.length = 0;
		const engine = new InferenceEngine();
		await engine.infer(MESSAGE, streaming(() => ({ apiKey: "sk-test" })), []);
		expect(captured[0].apiKey).toBe("sk-test");
		expect(captured[0]).not.toHaveProperty("headers");
	});

	it("calls anyway when the registry reports neither", async () => {
		captured.length = 0;
		const engine = new InferenceEngine();
		const anchors = await engine.infer(MESSAGE, streaming(() => ({})), []);
		expect(captured[0]).not.toHaveProperty("apiKey");
		expect(anchors).toEqual(["rebuild", "commit"]);
	});
});

describe("InferenceEngine — what a stream can send", () => {
	it("ignores an event that is neither a usable delta nor an error", async () => {
		const engine = new InferenceEngine();
		const h = host({
			stream: () =>
				(async function* () {
					yield { type: "start" };
					yield { type: "text_delta", delta: REPLY };
					yield { type: "done" };
				})(),
		});
		expect(await engine.infer(MESSAGE, h, [])).toEqual(["rebuild", "commit"]);
	});

	it("ignores a text_delta whose delta is not a string", async () => {
		const engine = new InferenceEngine();
		const h = host({
			stream: () =>
				(async function* () {
					yield { type: "text_delta", delta: 42 };
					yield { type: "text_delta", delta: REPLY };
				})(),
		});
		expect(await engine.infer(MESSAGE, h, [])).toEqual(["rebuild", "commit"]);
	});

	it("fails when the registry can neither stream nor complete", async () => {
		const engine = new InferenceEngine();
		expect(await engine.infer(MESSAGE, host(), [])).toBeNull();
		expect(engine.stoodDown).toBe(false); // one strike of three
	});

	it("fails when a single-shot completion is aborted", async () => {
		const engine = new InferenceEngine();
		const h = host({ complete: async () => ({ content: [], stopReason: "aborted" }) });
		expect(await engine.infer(MESSAGE, h, [])).toBeNull();
	});
});
