import { describe, expect, it } from "vitest";
import { MAX_SUGGESTIONS_PER_MESSAGE } from "../src/shared/suggestions.js";
import { chipLabel, superscript, toTuiMarkdown } from "../src/shared/tui-markdown.js";

describe("toTuiMarkdown (PRD §12)", () => {
	it("renders suggestions as superscript-numbered labels where there is no URL", () => {
		const out = toTuiMarkdown(
			"Want me to <snippet>rebuild the solution</snippet> or <snippet>run the tests</snippet>?",
			{ isStreaming: false, enabled: true },
		);
		expect(out).toBe("Want me to ¹rebuild the solution or ²run the tests?");
	});

	it("continues numbering across blocks via acceptedSoFar", () => {
		const out = toTuiMarkdown("Then <snippet>option c</snippet>?", {
			isStreaming: false,
			enabled: true,
			parse: { acceptedSoFar: 2 },
		});
		expect(out).toBe("Then ³option c?");
	});

	it("leaves code fences untouched", () => {
		const input = "```html\n<snippet>not real</snippet>\n```";
		expect(toTuiMarkdown(input, { isStreaming: false, enabled: true })).toBe(input);
	});

	it("strips tags to plain text when disabled", () => {
		const out = toTuiMarkdown("Want me to <snippet>rebuild</snippet>?", {
			isStreaming: false,
			enabled: false,
		});
		expect(out).toBe("Want me to rebuild?");
	});

	it("buffers partial tags while streaming (C1)", () => {
		expect(toTuiMarkdown("Want me to <sni", { isStreaming: true, enabled: true })).toBe(
			"Want me to ",
		);
		expect(
			toTuiMarkdown("Want me to <snippet>rebuild</snippet> or", {
				isStreaming: true,
				enabled: true,
			}),
		).toBe("Want me to ¹rebuild or");
	});

	it("finalized unclosed tag degrades to plain text (C4)", () => {
		expect(
			toTuiMarkdown("Sure — want me to <snippet>rebuild the sol", {
				isStreaming: false,
				enabled: true,
			}),
		).toBe("Sure — want me to rebuild the sol");
	});

	it("renders at most MAX_SUGGESTIONS_PER_MESSAGE numbered spans", () => {
		const cap = MAX_SUGGESTIONS_PER_MESSAGE;
		const nums = Array.from({ length: cap + 1 }, (_, i) => i + 1);
		const input = nums.map((n) => `<snippet>o${n}</snippet>`).join(" ");
		expect(toTuiMarkdown(input, { isStreaming: false, enabled: true })).toBe(
			`${nums
				.slice(0, cap)
				.map((n) => `${superscript(n)}o${n}`)
				.join(" ")} o${cap + 1}`,
		);
	});

	it("numbers past nine keep both digits superscripted", () => {
		const input = Array.from({ length: 12 }, (_, i) => `<snippet>o${i + 1}</snippet>`).join(" ");
		const out = toTuiMarkdown(input, { isStreaming: false, enabled: true });
		expect(out).toContain("\u00b9\u2070o10");
		expect(out).toContain("\u00b9\u00b2o12");
	});

	it("plain text passes through unchanged", () => {
		const input = "Done — the migration ran clean.";
		expect(toTuiMarkdown(input, { isStreaming: false, enabled: true })).toBe(input);
	});

	it("suggestion text containing brackets passes through unescaped without a URL", () => {
		// There is no link syntax to protect, so there is nothing to escape.
		const out = toTuiMarkdown("Try <snippet>use [npm test]</snippet> now", {
			isStreaming: false,
			enabled: true,
		});
		expect(out).toBe("Try ¹use [npm test] now");
	});
});

describe("chip labels", () => {
	it("superscripts single and double digits", () => {
		expect(superscript(1)).toBe("¹");
		expect(superscript(10)).toBe("¹⁰");
	});

	it("label is the superscript directly against the text", () => {
		expect(chipLabel(2, "run the tests")).toBe("²run the tests");
	});
});
