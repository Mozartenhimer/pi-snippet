/**
 * Multi-digit suggestion addressing (PRD §12.2).
 *
 * A terminal has ten digit keys, so `Alt+N` alone tops out at ten suggestions.
 * Holding Alt and typing `1` `2` sends two ordinary Alt+digit events a
 * millisecond apart — there is no "Alt released" byte in the legacy encoding —
 * so digits are accumulated and committed when no longer number could follow.
 *
 * The wait only ever happens when a longer number is actually reachable: with
 * four suggestions on screen, `Alt+3` commits instantly because no 30-something
 * exists. Surfaces that *can* observe the modifier being released (a browser's
 * `keyup`, a terminal that reports key-release events) commit on it immediately
 * instead of waiting out the timer.
 *
 * Pure decision logic lives here so both surfaces agree on what a digit means;
 * the timers and key events belong to the callers.
 */

/** How long an ambiguous prefix waits for another digit. */
const CHORD_TIMEOUT_MS = 350;

export interface ChordState {
	/**
	 * The suggestion number these digits address (1-based), or null when they
	 * address nothing — the number is larger than the addressable set.
	 */
	value: number | null;
	/** True when another digit could still address a larger suggestion. */
	canExtend: boolean;
}

/**
 * What a run of typed digits means against `count` addressable suggestions.
 *
 * A leading `0` means ten: `Alt+0` was the tenth suggestion before chaining
 * existed, and zero addresses nothing on its own, so the muscle memory is kept.
 */
export function chordState(digits: string, count: number): ChordState {
	if (digits === "") return { value: null, canExtend: count > 0 };
	if (digits === "0") return { value: count >= 10 ? 10 : null, canExtend: false };

	const value = Number(digits);
	if (!Number.isFinite(value)) return { value: null, canExtend: false };
	return {
		value: value >= 1 && value <= count ? value : null,
		// Reachable only if the smallest extension (value * 10) is in range.
		canExtend: value * 10 <= count,
	};
}

export interface ChordCallbacks {
	/** A suggestion number was settled on (1-based). */
	onCommit(value: number): void;
	/** The typed digits address nothing; `digits` is what was typed. */
	onReject?(digits: string): void;
	/**
	 * Called whenever the pending digits change, including to "" when the
	 * chord clears. Surfaces use it to show what is being typed.
	 */
	onPending?(digits: string): void;
}

/**
 * Accumulates digits into a suggestion number.
 *
 * Callers feed digits (`press`), may report the modifier being released
 * (`release`), and must supply the current addressable count each press.
 */
export class DigitChord {
	private digits = "";
	private timer: ReturnType<typeof setTimeout> | null = null;
	private readonly callbacks: ChordCallbacks;
	private readonly timeoutMs: number;

	constructor(callbacks: ChordCallbacks, timeoutMs: number = CHORD_TIMEOUT_MS) {
		this.callbacks = callbacks;
		this.timeoutMs = timeoutMs;
	}

	/** True while digits are held waiting for a possible next one. */
	get pending(): boolean {
		return this.digits !== "";
	}

	press(digit: number, count: number): void {
		this.clearTimer();
		const digits = this.digits + String(digit);
		const state = chordState(digits, count);

		if (state.canExtend) {
			this.digits = digits;
			this.callbacks.onPending?.(digits);
			this.timer = setTimeout(() => {
				this.timer = null;
				this.settle(count);
			}, this.timeoutMs);
			return;
		}

		this.digits = "";
		this.callbacks.onPending?.("");
		if (state.value !== null) this.callbacks.onCommit(state.value);
		else this.callbacks.onReject?.(digits);
	}

	/**
	 * The modifier was released: whatever is pending is final. Surfaces
	 * without a release signal simply never call this.
	 */
	release(count: number): void {
		if (!this.pending) return;
		this.clearTimer();
		this.settle(count);
	}

	/** Drop any pending digits without committing (message changed, etc.). */
	reset(): void {
		this.clearTimer();
		if (this.digits !== "") {
			this.digits = "";
			this.callbacks.onPending?.("");
		}
	}

	/**
	 * Finish a pending chord. Only reached with digits held: the timer is armed
	 * only after storing them, and `release` returns early when nothing is
	 * pending — so the empty-digits guard that used to stand here could never
	 * fire.
	 */
	private settle(count: number): void {
		const digits = this.digits;
		this.digits = "";
		this.callbacks.onPending?.("");
		const state = chordState(digits, count);
		if (state.value !== null) this.callbacks.onCommit(state.value);
		else this.callbacks.onReject?.(digits);
	}

	private clearTimer(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}
}
