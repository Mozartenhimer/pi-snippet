/**
 * Generate src/extension/char-width.ts from Ghostty's own width table.
 *
 * Hand-written width ranges were wrong in ways that move click targets: a
 * suggestion containing an emoji (⌚, ⏩, ⚡) or a combining mark measured one
 * cell here and two — or zero — in the terminal. Rather than curate Unicode by
 * hand, the table is generated from libghostty-vt and checked in.
 *
 * Run: npm run gen:widths   (needs Ghostty; see scripts/ghostty-env.sh)
 */
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tool = join(here, ".build", "ghostty-width");
if (!existsSync(tool)) execFileSync("bash", [join(here, "ghostty-env.sh")], { stdio: "inherit" });

const table = execFileSync(tool, ["--all"], { encoding: "utf8", maxBuffer: 1 << 28 });

/** Collapse consecutive codepoints of the same non-default width into ranges. */
const ranges = { 0: [], 2: [] };
let previous = null;
for (const line of table.split("\n")) {
	if (!line) continue;
	const tab = line.indexOf("\t");
	const cp = Number.parseInt(line.slice(2, tab), 16);
	const width = Number(line.slice(tab + 1));
	if (width === 1) {
		previous = null;
		continue;
	}
	const bucket = ranges[width];
	if (!bucket) throw new Error(`unexpected width ${width} at U+${cp.toString(16)}`);
	if (previous && previous.width === width && previous.end + 1 === cp) {
		previous.end = cp;
		continue;
	}
	previous = { start: cp, end: cp, width };
	bucket.push(previous);
}

const hex = (cp) => `0x${cp.toString(16)}`;
const format = (list) =>
	list.map((r) => `\t${hex(r.start)}, ${hex(r.end)},`).join("\n");

const source = `/**
 * Display widths, generated from Ghostty's own table — do not edit by hand.
 *
 * Click hit-testing turns a character index into a screen column, so this must
 * agree with the terminal exactly: a glyph we measure as one cell and the
 * terminal draws as two puts every later chip on the line one column off.
 *
 * Regenerate with \`npm run gen:widths\`; \`npm run check:widths\` verifies it
 * still matches. Ranges are inclusive pairs, sorted, for binary search.
 *
 * Source: libghostty-vt ${new Date().getFullYear()} (ghostty::CodepointWidth),
 * ${ranges[0].length} zero-width and ${ranges[2].length} double-width ranges.
 */

/** Codepoints that occupy no cell: combining marks, joiners, variation selectors. */
const ZERO_WIDTH: readonly number[] = [
${format(ranges[0])}
];

/** Codepoints that occupy two cells: CJK, fullwidth forms, most emoji. */
const DOUBLE_WIDTH: readonly number[] = [
${format(ranges[2])}
];

function inRanges(ranges: readonly number[], code: number): boolean {
	let low = 0;
	let high = ranges.length / 2 - 1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		if (code < ranges[mid * 2]!) high = mid - 1;
		else if (code > ranges[mid * 2 + 1]!) low = mid + 1;
		else return true;
	}
	return false;
}

/** Cells a codepoint occupies on screen: 0, 1 or 2. */
export function charWidth(code: number): number {
	// Fast path: ASCII, which is every column of most chips.
	if (code >= 0x20 && code < 0x7f) return 1;
	if (code === 0) return 0;
	if (inRanges(ZERO_WIDTH, code)) return 0;
	if (inRanges(DOUBLE_WIDTH, code)) return 2;
	return 1;
}
`;

const out = join(here, "..", "src", "extension", "char-width.ts");
writeFileSync(out, source);
console.log(
	`wrote ${out}: ${ranges[0].length} zero-width ranges, ${ranges[2].length} double-width ranges`,
);
