/**
 * Compute masking MC/DC from what the instrumented run observed.
 *
 * A condition `c` in a decision is covered when the run contains two
 * observations that together demonstrate `c` deciding the outcome by itself:
 *
 *  1. `c` was evaluated in both, with different values;
 *  2. the decision's outcome differs between them;
 *  3. every other condition either holds the same value in both, or was masked
 *     — never evaluated — in at least one of them.
 *
 * Rule 3 is what makes this *masking* MC/DC rather than unique-cause MC/DC.
 * `&&` and `||` short-circuit, so in `a && b` there is no way to hold `b` fixed
 * while `a` goes false: the language stops before `b` is asked. Unique-cause
 * MC/DC is therefore unsatisfiable for most short-circuited expressions, and
 * masking MC/DC — the variant DO-178C accepts for exactly this reason — treats
 * a condition the language declined to evaluate as one that cannot have
 * influenced the outcome.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { DecisionSite } from "./instrument.js";

export interface Observation {
	values: Array<boolean | null>;
	outcome: boolean;
}

export interface ConditionReport {
	index: number;
	line: number;
	text: string;
	covered: boolean;
	/** Which values were ever observed, for reporting what is missing. */
	seen: { true: boolean; false: boolean };
}

export interface DecisionReport {
	decision: DecisionSite;
	evaluated: boolean;
	outcomes: { true: boolean; false: boolean };
	conditions: ConditionReport[];
}

export function parseObservation(encoded: string): Observation {
	const [vector = "", outcome = "0"] = encoded.split(":");
	return {
		values: [...vector].map((c) => (c === "-" ? null : c === "1")),
		outcome: outcome === "1",
	};
}

/** Rules 1–3 above, for one condition. */
export function isCovered(index: number, observations: Observation[]): boolean {
	for (let a = 0; a < observations.length; a++) {
		for (let b = a + 1; b < observations.length; b++) {
			const x = observations[a]!;
			const y = observations[b]!;
			const xv = x.values[index];
			const yv = y.values[index];
			if (xv === null || xv === undefined || yv === null || yv === undefined) continue;
			if (xv === yv) continue;
			if (x.outcome === y.outcome) continue;
			let independent = true;
			const width = Math.max(x.values.length, y.values.length);
			for (let j = 0; j < width; j++) {
				if (j === index) continue;
				const xj = x.values[j] ?? null;
				const yj = y.values[j] ?? null;
				// Masked in either observation: it cannot be what moved the outcome.
				if (xj === null || yj === null) continue;
				if (xj !== yj) {
					independent = false;
					break;
				}
			}
			if (independent) return true;
		}
	}
	return false;
}

export function analyze(
	decisions: DecisionSite[],
	runs: Record<string, string[]>[],
): DecisionReport[] {
	const merged = new Map<number, Set<string>>();
	for (const run of runs) {
		for (const [id, encoded] of Object.entries(run)) {
			const set = merged.get(Number(id)) ?? new Set<string>();
			for (const e of encoded) set.add(e);
			merged.set(Number(id), set);
		}
	}
	return decisions.map((decision) => {
		const observations = [...(merged.get(decision.id) ?? [])].map(parseObservation);
		return {
			decision,
			evaluated: observations.length > 0,
			outcomes: {
				true: observations.some((o) => o.outcome),
				false: observations.some((o) => !o.outcome),
			},
			conditions: decision.conditions.map((condition, index) => ({
				index,
				line: condition.line,
				text: condition.text,
				covered: isCovered(index, observations),
				seen: {
					true: observations.some((o) => o.values[index] === true),
					false: observations.some((o) => o.values[index] === false),
				},
			})),
		};
	});
}

export function loadRuns(dir: string): Record<string, string[]>[] {
	try {
		return readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, string[]>);
	} catch {
		return [];
	}
}

export interface Formatted {
	text: string;
	/** One line per condition with no MC/DC pair, naming why it has none. */
	gaps: string[];
}

/** Why a condition has no pair, in the terms a reader can act on. */
export function gapReason(report: DecisionReport, condition: ConditionReport): string {
	if (!report.evaluated) return "decision never evaluated";
	if (!condition.seen.true) return "never true";
	if (!condition.seen.false) return "never false";
	return "no independence pair";
}

function percent(covered: number, total: number): string {
	// A file with no decisions at all is vacuously covered, not 0/0 = NaN.
	return total === 0 ? "100.00" : ((covered / total) * 100).toFixed(2);
}

/**
 * The per-file table and the gap list, as text.
 *
 * A pure function of the reports so it can be tested: this is where the
 * numbers a reader acts on are actually produced, and it used to live inside
 * an `import.meta.url` guard where no test could reach it.
 */
export function formatReport(reports: readonly DecisionReport[]): Formatted {
	const byFile = new Map<string, DecisionReport[]>();
	for (const report of reports) {
		const list = byFile.get(report.decision.file) ?? [];
		list.push(report);
		byFile.set(report.decision.file, list);
	}

	let total = 0;
	let covered = 0;
	const gaps: string[] = [];
	const rows: Array<[string, number, number]> = [];
	for (const [file, list] of [...byFile].sort()) {
		let fileTotal = 0;
		let fileCovered = 0;
		for (const report of list) {
			for (const condition of report.conditions) {
				fileTotal++;
				if (condition.covered) fileCovered++;
				else {
					gaps.push(
						`${file}:${condition.line}  ${condition.text}\n      (${gapReason(report, condition)}; in \`${report.decision.text}\`)`,
					);
				}
			}
		}
		total += fileTotal;
		covered += fileCovered;
		rows.push([file, fileCovered, fileTotal]);
	}

	const width = Math.max(...rows.map(([f]) => f.length), 10);
	const lines = [
		"",
		"Masking MC/DC by file",
		"",
		`${"file".padEnd(width)}  ${"cond".padStart(9)}  covered`,
		"-".repeat(width + 22),
	];
	for (const [file, c, t] of rows) {
		lines.push(`${file.padEnd(width)}  ${`${c}/${t}`.padStart(9)}  ${percent(c, t).padStart(6)}%`);
	}
	lines.push("-".repeat(width + 22));
	lines.push(
		`${"TOTAL".padEnd(width)}  ${`${covered}/${total}`.padStart(9)}  ${percent(covered, total).padStart(6)}%`,
	);
	if (gaps.length > 0) {
		lines.push("", `${gaps.length} condition(s) without an MC/DC pair:`, "");
		for (const gap of gaps) lines.push(`  - ${gap}`);
	}
	return { text: lines.join("\n"), gaps };
}
