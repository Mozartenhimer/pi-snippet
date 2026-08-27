import { describe, expect, it } from "vitest";
import {
	asksSomething,
	MAX_INFERRED_PER_MESSAGE,
	parseInferred,
} from "../src/shared/inferred.js";
import { linkifyAnchors, toTuiMarkdown } from "../src/shared/tui-markdown.js";

describe("asksSomething (the gate on spending a call)", () => {
	it("is true for a question", () => {
		expect(asksSomething("I'm done the model, do you want to see it?")).toBe(true);
	});

	it("is false for a statement", () => {
		expect(asksSomething("I've pushed the branch and CI is green.")).toBe(false);
	});

	it("ignores a question mark inside a fence", () => {
		expect(asksSomething("Done:\n\n```sh\ngrep -n 'what?' src\n```\n")).toBe(false);
	});

	it("ignores a question mark inside an inline code span", () => {
		expect(asksSomething("The glob is `src/**/*.?s` now.")).toBe(false);
	});

	it("still sees a real question alongside code", () => {
		expect(asksSomething("```sh\nls?\n```\n\nShall I run it?")).toBe(true);
	});
});

describe("parseInferred (believing a small model only so far)", () => {
	const message = "I'm done the model, do you want to see it?";

	it("accepts an anchor that is verbatim in the message", () => {
		const raw = '[{"anchor":"do you want to see it?","reply":"Show me the model."}]';
		expect(parseInferred(raw, message)).toEqual([
			{ anchor: "do you want to see it?", reply: "Show me the model." },
		]);
	});

	it("drops a paraphrased anchor rather than repairing it", () => {
		const raw = '[{"anchor":"Do you want to see it","reply":"Show me the model."}]';
		expect(parseInferred(raw, message)).toEqual([]);
	});

	it("unwraps a ```json fence", () => {
		const raw = '```json\n[{"anchor":"see it?","reply":"Show me the model."}]\n```';
		expect(parseInferred(raw, message)).toEqual([
			{ anchor: "see it?", reply: "Show me the model." },
		]);
	});

	it("returns nothing for malformed JSON", () => {
		expect(parseInferred("sure! here you go:", message)).toEqual([]);
	});

	it("returns nothing for a non-array", () => {
		expect(parseInferred('{"anchor":"see it?","reply":"yes"}', message)).toEqual([]);
	});

	it("keeps the good entries when one is bad", () => {
		const text = "Want me to fix them one at a time, or show all three errors first?";
		const raw = JSON.stringify([
			{ anchor: "fix them one at a time", reply: "Fix them one at a time." },
			{ anchor: "invented span", reply: "nope" },
			{ anchor: "show all three errors first", reply: "Show me all three errors first." },
		]);
		expect(parseInferred(raw, text).map((s) => s.anchor)).toEqual([
			"fix them one at a time",
			"show all three errors first",
		]);
	});

	it("drops an anchor that only occurs inside code", () => {
		const text = "Run this:\n\n```sh\nnpm test -- --watch?\n```\n\nAnything else?";
		const raw = '[{"anchor":"npm test -- --watch?","reply":"Run it."}]';
		expect(parseInferred(raw, text)).toEqual([]);
	});

	it("drops an overlapping anchor so a span is never underlined twice", () => {
		const text = "Want me to rebuild the solution?";
		const raw = JSON.stringify([
			{ anchor: "rebuild the solution", reply: "Rebuild the solution." },
			{ anchor: "the solution", reply: "Yes." },
		]);
		expect(parseInferred(raw, text).map((s) => s.anchor)).toEqual(["rebuild the solution"]);
	});

	it("drops a duplicate anchor", () => {
		const raw = JSON.stringify([
			{ anchor: "see it?", reply: "Show me the model." },
			{ anchor: "see it?", reply: "Yes please." },
		]);
		expect(parseInferred(raw, message)).toHaveLength(1);
	});

	it("drops an empty, oversized or multi-line reply", () => {
		const long = "x".repeat(200);
		for (const reply of ["", "   ", long, "line one\nline two"]) {
			const raw = JSON.stringify([{ anchor: "see it?", reply }]);
			expect(parseInferred(raw, message)).toEqual([]);
		}
	});

	it("keeps every anchor of a message that asks many things", () => {
		// The cap is a runaway guard, not a style rule: a message asking eight
		// questions gets eight chips, not four.
		const words = Array.from({ length: 8 }, (_, i) => `opt${i}`);
		const text = `Pick one: ${words.join(", ")}?`;
		const raw = JSON.stringify(words.map((w) => ({ anchor: w, reply: `Use ${w}.` })));
		expect(parseInferred(raw, text)).toHaveLength(8);
	});

	it("stops a runaway answer at the cap", () => {
		const words = Array.from({ length: MAX_INFERRED_PER_MESSAGE + 20 }, (_, i) => `opt${i}`);
		const text = `Pick one: ${words.join(", ")}?`;
		const raw = JSON.stringify(words.map((w) => ({ anchor: w, reply: `Use ${w}.` })));
		expect(parseInferred(raw, text)).toHaveLength(MAX_INFERRED_PER_MESSAGE);
	});

	it("ignores entries that aren't objects with two strings", () => {
		const raw = JSON.stringify(["see it?", { anchor: "see it?" }, { reply: "hi" }, null, 3]);
		expect(parseInferred(raw, message)).toEqual([]);
	});
});

describe("linkifyAnchors (unnumbered, link-styled spans)", () => {
	it("wraps an anchor as an inert link with no number", () => {
		expect(linkifyAnchors("I'm done, do you want to see it?", ["do you want to see it?"])).toBe(
			"I'm done, [do you want to see it?](infer:1)",
		);
	});

	it("leaves text alone when the anchor isn't there", () => {
		expect(linkifyAnchors("All green.", ["see it?"])).toBe("All green.");
	});

	it("never wraps inside a fence", () => {
		const input = "```sh\nsee it?\n```";
		expect(linkifyAnchors(input, ["see it?"])).toBe(input);
	});

	it("wraps every occurrence outside code", () => {
		expect(linkifyAnchors("go? or go?", ["go?"])).toBe("[go?](infer:1) or [go?](infer:1)");
	});

	it("prefers the longer anchor when two start together", () => {
		expect(linkifyAnchors("run the tests now", ["run the tests", "run the tests now"])).toBe(
			"[run the tests now](infer:2)",
		);
	});

	it("escapes brackets in the label", () => {
		expect(linkifyAnchors("pick [a] or b?", ["[a]"])).toBe("pick [\\[a\\]](infer:1) or b?");
	});
});

describe("toTuiMarkdown with anchors (the two layers together)", () => {
	it("renders anchors when the message carried no tags", () => {
		expect(
			toTuiMarkdown("I'm done, do you want to see it?", {
				isStreaming: false,
				enabled: true,
				anchors: ["do you want to see it?"],
			}),
		).toBe("I'm done, [do you want to see it?](infer:1)");
	});

	it("renders numbered chips and unnumbered anchors side by side", () => {
		const out = toTuiMarkdown("Want me to <snippet>rebuild</snippet>? Or shall I wait?", {
			isStreaming: false,
			enabled: true,
			anchors: ["shall I wait?"],
		});
		expect(out).toBe("Want me to [¹rebuild](chip:1)? Or [shall I wait?](infer:1)");
	});

	it("never underlines inside a tagged chip's own text", () => {
		const out = toTuiMarkdown("Want me to <snippet>rebuild</snippet>?", {
			isStreaming: false,
			enabled: true,
			anchors: ["rebuild"],
		});
		expect(out).toBe("Want me to [¹rebuild](chip:1)?");
	});

	it("drops anchors when the feature is off", () => {
		expect(
			toTuiMarkdown("Do you want to see it?", {
				isStreaming: false,
				enabled: false,
				anchors: ["Do you want to see it?"],
			}),
		).toBe("Do you want to see it?");
	});

	it("changes nothing when no anchors are supplied", () => {
		const input = "Do you want to see it?";
		expect(toTuiMarkdown(input, { isStreaming: false, enabled: true })).toBe(input);
	});
});
