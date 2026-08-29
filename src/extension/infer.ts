/**
 * The second model: reads a finished assistant message and streams back the
 * same message with `<snippet>` tags added (shared/inferred.ts holds the
 * contract and the validation).
 *
 * ## Which model
 *
 * A fixed one, chosen deliberately rather than guessed: OpenRouter's
 * `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`. Free and small is the
 * point — this layer runs after every question-bearing message, so its cost
 * must be zero and its latency invisible. `PI_SNIPPET_MODEL` (`provider/id`,
 * or a bare id) overrides it, which is how the tests point it at a mock.
 *
 * ## How it runs
 *
 * Streaming, via the provider's own `streamSimple` — the same path pi's
 * registries use for real models, so auth comes from wherever the session's
 * auth lives. Each `text_delta` re-runs the extraction against the
 * accumulated reply, and every newly completed tag is handed to the caller's
 * callback as soon as its closing tag arrives: chips light up while the small
 * model is still writing, the same way layer-1 chips do while the primary
 * model writes.
 *
 * ## What it will not do
 *
 * - Never surfaces its own failures. No auth, no such model, a timeout, a
 *   refusal, tag soup: the message simply has no extra chips, exactly as if
 *   the layer were off.
 * - Never repeats itself into the editor. Answers are cached by the exact
 *   message text, so a resize, a re-render or a `/tree` walk back to it never
 *   pays twice.
 * - Never keeps trying on a dead credential. `hasConfiguredAuth()` answers
 *   whether credentials are *configured*, not whether they work — an expired
 *   key or a model the account cannot invoke would otherwise fire a request
 *   that cannot succeed after every question-bearing message. Three
 *   consecutive failures stand the layer down for the session.
 */

import {
	buildInferPrompt,
	extractAnchors,
	INFER_SYSTEM_PROMPT,
} from "../shared/inferred.js";

/** The model this layer uses unless `PI_SNIPPET_MODEL` says otherwise. */
export const DEFAULT_INFER_MODEL = "openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";

/** Environment override, for harnesses and for pinning without a flag. */
export const MODEL_ENV_VAR = "PI_SNIPPET_MODEL";

/** How long a single inference may take before it is abandoned. */
const INFER_TIMEOUT_MS = 30_000;

/**
 * Consecutive failures before this layer stands down for the session.
 * Re-armed by `rearm()` — the extension calls it on `session_start`.
 */
const FAILURE_LIMIT = 3;

/** Messages whose answers are kept. Beyond this the oldest key is dropped. */
const CACHE_LIMIT = 64;

export interface PiModel {
	id: string;
	name?: string;
	provider?: string;
}

interface PiRegistry {
	getAvailable?(): PiModel[];
	hasConfiguredAuth?(model: PiModel): boolean;
	getProvider?(provider: string): PiProvider | undefined;
	complete?(
		model: PiModel,
		context: { systemPrompt?: string; messages: unknown[] },
		options?: { maxTokens?: number; signal?: AbortSignal },
	): Promise<{ content?: Array<{ type: string; text?: string }>; stopReason?: string }>;
}

/**
 * The slice of a pi-ai provider this layer needs. `streamSimple` yields
 * AssistantMessageEvents; only the text-bearing shapes are named here.
 */
interface PiProvider {
	streamSimple?(
		model: PiModel,
		context: { systemPrompt?: string; messages: unknown[] },
		options?: { maxTokens?: number; signal?: AbortSignal },
	): AsyncIterable<{ type: string; delta?: string; content?: Array<{ type: string; text?: string }> }> & {
		result?: () => Promise<{ content?: Array<{ type: string; text?: string }>; stopReason?: string }>;
	};
}

export interface InferHost {
	modelRegistry?: PiRegistry;
	signal?: AbortSignal;
}

/** Resolve a `provider/id` or bare `id` against what the registry offers. */
export function resolvePin(pin: string, available: PiModel[]): PiModel | undefined {
	const wanted = pin.trim().toLowerCase();
	if (wanted.length === 0) return undefined;
	return (
		available.find((m) => `${m.provider ?? ""}/${m.id}`.toLowerCase() === wanted) ??
		available.find((m) => m.id.toLowerCase() === wanted)
	);
}

/**
 * The model this layer would use, or undefined when there is nothing to use.
 *
 * The default is obeyed only when the registry knows it and has auth for it —
 * a model that is not configured must cost nothing, not one failed request
 * per message. `PI_SNIPPET_MODEL` overrides it outright.
 */
export function resolveInferenceModel(host: InferHost): PiModel | undefined {
	const registry = host.modelRegistry;
	if (!registry) return undefined;
	let available: PiModel[] = [];
	try {
		available = registry.getAvailable?.() ?? [];
	} catch {
		return undefined;
	}
	const pin = process.env[MODEL_ENV_VAR] ?? DEFAULT_INFER_MODEL;
	const model = resolvePin(pin, available);
	if (!model) return undefined;
	try {
		return registry.hasConfiguredAuth?.(model) ?? false ? model : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Runs inferences and remembers their answers.
 *
 * Keyed by the exact message text (tags included — they are part of what the
 * model sees) rather than by a message id: the same text re-rendered after a
 * resize, a fork, or a `/tree` walk is the same question, and a session that
 * comes back to it should not pay again.
 */
export class InferenceEngine {
	private readonly cache = new Map<string, string[]>();
	private readonly inFlight = new Map<string, Promise<string[]>>();
	private failures = 0;

	/** True once the layer has given up for the session. */
	get stoodDown(): boolean {
		return this.failures >= FAILURE_LIMIT;
	}

	/** Try again — a new session, or credentials that were fixed meanwhile. */
	rearm(): void {
		this.failures = 0;
	}

	/** Cached answer for a message, without asking. */
	peek(messageText: string): string[] | undefined {
		return this.cache.get(messageText);
	}

	private remember(key: string, value: string[]): void {
		this.cache.set(key, value);
		while (this.cache.size > CACHE_LIMIT) {
			const oldest = this.cache.keys().next();
			if (oldest.done) break;
			this.cache.delete(oldest.value);
		}
	}

	/**
	 * Infer chips for a message, reusing a cached or in-flight answer.
	 *
	 * `messageText` is the message as stored, layer-1 tags included — the
	 * second model sees them so it can add to them rather than duplicate
	 * them. `existing` names what layer 1 already painted, so its duplicates
	 * are dropped at validation time. `onChip` fires once per newly completed
	 * anchor as the reply streams in — and, on the cache path, once per
	 * anchor immediately, so a caller can treat the two paths alike. Resolves
	 * to the full anchor list, `[]` on every failure path.
	 */
	async infer(
		messageText: string,
		host: InferHost,
		existing: readonly string[],
		onChip?: (anchor: string) => void,
	): Promise<string[]> {
		const cached = this.cache.get(messageText);
		if (cached) {
			for (const anchor of cached) onChip?.(anchor);
			return cached;
		}
		const pending = this.inFlight.get(messageText);
		if (pending) return pending;
		if (this.stoodDown) return [];

		const model = resolveInferenceModel(host);
		const registry = host.modelRegistry;
		if (!model || !registry) return [];

		const run = (async (): Promise<string[]> => {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), INFER_TIMEOUT_MS);
			host.signal?.addEventListener("abort", () => controller.abort());
			const context = {
				systemPrompt: INFER_SYSTEM_PROMPT,
				messages: [{ role: "user", content: buildInferPrompt(messageText) }],
			};
			const options = { maxTokens: maxTokensFor(messageText), signal: controller.signal };
			try {
				const seen = new Set<string>();
				const finalText = await streamOrComplete(
					registry,
					model,
					context,
					options,
					(partial) => {
						for (const anchor of extractAnchors(partial, messageText, existing)) {
							if (!seen.has(anchor)) {
								seen.add(anchor);
								onChip?.(anchor);
							}
						}
					},
				);
				const anchors = extractAnchors(finalText, messageText, existing);
				this.failures = 0;
				this.remember(messageText, anchors);
				return anchors;
			} catch {
				// Timeout, transport failure, a provider that rejected the
				// request: all mean "no chips", never a visible error.
				this.failures++;
				return [];
			} finally {
				clearTimeout(timer);
				this.inFlight.delete(messageText);
			}
		})();

		this.inFlight.set(messageText, run);
		return run;
	}
}

/** Room for the re-emitted message plus its tags. */
function maxTokensFor(text: string): number {
	return Math.min(8192, Math.ceil(text.length / 3) + 512);
}

/**
 * Stream the reply, handing each accumulated prefix to `onPartial`, or fall
 * back to a single-shot `complete` when the provider cannot stream.
 *
 * Both paths end with the reply's full text; the caller parses that one final
 * time so the resolved answer does not depend on which path ran.
 */
async function streamOrComplete(
	registry: PiRegistry,
	model: PiModel,
	context: { systemPrompt?: string; messages: unknown[] },
	options: { maxTokens?: number; signal?: AbortSignal },
	onPartial: (accumulated: string) => void,
): Promise<string> {
	let provider: PiProvider | undefined;
	try {
		provider = registry.getProvider?.(model.provider ?? "");
	} catch {
		provider = undefined;
	}
	if (provider?.streamSimple) {
		let acc = "";
		const stream = provider.streamSimple(model, context, options);
		for await (const event of stream) {
			if (event.type === "text_delta" && typeof event.delta === "string") {
				acc += event.delta;
				onPartial(acc);
			} else if (event.type === "error") {
				throw new Error("inference stream failed");
			}
		}
		return acc;
	}
	if (typeof registry.complete !== "function") {
		throw new Error("no way to reach the second model");
	}
	const response = await registry.complete(model, context, options);
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(`inference stopped: ${response.stopReason}`);
	}
	const text = (response.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("");
	onPartial(text);
	return text;
}
