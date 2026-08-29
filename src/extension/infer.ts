/**
 * The second model: reads a finished assistant message and streams back the
 * same message with `<snippet>` tags added (shared/inferred.ts holds the
 * contract and the validation).
 *
 * ## Which model
 *
 * A fixed one, chosen deliberately rather than guessed: OpenRouter's
 * `qwen/qwen3.7-flash`. Small and cheap rather than free — this layer runs
 * after every question-bearing message, so its latency must be invisible and
 * its cost per call must round to nothing (~$0.00004 at this model's rates:
 * a few hundred tokens in, a hundred or so out). The free tier was tried
 * first and lost on availability, not on quality: OpenRouter meters free
 * models per day across the whole account, so the layer would fail with a 429
 * for the rest of the day after fifty calls — silently, since it surfaces
 * nothing. `PI_SNIPPET_MODEL` (`provider/id`, or a bare id) overrides it,
 * which is how the tests point it at a mock.
 *
 * ## How it runs
 *
 * Streaming, via the provider's own `streamSimple`, with the session's
 * credentials fetched from the registry (`getApiKeyAndHeaders`) and passed
 * per call — `getProvider()` returns a bare transport, so a call made without
 * them dies instantly with "No API key for provider: …" and, since this layer
 * surfaces nothing, looks exactly like a model that had nothing to add. Each
 * `text_delta` re-runs the extraction against the
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

import { fuzzyFilter } from "@earendil-works/pi-tui";
import {
	buildInferPrompt,
	extractAnchors,
	INFER_SYSTEM_PROMPT,
} from "../shared/inferred.js";

/** The model this layer uses unless `PI_SNIPPET_MODEL` or `/snippets` say otherwise. */
export const DEFAULT_INFER_MODEL = "openrouter/qwen/qwen3.7-flash";

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

export interface ModelCompletionItem {
	value: string;
	label: string;
	description?: string;
}

/**
 * `provider/id` completions for `/snippets model`'s argument, ranked by pi's
 * own fuzzy matcher (`@earendil-works/pi-tui`'s `fuzzyFilter` — word-boundary
 * and consecutive-run bonuses, an alpha/digit swap heuristic) so typing here
 * feels the same as typing after `/model`. Bundled at build time, not a
 * runtime dependency on whatever pi-tui a host process happens to carry.
 */
export function modelCompletions(query: string, available: readonly PiModel[]): ModelCompletionItem[] {
	const items = available.map((m) => ({
		model: m,
		searchText: `${m.provider ?? ""}/${m.id} ${m.name ?? ""}`,
	}));
	return fuzzyFilter(items, query, (item) => item.searchText).map(({ model }) => ({
		value: `${model.provider ?? ""}/${model.id}`,
		label: model.id,
		description: model.provider,
	}));
}

/** Credentials for one model, as the registry hands them out. */
interface ProviderAuth {
	ok?: boolean;
	apiKey?: string;
	headers?: Record<string, string>;
}

interface PiRegistry {
	getAvailable?(): PiModel[];
	hasConfiguredAuth?(model: PiModel): boolean;
	getApiKeyAndHeaders?(model: PiModel): ProviderAuth | Promise<ProviderAuth>;
	getProvider?(provider: string): PiProvider | undefined;
	complete?(
		model: PiModel,
		context: { systemPrompt?: string; messages: unknown[] },
		options?: CallOptions,
	): Promise<{ content?: Array<{ type: string; text?: string }>; stopReason?: string }>;
}

/**
 * What a provider needs to make one call. The credentials belong here rather
 * than on the provider: `getProvider()` hands out a bare transport that knows
 * its base URL and nothing about the session's auth, so a call made without
 * them fails at once with "No API key for provider: …" — which this layer
 * would then swallow as an ordinary failure, since it surfaces none of its own.
 */
interface CallOptions {
	maxTokens?: number;
	signal?: AbortSignal;
	apiKey?: string;
	headers?: Record<string, string>;
}

/**
 * The slice of a pi-ai provider this layer needs. `streamSimple` yields
 * AssistantMessageEvents; only the text-bearing shapes are named here.
 */
interface PiProvider {
	streamSimple?(
		model: PiModel,
		context: { systemPrompt?: string; messages: unknown[] },
		options?: CallOptions,
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
 * Sources, in order: `PI_SNIPPET_MODEL` (a session-level override, the same
 * role `--no-suggestions` plays), the stored `/snippets` choice
 * (`explicitPin`), the built-in default. A pin the registry knows is obeyed —
 * or refused outright when it has no auth, never substituted. A pin it does
 * not know (a model removed from the catalogue) falls through to the next
 * source rather than silently switching the layer off.
 */
export function resolveInferenceModel(host: InferHost, explicitPin?: string): PiModel | undefined {
	const registry = host.modelRegistry;
	if (!registry) return undefined;
	let available: PiModel[] = [];
	try {
		available = registry.getAvailable?.() ?? [];
	} catch {
		return undefined;
	}
	const sources = [process.env[MODEL_ENV_VAR], explicitPin, DEFAULT_INFER_MODEL]
		.map((pin) => pin?.trim())
		.filter((pin): pin is string => typeof pin === "string" && pin.length > 0);
	for (const pin of sources) {
		const model = resolvePin(pin, available);
		if (!model) continue; // unknown: try the next source
		try {
			if (registry.hasConfiguredAuth?.(model) ?? false) return model;
		} catch {
			/* fall through */
		}
		return undefined; // known but unusable: refuse, never substitute
	}
	return undefined;
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
	private readonly inFlight = new Map<string, Promise<string[] | null>>();
	private failures = 0;

	/**
	 * The stored `/snippets` choice, read per call so a model change in the
	 * menu applies to the next message without a reload.
	 */
	private readonly getPin: () => string | undefined;

	constructor(getPin: () => string | undefined = () => undefined) {
		this.getPin = getPin;
	}

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
	 * to the full anchor list — `[]` when a reply arrived and added nothing,
	 * `null` when the layer could not run at all: gate said no, no model or
	 * no auth, stood down, or the request itself failed. The distinction is
	 * what lets the footer report an honest zero without claiming the layer
	 * ran when it never sent anything.
	 */
	async infer(
		messageText: string,
		host: InferHost,
		existing: readonly string[],
		onChip?: (anchor: string) => void,
	): Promise<string[] | null> {
		const cached = this.cache.get(messageText);
		if (cached) {
			for (const anchor of cached) onChip?.(anchor);
			return cached;
		}
		const pending = this.inFlight.get(messageText);
		if (pending) return pending;
		if (this.stoodDown) return null;

		const model = resolveInferenceModel(host, this.getPin());
		const registry = host.modelRegistry;
		if (!model || !registry) return null;

		const run = (async (): Promise<string[] | null> => {
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
				// request: all mean "the layer did not run", never a visible
				// error — and never a zero report, which would claim a reply
				// arrived when none did.
				this.failures++;
				return null;
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
 * The session's credentials for a model, or nothing when the registry has no
 * such method (an older pi, a test double) or cannot answer.
 *
 * Nothing is the right answer for a provider that needs no key — a mock
 * registered from an extension — and for a registry that reports none: the
 * call is made anyway and fails like any other, which is the only failure
 * mode this layer has.
 */
async function credentialsFor(
	registry: PiRegistry,
	model: PiModel,
): Promise<{ apiKey?: string; headers?: Record<string, string> }> {
	try {
		const auth = await registry.getApiKeyAndHeaders?.(model);
		if (!auth) return {};
		return {
			...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
			...(auth.headers ? { headers: auth.headers } : {}),
		};
	} catch {
		return {};
	}
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
	baseOptions: CallOptions,
	onPartial: (accumulated: string) => void,
): Promise<string> {
	const options = { ...baseOptions, ...(await credentialsFor(registry, model)) };
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
