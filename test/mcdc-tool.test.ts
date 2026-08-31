/**
 * Tests for the MC/DC measurement itself (`scripts/mcdc/`).
 *
 * A coverage tool that is wrong reports a confident number, and nothing about
 * the number says it is wrong. This one did exactly that twice before it had
 * any tests: once reporting 0.00% because its flush never ran, and once
 * reporting 45.41% instead of 57.14% because the decision wrapper nested
 * *inside* its first condition rather than around the whole expression. Both
 * failures are pinned here.
 */
import { describe, expect, it } from "vitest";

import { instrumentFile } from "../scripts/mcdc/instrument.js";
import { analyze, isCovered, parseObservation } from "../scripts/mcdc/analyze.js";

/** The instrumented line, without the recorder import the transform prepends. */
function body(source: string): string {
	return instrumentFile("t.ts", source, "t.ts", "./r.js", 0).code.split("\n")[1]!;
}

describe("instrumentation nesting", () => {
	it("wraps the whole decision, not just its first condition", () => {
		// The regression: a decision and its first condition begin at the same
		// offset, and the tie-break put the condition's wrapper outside. That
		// recorded `a`'s value as the decision's outcome and the whole
		// expression as condition 0 — garbage that still looked like data.
		expect(body("export const f = (a: boolean, b: boolean) => a && b;\n")).toBe(
			"export const f = (a: boolean, b: boolean) => __mcdcD(0,__mcdcC(0,0,a) && __mcdcC(0,1,b));",
		);
	});

	it("wraps a single-condition decision the same way round", () => {
		expect(body("export function g(x: boolean) { if (x) return 1; return 0; }\n")).toBe(
			"export function g(x: boolean) { if (__mcdcD(0,__mcdcC(0,0,x))) return 1; return 0; }",
		);
	});

	it("treats a nested logical group as conditions of one decision", () => {
		// `a || (b && c)` is one decision with three conditions. Claiming only
		// the leaves left `b && c` looking like a decision of its own, which
		// instrumented b and c twice and inflated the denominator.
		expect(
			body("export function h(a: boolean, b: boolean, c: boolean) { if (a || (b && c)) return 1; return 0; }\n"),
		).toBe(
			"export function h(a: boolean, b: boolean, c: boolean) { if (__mcdcD(0,__mcdcC(0,0,a) || (__mcdcC(0,1,b) && __mcdcC(0,2,c)))) return 1; return 0; }",
		);
	});

	it("counts each decision once, with every leaf as a condition", () => {
		const { decisions } = instrumentFile(
			"t.ts",
			"export function h(a: boolean, b: boolean, c: boolean) { if (a || (b && c)) return 1; return 0; }\n",
			"t.ts",
			"./r.js",
			0,
		);
		expect(decisions).toHaveLength(1);
		expect(decisions[0]!.conditions.map((c) => c.text)).toEqual(["a", "b", "c"]);
	});

	it("still finds a decision nested inside a condition", () => {
		// A leaf is claimed but not descended into, so a ternary inside one is
		// its own decision rather than being swallowed.
		const { decisions } = instrumentFile(
			"t.ts",
			"export function k(a: boolean, b: boolean) { if (a && (b ? f() : g())) return 1; return 0; }\n",
			"t.ts",
			"./r.js",
			0,
		);
		expect(decisions).toHaveLength(2);
		expect(decisions[1]!.conditions.map((c) => c.text)).toEqual(["b"]);
	});

	it("preserves the source it does not need to change", () => {
		// Text rewriting at AST offsets, not a re-print: comments and this
		// repo's tab indentation have to survive verbatim.
		const source = "export function m(a: boolean) {\n\t// a comment\n\treturn a;\n}\n";
		expect(instrumentFile("t.ts", source, "t.ts", "./r.js", 0).code).toBe(
			`import { __mcdcC, __mcdcD } from "./r.js";\n${source}`,
		);
	});
});

describe("masking MC/DC verdicts", () => {
	const obs = (...encoded: string[]) => encoded.map(parseObservation);

	it("accepts a pair whose other condition is masked by short-circuit", () => {
		// `a && b`: a=T,b=T -> true; a=F, b never evaluated -> false. That pair
		// is what makes condition 0 independent, and it only counts because a
		// masked condition cannot have influenced the outcome.
		expect(isCovered(0, obs("11:1", "0-:0"))).toBe(true);
	});

	it("accepts a pair holding the other condition fixed", () => {
		expect(isCovered(1, obs("11:1", "10:0"))).toBe(true);
	});

	it("rejects a condition that never took both values", () => {
		expect(isCovered(0, obs("11:1", "10:0"))).toBe(false);
	});

	it("rejects a pair whose outcome did not change", () => {
		expect(isCovered(0, obs("10:0", "00:0"))).toBe(false);
	});

	it("rejects a pair where another evaluated condition also moved", () => {
		// Both conditions differ, so neither is shown to decide the outcome
		// alone — the case that separates MC/DC from mere condition coverage.
		expect(isCovered(0, obs("11:1", "00:0"))).toBe(false);
	});

	it("reports a decision that was never evaluated", () => {
		const decisions = [
			{ id: 0, file: "t.ts", line: 1, text: "a && b", conditions: [
				{ line: 1, text: "a" },
				{ line: 1, text: "b" },
			] },
		];
		const [report] = analyze(decisions, []);
		expect(report!.evaluated).toBe(false);
		expect(report!.conditions.every((c) => c.covered)).toBe(false);
	});

	it("unions observations across worker processes", () => {
		// Each vitest worker writes its own file; neither half proves
		// independence alone, and the union does.
		const decisions = [
			{ id: 0, file: "t.ts", line: 1, text: "a && b", conditions: [
				{ line: 1, text: "a" },
				{ line: 1, text: "b" },
			] },
		];
		const [report] = analyze(decisions, [{ "0": ["11:1"] }, { "0": ["0-:0", "10:0"] }]);
		expect(report!.conditions.map((c) => c.covered)).toEqual([true, true]);
	});
});
