import { describe, expect, it, vi } from "vitest";
import {
	inferenceCandidates,
	MagicInferrer,
	pickInferenceModel,
	resolvePin,
} from "../src/extension/magic.js";

const haiku = { id: "claude-haiku-4-5", provider: "anthropic", cost: { input: 1 } };
const sonnet = { id: "claude-sonnet-5", provider: "anthropic", cost: { input: 3 } };
const opus = { id: "claude-opus-5", provider: "anthropic", cost: { input: 15 } };
const mini = { id: "gpt-5-mini", provider: "openai", cost: { input: 0.5 } };

function host(options: {
	available?: unknown[];
	model?: unknown;
	complete?: unknown;
	auth?: (m: any) => boolean;
} = {}) {
	return {
		model: options.model ?? sonnet,
		modelRegistry: {
			getAvailable: () => (options.available ?? [haiku, sonnet, opus, mini]) as any,
			hasConfiguredAuth: options.auth ?? (() => true),
			complete: options.complete ?? (async () => ({ content: [], stopReason: "stop" })),
		},
	} as any;
}

function reply(text: string, usage = { input: 10, output: 4 }) {
	return async () => ({ content: [{ type: "text", text }], stopReason: "stop", usage });
}

describe("pickInferenceModel", () => {
	it("prefers a small model of the session's own provider", () => {
		expect(pickInferenceModel(host())?.id).toBe("claude-haiku-4-5");
	});

	it("never crosses to another provider, even for a cheaper small model", () => {
		// gpt-5-mini is cheaper than haiku, but the session isn't talking to openai.
		expect(pickInferenceModel(host())?.provider).toBe("anthropic");
	});

	it("falls back to the active model when the provider has nothing small", () => {
		expect(pickInferenceModel(host({ available: [sonnet, opus] }))?.id).toBe("claude-sonnet-5");
	});

	it("skips a small model with no configured auth", () => {
		const auth = (m: any) => m.id !== "claude-haiku-4-5";
		expect(pickInferenceModel(host({ auth }))?.id).toBe("claude-sonnet-5");
	});

	it("returns nothing when the registry cannot complete", () => {
		const broken = { model: sonnet, modelRegistry: { getAvailable: () => [haiku] } } as any;
		expect(pickInferenceModel(broken)).toBeUndefined();
	});

	it("obeys a pin even when it is neither small nor cheap", () => {
		expect(pickInferenceModel(host(), "anthropic/claude-opus-5")?.id).toBe("claude-opus-5");
	});

	it("obeys a pin given as a bare model id", () => {
		expect(pickInferenceModel(host(), "gpt-5-mini")?.id).toBe("gpt-5-mini");
	});

	it("refuses a pin with no configured auth rather than silently substituting", () => {
		const auth = (m: any) => m.id !== "claude-opus-5";
		expect(pickInferenceModel(host({ auth }), "claude-opus-5")).toBeUndefined();
	});

	it("falls back to auto-selection when a pin names nothing that exists", () => {
		expect(pickInferenceModel(host(), "llama-9000")?.id).toBe("claude-haiku-4-5");
	});
});

describe("resolvePin", () => {
	const available = [haiku, mini];
	it("matches provider/id and bare id, case-insensitively", () => {
		expect(resolvePin("anthropic/CLAUDE-HAIKU-4-5", available)?.id).toBe("claude-haiku-4-5");
		expect(resolvePin("gpt-5-mini", available)?.id).toBe("gpt-5-mini");
	});
	it("is undefined for blank or unknown pins", () => {
		expect(resolvePin("  ", available)).toBeUndefined();
		expect(resolvePin(undefined, available)).toBeUndefined();
		expect(resolvePin("nope", available)).toBeUndefined();
	});
});

describe("inferenceCandidates", () => {
	it("lists small models first, then by cost", () => {
		expect(inferenceCandidates(host()).map((m) => m.id)).toEqual([
			"gpt-5-mini",
			"claude-haiku-4-5",
			"claude-sonnet-5",
			"claude-opus-5",
		]);
	});

	it("omits models with no configured auth", () => {
		const auth = (m: any) => m.provider === "anthropic";
		expect(inferenceCandidates(host({ auth })).some((m) => m.provider === "openai")).toBe(false);
	});
});

describe("MagicInferrer", () => {
	const message = "I'm done the model, do you want to see it?";
	const answer = '[{"anchor":"do you want to see it?","reply":"see it"}]';

	it("infers, validates and returns anchors", async () => {
		const magic = new MagicInferrer();
		const result = await magic.infer(message, host({ complete: reply(answer) }));
		expect(result).toEqual([{ anchor: "do you want to see it?", reply: "see it" }]);
	});

	it("asks the model once and serves the rest from cache", async () => {
		const complete = vi.fn(reply(answer));
		const magic = new MagicInferrer();
		const h = host({ complete });
		await magic.infer(message, h);
		await magic.infer(message, h);
		expect(complete).toHaveBeenCalledTimes(1);
		expect(magic.peek(message)).toHaveLength(1);
	});

	it("shares one call between concurrent asks for the same message", async () => {
		const complete = vi.fn(reply(answer));
		const magic = new MagicInferrer();
		const h = host({ complete });
		const [a, b] = await Promise.all([magic.infer(message, h), magic.infer(message, h)]);
		expect(complete).toHaveBeenCalledTimes(1);
		expect(a).toEqual(b);
	});

	it("counts what it spent", async () => {
		const magic = new MagicInferrer();
		await magic.infer(message, host({ complete: reply(answer) }));
		expect(magic.usage).toEqual({ calls: 1, input: 10, output: 4 });
	});

	it("returns nothing when the provider throws", async () => {
		const magic = new MagicInferrer();
		const complete = async () => {
			throw new Error("401");
		};
		expect(await magic.infer(message, host({ complete }))).toEqual([]);
	});

	it("returns nothing when the model errored or was aborted", async () => {
		for (const stopReason of ["error", "aborted"]) {
			const magic = new MagicInferrer();
			const complete = async () => ({ content: [{ type: "text", text: answer }], stopReason });
			expect(await magic.infer(message, host({ complete }))).toEqual([]);
		}
	});

	it("returns nothing when there is no usable model, without calling", async () => {
		const complete = vi.fn(reply(answer));
		const magic = new MagicInferrer();
		const h = host({ complete, auth: () => false, model: undefined });
		expect(await magic.infer(message, h)).toEqual([]);
		expect(complete).not.toHaveBeenCalled();
	});

	it("caches an empty answer so a message is never re-read", async () => {
		const complete = vi.fn(reply("[]"));
		const magic = new MagicInferrer();
		const h = host({ complete });
		await magic.infer(message, h);
		await magic.infer(message, h);
		expect(complete).toHaveBeenCalledTimes(1);
		expect(magic.knows(message)).toBe(true);
	});

	it("does not cache a transport failure, so a retry can succeed", async () => {
		const magic = new MagicInferrer();
		const failing = async () => {
			throw new Error("network");
		};
		expect(await magic.infer(message, host({ complete: failing }))).toEqual([]);
		expect(magic.knows(message)).toBe(false);
		expect(await magic.infer(message, host({ complete: reply(answer) }))).toHaveLength(1);
	});

	it("sends the message as the user turn and the contract as the system prompt", async () => {
		const complete = vi.fn(reply(answer));
		const magic = new MagicInferrer();
		await magic.infer(message, host({ complete }));
		const [model, context, options] = complete.mock.calls[0] as any[];
		expect(model.id).toBe("claude-haiku-4-5");
		expect(context.systemPrompt).toContain("anchor");
		expect(context.messages[0].role).toBe("user");
		expect(context.messages[0].content).toContain(message);
		expect(options.maxTokens).toBeGreaterThan(0);
		expect(options.signal).toBeInstanceOf(AbortSignal);
	});

	it("passes the pin through to model selection", async () => {
		const complete = vi.fn(reply(answer));
		const magic = new MagicInferrer();
		await magic.infer(message, host({ complete }), "claude-opus-5");
		expect((complete.mock.calls[0] as any[])[0].id).toBe("claude-opus-5");
	});
});

describe("MagicInferrer: standing down on a dead provider", () => {
	const message = "Shall I push?";
	const failing = async () => ({ content: [], stopReason: "error" });

	it("stops calling after repeated failures", async () => {
		const complete = vi.fn(failing);
		const magic = new MagicInferrer();
		const h = host({ complete });
		for (let i = 0; i < 6; i++) await magic.infer(`${message} ${i}`, h);
		expect(complete).toHaveBeenCalledTimes(3);
		expect(magic.stoodDown).toBe(true);
	});

	it("counts consecutively — one success clears the tally", async () => {
		const answers = [failing, failing, reply('[{"anchor":"push?","reply":"push"}]'), failing];
		let call = 0;
		const complete = vi.fn(() => answers[call++]!());
		const magic = new MagicInferrer();
		const h = host({ complete });
		for (let i = 0; i < 4; i++) await magic.infer(`Shall I push? ${i}`, h);
		expect(magic.stoodDown).toBe(false);
		expect(complete).toHaveBeenCalledTimes(4);
	});

	it("does not count an abort against the provider", async () => {
		const aborted = async () => ({ content: [], stopReason: "aborted" });
		const complete = vi.fn(aborted);
		const magic = new MagicInferrer();
		const h = host({ complete });
		for (let i = 0; i < 5; i++) await magic.infer(`Shall I push? ${i}`, h);
		expect(magic.stoodDown).toBe(false);
		expect(complete).toHaveBeenCalledTimes(5);
	});

	it("rearm() lets it try again", async () => {
		const complete = vi.fn(failing);
		const magic = new MagicInferrer();
		const h = host({ complete });
		for (let i = 0; i < 5; i++) await magic.infer(`Shall I push? ${i}`, h);
		expect(complete).toHaveBeenCalledTimes(3);
		magic.rearm();
		await magic.infer("Shall I push? later", h);
		expect(complete).toHaveBeenCalledTimes(4);
	});
});

describe("pickInferenceModel: quality before price", () => {
	const tiny = { id: "mistral.ministral-3-3b-instruct", provider: "anthropic", cost: { input: 0.02 } };
	it("prefers a known-good small model over a cheaper unknown one", () => {
		expect(pickInferenceModel(host({ available: [tiny, haiku, opus] }))?.id).toBe(
			"claude-haiku-4-5",
		);
	});
	it("still takes the cheap one when nothing preferred is available", () => {
		expect(pickInferenceModel(host({ available: [tiny, opus] }))?.id).toBe(
			"mistral.ministral-3-3b-instruct",
		);
	});
});
