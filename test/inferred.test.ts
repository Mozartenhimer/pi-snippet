import { describe, expect, it } from "vitest";
import {
	buildInferPrompt,
	extractAnchors,
	extractOptionAnchors,
	INFER_OPTIONS_SYSTEM_PROMPT,
	INFER_SYSTEM_PROMPT,
	locateAllOccurrences,
	locateAnchors,
	unfence,
} from "../src/shared/inferred.js";
import { MAX_SUGGESTIONS_PER_MESSAGE } from "../src/shared/suggestions.js";
import { mergeSuggestions, toTuiMarkdown } from "../src/shared/tui-markdown.js";

describe("buildInferPrompt", () => {
	it("sends the message as stored, layer-1 tags included", () => {
		const wire = buildInferPrompt("<snippet>Yes</snippet>, done.");
		expect(wire).toContain("<assistant_message>");
		expect(wire).toContain("<snippet>Yes</snippet>, done.");
	});

	it("asks the model to add to existing tags, freely — more is better", () => {
		expect(INFER_SYSTEM_PROMPT).toMatch(/no limit on how many/);
		expect(INFER_SYSTEM_PROMPT).toMatch(/Never remove, move, or alter an existing <snippet> tag/);
	});
});

describe("INFER_OPTIONS_SYSTEM_PROMPT", () => {
	it("asks for bare lines, not tags", () => {
		expect(INFER_OPTIONS_SYSTEM_PROMPT).toMatch(/one per line/);
		expect(INFER_OPTIONS_SYSTEM_PROMPT).not.toContain("<snippet>");
	});

	it("shares its 'what counts as a plausible reply' guidance with the reemit prompt", () => {
		// Factored out so the two prompts can drift on format only, never on
		// what to offer — this is the guarantee that they still agree.
		const shared = "A binary question's affirmative: \"Shall I proceed?\" -> proceed.";
		expect(INFER_SYSTEM_PROMPT).toContain(shared);
		expect(INFER_OPTIONS_SYSTEM_PROMPT).toContain(shared);
	});

	it("shares its worked examples with the reemit prompt, one shape per style", () => {
		// Same underlying scenario (INFER_EXAMPLES, unexported): reemit tags
		// the replies in place, options lists them as bare lines. Both must
		// show the exact same example message, verbatim.
		const exampleMessage =
			"The build failed in three places. Want me to fix them one at a time, or show you all three errors first?";
		expect(INFER_SYSTEM_PROMPT).toContain(exampleMessage);
		expect(INFER_OPTIONS_SYSTEM_PROMPT).toContain(exampleMessage);
		expect(INFER_SYSTEM_PROMPT).toContain(
			"The build failed in three places. Want me to <snippet>fix them one at a time</snippet>, or <snippet>show you all three errors first</snippet>?",
		);
		expect(INFER_OPTIONS_SYSTEM_PROMPT).toContain("fix them one at a time\nshow you all three errors first");
		// The no-op example agrees too, rendered plain in one and empty in the
		// other. "Empty" is what there is to assert and nothing is what it looks
		// like, so the match runs to whatever follows the block — the separator
		// before the next example, or the end of the prompt when it is the last
		// one. Anchoring it to the end alone said the same thing only while it
		// stayed last, and broke the moment an example was appended after it.
		expect(INFER_SYSTEM_PROMPT).toContain("I've pushed the branch and CI is green.");
		expect(INFER_OPTIONS_SYSTEM_PROMPT).toMatch(
			/I've pushed the branch and CI is green\.\n\nExample reply:\n(?:\n\nExample message:|$)/,
		);
	});
});

describe("unfence", () => {
	it("strips a fence the model wrapped around its answer", () => {
		expect(unfence("```markdown\nhello\n```")).toBe("hello");
		expect(unfence("plain")).toBe("plain");
	});
});

describe("extractAnchors", () => {
	const message = "Do you want to rebuild or commit?";
	const reply = "Do you want to <snippet>rebuild</snippet> or <snippet>commit</snippet>?";

	it("keeps the wrapped spans that appear verbatim in the message", () => {
		expect(extractAnchors(reply, message)).toEqual(["rebuild", "commit"]);
	});

	it("drops the tags the model echoed back from the tagged message", () => {
		const tagged = "Do you want to <snippet>rebuild</snippet> or commit?";
		const added = "Do you want to <snippet>rebuild</snippet> or <snippet>commit</snippet>?";
		expect(extractAnchors(added, tagged, ["rebuild"])).toEqual(["commit"]);
	});

	it("drops an anchor the model paraphrased or invented", () => {
		const bad = "Do you want to <snippet>rebuild the project</snippet> or <snippet>commit</snippet>?";
		expect(extractAnchors(bad, message)).toEqual(["commit"]);
	});

	it("drops an anchor that sits inside a code block of the message", () => {
		const msg = "Run this?\n\n```\nnpm run build?\n```";
		const rep = "Run this?\n\n```\nnpm run <snippet>build</snippet>?\n```";
		// "build" is verbatim in the message but only inside the fence.
		expect(extractAnchors(rep, msg)).toEqual([]);
	});

	it("drops an anchor that duplicates a chip the primary model already tagged", () => {
		expect(extractAnchors(reply, "<snippet>rebuild</snippet> or commit?", ["rebuild"])).toEqual([
			"commit",
		]);
	});

	it("drops overlapping anchors rather than doubling a span", () => {
		const rep = "Do you want to <snippet>rebuild</snippet> or <snippet>rebuild or commit</snippet>?";
		const anchors = extractAnchors(rep, message);
		expect(anchors).toContain("rebuild");
		// "rebuild or commit" overlaps "rebuild" — one of them must lose.
		const spans = locateAnchors(message, anchors);
		for (let i = 1; i < spans.length; i++) {
			expect(spans[i]!.start).toBeGreaterThanOrEqual(spans[i - 1]!.end);
		}
	});

	it("imposes no limit of its own — more tags all survive", () => {
		const options = Array.from({ length: 8 }, (_, i) => `option${i}`);
		const msg = `Pick one: ${options.join(", ")}?`;
		const rep = `Pick one: ${options.map((o) => `<snippet>${o}</snippet>`).join(", ")}?`;
		expect(extractAnchors(rep, msg)).toEqual(options);
	});

	it("returns nothing when the model answers prose instead of markup", () => {
		expect(extractAnchors("I would suggest committing first.", message)).toEqual([]);
	});
});

describe("extractOptionAnchors", () => {
	const message = "Do you want to rebuild or commit?";

	it("keeps lines that appear verbatim in the message", () => {
		expect(extractOptionAnchors("rebuild\ncommit", message)).toEqual(["rebuild", "commit"]);
	});

	it("trims each line and drops blank ones", () => {
		expect(extractOptionAnchors("  rebuild  \n\ncommit\n", message)).toEqual(["rebuild", "commit"]);
	});

	it("drops a line the model invented or paraphrased", () => {
		expect(extractOptionAnchors("rebuild the project\ncommit", message)).toEqual(["commit"]);
	});

	it("drops a line that duplicates a chip the primary model already tagged", () => {
		const tagged = "Do you want to <snippet>rebuild</snippet> or commit?";
		expect(extractOptionAnchors("rebuild\ncommit", tagged, ["rebuild"])).toEqual(["commit"]);
	});

	it("drops a line that only exists inside a code block", () => {
		const msg = "Run this?\n\n```\nnpm run build\n```";
		expect(extractOptionAnchors("npm run build", msg)).toEqual([]);
	});

	it("drops a line the model repeated within the same reply", () => {
		expect(extractOptionAnchors("rebuild\nrebuild\ncommit", message)).toEqual(["rebuild", "commit"]);
	});

	it("returns nothing for a reply that lists nothing usable", () => {
		expect(extractOptionAnchors("", message)).toEqual([]);
		expect(extractOptionAnchors("I would suggest committing first.", message)).toEqual([]);
	});

	it("strips a fence the model wrapped the list in", () => {
		expect(extractOptionAnchors("```\nrebuild\ncommit\n```", message)).toEqual(["rebuild", "commit"]);
	});

	it("imposes no limit of its own beyond the runaway cap", () => {
		const options = Array.from({ length: 8 }, (_, i) => `option${i}`);
		const msg = `Pick one: ${options.join(", ")}?`;
		expect(extractOptionAnchors(options.join("\n"), msg)).toEqual(options);
	});

	it("adds nothing once the message already carries the maximum chips", () => {
		const full = Array.from(
			{ length: MAX_SUGGESTIONS_PER_MESSAGE },
			(_, i) => `<snippet>reply ${i}</snippet>`,
		).join(" and also ");
		const plain = Array.from({ length: MAX_SUGGESTIONS_PER_MESSAGE }, (_, i) => `reply ${i}`).join(
			" and also ",
		);
		expect(extractOptionAnchors("one more", `${full} and also ${plain}`)).toEqual([]);
	});

	describe("a still-streaming reply (`complete: false`)", () => {
		it("holds back the last line, which has not seen its newline yet", () => {
			// "commit" has no trailing newline in this partial — it may still be
			// growing into "commitment" or further — so only "rebuild" is safe.
			expect(extractOptionAnchors("rebuild\ncommit", message, [], { complete: false })).toEqual([
				"rebuild",
			]);
		});

		it("releases the final line once the caller says the reply is complete", () => {
			expect(extractOptionAnchors("rebuild\ncommit", message, [], { complete: true })).toEqual([
				"rebuild",
				"commit",
			]);
			expect(extractOptionAnchors("rebuild\ncommit", message)).toEqual(["rebuild", "commit"]);
		});
	});
});

describe("locateAnchors", () => {
	it("finds each anchor at its verbatim position, in document order", () => {
		const found = locateAnchors("Do you want to rebuild or commit?", ["commit", "rebuild"]);
		// `order` records each anchor's rank in the array it was located from —
		// commit was asked for first, so it keeps the earlier number even though
		// it sits later in the text.
		expect(found).toEqual([
			{ text: "rebuild", start: 15, end: 22, order: 1 },
			{ text: "commit", start: 26, end: 32, order: 0 },
		]);
	});

	it("skips an anchor that would overlap one already placed", () => {
		const existing = [{ text: "rebuild", start: 14, end: 21 }];
		expect(locateAnchors("Do you want to rebuild or commit?", ["rebuild"], existing)).toEqual([]);
	});

	it("never lands inside a code fence", () => {
		const text = "```\nrebuild\n```\nWant me to rebuild?";
		expect(locateAnchors(text, ["rebuild"])).toEqual([
			{ text: "rebuild", start: text.indexOf("rebuild?"), end: text.indexOf("rebuild?") + 7, order: 0 },
		]);
	});

	it("stops at the first occurrence — the `reemit` shape, one span per anchor", () => {
		const text = "rebuild it, or just rebuild without asking?";
		expect(locateAnchors(text, ["rebuild"])).toEqual([
			{ text: "rebuild", start: 0, end: 7, order: 0 },
		]);
	});
});

describe("locateAllOccurrences", () => {
	it("finds every verbatim occurrence, all sharing the anchor's order", () => {
		const text = "Type rebuild to rebuild, or type commit to commit.";
		const found = locateAllOccurrences(text, ["rebuild", "commit"]);
		expect(found.map((f) => f.order)).toEqual([0, 0, 1, 1]);
		expect(found.map((f) => f.text)).toEqual(["rebuild", "rebuild", "commit", "commit"]);
	});

	it("never lands inside a code fence, for any occurrence", () => {
		const text = "```\nrebuild\n```\nrebuild now, or rebuild later?";
		const found = locateAllOccurrences(text, ["rebuild"]);
		// The fenced "rebuild" is excluded; only the two outside it survive.
		expect(found.map((f) => f.start)).toEqual([
			text.indexOf("rebuild now"),
			text.indexOf("rebuild later"),
		]);
	});

	it("still refuses to overlap an existing chip", () => {
		const existing = [{ text: "rebuild", start: 0, end: 7 }];
		const found = locateAllOccurrences("rebuild or rebuild again?", ["rebuild"], existing);
		expect(found).toEqual([{ text: "rebuild", start: 11, end: 18, order: 0 }]);
	});

	it("drops an empty anchor rather than matching everywhere", () => {
		expect(locateAllOccurrences("anything at all", [""])).toEqual([]);
	});
});

describe("mergeSuggestions — layer 1 and layer 2 paint as one stream", () => {
	it("numbers inferred anchors after the tagged chips, in document order", () => {
		const text = "First <snippet>tagged</snippet>, then want me to go ahead?";
		const merged = mergeSuggestions(text, undefined, ["go ahead"]);
		expect(merged.suggestions).toEqual(["tagged", "go ahead"]);
		const kinds = merged.nodes.map((n) => n.type);
		expect(kinds).toEqual(["text", "suggestion", "text", "suggestion", "text"]);
	});

	it("keeps a tagged chip's number when an anchor lands before it in the text", () => {
		const text = "Want me to fix it now, or <snippet>wait for CI</snippet>?";
		const merged = mergeSuggestions(text, undefined, ["fix it now"]);
		// The anchor sits earlier in the document but numbers after: the tagged
		// chip streamed in as ¹ and must not become ² under the user's fingers.
		expect(merged.suggestions).toEqual(["wait for CI", "fix it now"]);
		const indexOf = (label: string) => {
			const node = merged.nodes.find((n) => n.type === "suggestion" && n.text === label);
			return node && node.type === "suggestion" ? node.index : -1;
		};
		expect(indexOf("wait for CI")).toBe(0);
		expect(indexOf("fix it now")).toBe(1);
		const out = toTuiMarkdown(text, { isStreaming: false, enabled: true, inferred: ["fix it now"] });
		expect(out).toBe("Want me to ²fix it now, or ¹wait for CI?");
	});

	it("never shifts an earlier anchor when a later one lands before it", () => {
		const text = "Try a or b, then <snippet>c</snippet>?";
		// Arrival order, not document order: "b" was inferred first.
		const merged = mergeSuggestions(text, undefined, ["b", "a"]);
		expect(merged.suggestions).toEqual(["c", "b", "a"]);
		const indexOf = (label: string) => {
			const node = merged.nodes.find((n) => n.type === "suggestion" && n.text === label);
			return node && node.type === "suggestion" ? node.index : -1;
		};
		expect(indexOf("b")).toBe(1);
		expect(indexOf("a")).toBe(2);
	});

	it("paints an inferred chip exactly like a tagged one", () => {
		const text = "Shall I proceed?";
		const out = toTuiMarkdown(text, {
			isStreaming: false,
			enabled: true,
			inferred: ["proceed"],
		});
		expect(out).toBe("Shall I ¹proceed?");
	});

	it("keeps an inferred anchor out of a tagged chip's span and out of code", () => {
		const text = "Use `rebuild`?\n\nI can <snippet>rebuild</snippet> for you.";
		const merged = mergeSuggestions(text, undefined, ["rebuild"]);
		// Only the tagged occurrence survives; the inline-code and duplicate
		// positions are taken.
		expect(merged.suggestions).toEqual(["rebuild"]);
	});

	it("renders plain when nothing is inferred and nothing tagged", () => {
		expect(
			toTuiMarkdown("No questions here.", { isStreaming: false, enabled: true }),
		).toBe("No questions here.");
	});
});

describe("mergeSuggestions — the `options` style paints every occurrence", () => {
	it("gives repeated occurrences of the same option one shared chip number", () => {
		const text = "Type rebuild to rebuild.";
		const merged = mergeSuggestions(text, undefined, ["rebuild"], "options");
		expect(merged.suggestions).toEqual(["rebuild"]);
		const indexes = merged.nodes
			.filter((n) => n.type === "suggestion")
			.map((n) => (n.type === "suggestion" ? n.index : -1));
		expect(indexes).toEqual([0, 0]);
		const out = toTuiMarkdown(text, {
			isStreaming: false,
			enabled: true,
			inferred: ["rebuild"],
			inferStyle: "options",
		});
		expect(out).toBe("Type ¹rebuild to ¹rebuild.");
	});

	it("defaults to the `reemit` shape — one occurrence — when no style is given", () => {
		const text = "Type rebuild to rebuild.";
		const merged = mergeSuggestions(text, undefined, ["rebuild"]);
		expect(merged.nodes.filter((n) => n.type === "suggestion")).toHaveLength(1);
	});

	it("numbers two different options after the tagged chips, each at every occurrence", () => {
		const text = "<snippet>tagged</snippet>. rebuild or commit, rebuild or commit.";
		const merged = mergeSuggestions(text, undefined, ["rebuild", "commit"], "options");
		expect(merged.suggestions).toEqual(["tagged", "rebuild", "commit"]);
		const suggestionNodes = merged.nodes.filter((n) => n.type === "suggestion");
		expect(suggestionNodes.map((n) => (n.type === "suggestion" ? n.index : -1))).toEqual([0, 1, 2, 1, 2]);
	});
});

/**
 * Boundary cases the ordinary tests never reach, found by MC/DC. Each one is
 * a way an anchor could be mislocated: an occurrence that stops just short of
 * code, an empty anchor, and the runaway cap.
 */
describe("locateAnchors — boundaries", () => {
	it("places an anchor that ends immediately before a code span", () => {
		const text = "Run it now `--force` instead.";
		expect(locateAnchors(text, ["Run it now"])).toEqual([
			{ text: "Run it now", start: 0, end: 10, order: 0 },
		]);
	});

	it("places an anchor that begins immediately after a code span", () => {
		const text = "Use `--force` and retry.";
		const [found] = locateAnchors(text, ["and retry"]);
		expect(text.slice(found!.start, found!.end)).toBe("and retry");
	});

	it("drops an empty anchor rather than matching everywhere", () => {
		expect(locateAnchors("anything at all", [""])).toEqual([]);
	});
});

describe("extractAnchors — the runaway cap", () => {
	it("adds nothing to a message that already carries the maximum chips", () => {
		const full = Array.from(
			{ length: MAX_SUGGESTIONS_PER_MESSAGE },
			(_, i) => `<snippet>reply ${i}</snippet>`,
		).join(" and also ");
		const reply = `${full} and also <snippet>one more</snippet>`;
		expect(extractAnchors(reply, `${full} and also one more`)).toEqual([]);
	});
});

describe("mergeSuggestions — an anchor flush against the ends of its text", () => {
	it("paints an anchor that starts the message", () => {
		const merged = mergeSuggestions("Rebuild it, or wait?", undefined, ["Rebuild it"]);
		expect(merged.nodes[0]).toEqual({
			type: "suggestion",
			text: "Rebuild it",
			index: 0,
			start: 0,
		});
	});

	it("paints an anchor that ends the message", () => {
		const text = "Shall I wait for CI";
		const merged = mergeSuggestions(text, undefined, ["wait for CI"]);
		expect(merged.nodes.at(-1)).toEqual({
			type: "suggestion",
			text: "wait for CI",
			index: 0,
			start: 8,
		});
	});

	it("paints an anchor that is the whole message", () => {
		const merged = mergeSuggestions("ship it", undefined, ["ship it"]);
		expect(merged.nodes).toEqual([{ type: "suggestion", text: "ship it", index: 0, start: 0 }]);
	});
});
