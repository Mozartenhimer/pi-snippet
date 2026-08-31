/**
 * The executable shim for the two halves of the MC/DC tool.
 *
 * Deliberately empty of logic, and excluded from instrumentation for that
 * reason: everything worth measuring was moved into `instrument.ts` and
 * `analyze.ts` as exported functions, because an entry point guarded on
 * `process.argv[1]` can never run under vitest and so can never be measured.
 * What is left here is argument plumbing and two writes to stdout.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { analyze, formatReport, loadRuns } from "./analyze.js";
import { instrumentAll, summarize, type DecisionSite } from "./instrument.js";

const [, , command, rootArg] = process.argv;
const root = resolve(rootArg ?? ".");

if (command === "instrument") {
	console.log(summarize(instrumentAll(root, ["src", "scripts/mcdc"])));
} else if (command === "analyze") {
	const decisions = JSON.parse(
		readFileSync(join(root, ".mcdc", "decisions.json"), "utf8"),
	) as DecisionSite[];
	const formatted = formatReport(analyze(decisions, loadRuns(join(root, ".mcdc", "runs"))));
	console.log(formatted.text);
	process.exitCode = formatted.gaps.length === 0 ? 0 : 1;
} else {
	console.error("usage: cli.ts <instrument|analyze> [root]");
	process.exitCode = 2;
}
