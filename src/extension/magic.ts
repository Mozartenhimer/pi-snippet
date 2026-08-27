/**
 * The inference layer: a small, fast model reads a finished assistant message
 * and says which spans invite a reply (PRD §17).
 *
 * This exists because mode 1 needs the primary model's cooperation. It has to
 * notice it has asked something and wrap the answer as it writes — and a
 * provider bridge that rebuilds the system prompt may never have shown it the
 * contract at all. When the tags don't come, this layer reads the message
 * after the fact and fills them in.
 *
 * ## Why this is affordable
 *
 * PRD §16 rejected client-side generation as "latency and cost for something
 * the primary model already knows". That holds for messages the primary model
 * *did* tag, which is why this never runs on one. What is left is a small
 * model reading a few hundred tokens, once, on a message that asks a question
 * — and the answer is cached, so a resize, a re-render or a `/tree` walk back
 * to it never pays twice.
 *
 * Latency is spent where nobody is waiting: the call goes out at
 * `message_end`, so by the time a hand reaches the mouse the anchors are
 * usually already there. A click never waits on a model.
 *
 * ## What it will not do
 *
 * - Never runs on a message that already carries `<snippet>` tags.
 * - Never runs unless the message asks something (`asksSomething`).
 * - Never routes to a provider other than the session's own — the assistant
 *   message can contain file contents, and this layer must not become a way
 *   for them to reach somewhere the session wasn't already talking to.
 * - Never surfaces its own failures. No auth, no small model, a timeout, a
 *   refusal, malformed JSON: the message simply has no anchors, exactly as if
 *   the feature were off.
 */

import { buildInferPrompt, INFER_SYSTEM_PROMPT, type InferredSuggestion, parseInferred } from "../shared/inferred.js";

/** How long a single inference may take before it is abandoned. */
const INFER_TIMEOUT_MS = 12_000;

/** Room for four short replies and their anchors, and nothing more. */
const INFER_MAX_TOKENS = 512;

/** Messages whose answers are kept. Beyond this the oldest key is dropped. */
const CACHE_LIMIT = 64;

/**
 * Consecutive failures before this layer stands down for the session.
 *
 * `hasConfiguredAuth()` answers whether credentials are *configured*, not
 * whether they work — an expired key, a revoked token or a model the account
 * cannot invoke all pass that check and then 403 on every call. Without a
 * breaker, every question-bearing message for the rest of the session would
 * fire a request that cannot succeed. Three strikes is enough to tell a dead
 * credential from a blip, and `/snippets` re-arms it.
 */
const FAILURE_LIMIT = 3;

/**
 * Model ids that are small and fast enough to sit in a click's way. Matched
 * against the id, cheapest match wins, and only ever within the provider the
 * session is already using.
 */
const SMALL_MODEL_PATTERN = /haiku|mini|flash|lite|small|nano|micro|8b|7b/i;

/**
 * Small models known to hold up at this job — copying a span verbatim and
 * returning bare JSON. Ranked ahead of merely cheap ones, because the cheapest
 * small model in a large catalogue is often a 3B that paraphrases the anchor,
 * and a paraphrased anchor is a dropped chip. Cost still breaks ties.
 */
const PREFERRED_SMALL = /haiku|-mini|flash|nova-lite/i;

/** Environment override, for harnesses and for pinning without a flag. */
export const MODEL_ENV_VAR = "PI_SNIPPET_MODEL";

interface PiModel {
	id: string;
	name?: string;
	provider?: string;
	cost?: { input?: number; output?: number };
}

interface PiModelRegistry {
	getAvailable?(): PiModel[];
	hasConfiguredAuth?(model: PiModel): boolean;
	complete?(
		model: PiModel,
		context: { systemPrompt?: string; messages: unknown[] },
		options?: { maxTokens?: number; signal?: AbortSignal },
	): Promise<{ content?: Array<{ type: string; text?: string }>; stopReason?: string; usage?: { input?: number; output?: number } }>;
}

export interface MagicHost {
	modelRegistry?: PiModelRegistry;
	model?: PiModel;
	signal?: AbortSignal;
}

/**
 * An explicitly chosen inference model, as `provider/id` or a bare `id`.
 *
 * Auto-selection guesses from the model id, which is fine for the providers
 * whose naming says "small" out loud and useless for a local or renamed one.
 * A pin settles it: `--snippet-model`, `PI_SNIPPET_MODEL`, or the picker in
 * `/snippets`, in that order of specificity.
 */
export type ModelPin = string | undefined;

/** Resolve a `provider/id` or bare `id` against what the registry offers. */
export function resolvePin(pin: ModelPin, available: PiModel[]): PiModel | undefined {
	if (!pin) return undefined;
	const wanted = pin.trim().toLowerCase();
	if (wanted.length === 0) return undefined;
	return (
		available.find((m) => `${m.provider ?? ""}/${m.id}`.toLowerCase() === wanted) ??
		available.find((m) => m.id.toLowerCase() === wanted)
	);
}

/** Tokens spent by this layer, for `/snippets` to report honestly. */
export interface MagicUsage {
	calls: number;
	input: number;
	output: number;
}

function costOf(model: PiModel): number {
	const input = model.cost?.input;
	return typeof input === "number" ? input : Number.POSITIVE_INFINITY;
}

/**
 * The model this layer would use, or undefined when there is nothing suitable.
 *
 * Prefers the cheapest small model of the session's own provider. Falls back
 * to the active model rather than doing nothing — a fallback that would
 * otherwise be an unpleasant surprise on an expensive model, which is why
 * `/snippets` names whatever this picked.
 */
export function pickInferenceModel(host: MagicHost, pin?: ModelPin): PiModel | undefined {
	const registry = host.modelRegistry;
	const active = host.model;
	if (!registry || typeof registry.complete !== "function") return undefined;

	const hasAuth = (model: PiModel): boolean => {
		try {
			return registry.hasConfiguredAuth?.(model) ?? true;
		} catch {
			return false;
		}
	};

	let available: PiModel[] = [];
	try {
		available = registry.getAvailable?.() ?? [];
	} catch {
		available = [];
	}

	// A pin is obeyed even when it is neither small nor cheap — it was asked
	// for by name. It is not obeyed when it has no auth: that would spend every
	// message on a call that cannot succeed.
	const pinned = resolvePin(pin, available);
	if (pinned) return hasAuth(pinned) ? pinned : undefined;

	const candidates = available
		.filter((m) => (active?.provider ? m.provider === active.provider : true))
		.filter((m) => SMALL_MODEL_PATTERN.test(m.id))
		.filter(hasAuth)
		.sort((a, b) => {
			const tier = Number(PREFERRED_SMALL.test(b.id)) - Number(PREFERRED_SMALL.test(a.id));
			return tier !== 0 ? tier : costOf(a) - costOf(b);
		});

	const smallest = candidates[0];
	if (smallest) return smallest;
	if (active && hasAuth(active)) return active;
	return undefined;
}

/** Abort signal that trips on the first of `signals` to abort, or a timeout. */
function deadline(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; done: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const onAbort = () => controller.abort();
	external?.addEventListener("abort", onAbort);
	return {
		signal: controller.signal,
		done: () => {
			clearTimeout(timer);
			external?.removeEventListener("abort", onAbort);
		},
	};
}

/**
 * Runs inferences and remembers their answers.
 *
 * Keyed by the message text itself rather than by a message id: the same text
 * re-rendered after a resize, a fork, or a `/tree` walk is the same question,
 * and a session that comes back to it should not pay again.
 */
export class MagicInferrer {
	private readonly cache = new Map<string, InferredSuggestion[]>();
	private readonly inFlight = new Map<string, Promise<InferredSuggestion[]>>();
	private failures = 0;
	readonly usage: MagicUsage = { calls: 0, input: 0, output: 0 };

	/** True once the layer has given up on this session's provider. */
	get stoodDown(): boolean {
		return this.failures >= FAILURE_LIMIT;
	}

	/** Try again — after a model change, or when the user toggles the layer. */
	rearm(): void {
		this.failures = 0;
	}

	/** Cached answer for a message, without asking. */
	peek(messageText: string): InferredSuggestion[] | undefined {
		return this.cache.get(messageText);
	}

	/** True when an answer for this message is already known or on its way. */
	knows(messageText: string): boolean {
		return this.cache.has(messageText) || this.inFlight.has(messageText);
	}

	private remember(key: string, value: InferredSuggestion[]): void {
		this.cache.set(key, value);
		while (this.cache.size > CACHE_LIMIT) {
			const oldest = this.cache.keys().next();
			if (oldest.done) break;
			this.cache.delete(oldest.value);
		}
	}

	/**
	 * Infer anchors for a message, reusing a cached or in-flight answer.
	 *
	 * Resolves to `[]` on every failure path. A caller can treat the result as
	 * "the anchors for this message", nothing more.
	 */
	async infer(messageText: string, host: MagicHost, pin?: ModelPin): Promise<InferredSuggestion[]> {
		const cached = this.cache.get(messageText);
		if (cached) return cached;
		const pending = this.inFlight.get(messageText);
		if (pending) return pending;
		if (this.stoodDown) return [];

		const model = pickInferenceModel(host, pin);
		const registry = host.modelRegistry;
		if (!model || !registry?.complete) return [];

		const run = (async (): Promise<InferredSuggestion[]> => {
			const { signal, done } = deadline(INFER_TIMEOUT_MS, host.signal);
			try {
				const response = await registry.complete!(
					model,
					{
						systemPrompt: INFER_SYSTEM_PROMPT,
						messages: [
							{ role: "user", content: buildInferPrompt(messageText), timestamp: Date.now() },
						],
					},
					{ maxTokens: INFER_MAX_TOKENS, signal },
				);
				this.usage.calls++;
				this.usage.input += response.usage?.input ?? 0;
				this.usage.output += response.usage?.output ?? 0;
				if (response.stopReason === "error" || response.stopReason === "aborted") {
					// An abort is the user's doing, not the provider's fault.
					if (response.stopReason === "error") this.failures++;
					return [];
				}
				this.failures = 0;
				const text = (response.content ?? [])
					.filter((block) => block.type === "text")
					.map((block) => block.text ?? "")
					.join("");
				const parsed = parseInferred(text, messageText);
				this.remember(messageText, parsed);
				return parsed;
			} catch {
				// Timeout, transport failure, a provider that rejected the request:
				// all mean "no anchors", never a visible error.
				this.failures++;
				return [];
			} finally {
				done();
				this.inFlight.delete(messageText);
			}
		})();

		this.inFlight.set(messageText, run);
		return run;
	}
}

/**
 * Models worth offering in the `/snippets` picker: everything the registry has
 * auth for, small ones first, so the sensible choice is at the top without
 * hiding the unusual one.
 */
export function inferenceCandidates(host: MagicHost): PiModel[] {
	const registry = host.modelRegistry;
	if (!registry || typeof registry.complete !== "function") return [];
	let available: PiModel[] = [];
	try {
		available = registry.getAvailable?.() ?? [];
	} catch {
		return [];
	}
	return available
		.filter((m) => {
			try {
				return registry.hasConfiguredAuth?.(m) ?? true;
			} catch {
				return false;
			}
		})
		.sort((a, b) => {
			const small = Number(SMALL_MODEL_PATTERN.test(b.id)) - Number(SMALL_MODEL_PATTERN.test(a.id));
			if (small !== 0) return small;
			const tier = Number(PREFERRED_SMALL.test(b.id)) - Number(PREFERRED_SMALL.test(a.id));
			return tier !== 0 ? tier : costOf(a) - costOf(b);
		});
}
