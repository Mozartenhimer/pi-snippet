import { describe, expect, it } from "vitest";
import {
	asksSomething,
	buildInferPrompt,
	extractAnchors,
	INFER_SYSTEM_PROMPT,
	locateAnchors,
	unfence,
} from "../src/shared/inferred.js";
import { MAX_SUGGESTIONS_PER_MESSAGE } from "../src/shared/suggestions.js";
import { mergeSuggestions, toTuiMarkdown } from "../src/shared/tui-markdown.js";

describe("asksSomething", () => {
	it("says yes to a question in prose", () => {
		expect(asksSomething("Do you want to rebuild or commit?")).toBe(true);
		expect(asksSomething("Want me to fix them one at a time,\n\nor all at once?")).toBe(true);
	});

	it("says no to a status update", () => {
		expect(asksSomething("Pushed the branch, CI is green.")).toBe(false);
	});

	it("says no when the only question mark is code", () => {
		expect(asksSomething("Use `items.filter(x => x.ok)?` here:\n\n```\nwhere ok = ?\n```")).toBe(
			false,
		);
	});
});

describe("buildInferPrompt", () => {
	it("sends the message as stored, layer-1 tags included", () => {
		const wire = buildInferPrompt("<snippet>Yes</snippet>, done.");
		expect(wire).toContain("<assistant_message>");
		expect(wire).toContain("<snippet>Yes</snippet>, done.");
	});

	it("asks the model to add to existing tags, freely — more is better", () => {
		expect(INFER_SYSTEM_PROMPT).toMatch(/no limit on the number of tags/);
		expect(INFER_SYSTEM_PROMPT).toMatch(/Never remove, move, or alter an existing <snippet> tag/);
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

/**
 * Boundary cases the ordinary tests never reach, found by MC/DC. Each one is
 * a way an anchor could be mislocated: a question mark that sits after a code
 * block rather than inside one, an occurrence that stops just short of code,
 * an empty anchor, and the runaway cap.
 */
describe("asksSomething — a question outside the code that precedes it", () => {
	it("sees a question mark that follows a fenced block", () => {
		expect(asksSomething("```\nrm -rf /\n```\nShall I run that?")).toBe(true);
	});

	it("sees a question mark that follows an inline span", () => {
		expect(asksSomething("`git push` next?")).toBe(true);
	});

	it("still ignores one inside the block", () => {
		expect(asksSomething("```\nwhat?\n```\nDone.")).toBe(false);
	});
});

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
