import { describe, expect, it } from "vitest";
import { toTuiMarkdown } from "../src/shared/tui-markdown.js";

describe("toTuiMarkdown (PRD §12)", () => {
	it("renders suggestions as numbered bracketed spans", () => {
		const out = toTuiMarkdown(
			"Want me to <pi:suggest>rebuild the solution</pi:suggest> or <pi:suggest>run the tests</pi:suggest>?",
			{ isStreaming: false, enabled: true },
		);
		expect(out).toBe("Want me to **[1 rebuild the solution]** or **[2 run the tests]**?");
	});

	it("continues numbering across blocks via acceptedSoFar", () => {
		const out = toTuiMarkdown("Then <pi:suggest>option c</pi:suggest>?", {
			isStreaming: false,
			enabled: true,
			parse: { acceptedSoFar: 2 },
		});
		expect(out).toBe("Then **[3 option c]**?");
	});

	it("leaves code fences untouched", () => {
		const input = "```html\n<pi:suggest>not real</pi:suggest>\n```";
		expect(toTuiMarkdown(input, { isStreaming: false, enabled: true })).toBe(input);
	});

	it("strips tags to plain text when disabled", () => {
		const out = toTuiMarkdown("Want me to <pi:suggest>rebuild</pi:suggest>?", {
			isStreaming: false,
			enabled: false,
		});
		expect(out).toBe("Want me to rebuild?");
	});

	it("buffers partial tags while streaming (C1)", () => {
		expect(toTuiMarkdown("Want me to <pi:sug", { isStreaming: true, enabled: true })).toBe(
			"Want me to ",
		);
		expect(
			toTuiMarkdown("Want me to <pi:suggest>rebuild</pi:suggest> or", {
				isStreaming: true,
				enabled: true,
			}),
		).toBe("Want me to **[1 rebuild]** or");
	});

	it("finalized unclosed tag degrades to plain text (C4)", () => {
		expect(
			toTuiMarkdown("Sure — want me to <pi:suggest>rebuild the sol", {
				isStreaming: false,
				enabled: true,
			}),
		).toBe("Sure — want me to rebuild the sol");
	});

	it("renders at most ten numbered spans", () => {
		const nums = Array.from({ length: 11 }, (_, i) => i + 1);
		const input = nums.map((n) => `<pi:suggest>o${n}</pi:suggest>`).join(" ");
		expect(toTuiMarkdown(input, { isStreaming: false, enabled: true })).toBe(
			`${nums.slice(0, 10).map((n) => `**[${n} o${n}]**`).join(" ")} o11`,
		);
	});

	it("plain text passes through unchanged", () => {
		const input = "Done — the migration ran clean.";
		expect(toTuiMarkdown(input, { isStreaming: false, enabled: true })).toBe(input);
	});
});
