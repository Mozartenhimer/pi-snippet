/**
 * Run the real `INFER_SYSTEM_PROMPT` against a live model and print both what
 * came back and what `parseInferred()` keeps of it.
 *
 * The mock-LLM test proves the *wiring*; this proves the *prompt*. It is the
 * only way to find out whether a given small model copies anchors verbatim,
 * which is what rule 5 (PRD §17.2) costs a chip for when it doesn't.
 *
 * Loaded with `pi -e`, so it goes through the same ModelRegistry the extension
 * does — no HTTP here, no credentials of its own.
 *
 *   npm run build:probe
 *   GEMINI_API_KEY=... PI_SNIPPET_MODEL=google/gemini-2.5-flash-lite \
 *     npx pi --mode rpc --no-session --no-extensions -e dist/scripts/infer-probe.js </dev/null
 *
 * `PI_SNIPPET_MODEL` picks the model, exactly as it does for the extension;
 * without it the probe uses the session's own.
 */
import { INFER_SYSTEM_PROMPT, buildInferPrompt, parseInferred } from "../src/shared/inferred.js";

const EXAMPLES: Array<{ name: string; text: string }> = [
	{ name: "canonical (the user's own example)", text: "I'm done the model, do you want to see it?" },
	{ name: "two options in one sentence", text: "The build failed in three places. Want me to fix them one at a time, or show you all three errors first?" },
	{ name: "named options", text: "A few name ideas: pi-chip, pi-reply, or pi-nudge. Which do you like?" },
	{ name: "pronoun resolution", text: "Your old `wip` branch is merged and stale. Should I delete it for you?" },
	{ name: "rhetorical, invites nothing", text: "Why did that fail? Because the token had expired. I've refreshed it and the tests pass now." },
	{ name: "question only inside code", text: "Here's the check:\n\n```py\nif not ok:\n    raise ValueError(\"who broke it?\")\n```\n\nThat's the whole change." },
	{ name: "statement, no question at all", text: "I refactored the parser into three functions and all 204 tests still pass." },
	{ name: "question buried after code", text: "Here's the fix:\n\n```ts\nconst clickOn = () => state.clickEnabled || flagClick;\n```\n\nI can also add a test for the flag latch, or leave that for a follow-up. Which would you prefer?" },
];

export default function inferProbe(pi: any): void {
	pi.on("session_start", async (_event: unknown, ctx: any) => {
		const registry = ctx?.modelRegistry;
		const out = (s: string) => process.stderr.write(s + "\n");
		if (!registry?.complete) { out("PROBE: no modelRegistry.complete"); process.exit(1); }

		const available = registry.getAvailable?.() ?? [];
		const authed = available.filter((m: any) => registry.hasConfiguredAuth?.(m) ?? true);
		out(`PROBE: ${available.length} models, ${authed.length} with configured auth`);

		const pin = process.env.PI_SNIPPET_MODEL;
		const model =
			(pin && (available.find((m: any) => `${m.provider}/${m.id}`.toLowerCase() === pin.toLowerCase())
				?? available.find((m: any) => m.id.toLowerCase() === pin.toLowerCase())))
			|| ctx.model;
		out(`PROBE: using ${model?.provider}/${model?.id}`);

		for (const ex of EXAMPLES) {
			out("\n" + "=".repeat(72) + `\nMESSAGE (${ex.name}):\n${ex.text}\n` + "-".repeat(72));
			try {
				const res = await registry.complete(
					model,
					{ systemPrompt: INFER_SYSTEM_PROMPT, messages: [{ role: "user", content: buildInferPrompt(ex.text), timestamp: Date.now() }] },
					{ maxTokens: 512 },
				);
				const raw = (res.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text ?? "").join("");
				out(`stopReason: ${res.stopReason}  tokens in/out: ${res.usage?.input ?? "?"}/${res.usage?.output ?? "?"}`);
				if (res.stopReason === "error") out("FULL: " + JSON.stringify(res).slice(0, 1200));
				out("RAW:\n" + (raw || "(empty)"));
				const kept = parseInferred(raw, ex.text);
				out(`KEPT (${kept.length}): ` + JSON.stringify(kept, null, 2));
			} catch (err) {
				out("THREW: " + (err as Error)?.message);
			}
		}
		out("\nPROBE: done");
		process.exit(0);
	});
}
