/**
 * MC/DC instrumentation for this extension's TypeScript sources.
 *
 * No JavaScript coverage tool measures MC/DC. v8 and istanbul report
 * statement, branch, function and line coverage; "branch" there means each arm
 * of a decision was taken at least once, which is decision coverage (and, for
 * `&&`/`||` operands, something close to condition coverage). Neither shows
 * that a condition can *independently* change the decision's outcome, which is
 * the whole content of MC/DC — so the measurement has to be built.
 *
 * ## What is measured
 *
 * A **decision** is a boolean expression that controls flow: the condition of
 * an `if`, `while`, `do`, `for`, or conditional expression, and any standalone
 * `&&`/`||` expression (`const live = a && b`). A **condition** is a leaf of
 * that expression once `&&`, `||`, `!` and parentheses are peeled away.
 *
 * This instruments the source so that each evaluation records which conditions
 * were evaluated, what they returned, and what the decision as a whole
 * returned. `analyze.ts` then computes **masking MC/DC**, the variant used for
 * short-circuiting languages: a condition that was never evaluated on a given
 * pass is masked rather than treated as false, because a short-circuit means
 * the language never asked.
 *
 * ## How it is applied
 *
 * By rewriting text at AST positions rather than re-printing the tree: edits
 * are collected as point insertions and applied back-to-front, so nested
 * decisions nest correctly and every byte the compiler did not need to change
 * survives exactly as written — comments, formatting, and the tab indentation
 * this repo uses included.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

export interface ConditionSite {
	line: number;
	text: string;
}

export interface DecisionSite {
	id: number;
	file: string;
	line: number;
	text: string;
	conditions: ConditionSite[];
}

interface Edit {
	pos: number;
	text: string;
	/**
	 * Tie-break for insertions at the same offset, which is the norm rather
	 * than the exception: a decision and its first condition start at the same
	 * character in `a && b`, and end at the same character too.
	 *
	 * Insertions are applied back-to-front at a point, so at equal offsets the
	 * *last* one applied ends up leftmost. The decision's wrapper has to end up
	 * outside its conditions' wrappers, which means its opening text is applied
	 * last (leftmost) and its closing text first (rightmost). Getting this
	 * backwards produced `__mcdcC(id,0,__mcdcD(id,a) && __mcdcC(id,1,b))` —
	 * the decision recording only its first condition's value as the outcome,
	 * and condition 0 recording the whole expression.
	 */
	order: number;
}

/** Peel parentheses and `as`/`!` assertions to reach the expression that matters. */
function unwrap(node: ts.Expression): ts.Expression {
	if (ts.isParenthesizedExpression(node)) return unwrap(node.expression);
	if (ts.isAsExpression(node) || ts.isNonNullExpression(node)) return unwrap(node.expression);
	return node;
}

function isLogical(node: ts.Expression): node is ts.BinaryExpression {
	return (
		ts.isBinaryExpression(node) &&
		(node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
			node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
	);
}

/**
 * The leaves of a decision.
 *
 * `!` is transparent: `!(a && b)` has the same two conditions as `a && b`,
 * since negating the decision does not change which conditions drive it. `??`
 * is not a boolean operator and stays a leaf.
 */
function conditionsOf(node: ts.Expression, out: ts.Expression[]): void {
	const inner = unwrap(node);
	if (isLogical(inner)) {
		conditionsOf(inner.left, out);
		conditionsOf(inner.right, out);
		return;
	}
	if (ts.isPrefixUnaryExpression(inner) && inner.operator === ts.SyntaxKind.ExclamationToken) {
		conditionsOf(inner.operand, out);
		return;
	}
	out.push(inner);
}

export function instrumentFile(
	sourcePath: string,
	sourceText: string,
	relPath: string,
	recorderSpecifier: string,
	startId: number,
): { code: string; decisions: DecisionSite[] } {
	const sf = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.ESNext, true);
	const edits: Edit[] = [];
	const decisions: DecisionSite[] = [];
	let nextId = startId;
	/** Decisions already claimed, so a nested `&&` is not also counted alone. */
	const claimed = new Set<ts.Node>();

	const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;

	/**
	 * Claim every logical node in a decision's tree, not just its leaves.
	 *
	 * `a || (b && c)` is one decision with three conditions. Claiming only the
	 * leaves left the inner `b && c` unclaimed, so the walk below picked it up
	 * as a decision of its own and instrumented b and c twice — inflating the
	 * denominator with conditions that already belonged to their parent.
	 */
	const claimTree = (node: ts.Expression): void => {
		const inner = unwrap(node);
		claimed.add(inner);
		if (isLogical(inner)) {
			claimTree(inner.left);
			claimTree(inner.right);
			return;
		}
		if (ts.isPrefixUnaryExpression(inner) && inner.operator === ts.SyntaxKind.ExclamationToken) {
			claimTree(inner.operand);
		}
		// A leaf is claimed but not descended into: a ternary nested inside one
		// carries its own decision and must still be found by the walk.
	};

	const record = (expr: ts.Expression): void => {
		const inner = unwrap(expr);
		if (claimed.has(inner)) return;
		const conds: ts.Expression[] = [];
		conditionsOf(inner, conds);
		// A single-condition decision is still MC/DC-relevant: the one condition
		// must be seen both ways. Keep it.
		const id = nextId++;
		claimTree(inner);
		decisions.push({
			id,
			file: relPath,
			line: lineOf(inner.getStart(sf)),
			text: inner.getText(sf).replace(/\s+/g, " ").slice(0, 160),
			conditions: conds.map((c) => ({
				line: lineOf(c.getStart(sf)),
				text: c.getText(sf).replace(/\s+/g, " ").slice(0, 120),
			})),
		});
		// The decision wraps the conditions, never the other way round: see the
		// `order` field on Edit for why equal offsets have to be broken this way.
		edits.push({ pos: inner.getStart(sf), text: `__mcdcD(${id},`, order: 1 });
		edits.push({ pos: inner.getEnd(), text: ")", order: 0 });
		conds.forEach((c, index) => {
			edits.push({ pos: c.getStart(sf), text: `__mcdcC(${id},${index},`, order: 0 });
			edits.push({ pos: c.getEnd(), text: ")", order: 1 });
		});
	};

	const visit = (node: ts.Node): void => {
		if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
			record(node.expression);
		} else if (ts.isConditionalExpression(node)) {
			record(node.condition);
		} else if (ts.isForStatement(node) && node.condition) {
			record(node.condition);
		} else if (isLogical(node as ts.Expression) && !claimed.has(node)) {
			// A standalone logical expression: `const live = a && b`, or a
			// returned one. Still a decision — its value is a boolean someone acts
			// on, and MC/DC applies wherever conditions combine.
			record(node as ts.Expression);
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);

	edits.sort((a, b) => b.pos - a.pos || a.order - b.order);
	let code = sourceText;
	for (const edit of edits) code = code.slice(0, edit.pos) + edit.text + code.slice(edit.pos);
	const importLine = `import { __mcdcC, __mcdcD } from "${recorderSpecifier}";\n`;
	return { code: importLine + code, decisions };
}

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path, out);
		else if (entry.name.endsWith(".ts")) out.push(path);
	}
	return out;
}

export function instrumentTree(srcDir: string, outDir: string): DecisionSite[] {
	const files = walk(srcDir).sort();
	const decisions: DecisionSite[] = [];
	for (const file of files) {
		const rel = relative(srcDir, file);
		const target = join(outDir, rel);
		mkdirSync(dirname(target), { recursive: true });
		// Every instrumented file reaches the one recorder, however deep it sits.
		const depth = rel.split("/").length - 1;
		const specifier = `${"../".repeat(depth) || "./"}__mcdc-recorder.js`;
		const result = instrumentFile(
			file,
			readFileSync(file, "utf8"),
			rel,
			specifier,
			decisions.length,
		);
		writeFileSync(target, result.code, "utf8");
		decisions.push(...result.decisions);
	}
	return decisions;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const root = resolve(process.argv[2] ?? ".");
	const outDir = join(root, ".mcdc", "src");
	mkdirSync(outDir, { recursive: true });
	const decisions = instrumentTree(join(root, "src"), outDir);
	writeFileSync(join(root, ".mcdc", "decisions.json"), JSON.stringify(decisions, null, "\t"));
	const conditions = decisions.reduce((n, d) => n + d.conditions.length, 0);
	console.log(`instrumented ${decisions.length} decisions, ${conditions} conditions`);
}
