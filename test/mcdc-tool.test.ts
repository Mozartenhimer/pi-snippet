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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { instrumentFile, instrumentTree } from "../scripts/mcdc/instrument.js";
import {
	analyze,
	formatReport,
	isCovered,
	parseObservation,
	type ConditionReport,
	type DecisionReport,
} from "../scripts/mcdc/analyze.js";

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

/**
 * The AST shapes `instrument.ts` classifies.
 *
 * Every branch of that classification is a decision in its own right, and each
 * needs the pair that shows it deciding the outcome alone — so each shape gets
 * a source that has it and a source that does not.
 */
describe("decision discovery across statement shapes", () => {
	const decisionsIn = (source: string) =>
		instrumentFile("t.ts", source, "t.ts", "./r.js", 0).decisions;

	it("finds the condition of a while loop", () => {
		expect(decisionsIn("export function f(a: boolean) { while (a) { break; } }\n")).toHaveLength(1);
	});

	it("finds the condition of a do/while loop", () => {
		expect(decisionsIn("export function f(a: boolean) { do { break; } while (a); }\n")).toHaveLength(1);
	});

	it("finds the condition of a for loop", () => {
		expect(
			decisionsIn("export function f(a: boolean) { for (let i = 0; a; i++) { break; } }\n"),
		).toHaveLength(1);
	});

	it("finds no decision in a for loop that has no condition", () => {
		// `node.condition` is optional in the AST; `for (;;)` is the shape that
		// makes the second half of that check matter.
		expect(decisionsIn("export function f() { for (;;) { break; } }\n")).toHaveLength(0);
	});

	it("looks through an `as` assertion to the real condition", () => {
		const [decision] = decisionsIn("export function f(x: unknown) { if (x as boolean) return 1; return 0; }\n");
		expect(decision!.conditions.map((c) => c.text)).toEqual(["x"]);
	});

	it("looks through a non-null assertion to the real condition", () => {
		const [decision] = decisionsIn("export function f(x?: boolean) { if (x!) return 1; return 0; }\n");
		expect(decision!.conditions.map((c) => c.text)).toEqual(["x"]);
	});

	it("treats a negation as transparent, keeping the condition inside it", () => {
		const [decision] = decisionsIn("export function f(a: boolean, b: boolean) { if (!a && b) return 1; return 0; }\n");
		expect(decision!.conditions.map((c) => c.text)).toEqual(["a", "b"]);
	});

	it("treats a prefix operator that is not negation as part of the condition", () => {
		// `!` is transparent, every other prefix operator is not: `-x` is one
		// condition, not a negation wrapping one.
		const [decision] = decisionsIn("export function f(x: number, b: boolean) { if (-x && b) return 1; return 0; }\n");
		expect(decision!.conditions.map((c) => c.text)).toEqual(["-x", "b"]);
	});

	it("does not treat a non-logical binary operator as a decision to split", () => {
		// `===` is a binary expression but not `&&`/`||`, so it is one condition
		// rather than a decision with two.
		const [decision] = decisionsIn("export function f(a: number, b: number) { if (a === b) return 1; return 0; }\n");
		expect(decision!.conditions.map((c) => c.text)).toEqual(["a === b"]);
	});
});

describe("instrumenting a tree on disk", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mcdc-tree-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("walks subdirectories, skips non-TypeScript files, and passes the recorder through", () => {
		const src = join(dir, "src");
		mkdirSync(join(src, "nested"), { recursive: true });
		writeFileSync(join(src, "a.ts"), "export const a = (x: boolean) => x || false;\n", "utf8");
		writeFileSync(join(src, "nested", "b.ts"), "export const b = (x: boolean) => x || false;\n", "utf8");
		writeFileSync(join(src, "notes.md"), "not source\n", "utf8");
		// Copied verbatim: instrumenting the recorder would have its own hooks
		// calling themselves.
		writeFileSync(join(src, "recorder.ts"), "export const untouched = (x: boolean) => x || true;\n", "utf8");

		const out = join(dir, "out");
		const decisions = instrumentTree(src, out, 0, join(out, "__mcdc-recorder.ts"), "src");

		expect(existsSync(join(out, "notes.md"))).toBe(false);
		expect(existsSync(join(out, "nested", "b.ts"))).toBe(true);
		expect(readFileSync(join(out, "recorder.ts"), "utf8")).toBe(
			"export const untouched = (x: boolean) => x || true;\n",
		);
		expect(decisions.map((d) => d.file)).toEqual(["src/a.ts", "src/nested/b.ts"]);
	});

	it("writes a relative recorder specifier for a file beside the recorder", () => {
		// `relative()` returns a bare filename for a sibling, which is not a valid
		// module specifier until it is prefixed.
		const src = join(dir, "src");
		mkdirSync(src, { recursive: true });
		writeFileSync(join(src, "a.ts"), "export const a = (x: boolean) => x || false;\n", "utf8");
		const out = join(dir, "out");
		instrumentTree(src, out, 0, join(out, "__mcdc-recorder.ts"), "src");
		expect(readFileSync(join(out, "a.ts"), "utf8").split("\n")[0]).toBe(
			'import { __mcdcC, __mcdcD } from "./__mcdc-recorder.js";',
		);
	});

	it("writes a specifier that climbs out of a nested directory", () => {
		const src = join(dir, "src");
		mkdirSync(join(src, "deep"), { recursive: true });
		writeFileSync(join(src, "deep", "a.ts"), "export const a = (x: boolean) => x || false;\n", "utf8");
		const out = join(dir, "out");
		instrumentTree(src, out, 0, join(dir, "__mcdc-recorder.ts"), "src");
		expect(readFileSync(join(out, "deep", "a.ts"), "utf8").split("\n")[0]).toBe(
			'import { __mcdcC, __mcdcD } from "../../__mcdc-recorder.js";',
		);
	});

	it("numbers decisions continuously across trees", () => {
		const src = join(dir, "src");
		mkdirSync(src, { recursive: true });
		writeFileSync(join(src, "a.ts"), "export const a = (x: boolean) => x || false;\n", "utf8");
		const decisions = instrumentTree(src, join(dir, "out"), 7, join(dir, "r.ts"), "src");
		expect(decisions[0]!.id).toBe(7);
	});
});

describe("masked and absent condition values", () => {
	const obs = (...encoded: string[]) => encoded.map(parseObservation);

	it("ignores an observation where the condition itself was masked", () => {
		expect(isCovered(0, obs("-:1", "0:0"))).toBe(false);
	});

	it("ignores an observation that never reached the condition at all", () => {
		// An empty vector: the decision was evaluated but recorded no value at
		// this index, so there is nothing to compare.
		expect(isCovered(0, obs(":1", "0:0"))).toBe(false);
	});

	it("ignores a candidate partner that never reached the condition", () => {
		expect(isCovered(0, obs("1:1", ":0"))).toBe(false);
	});

	it("accepts a pair whose other condition is masked on the left-hand side", () => {
		expect(isCovered(0, obs("1-:1", "00:0"))).toBe(true);
	});
});

describe("report formatting", () => {
	const report = (over: Partial<DecisionReport> = {}, condition: Partial<ConditionReport> = {}): DecisionReport => ({
		decision: { id: 0, file: "f.ts", line: 3, text: "a && b", conditions: [{ line: 3, text: "a" }] },
		evaluated: true,
		outcomes: { true: true, false: true },
		conditions: [
			{ index: 0, line: 3, text: "a", covered: false, seen: { true: true, false: true }, ...condition },
		],
		...over,
	});

	it("reports a fully covered file as 100% with no gap list", () => {
		const formatted = formatReport([report({}, { covered: true })]);
		expect(formatted.gaps).toEqual([]);
		expect(formatted.text).toContain("f.ts");
		expect(formatted.text).toContain("100.00%");
		expect(formatted.text).not.toContain("without an MC/DC pair");
	});

	it("lists a gap and says why there is no pair", () => {
		const formatted = formatReport([report()]);
		expect(formatted.gaps).toHaveLength(1);
		expect(formatted.text).toContain("1 condition(s) without an MC/DC pair");
		expect(formatted.gaps[0]).toContain("no independence pair");
	});

	it("calls an empty set of decisions vacuously covered rather than NaN", () => {
		const formatted = formatReport([]);
		expect(formatted.text).toContain("100.00%");
		expect(formatted.text).not.toContain("NaN");
	});

	it.each([
		["decision never evaluated", { evaluated: false }, {}],
		["never true", {}, { seen: { true: false, false: true } }],
		["never false", {}, { seen: { true: true, false: false } }],
		["no independence pair", {}, {}],
	] as const)("names the reason %s", (reason, over, condition) => {
		const [built] = formatReport([report(over, condition)]).gaps;
		expect(built).toContain(reason);
	});
});
