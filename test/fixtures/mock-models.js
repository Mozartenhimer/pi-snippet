/**
 * A mock provider registered with several distinctly-named models, so a real
 * pi process has something for `ctx.modelRegistry.getAvailable()` — and
 * therefore `/snippet-model`'s autocomplete — to filter over, without a
 * network call or credentials. No `streamSimple`: this fixture never answers
 * a prompt, only advertises a catalogue.
 *
 * `getAvailable()` returns real pi's whole model catalogue too, not just
 * this fixture's models — `--no-extensions` only skips third-party
 * extensions, not the built-in registry. IDs here carry a `zzpisnip-`
 * prefix a real model id has no reason to ever contain, so a fuzzy query
 * built to hit one of these can't tie against (or lose to) hundreds of real
 * ones — that collision is exactly what scripts/snippet-model-tmux.py hit
 * before the prefix was added.
 */
function model(id, name) {
	return {
		id,
		name,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4096,
	};
}

export default function mockModels(pi) {
	pi.registerProvider("mockllm", {
		name: "Mock LLM",
		baseUrl: "http://mock.invalid",
		apiKey: "mock",
		api: "openai-completions",
		models: [
			model("zzpisnip-small", "Zzpisnip Small"),
			model("zzpisnip-medium", "Zzpisnip Medium"),
			model("zzpisnip-large-reasoner", "Zzpisnip Large Reasoner"),
		],
	});
}
