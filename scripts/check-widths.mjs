/**
 * Diff our click hit-testing width table against Ghostty's own.
 *
 * Column math decides which chip a click landed on, so disagreeing with the
 * terminal about glyph widths means clicks land on the wrong suggestion. This
 * asks libghostty-vt (via scripts/ghostty-width) for the truth and reports
 * every codepoint where we differ, grouped into ranges.
 *
 * Run: npm run check:widths   (skips cleanly when Ghostty is not installed)
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { charWidth } from "../src/extension/tui-mouse.ts";

const here = dirname(fileURLToPath(import.meta.url));
const tool = join(here, ".build", "ghostty-width");

if (!existsSync(tool)) {
	try {
		execFileSync("bash", [join(here, "ghostty-env.sh")], { stdio: "inherit" });
	} catch {
		console.log("skipped: libghostty-vt not available");
		process.exit(0);
	}
}

const table = execFileSync(tool, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** Codepoints we deliberately never measure: they cannot appear in a chip. */
const isControl = (cp) => cp < 0x20 || (cp >= 0x7f && cp <= 0x9f);

const diffs = [];
for (const line of table.split("\n")) {
	if (!line) continue;
	const [cpText, widthText] = line.split("\t");
	const cp = Number.parseInt(cpText.slice(2), 16);
	const theirs = Number(widthText);
	if (isControl(cp)) continue;
	const ours = charWidth(cp);
	if (ours !== theirs) diffs.push({ cp, ours, theirs });
}

if (diffs.length === 0) {
	console.log("width table matches Ghostty across every codepoint checked");
	process.exit(0);
}

// Collapse runs so the report is readable.
const ranges = [];
for (const d of diffs) {
	const last = ranges.at(-1);
	if (last && last.end + 1 === d.cp && last.ours === d.ours && last.theirs === d.theirs) {
		last.end = d.cp;
	} else {
		ranges.push({ start: d.cp, end: d.cp, ours: d.ours, theirs: d.theirs });
	}
}

const hex = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
console.log(`${diffs.length} codepoints disagree with Ghostty, in ${ranges.length} ranges:\n`);
for (const r of ranges.slice(0, 60)) {
	const label = r.start === r.end ? hex(r.start) : `${hex(r.start)}..${hex(r.end)}`;
	console.log(`  ${label.padEnd(20)} ours=${r.ours} ghostty=${r.theirs}`);
}
if (ranges.length > 60) console.log(`  … and ${ranges.length - 60} more ranges`);
process.exitCode = 1;
