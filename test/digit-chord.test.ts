/**
 * Multi-digit Alt addressing (PRD §12.2).
 *
 * The gesture under test: hold Alt, type 1, type 2, let go — that must insert
 * suggestion 12, while a lone Alt+3 against four suggestions inserts 3 with no
 * perceptible wait.
 */
import { describe, expect, it, vi } from "vitest";
import { chordState, DigitChord } from "../src/shared/digit-chord.js";

describe("chordState", () => {
	it("commits a single digit when no longer number can exist", () => {
		expect(chordState("3", 4)).toEqual({ value: 3, canExtend: false });
	});

	it("holds a digit that could still grow", () => {
		// 12 suggestions: "1" might yet become 10, 11 or 12.
		expect(chordState("1", 12)).toEqual({ value: 1, canExtend: true });
	});

	it("does not hold a digit whose extensions are all out of range", () => {
		// 12 suggestions: "2" cannot become 20-29, so it is final.
		expect(chordState("2", 12)).toEqual({ value: 2, canExtend: false });
	});

	it("resolves two digits", () => {
		expect(chordState("12", 12)).toEqual({ value: 12, canExtend: false });
	});

	it("keeps Alt+0 meaning the tenth suggestion", () => {
		expect(chordState("0", 10)).toEqual({ value: 10, canExtend: false });
		expect(chordState("0", 4)).toEqual({ value: null, canExtend: false });
	});

	it("addresses nothing beyond the addressable set", () => {
		expect(chordState("7", 4).value).toBeNull();
		expect(chordState("13", 12).value).toBeNull();
	});

	it("reaches three digits when there are that many suggestions", () => {
		expect(chordState("1", 120)).toEqual({ value: 1, canExtend: true });
		expect(chordState("11", 120)).toEqual({ value: 11, canExtend: true });
		expect(chordState("11", 99)).toEqual({ value: 11, canExtend: false });
	});
});

describe("DigitChord", () => {
	const make = (timeoutMs = 50) => {
		const commits: number[] = [];
		const rejects: string[] = [];
		const pendings: string[] = [];
		const chord = new DigitChord(
			{
				onCommit: (v) => commits.push(v),
				onReject: (d) => rejects.push(d),
				onPending: (d) => pendings.push(d),
			},
			timeoutMs,
		);
		return { chord, commits, rejects, pendings };
	};

	it("hold Alt, 1, 2, release → suggestion 12", () => {
		const { chord, commits } = make();
		chord.press(1, 12);
		expect(commits).toEqual([]); // waiting: 1 could still become 12
		chord.press(2, 12);
		expect(commits).toEqual([12]);
	});

	it("a lone digit commits immediately when unambiguous", () => {
		const { chord, commits } = make();
		chord.press(3, 4);
		expect(commits).toEqual([3]);
		expect(chord.pending).toBe(false);
	});

	it("releasing Alt settles an ambiguous prefix at once", () => {
		const { chord, commits } = make(10_000);
		chord.press(1, 12);
		expect(chord.pending).toBe(true);
		chord.release(12);
		expect(commits).toEqual([1]);
		expect(chord.pending).toBe(false);
	});

	it("without a release signal the prefix settles on the timeout", async () => {
		vi.useFakeTimers();
		try {
			const { chord, commits } = make(350);
			chord.press(1, 12);
			expect(commits).toEqual([]);
			vi.advanceTimersByTime(349);
			expect(commits).toEqual([]);
			vi.advanceTimersByTime(2);
			expect(commits).toEqual([1]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports the pending prefix for display, then clears it", () => {
		const { chord, pendings } = make();
		chord.press(1, 12);
		chord.press(2, 12);
		expect(pendings).toEqual(["1", ""]);
	});

	it("rejects a number with no such suggestion", () => {
		const { chord, commits, rejects } = make();
		chord.press(1, 12);
		chord.press(9, 12); // 19 > 12
		expect(commits).toEqual([]);
		expect(rejects).toEqual(["19"]);
	});

	it("release with nothing pending does nothing", () => {
		const { chord, commits } = make();
		chord.release(12);
		expect(commits).toEqual([]);
	});

	it("reset drops a pending prefix without inserting", () => {
		const { chord, commits, pendings } = make(10_000);
		chord.press(1, 12);
		chord.reset();
		expect(commits).toEqual([]);
		expect(pendings).toEqual(["1", ""]);
		chord.release(12);
		expect(commits).toEqual([]);
	});

	it("a timed-out prefix does not poison the next press", async () => {
		vi.useFakeTimers();
		try {
			const { chord, commits } = make(350);
			chord.press(1, 12);
			vi.advanceTimersByTime(400);
			chord.press(2, 12);
			expect(commits).toEqual([1, 2]);
		} finally {
			vi.useRealTimers();
		}
	});
});

/**
 * The states no gesture produces but the function still has to answer for.
 * `chordState` is exported and called from two surfaces; MC/DC showed these
 * arms had never been taken.
 */
describe("chordState — degenerate inputs", () => {
	it("addresses nothing with no digits typed", () => {
		expect(chordState("", 4)).toEqual({ value: null, canExtend: true });
		expect(chordState("", 0)).toEqual({ value: null, canExtend: false });
	});

	it("addresses nothing for a run of zeros", () => {
		// "0" alone means ten; "00" is a number below the first suggestion. It
		// can still extend — "001" is not yet ruled out — but addresses nothing
		// on its own.
		expect(chordState("00", 20)).toEqual({ value: null, canExtend: true });
	});

	it("addresses nothing for digits that are not a number", () => {
		expect(chordState("x", 4)).toEqual({ value: null, canExtend: false });
	});
});

describe("DigitChord — settling on nothing", () => {
	it("rejects digits that address nothing, and commits nothing", () => {
		const onCommit = vi.fn();
		const onReject = vi.fn();
		const chord = new DigitChord({ onCommit, onReject });
		chord.press(9, 3);
		expect(onCommit).not.toHaveBeenCalled();
		expect(onReject).toHaveBeenCalledWith("9");
	});

	it("does nothing on a release with no digits pending", () => {
		const onCommit = vi.fn();
		const onReject = vi.fn();
		const onPending = vi.fn();
		const chord = new DigitChord({ onCommit, onReject, onPending });
		chord.release(4);
		expect(onCommit).not.toHaveBeenCalled();
		expect(onReject).not.toHaveBeenCalled();
		expect(onPending).not.toHaveBeenCalled();
	});
});

describe("DigitChord — the addressable set shrinks under a pending chord", () => {
	it("rejects held digits that no longer address anything on release", () => {
		const onCommit = vi.fn();
		const onReject = vi.fn();
		// 2 is held rather than committed because 20 is still reachable.
		const chord = new DigitChord({ onCommit, onReject });
		chord.press(2, 25);
		expect(chord.pending).toBe(true);
		// The message changed under it: only one suggestion is addressable now.
		chord.release(1);
		expect(onCommit).not.toHaveBeenCalled();
		expect(onReject).toHaveBeenCalledWith("2");
	});
});
