/**
 * The bounded insert shared by the inference cache and the three maps the TUI
 * extension keeps about recent messages.
 *
 * It had no direct tests when it was four copies of the same loop — every copy
 * was uncovered, since a test would have had to push 64 messages through the
 * extension to reach one. Extracting it made the eviction rule cheap to state.
 */
import { describe, expect, it } from "vitest";

import { putBounded } from "../src/shared/bounded-map.js";

describe("putBounded", () => {
	it("inserts like a plain set below the limit", () => {
		const map = new Map<string, number>();
		putBounded(map, "a", 1, 3);
		putBounded(map, "b", 2, 3);
		expect([...map]).toEqual([
			["a", 1],
			["b", 2],
		]);
	});

	it("drops the oldest key once the limit is passed", () => {
		const map = new Map<string, number>();
		for (const [i, key] of ["a", "b", "c", "d"].entries()) putBounded(map, key, i, 2);
		expect([...map.keys()]).toEqual(["c", "d"]);
	});

	it("ages a key from when it was first set, not when it was last written", () => {
		// Insertion order, not use order: re-setting `a` does not move it behind
		// `b`, so `a` is still the one evicted. The anchor lists this backs are
		// rewritten in place as each anchor streams in, so the distinction is
		// worth pinning down.
		const map = new Map<string, number>();
		putBounded(map, "a", 1, 2);
		putBounded(map, "b", 2, 2);
		putBounded(map, "a", 99, 2);
		putBounded(map, "c", 3, 2);
		expect([...map.keys()]).toEqual(["b", "c"]);
	});

	it("holds exactly the limit, evicting one per insert past it", () => {
		const map = new Map<number, number>();
		for (let i = 0; i < 100; i++) putBounded(map, i, i, 64);
		expect(map.size).toBe(64);
		expect(map.has(35)).toBe(false);
		expect(map.has(36)).toBe(true);
		expect(map.has(99)).toBe(true);
	});

	it("keeps the newest entry when the limit is one", () => {
		const map = new Map<string, number>();
		putBounded(map, "a", 1, 1);
		putBounded(map, "b", 2, 1);
		expect([...map]).toEqual([["b", 2]]);
	});
});

describe("putBounded — the eviction loop itself", () => {
	it("evicts nothing when the map is already within its limit", () => {
		const map = new Map([["a", 1]]);
		putBounded(map, "b", 2, 4);
		expect([...map.keys()]).toEqual(["a", "b"]);
	});

	it("evicts more than one entry when the limit shrinks under it", () => {
		const map = new Map<string, number>();
		for (const k of ["a", "b", "c", "d"]) putBounded(map, k, 1, 10);
		putBounded(map, "e", 2, 2);
		expect([...map.keys()]).toEqual(["d", "e"]);
	});

	it("accepts a limit of zero by keeping nothing", () => {
		const map = new Map<string, number>();
		putBounded(map, "a", 1, 0);
		expect(map.size).toBe(0);
	});
});
