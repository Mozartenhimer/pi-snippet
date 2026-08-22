/**
 * Clickable text in the terminal.
 *
 * Gives the TUI the one thing the browser had for free: a chip you can click.
 *
 * ## How it works, and why there is no fork
 *
 * Three facts about pi-tui make this possible from outside:
 *
 * 1. `TUI.doRender()` gets its content from `this.render(width)` — the public
 *    `Container.render`. Wrapping it on the instance yields every rendered line
 *    without changing a single byte of output.
 * 2. `TUI.addInputListener()` sees raw stdin before the focused component and
 *    can consume it, which is where mouse escape sequences are caught.
 * 3. pi-tui tracks where it left the hardware cursor, in buffer-relative rows
 *    (`hardwareCursorRow`). pi never clears the screen and only ever moves the
 *    cursor relatively, so when pi is launched under an existing shell prompt
 *    its buffer row 0 is NOT screen row 0 — the whole buffer is shifted down by
 *    however far the shell had scrolled. The screen position of that shift is
 *    unknowable from inside the process, so on each click the terminal itself
 *    is asked where the cursor is (DSR, `ESC[6n`); the reply row minus
 *    `hardwareCursorRow` is the screen row of buffer line 0, which turns a
 *    click's screen row into a buffer index exactly. Terminals answer DSR in
 *    well under a frame; if no answer arrives the click falls back to the
 *    bottom-aligned mapping, which is correct once pi has filled the screen.
 *
 * Hit testing matches the *rendered text* of each target rather than embedding
 * position markers in the message. That keeps escape sequences out of the
 * session file and out of what the model sees on later turns — the message
 * stays `¹rebuild the solution`, exactly as it reads.
 *
 * ## The cost, which is real
 *
 * Mouse reporting is a terminal-wide mode. While it is on:
 *
 * - The scroll wheel is delivered to the application, so the terminal's own
 *   scrollback stops responding to it.
 * - Click-drag text selection needs Shift held down in most terminals.
 *
 * That is a bad trade for anyone who scrolls more than they click, so it is
 * off unless asked for, and can be toggled at runtime.
 */

import { appendFileSync } from "node:fs";

import { charWidth } from "./char-width.js";

export { charWidth } from "./char-width.js";

export interface ClickTarget {
	id: string;
	/** The exact visible text to match, e.g. `[1 rebuild the solution]`. */
	text: string;
}

export interface TerminalLike {
	readonly columns: number;
	readonly rows: number;
	write(data: string): void;
}

export interface TuiLike {
	render(width: number): string[];
	terminal: TerminalLike;
	addInputListener(listener: (data: string) => { consume?: boolean } | undefined): () => void;
	requestRender?(force?: boolean): void;
	/** Buffer-relative row where pi-tui last left the hardware cursor. */
	hardwareCursorRow?: number;
}

export interface ClickableTextOptions {
	onActivate: (target: ClickTarget) => void;
	/** Called for clicks that hit nothing. */
	onMiss?: () => void;
	/** How long to wait for the terminal's cursor-position report. */
	dsrTimeoutMs?: number;
}

/** Diagnostics for click mapping; set PI_CLIK_CLICK_DEBUG to a file path. */
function debugLog(message: () => string): void {
	const path = process.env.PI_CLIK_CLICK_DEBUG;
	if (!path) return;
	try {
		appendFileSync(path, `${message()}\n---\n`);
	} catch {
		/* diagnostics only */
	}
}

/** DECSET 1000 (button events) + 1006 (SGR coordinates, needed past column 223). */
const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1006l\x1b[?1000l";
const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const DSR_QUERY = "\x1b[6n";
const DSR_RESPONSE = /\x1b\[(\d+);(\d+)R/;
const DSR_TIMEOUT_MS = 200;
/** A stale report may still arrive after the timeout; keep eating it. */
const DSR_CONSUME_GRACE_MS = 1000;

export class ClickableText {
	private tui: TuiLike | null = null;
	private targets: ClickTarget[] = [];
	private lines: string[] = [];
	private originalRender: ((width: number) => string[]) | null = null;
	private removeListener: (() => void) | null = null;
	private readonly options: ClickableTextOptions;

	/** Clicks parked while the terminal is asked for the cursor position. */
	private pendingClicks: Array<{ row: number; col: number }> = [];
	/** `hardwareCursorRow` captured at the moment the DSR query was written. */
	private dsrAnchor = 0;
	private dsrTimer: ReturnType<typeof setTimeout> | null = null;
	private dsrConsumeUntil = 0;

	constructor(options: ClickableTextOptions) {
		this.options = options;
	}

	get enabled(): boolean {
		return this.tui !== null;
	}

	attach(tui: TuiLike): void {
		if (this.tui) return;
		this.tui = tui;

		// Cache what was drawn. The lines are returned untouched — this wrapper
		// observes, it does not rewrite.
		const original = tui.render.bind(tui);
		this.originalRender = original;
		tui.render = (width: number) => {
			const lines = original(width);
			this.lines = lines;
			return lines;
		};

		this.removeListener = tui.addInputListener((data) => this.handleInput(data));
		tui.terminal.write(MOUSE_ON);
	}

	detach(): void {
		if (!this.tui) return;
		this.tui.terminal.write(MOUSE_OFF);
		this.removeListener?.();
		if (this.originalRender) this.tui.render = this.originalRender;
		this.removeListener = null;
		this.originalRender = null;
		this.lines = [];
		if (this.dsrTimer !== null) clearTimeout(this.dsrTimer);
		this.dsrTimer = null;
		this.pendingClicks = [];
		this.tui = null;
	}

	setTargets(targets: ClickTarget[]): void {
		this.targets = targets;
	}

	/**
	 * Consumes every mouse sequence, hit-testing left-button presses.
	 *
	 * Unrecognised buttons (wheel, right, motion) are swallowed too: with
	 * reporting on they would otherwise be typed into the editor as literal
	 * escape gibberish.
	 */
	private handleInput(data: string): { consume?: boolean } | undefined {
		let consumed = false;

		// A cursor-position report is only ever present because this class asked
		// for one; eat it so "1;42R" is never typed into the editor.
		if (Date.now() < this.dsrConsumeUntil) {
			const report = DSR_RESPONSE.exec(data);
			if (report) {
				consumed = true;
				if (this.dsrTimer !== null) {
					clearTimeout(this.dsrTimer);
					this.dsrTimer = null;
					this.resolvePendingClicks(Number(report[1]) - 1);
				}
			}
		}

		if (!data.includes("\x1b[<")) return consumed ? { consume: true } : undefined;
		SGR_MOUSE.lastIndex = 0;
		let match: RegExpExecArray | null;
		let sawMouse = false;
		while ((match = SGR_MOUSE.exec(data)) !== null) {
			sawMouse = true;
			const button = Number(match[1]);
			const col = Number(match[2]) - 1; // SGR coordinates are 1-based
			const row = Number(match[3]) - 1;
			const isPress = match[4] === "M";
			const isMotion = (button & 32) !== 0;
			const isWheel = button >= 64;
			if (!isPress || isMotion || isWheel || (button & 3) !== 0) continue;

			this.pendingClicks.push({ row, col });
			this.requestCursorPosition();
		}
		return sawMouse || consumed ? { consume: true } : undefined;
	}

	/**
	 * Asks the terminal where the cursor is, so pending clicks can be mapped
	 * from screen rows to buffer lines with the true offset.
	 */
	private requestCursorPosition(): void {
		if (!this.tui || this.dsrTimer !== null) return;
		const anchor = this.tui.hardwareCursorRow;
		if (typeof anchor !== "number") {
			// No cursor bookkeeping to anchor against — legacy mapping.
			this.flushPendingClicks((row, col) => this.hitTest(row, col));
			return;
		}
		this.dsrAnchor = anchor;
		this.dsrConsumeUntil = Date.now() + DSR_CONSUME_GRACE_MS;
		this.dsrTimer = setTimeout(() => {
			this.dsrTimer = null;
			this.flushPendingClicks((row, col) => this.hitTest(row, col));
		}, this.options.dsrTimeoutMs ?? DSR_TIMEOUT_MS);
		this.tui.terminal.write(DSR_QUERY);
	}

	/** The terminal answered: cursor is at `cursorScreenRow` (0-based). */
	private resolvePendingClicks(cursorScreenRow: number): void {
		// The cursor sits on buffer line `dsrAnchor`, so buffer line 0 is drawn
		// at this screen row (negative once the buffer has scrolled the screen).
		const bufferTopScreenRow = cursorScreenRow - this.dsrAnchor;
		debugLog(() => {
			const lines = this.lines.map((l, i) => `${i}: ${JSON.stringify(stripAnsi(l)).slice(0, 90)}`);
			return [
				`resolve: dsrRow=${cursorScreenRow} anchor=${this.dsrAnchor} bufferTop=${bufferTopScreenRow}`,
				`clicks=${JSON.stringify(this.pendingClicks)} targets=${JSON.stringify(this.targets)}`,
				`lines (${this.lines.length}):`,
				...lines,
			].join("\n");
		});
		this.flushPendingClicks((row, col) => this.hitTestLine(row - bufferTopScreenRow, col));
	}

	private flushPendingClicks(
		test: (row: number, col: number) => ClickTarget | null,
	): void {
		const clicks = this.pendingClicks;
		this.pendingClicks = [];
		let activatedAny = false;
		for (const { row, col } of clicks) {
			const hit = test(row, col);
			debugLog(() => `flush: click(${row},${col}) -> ${hit ? `hit ${hit.id}` : "miss"}`);
			try {
				if (hit) {
					this.options.onActivate(hit);
					activatedAny = true;
				} else {
					this.options.onMiss?.();
				}
			} catch (error) {
				debugLog(() => `activate threw: ${String(error)}`);
			}
		}
		// Consumed input never reaches pi's own render pass, so a repaint has
		// to be asked for — without this the inserted text sits invisibly in
		// the editor until the next keypress.
		if (activatedAny) this.tui?.requestRender?.();
	}

	/**
	 * Fallback mapping when the terminal never answers DSR: assume the buffer
	 * is bottom-aligned to the screen. Exposed for tests.
	 */
	hitTest(screenRow: number, screenCol: number): ClickTarget | null {
		if (!this.tui) return null;
		const viewportTop = Math.max(0, this.lines.length - this.tui.terminal.rows);
		return this.hitTestLine(viewportTop + screenRow, screenCol);
	}

	/** Matches a column of one buffer line against the targets, or null. */
	private hitTestLine(bufferIndex: number, screenCol: number): ClickTarget | null {
		if (!this.tui || this.targets.length === 0) return null;
		const line = this.lines[bufferIndex];
		if (line === undefined) return null;

		const visible = stripAnsi(line);
		for (const target of this.targets) {
			for (const span of findSpans(visible, target.text)) {
				if (screenCol >= span.start && screenCol < span.end) return target;
			}
		}
		return null;
	}
}

interface Span {
	start: number;
	end: number;
}

/**
 * Column ranges where `text` appears in a rendered line.
 *
 * A chip that wrapped mid-phrase leaves a prefix at the end of one line and the
 * rest at the start of the next, so both halves are matched — clicking either
 * one has to work.
 */
export function findSpans(visible: string, text: string): Span[] {
	const spans: Span[] = [];
	if (!text) return spans;

	let from = 0;
	for (;;) {
		const index = visible.indexOf(text, from);
		if (index === -1) break;
		spans.push({ start: columnOf(visible, index), end: columnOf(visible, index + text.length) });
		from = index + text.length;
	}
	if (spans.length > 0) return spans;

	// Wrapped: the tail of this line is a prefix of the target …
	for (let length = text.length - 1; length > 0; length--) {
		if (visible.endsWith(text.slice(0, length))) {
			const start = visible.length - length;
			return [{ start: columnOf(visible, start), end: columnOf(visible, visible.length) }];
		}
	}
	// … or the head of this line is the rest of it.
	const trimmed = visible.trimStart();
	const indent = visible.length - trimmed.length;
	for (let length = text.length - 1; length > 0; length--) {
		if (trimmed.startsWith(text.slice(text.length - length))) {
			return [{ start: columnOf(visible, indent), end: columnOf(visible, indent + length) }];
		}
	}
	return spans;
}

/** CSI, OSC and APC sequences, including pi-tui's own zero-width markers. */
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]/g;

export function stripAnsi(value: string): string {
	return value.replace(ANSI, "");
}

/** Visible column of a character index, accounting for glyph widths. */
function columnOf(visible: string, index: number): number {
	let column = 0;
	for (const char of visible.slice(0, index)) column += charWidth(char.codePointAt(0) ?? 0);
	return column;
}
