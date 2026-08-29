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

const MODEL: PiModel = { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", provider: "openrouter" };
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
	stream?: (model: PiModel, context: any) => any;
	complete?: (model: PiModel, context: any) => any;
} = {}) {
	return {
		modelRegistry: {
			getAvailable: () => options.available ?? [MODEL, SONNET],
			hasConfiguredAuth: options.auth ?? (() => true),
			getProvider: (provider: string) =>
				provider === "openrouter" && options.stream
					? { streamSimple: (model: PiModel, context: any) => options.stream!(model, context) }
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
		expect(resolveInferenceModel(host(), "openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free")?.id).toBe(
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
