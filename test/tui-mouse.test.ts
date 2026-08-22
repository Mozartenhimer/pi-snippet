/**
 * Clickable-text tests.
 *
 * A stand-in TUI with the same three surfaces the real one exposes: a
 * `render(width)` that returns lines, an input listener registry, and a
 * terminal with dimensions and a write sink. What cannot be tested here is
 * whether a real terminal emits the sequences these tests feed in — that needs
 * a terminal and a hand.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "vitest";

import { ClickableText, findSpans, stripAnsi, type TuiLike } from "../src/extension/tui-mouse.js";

const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

class FakeTui implements TuiLike {
	lines: string[] = [];
	written: string[] = [];
	listeners: Array<(data: string) => { consume?: boolean } | undefined> = [];
	/** pi-tui's buffer-relative cursor row bookkeeping. */
	hardwareCursorRow = 0;
	renderRequests = 0;

	requestRender(): void {
		this.renderRequests++;
	}
	/**
	 * Where the cursor really is on screen, 1-based, as the emulator would
	 * answer a DSR query. null: the terminal never answers (fallback path).
	 */
	cursorScreenRow: number | null = 1;
	terminal = {
		columns: 80,
		rows: 24,
		write: (data: string) => {
			this.written.push(data);
			if (data.includes("\x1b[6n") && this.cursorScreenRow !== null) {
				this.send(`\x1b[${this.cursorScreenRow};1R`);
			}
		},
	};

	render(_width: number): string[] {
		return this.lines;
	}

	addInputListener(listener: (data: string) => { consume?: boolean } | undefined): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener);
		};
	}

	/**
	 * Drives a render the way TUI.doRender does, so the cache fills. The cursor
	 * lands on the last buffer line; on screen that is bottom-aligned once the
	 * buffer overflows the terminal (a row-0 start, like `script` gives).
	 */
	draw(lines: string[]): void {
		this.lines = lines;
		this.render(this.terminal.columns);
		this.hardwareCursorRow = Math.max(0, lines.length - 1);
		this.cursorScreenRow = Math.min(lines.length, this.terminal.rows);
	}

	send(data: string): { consume?: boolean } | undefined {
		let result: { consume?: boolean } | undefined;
		for (const listener of this.listeners) result = listener(data) ?? result;
		return result;
	}
}

/** SGR press at 1-based screen coordinates. */
const click = (col: number, row: number, button = 0) => `\x1b[<${button};${col};${row}M`;

let tui: FakeTui;
let activated: string[];
let chips: ClickableText;

beforeEach(() => {
	tui = new FakeTui();
	activated = [];
	chips = new ClickableText({ onActivate: (target) => activated.push(target.id) });
	chips.attach(tui);
	chips.setTargets([
		{ id: "1", text: "¹rebuild the solution" },
		{ id: "2", text: "²run the tests" },
	]);
});

describe("mouse mode", () => {
	it("turns reporting on at attach and off at detach", () => {
		assert.match(tui.written.join(""), /\x1b\[\?1000h/);
		assert.match(tui.written.join(""), /\x1b\[\?1006h/);
		chips.detach();
		assert.match(tui.written.join(""), /\x1b\[\?1000l/);
	});

	it("restores the original render on detach", () => {
		const patched = tui.render;
		chips.detach();
		assert.notEqual(tui.render, patched);
		assert.deepEqual(tui.render(80), tui.lines, "rendering still works");
	});

	it("passes rendered lines through untouched", () => {
		const lines = [`${BOLD}Want me to ¹rebuild the solution?${RESET}`];
		tui.draw(lines);
		assert.deepEqual(tui.render(80), lines);
	});

	it("swallows mouse sequences so they never reach the editor", () => {
		tui.draw(["nothing here"]);
		assert.deepEqual(tui.send(click(1, 1)), { consume: true });
		assert.equal(tui.send("hello"), undefined, "ordinary keystrokes pass through");
	});
});

describe("hit testing", () => {
	it("activates the chip under the cursor", () => {
		tui.draw([`${BOLD}Want me to ¹rebuild the solution or ²run the tests?${RESET}`]);
		// "Want me to " is 11 columns, so the first chip starts at column 11.
		tui.send(click(13, 1));
		assert.deepEqual(activated, ["1"]);
	});

	it("picks the right chip when two share a line", () => {
		tui.draw(["Want me to ¹rebuild the solution or ²run the tests?"]);
		tui.send(click(41, 1));
		assert.deepEqual(activated, ["2"]);
	});

	it("ignores clicks just outside a chip", () => {
		tui.draw(["Want me to ¹rebuild the solution or ²run the tests?"]);
		tui.send(click(11, 1)); // the space before the chip
		tui.send(click(36, 1)); // the space after it
		assert.deepEqual(activated, []);
	});

	it("ignores the wheel and other buttons", () => {
		tui.draw(["Want me to ¹rebuild the solution"]);
		tui.send(click(13, 1, 64)); // wheel up
		tui.send(click(13, 1, 2)); // right button
		assert.deepEqual(activated, []);
		// Still consumed: an unhandled sequence would be typed into the editor.
		assert.deepEqual(tui.send(click(13, 1, 64)), { consume: true });
	});

	it("ignores button release", () => {
		tui.draw(["Want me to ¹rebuild the solution"]);
		tui.send("\x1b[<0;13;1m");
		assert.deepEqual(activated, []);
	});

	it("counts columns past ANSI styling, not raw string offsets", () => {
		tui.draw([`${BOLD}Want${RESET} me to ${BOLD}¹rebuild the solution${RESET}`]);
		tui.send(click(13, 1));
		assert.deepEqual(activated, ["1"]);
	});

	it("maps screen rows through the viewport, not the buffer", () => {
		// 30 lines of history in a 24-row terminal: only the last 24 are visible,
		// so the chip on buffer line 29 sits on screen row 23.
		const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
		lines[29] = "Want me to ¹rebuild the solution";
		tui.draw(lines);
		tui.send(click(13, 24));
		assert.deepEqual(activated, ["1"]);
		tui.send(click(13, 23));
		assert.deepEqual(activated, ["1"], "a different row must not activate");
	});

	it("a chip scrolled off the top is not clickable", () => {
		const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
		lines[0] = "Want me to ¹rebuild the solution";
		tui.draw(lines);
		for (let row = 1; row <= 24; row++) tui.send(click(13, row));
		assert.deepEqual(activated, []);
	});

	it("both halves of a wrapped chip are clickable", () => {
		tui.draw(["Want me to ¹rebuild the", "solution or something else"]);
		tui.send(click(20, 1));
		tui.send(click(3, 2));
		assert.deepEqual(activated, ["1", "1"]);
	});

	it("stale targets stop responding", () => {
		tui.draw(["Want me to ¹rebuild the solution"]);
		chips.setTargets([]);
		tui.send(click(13, 1));
		assert.deepEqual(activated, []);
	});

	it("handles double-width labels", () => {
		chips.setTargets([{ id: "1", text: "¹再構築する" }]);
		tui.draw(["やる ¹再構築する"]);
		// "やる " is 5 columns; the chip runs from column 5 to 5 + 1 + 10.
		tui.send(click(8, 1));
		assert.deepEqual(activated, ["1"]);
	});
});

describe("screen offset (pi launched mid-screen — the Ghostty case)", () => {
	it("maps clicks through the true offset when pi started below a shell prompt", () => {
		// pi drew two lines starting at screen row 11: shell history above is not
		// pi's, and pi never clears the screen.
		tui.draw(["Want me to ¹rebuild the solution", "or press a key"]);
		tui.hardwareCursorRow = 1; // cursor on buffer line 1 …
		tui.cursorScreenRow = 12; // … which really sits at screen row 12
		tui.send(click(13, 11)); // the chip's true screen position
		assert.deepEqual(activated, ["1"]);
		assert.ok(tui.renderRequests > 0, "insertion must repaint: consumed input skips pi's render pass");
		tui.send(click(13, 1)); // where the naive mapping would look
		assert.deepEqual(activated, ["1"], "screen row 1 is shell scrollback, not pi");
	});

	it("issues one cursor-position query per click burst and consumes the report", () => {
		tui.draw(["Want me to ¹rebuild the solution"]);
		tui.cursorScreenRow = null; // hold the answer to inspect the exchange
		tui.send(click(13, 1));
		tui.send(click(41, 1));
		const queries = tui.written.filter((w) => w.includes("\x1b[6n"));
		assert.equal(queries.length, 1, "second click reuses the outstanding query");
		assert.deepEqual(activated, [], "clicks wait for the terminal's answer");
		const result = tui.send("\x1b[1;1R");
		assert.deepEqual(result, { consume: true }, "the report never reaches the editor");
		assert.deepEqual(activated, ["1"], "both clicks resolve; only the first hits");
	});

	it("falls back to the bottom-aligned mapping when the terminal never answers", async () => {
		const silent = new FakeTui();
		silent.cursorScreenRow = null;
		const local: string[] = [];
		const localChips = new ClickableText({
			onActivate: (t) => local.push(t.id),
			dsrTimeoutMs: 10,
		});
		localChips.attach(silent);
		localChips.setTargets([{ id: "1", text: "¹rebuild the solution" }]);
		silent.draw(["Want me to ¹rebuild the solution"]);
		silent.cursorScreenRow = null;
		silent.send(click(13, 1));
		assert.deepEqual(local, []);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.deepEqual(local, ["1"], "row-0 launches still work without DSR support");
		localChips.detach();
	});

	it("legacy hitTest still maps through a bottom-aligned viewport", () => {
		const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
		lines[29] = "Want me to ¹rebuild the solution";
		tui.draw(lines);
		assert.equal(chips.hitTest(23, 12)?.id, "1");
		assert.equal(chips.hitTest(22, 12), null);
	});
});

describe("helpers", () => {
	it("strips CSI, OSC and APC sequences", () => {
		assert.equal(stripAnsi(`${BOLD}bold${RESET}`), "bold");
		assert.equal(stripAnsi("a\x1b_pi:c\x07b"), "ab", "pi-tui's own cursor marker");
		assert.equal(stripAnsi("\x1b]8;;https://example.com\x07link\x1b]8;;\x07"), "link");
	});

	it("finds every occurrence on a line", () => {
		assert.deepEqual(findSpans("x ¹a y ¹a", "¹a"), [
			{ start: 2, end: 4 },
			{ start: 7, end: 9 },
		]);
	});

	it("returns nothing when the text is absent", () => {
		assert.deepEqual(findSpans("nothing to see", "¹a"), []);
	});
});
