/**
 * Live sweep of small-to-mid OpenRouter models against the layer-2 task:
 * send the real prompt for a set of fixed sample messages, then score each
 * reply with the real validation so a model is measured on exactly what the
 * extension would paint. Writes a JSON dump of every result and an HTML
 * report built from it, so a report can be regenerated later without
 * spending money on the API calls again.
 *
 * `--style` picks which of the two live reply shapes (`shared/inferred.ts`,
 * PRD §17) is under test: `reemit` (the default, unchanged from before this
 * flag existed) sends `INFER_SYSTEM_PROMPT` and scores with `extractAnchors`
 * — the model rewrites the whole message with more `<snippet>` tags added.
 * `options` sends `INFER_OPTIONS_SYSTEM_PROMPT` and scores with
 * `extractOptionAnchors` — the model lists bare reply lines instead. Both
 * styles are live in production as an ongoing A/B; running this sweep once
 * per style against the same models and samples is how to compare them
 * side by side rather than by guessing.
 *
 * Entry points:
 *   npm run infer-sweep                              # reemit, all curated (paid) models
 *   npm run infer-sweep -- --style options            # the other reply shape
 *   npm run infer-sweep -- vendor/model ...            # a subset, live
 *   npm run infer-sweep -- --from-json <path>          # rebuild the HTML only
 *
 * Needs OPENROUTER_API_KEY in the environment for a live run; --from-json
 * needs neither the key nor the network. Everything else is fixed strings:
 * no vitest, no live test in the suite — this is a manual harness.
 *
 * Requests for a model's samples run in parallel (Promise.all per model);
 * models themselves are queued through a shared concurrency limit so a
 * dozen models don't open a hundred connections at once.
 *
 * CANDIDATES is paid models only. OpenRouter's `:free` models share one
 * account-wide quota — 50 requests/day without added credits, seen as
 * `free-models-per-day` in a 429 body — which made an all-free sweep
 * unreliable mid-run and untestable for cost; a `:free` id is not in this
 * list for that reason, but pass one explicitly on argv to include it,
 * knowing its cost columns will read zero and its results may be quota
 * noise rather than a real score. `DEFAULT_INFER_MODEL` in
 * `src/extension/infer.ts` (the shipped default, `qwen/qwen3.7-flash`) is
 * paid and simply not curated into this particular list; pass it on argv
 * too if you want it swept.
 *
 * Scores per sample: fidelity (nothing invented or paraphrased — the whole
 * message must come back unchanged under `reemit`, every listed line must
 * be verbatim under `options`), preservation of existing tags (`reemit`
 * only — `options` never re-emits them, so there is nothing to lose),
 * anchors accepted by the style's own extraction function, and anchors the
 * model proposed that validation dropped (invented or paraphrased). Cost is
 * OpenRouter's own measured `usage.cost_details` when the provider returns
 * it, split into input and output; a model that fails every sample can
 * still have spent money (a reasoning model burning its budget on
 * chain-of-thought is billed for those tokens even with empty `content`).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	buildInferPrompt,
	extractAnchors,
	extractOptionAnchors,
	INFER_OPTIONS_SYSTEM_PROMPT,
	INFER_SYSTEM_PROMPT,
	unfence,
	type InferStyle,
} from "../src/shared/inferred.js";
import { parseSuggestions } from "../src/shared/suggestions.js";

interface ModelSpec {
	id: string;
	/** Active parameters in billions, as stated by OpenRouter's catalog (a MoE's total may be far larger). NaN when unknown (a bare argv override). */
	params: number;
	/** List price, USD per 1M input tokens. NaN when unknown. */
	inputPerM: number;
	/** List price, USD per 1M output tokens. NaN when unknown. */
	outputPerM: number;
}

/**
 * The curated candidates: paid OpenRouter models with 8B-50B (active)
 * parameters, one per model family where OpenRouter lists several
 * near-duplicate sizes. Pulled from a live `GET /api/v1/models` snapshot
 * (ids, params, and $/1M pricing) and hand-picked, not filtered at run
 * time, so a sweep is reproducible and a model only enters by a reviewed
 * edit here.
 */
const CANDIDATES: ModelSpec[] = [
	{ id: "meta-llama/llama-3.1-8b-instruct", params: 8, inputPerM: 0.05, outputPerM: 0.08 },
	{ id: "mistralai/ministral-8b-2512", params: 8, inputPerM: 0.15, outputPerM: 0.15 },
	{ id: "qwen/qwen3-8b", params: 8, inputPerM: 0.117, outputPerM: 0.455 },
	{ id: "ibm-granite/granite-4.1-8b", params: 8, inputPerM: 0.05, outputPerM: 0.1 },
	{ id: "qwen/qwen3.5-9b", params: 9, inputPerM: 0.1, outputPerM: 0.15 },
	{ id: "google/gemma-3-12b-it", params: 12, inputPerM: 0.05, outputPerM: 0.15 },
	{ id: "upstage/solar-pro-3", params: 12, inputPerM: 0.15, outputPerM: 0.6 },
	{ id: "thinkingmachines/inkling-small", params: 12, inputPerM: 0.45, outputPerM: 1.2 },
	{ id: "mistralai/ministral-14b-2512", params: 14, inputPerM: 0.2, outputPerM: 0.2 },
	{ id: "qwen/qwen3-14b", params: 14, inputPerM: 0.12, outputPerM: 0.24 },
	{ id: "openai/gpt-oss-safeguard-20b", params: 20, inputPerM: 0.075, outputPerM: 0.3 },
	{ id: "mistralai/mistral-small-3.2-24b-instruct", params: 24, inputPerM: 0.075, outputPerM: 0.2 },
	{ id: "google/gemma-4-26b-a4b-it", params: 26, inputPerM: 0.07, outputPerM: 0.34 },
	{ id: "google/gemma-3-27b-it", params: 27, inputPerM: 0.08, outputPerM: 0.45 },
	{ id: "qwen/qwen3-coder-30b-a3b-instruct", params: 30, inputPerM: 0.07, outputPerM: 0.28 },
	{ id: "qwen/qwen3-32b", params: 32, inputPerM: 0.08, outputPerM: 0.28 },
	{ id: "mistralai/mixtral-8x22b-instruct", params: 39, inputPerM: 2.0, outputPerM: 6.0 },
	{ id: "tencent/hy4-preview", params: 49, inputPerM: 0.834, outputPerM: 2.501 },
];

interface Sample {
	/** The message exactly as the extension would send it, tags included. */
	message: string;
	/** Layer-1 chips, i.e. what the second model must preserve. */
	existing: string[];
	/** What a good reply adds — shown in the report for eyeballing, not asserted automatically. */
	hopedFor: string[];
}

const SAMPLES: Sample[] = [
	{
		message: "The build failed in three places. Want me to fix them one at a time, or show you all three errors first?",
		existing: [],
		hopedFor: ["fix them one at a time", "show you all three errors first"],
	},
	{
		message: "I found the bug: the socket path was cached from the previous session. Shall I proceed with the fix?",
		existing: [],
		hopedFor: ["proceed"],
	},
	{
		message: "Here's what I'd do next: refactor the parser, add tests for the chord path, or update the docs. Which would you like?",
		existing: [],
		hopedFor: ["refactor the parser", "add tests for the chord path", "update the docs"],
	},
	{
		message: "The build failed in three places. Want me to fix them one at a time, or show you all three errors first?",
		existing: ["fix them one at a time"],
		hopedFor: ["show you all three errors first"],
	},
	{
		message: "I've pushed the branch and CI is green.",
		existing: [],
		hopedFor: [],
	},
];

/** Tags stripped from both sides — the prompt's copy-fidelity hard rule. */
const stripTags = (text: string): string => text.replace(/<\/?snippet>/g, "");

interface Usage {
	prompt_tokens?: number;
	completion_tokens?: number;
	cost?: number;
	cost_details?: { upstream_inference_prompt_cost?: number; upstream_inference_completions_cost?: number };
}

interface Cost {
	promptTokens: number;
	completionTokens: number;
	inputCost: number;
	outputCost: number;
	totalCost: number;
}

/** Measured spend when OpenRouter returns it, else a list-price estimate from token counts. */
function computeCost(model: ModelSpec, usage: Usage | undefined): Cost | undefined {
	if (!usage) return undefined;
	const promptTokens = usage.prompt_tokens ?? 0;
	const completionTokens = usage.completion_tokens ?? 0;
	const inputCost =
		usage.cost_details?.upstream_inference_prompt_cost ??
		(Number.isFinite(model.inputPerM) ? (promptTokens / 1_000_000) * model.inputPerM : undefined);
	const outputCost =
		usage.cost_details?.upstream_inference_completions_cost ??
		(Number.isFinite(model.outputPerM) ? (completionTokens / 1_000_000) * model.outputPerM : undefined);
	if (inputCost === undefined && outputCost === undefined && usage.cost === undefined) return undefined;
	return {
		promptTokens,
		completionTokens,
		inputCost: inputCost ?? 0,
		outputCost: outputCost ?? 0,
		totalCost: usage.cost ?? (inputCost ?? 0) + (outputCost ?? 0),
	};
}

interface SampleResult {
	ok: boolean;
	latencyMs: number;
	copyFidelity: boolean;
	preserved: boolean;
	proposed: number;
	accepted: string[];
	dropped: string[];
	raw?: string;
	note?: string;
	cost?: Cost;
}

async function runSample(model: ModelSpec, sample: Sample, style: InferStyle): Promise<SampleResult> {
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 60_000);
	try {
		const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
			method: "POST",
			signal: controller.signal,
			headers: {
				authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: model.id,
				max_tokens: 2048,
				temperature: 0,
				messages: [
					{ role: "system", content: style === "options" ? INFER_OPTIONS_SYSTEM_PROMPT : INFER_SYSTEM_PROMPT },
					{ role: "user", content: buildInferPrompt(sample.message) },
				],
			}),
		});
		const latencyMs = Date.now() - started;
		if (!res.ok) {
			const body = await res.text();
			return {
				ok: false,
				latencyMs,
				copyFidelity: false,
				preserved: false,
				proposed: 0,
				accepted: [],
				dropped: [],
				note: `HTTP ${res.status}: ${body.slice(0, 200)}`,
			};
		}
		const data = (await res.json()) as {
			choices?: Array<{ message?: { content?: string } }>;
			usage?: Usage;
		};
		const cost = computeCost(model, data.usage);
		const raw = data.choices?.[0]?.message?.content ?? "";
		if (raw.trim() === "") {
			// Reasoning models can spend the whole max_tokens budget on chain-of-
			// thought (reasoning_details in the response) before emitting content
			// — seen live with qwen/qwen3.5-9b, 1400+ reasoning tokens for a
			// one-line reply. That is a real disqualifier for this layer, not a
			// request bug: raising max_tokens buys correctness at the cost of the
			// latency and price layer 2 exists to avoid. The tokens are still
			// billed, so `cost` is kept even though the sample failed.
			return {
				ok: false,
				latencyMs,
				copyFidelity: false,
				preserved: false,
				proposed: 0,
				accepted: [],
				dropped: [],
				note: "empty reply (a reasoning model may have spent the token budget on chain-of-thought)",
				cost,
			};
		}
		const reply = unfence(raw);
		let proposed: number;
		let copyFidelity: boolean;
		let preserved: boolean;
		let accepted: string[];
		let dropped: string[];
		if (style === "options") {
			const lines = reply
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0);
			proposed = lines.length;
			accepted = extractOptionAnchors(reply, sample.message, sample.existing);
			dropped = lines.filter((line) => !sample.existing.includes(line) && !accepted.includes(line));
			// There is no re-emitted message to diff against a tag-preservation
			// rule, so both fidelity concepts collapse to one question: did every
			// listed line survive validation, i.e. was nothing invented or
			// paraphrased. Nothing is ever "lost" here — the model never had to
			// carry an existing chip forward — so `preserved` is trivially true.
			copyFidelity = dropped.length === 0;
			preserved = true;
		} else {
			const { nodes } = parseSuggestions(reply);
			proposed = nodes.filter((n) => n.type === "suggestion").length;
			copyFidelity = stripTags(reply) === stripTags(sample.message);
			preserved = sample.existing.every((t) => stripTags(reply).includes(t));
			accepted = extractAnchors(reply, sample.message, sample.existing);
			dropped = nodes
				.filter((n): n is Extract<typeof n, { type: "suggestion" }> => n.type === "suggestion")
				.map((n) => n.text)
				.filter((t) => !sample.existing.includes(t) && !accepted.includes(t));
		}
		return { ok: true, latencyMs, copyFidelity, preserved, proposed, accepted, dropped, raw, cost };
	} catch (err) {
		const latencyMs = Date.now() - started;
		return {
			ok: false,
			latencyMs,
			copyFidelity: false,
			preserved: false,
			proposed: 0,
			accepted: [],
			dropped: [],
			note: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
		};
	} finally {
		clearTimeout(timer);
	}
}

/** Bounds total in-flight requests across every model×sample task. */
function makeLimiter(concurrency: number) {
	let active = 0;
	const queue: Array<() => void> = [];
	return async function limit<T>(fn: () => Promise<T>): Promise<T> {
		if (active >= concurrency) await new Promise<void>((resolve) => queue.push(resolve));
		active++;
		try {
			return await fn();
		} finally {
			active--;
			queue.shift()?.();
		}
	};
}

interface ModelRow {
	model: ModelSpec;
	results: SampleResult[]; // aligned with the samples that produced them
	fidelity: number;
	preserved: number;
	anchors: number;
	dropped: number;
	failed: number;
	ms: number[];
	inputCost: number;
	outputCost: number;
	totalCost: number;
	costKnown: boolean;
}

function summarizeRow(model: ModelSpec, results: SampleResult[], samples: Sample[]): ModelRow {
	const row: ModelRow = {
		model,
		results,
		fidelity: 0,
		preserved: 0,
		anchors: 0,
		dropped: 0,
		failed: 0,
		ms: [],
		inputCost: 0,
		outputCost: 0,
		totalCost: 0,
		costKnown: false,
	};
	results.forEach((r, i) => {
		if (r.cost) {
			row.costKnown = true;
			row.inputCost += r.cost.inputCost;
			row.outputCost += r.cost.outputCost;
			row.totalCost += r.cost.totalCost;
		}
		if (!r.ok) {
			row.failed += 1;
			return;
		}
		row.ms.push(r.latencyMs);
		if (r.copyFidelity) row.fidelity += 1;
		if (samples[i]!.existing.length > 0 && r.preserved) row.preserved += 1;
		row.anchors += r.accepted.length;
		row.dropped += r.dropped.length;
	});
	return row;
}

interface SweepData {
	generatedAt: string;
	style: InferStyle;
	systemPrompt: string;
	samples: Sample[];
	rows: Array<{ model: ModelSpec; results: SampleResult[] }>;
}

async function runModel(
	model: ModelSpec,
	limit: <T>(fn: () => Promise<T>) => Promise<T>,
	style: InferStyle,
): Promise<ModelRow> {
	const results = await Promise.all(SAMPLES.map((sample) => limit(() => runSample(model, sample, style))));
	return summarizeRow(model, results, SAMPLES);
}

// ---- CLI ----

const argv = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
	const i = argv.indexOf(name);
	return i !== -1 ? argv[i + 1] : undefined;
};
const styleArg = flagValue("--style") ?? "reemit";
if (styleArg !== "reemit" && styleArg !== "options") {
	console.error(`--style must be "reemit" or "options", got ${JSON.stringify(styleArg)}`);
	process.exit(1);
}
const style: InferStyle = styleArg;
const outPath = flagValue("--out") ?? `scripts/.build/infer-sweep-report.${style}.html`;
const jsonPath = flagValue("--json") ?? outPath.replace(/\.html?$/, ".json");
const fromJsonPath = flagValue("--from-json");
const argvModels = argv.filter(
	(a, i, arr) =>
		!a.startsWith("-") &&
		arr[i - 1] !== "--out" &&
		arr[i - 1] !== "--json" &&
		arr[i - 1] !== "--from-json" &&
		arr[i - 1] !== "--style",
);

let data: SweepData;

if (fromJsonPath) {
	const loaded = JSON.parse(readFileSync(fromJsonPath, "utf8")) as Omit<SweepData, "style"> & {
		style?: InferStyle;
	};
	// Older dumps, from before `--style` existed, carried only the reemit
	// shape — read across the same way `settings.ts` reads a stale key.
	data = { style: "reemit", ...loaded };
	console.log(
		`Regenerating from ${fromJsonPath} (${data.rows.length} model(s), style=${data.style}, captured ${data.generatedAt}), no network calls.`,
	);
} else {
	if (!process.env.OPENROUTER_API_KEY) {
		console.error("OPENROUTER_API_KEY is not set");
		process.exit(1);
	}
	const byId = new Map(CANDIDATES.map((m) => [m.id, m]));
	const models: ModelSpec[] =
		argvModels.length > 0
			? argvModels.map((id) => byId.get(id) ?? { id, params: NaN, inputPerM: NaN, outputPerM: NaN })
			: CANDIDATES;

	const limit = makeLimiter(8);
	console.log(
		`Sweeping ${models.length} model(s) across ${SAMPLES.length} samples, style=${style} (up to 8 requests in flight)…\n`,
	);
	const rows = await Promise.all(models.map((m) => runModel(m, limit, style)));

	for (const row of rows) {
		console.log(`=== ${row.model.id}`);
		row.results.forEach((r, i) => {
			const sample = SAMPLES[i]!;
			const costNote = r.cost ? ` cost=$${r.cost.totalCost.toFixed(6)}` : "";
			if (!r.ok) {
				console.log(`  [${i}] FAILED ${r.latencyMs}ms${costNote} — ${r.note}`);
				return;
			}
			const mark = `${r.copyFidelity ? "copy-ok" : "COPY-DRIFT"}${
				sample.existing.length > 0 ? (r.preserved ? " kept-tags" : " LOST-TAGS") : ""
			}`;
			console.log(`  [${i}] ${mark} ${r.latencyMs}ms${costNote} proposed=${r.proposed} accepted=${r.accepted.length}`);
			if (r.accepted.length > 0) console.log(`      + ${JSON.stringify(r.accepted)}`);
			if (r.dropped.length > 0) console.log(`      - dropped: ${JSON.stringify(r.dropped)}`);
		});
		console.log();
	}

	const samplesWithExisting = SAMPLES.filter((s) => s.existing.length > 0).length;
	console.log(`=== summary (${SAMPLES.length} samples per model)`);
	console.log(`model\tcopy\tpreserved\tanchors\tdropped\tfailed\tmedian ms\tin $\tout $\ttotal $`);
	let sweepTotalCost = 0;
	for (const row of rows) {
		const sorted = [...row.ms].sort((a, b) => a - b);
		const med = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : NaN;
		sweepTotalCost += row.totalCost;
		console.log(
			`${row.model.id}\t${row.fidelity}/${SAMPLES.length}\t${row.preserved}/${samplesWithExisting}\t${row.anchors}\t${row.dropped}\t${row.failed}\t${med}\t${row.inputCost.toFixed(6)}\t${row.outputCost.toFixed(6)}\t${row.totalCost.toFixed(6)}`,
		);
	}
	console.log(`\nTotal spend this sweep: $${sweepTotalCost.toFixed(6)}`);

	data = {
		generatedAt: new Date().toISOString(),
		style,
		systemPrompt: style === "options" ? INFER_OPTIONS_SYSTEM_PROMPT : INFER_SYSTEM_PROMPT,
		samples: SAMPLES,
		rows: rows.map((r) => ({ model: r.model, results: r.results })),
	};
	mkdirSync(dirname(jsonPath), { recursive: true });
	writeFileSync(jsonPath, JSON.stringify(data, null, 2), "utf8");
	console.log(`\nJSON dump written to ${jsonPath}`);
}

// ---- HTML report ----

const rows = data.rows.map((r) => summarizeRow(r.model, r.results, data.samples));
const samplesWithExisting = data.samples.filter((s) => s.existing.length > 0).length;

const esc = (s: string): string =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Renders a message's <snippet> tags as visible chip-like spans instead of raw markup. */
function renderTagged(text: string): string {
	return esc(text)
		.replace(/&lt;snippet&gt;/g, '<span class="chip">')
		.replace(/&lt;\/snippet&gt;/g, "</span>");
}

function median(ms: number[]): number | undefined {
	if (ms.length === 0) return undefined;
	const sorted = [...ms].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

function fmtCost(v: number | undefined): string {
	if (v === undefined || !Number.isFinite(v)) return "?";
	if (v === 0) return "$0";
	return `$${v < 0.01 ? v.toFixed(6) : v.toFixed(4)}`;
}

function fmtRate(v: number): string {
	return Number.isFinite(v) ? `$${v.toFixed(3)}/1M` : "?";
}

function scoreRow(row: ModelRow): number {
	// Fidelity and tag-preservation are hard rules; anchors found is the payoff.
	const fidelityRate = row.fidelity / data.samples.length;
	const preservedRate = samplesWithExisting > 0 ? row.preserved / samplesWithExisting : 1;
	return fidelityRate * 2 + preservedRate + row.anchors * 0.1 - row.failed - row.dropped * 0.05;
}

const ranked = [...rows].sort((a, b) => scoreRow(b) - scoreRow(a));
const sweepTotalCost = rows.reduce((sum, r) => sum + r.totalCost, 0);

const promptsHtml = `
<section>
  <h2>Prompts</h2>
  <details>
    <summary>System prompt (${data.style === "options" ? "INFER_OPTIONS_SYSTEM_PROMPT" : "INFER_SYSTEM_PROMPT"})</summary>
    <pre class="prompt">${esc(data.systemPrompt)}</pre>
  </details>
  <table class="samples">
    <thead><tr><th>#</th><th>Message sent (existing tags shown as chips)</th><th>Hoped-for additions</th></tr></thead>
    <tbody>
      ${data.samples
				.map(
					(s, i) => `<tr>
        <td>${i}</td>
        <td>${renderTagged(s.message)}</td>
        <td>${s.hopedFor.length > 0 ? s.hopedFor.map((h) => `<span class="chip">${esc(h)}</span>`).join(" ") : "<em>none</em>"}</td>
      </tr>`,
				)
				.join("\n      ")}
    </tbody>
  </table>
</section>`;

const summaryHtml = `
<section>
  <h2>Summary</h2>
  <table class="summary">
    <thead>
      <tr>
        <th>Model</th><th>Params</th><th>$/1M in</th><th>$/1M out</th>
        <th>Copy fidelity</th><th>Tags preserved</th>
        <th>Anchors accepted</th><th>Anchors dropped</th><th>Failed</th><th>Median ms</th>
        <th>Input $</th><th>Output $</th><th>Total $</th>
      </tr>
    </thead>
    <tbody>
      ${ranked
				.map((row) => {
					const fidelityOk = row.fidelity === data.samples.length;
					const preservedOk = samplesWithExisting === 0 || row.preserved === samplesWithExisting;
					const m = median(row.ms);
					return `<tr>
        <td>${esc(row.model.id)}</td>
        <td>${Number.isFinite(row.model.params) ? `${row.model.params}B` : "?"}</td>
        <td>${fmtRate(row.model.inputPerM)}</td>
        <td>${fmtRate(row.model.outputPerM)}</td>
        <td class="${fidelityOk ? "good" : "bad"}">${row.fidelity}/${data.samples.length}</td>
        <td class="${preservedOk ? "good" : "bad"}">${samplesWithExisting > 0 ? `${row.preserved}/${samplesWithExisting}` : "n/a"}</td>
        <td>${row.anchors}</td>
        <td class="${row.dropped === 0 ? "" : "warn"}">${row.dropped}</td>
        <td class="${row.failed === 0 ? "" : "bad"}">${row.failed}</td>
        <td>${m ?? "—"}</td>
        <td>${row.costKnown ? fmtCost(row.inputCost) : "?"}</td>
        <td>${row.costKnown ? fmtCost(row.outputCost) : "?"}</td>
        <td>${row.costKnown ? fmtCost(row.totalCost) : "?"}</td>
      </tr>`;
				})
				.join("\n      ")}
    </tbody>
    <tfoot>
      <tr><td colspan="12" style="text-align:right">Total spend, this sweep:</td><td>${fmtCost(sweepTotalCost)}</td></tr>
    </tfoot>
  </table>
</section>`;

function cellHtml(r: SampleResult, sample: Sample): string {
	const costLine = r.cost ? `<div class="ms">${fmtCost(r.cost.totalCost)} (${r.cost.promptTokens}in/${r.cost.completionTokens}out)</div>` : "";
	if (!r.ok) return `<div class="cell fail">FAILED<br><span class="note">${esc(r.note ?? "")}</span>${costLine}</div>`;
	const badge = r.copyFidelity ? '<span class="badge good">copy-ok</span>' : '<span class="badge bad">copy-drift</span>';
	const tagBadge =
		sample.existing.length > 0
			? r.preserved
				? '<span class="badge good">kept-tags</span>'
				: '<span class="badge bad">lost-tags</span>'
			: "";
	const accepted =
		r.accepted.length > 0
			? `<div class="anchors">${r.accepted.map((a) => `<span class="chip">${esc(a)}</span>`).join(" ")}</div>`
			: "";
	const dropped =
		r.dropped.length > 0
			? `<div class="dropped">dropped: ${r.dropped.map((a) => `<span class="chip-dropped">${esc(a)}</span>`).join(" ")}</div>`
			: "";
	return `<div class="cell">${badge} ${tagBadge}<div class="ms">${r.latencyMs}ms</div>${costLine}${accepted}${dropped}</div>`;
}

const detailHtml = `
<section>
  <h2>Per-sample detail</h2>
  <table class="detail">
    <thead>
      <tr><th>Model</th>${data.samples.map((_, i) => `<th>Sample ${i}</th>`).join("")}</tr>
    </thead>
    <tbody>
      ${ranked
				.map(
					(row) =>
						`<tr><td class="modelname">${esc(row.model.id)}</td>${row.results
							.map((r, i) => `<td>${cellHtml(r, data.samples[i]!)}</td>`)
							.join("")}</tr>`,
				)
				.join("\n      ")}
    </tbody>
  </table>
</section>`;

const legendHtml = `
<section>
  <h2>Column reference</h2>
  <dl class="legend">
    <dt>Model</dt><dd>OpenRouter model id, exactly as sent in the API request.</dd>
    <dt>Params</dt><dd>Active parameters in billions, as OpenRouter's catalog states them. A mixture-of-experts model's total parameter count can be far larger than what's active per token; this is the active figure, which is what governs cost and latency.</dd>
    <dt>$/1M in, $/1M out</dt><dd>List price from OpenRouter's catalog at the time <code>CANDIDATES</code> was curated — a reference, not what this sweep actually paid (see Input $/Output $/Total $).</dd>
    <dt>Copy fidelity</dt><dd>${
			data.style === "options"
				? "Samples (out of the total) where every line the model listed survived <code>extractOptionAnchors</code> \u2014 nothing invented, paraphrased, or already covered. There is no re-emitted message to diff here (that is the <code>reemit</code> style's version of this column); a model that drifts is proposing lines that are not the user's own words."
				: "Samples (out of the total) where the reply, with all &lt;snippet&gt; tags stripped, was byte-identical to the message sent, with tags stripped the same way. This is <code>INFER_SYSTEM_PROMPT</code>'s hard rule: no paraphrasing, no dropped or added words. A model that drifts here cannot be trusted not to corrupt a transcript."
		}</dd>
    <dt>Tags preserved</dt><dd>${
			data.style === "options"
				? "Not meaningful under this style \u2014 <code>options</code> never re-emits the message, so there is nothing for the model to lose. Always shown as fully preserved."
				: "Of the samples that included an existing &lt;snippet&gt; tag (layer 1's own chip), how many the model left untouched. Only one sample in the fixed set has an existing tag, so this is out of 1, not out of the sample count."
		}</dd>
    <dt>Anchors accepted</dt><dd>Total chips, summed across every sample, that passed the style's own extraction function (<code>extractAnchors</code> for <code>reemit</code>, <code>extractOptionAnchors</code> for <code>options</code>) \u2014 found verbatim in the original message's non-code text and not overlapping a chip that already existed. These are the chips layer 2 would actually paint.</dd>
    <dt>Anchors dropped</dt><dd>Tags or lines the model proposed that the style's extraction function rejected: invented text, a paraphrase, or a span already covered. A model with fidelity intact but many drops is hallucinating snippets, not just failing to add them.</dd>
    <dt>Failed</dt><dd>Samples where the request errored, timed out, or came back with an empty reply (including a reasoning model that spent its whole token budget on chain-of-thought before writing content).</dd>
    <dt>Median ms</dt><dd>Median latency across the samples that returned a response at all (failed samples are excluded, not counted as 0ms).</dd>
    <dt>Input $, Output $, Total $</dt><dd>Measured spend, summed across every sample for that model. Read from OpenRouter's own <code>usage.cost_details</code> when the provider returns it; otherwise estimated from token counts against the list price. Includes failed samples \u2014 a reasoning model that returns empty content is still billed for the reasoning tokens it generated.</dd>
    <dt>copy-ok / copy-drift badge</dt><dd>Per-sample version of Copy fidelity.</dd>
    <dt>kept-tags / lost-tags badge</dt><dd>Per-sample version of Tags preserved, shown only on the sample that has an existing tag to preserve.</dd>
    <dt><span class="chip">blue chip</span></dt><dd>An accepted anchor \u2014 what would actually render as a clickable suggestion.</dd>
    <dt><span class="chip-dropped">red chip</span></dt><dd>A tag the model proposed that validation rejected.</dd>
  </dl>
</section>`;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>infer-sweep report (${data.style}) — ${data.generatedAt}</title>
<style>
  body { font-family: -apple-system, "Segoe UI", sans-serif; margin: 2rem; color: #1a1a1a; background: #fafafa; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.1rem; margin-top: 2.5rem; border-bottom: 1px solid #ddd; padding-bottom: 0.3rem; }
  table { border-collapse: collapse; width: 100%; margin-top: 0.75rem; font-size: 0.85rem; }
  th, td { border: 1px solid #ddd; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
  th { background: #f0f0f0; position: sticky; top: 0; }
  tr:nth-child(even) { background: #f7f7f7; }
  tfoot td { font-weight: 600; background: #f0f0f0; }
  .chip { background: #dbeafe; border: 1px solid #93c5fd; border-radius: 4px; padding: 0 0.3rem; }
  .chip-dropped { background: #fee2e2; border: 1px solid #fca5a5; border-radius: 4px; padding: 0 0.3rem; }
  .good { color: #15803d; font-weight: 600; }
  .bad { color: #b91c1c; font-weight: 600; }
  .warn { color: #b45309; }
  .badge { display: inline-block; border-radius: 3px; padding: 0.05rem 0.35rem; font-size: 0.75rem; margin-right: 0.25rem; }
  .badge.good { background: #dcfce7; color: #15803d; }
  .badge.bad { background: #fee2e2; color: #b91c1c; }
  .cell.fail { color: #b91c1c; }
  .cell .ms { color: #777; font-size: 0.75rem; }
  .cell .anchors, .cell .dropped { margin-top: 0.25rem; }
  .cell .note { color: #999; font-size: 0.75rem; }
  .modelname { font-family: ui-monospace, monospace; white-space: nowrap; }
  pre.prompt { white-space: pre-wrap; background: #fff; border: 1px solid #ddd; padding: 0.75rem; border-radius: 4px; }
  table.detail td { min-width: 9rem; }
  dl.legend dt { font-weight: 600; margin-top: 0.6rem; font-family: ui-monospace, monospace; }
  dl.legend dd { margin: 0.15rem 0 0 0; color: #333; }
  code { background: #eee; border-radius: 3px; padding: 0 0.25rem; }
</style>
</head>
<body>
  <h1>infer-sweep: second-model layer (${data.style} style), live scored against ${rows.length} model(s)</h1>
  <p>Generated ${esc(data.generatedAt)}. Ranked by copy fidelity, tag preservation, then anchors accepted. Total spend: ${fmtCost(sweepTotalCost)}. Run the sweep again with <code>--style ${data.style === "options" ? "reemit" : "options"}</code> for the other shape's report, to compare side by side.</p>
  ${promptsHtml}
  ${summaryHtml}
  ${detailHtml}
  ${legendHtml}
</body>
</html>`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, html, "utf8");
console.log(`HTML report written to ${outPath}`);
