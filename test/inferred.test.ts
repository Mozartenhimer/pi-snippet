import { describe, expect, it } from "vitest";
import {
	asksSomething,
	buildInferPrompt,
	extractAnchors,
	INFER_SYSTEM_PROMPT,
	locateAnchors,
	stripSnippetTags,
	unfence,
} from "../src/shared/inferred.js";
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

describe("stripSnippetTags", () => {
	it("removes the primary model's tags but keeps their text", () => {
		expect(stripSnippetTags("Do you want to <snippet>rebuild</snippet> or <snippet>commit</snippet>?")).toBe(
			"Do you want to rebuild or commit?",
		);
	});

	it("leaves a message without tags untouched", () => {
		expect(stripSnippetTags("Plain text, no tags.")).toBe("Plain text, no tags.");
	});
});

describe("buildInferPrompt", () => {
	it("wraps the message, tagged form stripped away from the wire", () => {
		const wire = buildInferPrompt(stripSnippetTags("<snippet>Yes</snippet>, done."));
		expect(wire).toContain("<assistant_message>");
		expect(wire).toContain("Yes, done.");
	});

	it("asks the model to tag freely — more is better", () => {
		expect(INFER_SYSTEM_PROMPT).toMatch(/no limit on the number of tags/);
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
		expect(extractAnchors(reply, "<snippet>rebuild</snippet> or commit?".replace("commit?", "commit?"), [
			"rebuild",
		])).toEqual(["commit"]);
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
		expect(found).toEqual([
			{ text: "rebuild", start: 15, end: 22 },
			{ text: "commit", start: 26, end: 32 },
		]);
	});

	it("skips an anchor that would overlap one already placed", () => {
		const existing = [{ text: "rebuild", start: 14, end: 21 }];
		expect(locateAnchors("Do you want to rebuild or commit?", ["rebuild"], existing)).toEqual([]);
	});

	it("never lands inside a code fence", () => {
		const text = "```\nrebuild\n```\nWant me to rebuild?";
		expect(locateAnchors(text, ["rebuild"])).toEqual([
			{ text: "rebuild", start: text.indexOf("rebuild?"), end: text.indexOf("rebuild?") + 7 },
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

	it("paints an inferred chip exactly like a tagged one", () => {
		const text = "Shall I proceed?";
		const out = toTuiMarkdown(text, {
			isStreaming: false,
			enabled: true,
			inferred: ["proceed"],
		});
		expect(out).toBe("Shall I [¹proceed](chip:1)?");
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
