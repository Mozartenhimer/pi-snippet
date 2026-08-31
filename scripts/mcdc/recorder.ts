/**
 * The runtime half of the MC/DC measurement: what each decision was observed
 * doing, written out per process for `analyze.ts` to combine.
 *
 * Vitest runs test files in a pool of separate processes, so nothing can be
 * accumulated in one shared object — each process writes its own file on exit
 * and the analysis unions them.
 *
 * The two hooks are called from instrumented source (`instrument.ts`):
 * `__mcdcC` records one condition's value as it is evaluated, and `__mcdcD`
 * closes the pass by recording the decision's own outcome. Both are pass-through
 * — they return exactly what they were given — so instrumented code behaves
 * identically to the original, short-circuiting included: a condition the
 * language never evaluates never calls `__mcdcC`, which is precisely the
 * "masked" case MC/DC has to account for.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Per decision, the conditions evaluated so far in the current pass. */
const current = new Map<number, Map<number, boolean>>();
/**
 * Per decision, the distinct observations seen. An observation is the vector of
 * condition values (`true`/`false`/`null` for masked) plus the outcome, encoded
 * as a string so the set stays small however many times a test loops.
 */
const observed = new Map<number, Set<string>>();

export function __mcdcC<T>(decision: number, index: number, value: T): T {
	let pass = current.get(decision);
	if (!pass) {
		pass = new Map();
		current.set(decision, pass);
	}
	pass.set(index, Boolean(value));
	return value;
}

export function __mcdcD<T>(decision: number, value: T): T {
	const pass = current.get(decision);
	current.delete(decision);
	let seen = observed.get(decision);
	if (!seen) {
		seen = new Set();
		observed.set(decision, seen);
	}
	const size = pass ? Math.max(...pass.keys()) + 1 : 0;
	const vector: string[] = [];
	for (let i = 0; i < size; i++) {
		const v = pass?.get(i);
		vector.push(v === undefined ? "-" : v ? "1" : "0");
	}
	seen.add(`${vector.join("")}:${Boolean(value) ? "1" : "0"}`);
	return value;
}

const dir = process.env.MCDC_OUT ?? ".mcdc/runs";
let written = false;

/**
 * Write this worker's observations out.
 *
 * Called from an `afterAll` in a setup file rather than left to `process.on
 * ("exit")`: vitest runs test files in a worker pool, and an exit hook
 * registered from a worker either never fires or fires against a module
 * registry that is already being torn down — which is why the first run of this
 * tool reported a confident 0%, with every decision "never evaluated", while
 * the instrumented code had in fact been running the whole time.
 */
export function __mcdcFlush(): void {
	if (written) return;
	written = true;
	try {
		mkdirSync(dir, { recursive: true });
		const out: Record<string, string[]> = {};
		for (const [id, set] of observed) out[String(id)] = [...set];
		writeFileSync(join(dir, `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`), JSON.stringify(out), "utf8");
	} catch {
		/* a run that cannot write its observations is a gap in the report, not a
		   failed test run */
	}
}

// Belt and braces for a run outside vitest (a script, a harness): harmless
// where the flush above already happened.
process.on("exit", __mcdcFlush);
