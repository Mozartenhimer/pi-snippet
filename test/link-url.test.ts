/**
 * The URL a chip carries in link mode is a contract between three processes
 * that never speak otherwise — the transformer that paints it, the handler the
 * desktop launches, and the socket that resolves it. These are the rules that
 * keep those three agreeing.
 */
import { describe, expect, it } from "vitest";
import {
	buildChipUrl,
	messageKey,
	parseChipPath,
	parseChipUrl,
	sessionToken,
} from "../src/shared/link-url.js";

describe("chip URLs", () => {
	it("round-trips what it builds", () => {
		const url = buildChipUrl("a1b2c3d4", messageKey("hello"), 3);
		expect(parseChipUrl(url)).toEqual({
			token: "a1b2c3d4",
			msg: messageKey("hello"),
			index: 3,
		});
	});

	it("carries the chip kind in the path", () => {
		expect(buildChipUrl("tok", "0f3e2a91", 2)).toBe("pisnip://tok/0f3e2a91/c2");
	});

	it("reaches two-digit chips, matching what Alt addressing reaches", () => {
		expect(parseChipUrl(buildChipUrl("tok", "0f3e2a91", 99))?.index).toBe(99);
	});
});

describe("sessionToken", () => {
	it("is stable across a resume, unlike a fresh random token", () => {
		const id = "3fae1c2e-9b7c-4b8b-8f2a-1a2b3c4d5e6f";
		expect(sessionToken(id)).toBe(sessionToken(id));
	});

	it("separates two sessions the same way messageKey separates two messages", () => {
		expect(sessionToken("session-a")).not.toBe(sessionToken("session-b"));
	});

	it("is alnum, satisfying the handler's isalnum() check a raw UUID would fail", () => {
		expect(sessionToken("3fae1c2e-9b7c-4b8b-8f2a-1a2b3c4d5e6f")).toMatch(/^[0-9a-f]{8}$/);
	});
});

describe("messageKey", () => {
	it("is stable for the same text", () => {
		expect(messageKey("Want me to rebuild?")).toBe(messageKey("Want me to rebuild?"));
	});

	it("separates messages that differ by one character", () => {
		expect(messageKey("rebuild the solution")).not.toBe(messageKey("rebuild the solutio"));
	});

	it("is always eight hex characters, including for the empty string", () => {
		for (const text of ["", "a", "x".repeat(5000), "🎉 unicode ✨"]) {
			expect(messageKey(text)).toMatch(/^[0-9a-f]{8}$/);
		}
	});
});

describe("parsing what arrives on the socket", () => {
	it("accepts the path the handler forwards, with or without a leading slash", () => {
		expect(parseChipPath("0f3e2a91/c3")).toEqual({ msg: "0f3e2a91", index: 3 });
		expect(parseChipPath("/0f3e2a91/c3")).toEqual({ msg: "0f3e2a91", index: 3 });
		expect(parseChipPath(" 0f3e2a91/c3\n")).toEqual({ msg: "0f3e2a91", index: 3 });
	});

	// Everything here arrives from outside the process. A malformed value has
	// to be a miss, never an index coerced into something that resolves.
	it.each([
		["", "empty"],
		["0f3e2a91", "no target"],
		["0f3e2a91/c0", "zero is not a suggestion"],
		["0f3e2a91/c-1", "negative"],
		["0f3e2a91/c1.5", "not an integer"],
		["0f3e2a91/x1", "unknown layer"],
		["0f3e2a91/a1", "inferred-anchor URLs are gone; parse as a miss"],
		["0f3e2a91/c1/../../etc/passwd", "traversal"],
		["ZZZZ/c1", "non-hex message key"],
		["0f3e2a91/c99999", "absurd index"],
		["0f3e2a91/c1 rm -rf /", "trailing junk"],
	])("rejects %s (%s)", (input) => {
		expect(parseChipPath(input)).toBeNull();
	});

	it.each([
		"https://example.com/0f3e2a91/c1",
		"pisnip:/0f3e2a91/c1",
		"pisnip://tok!/0f3e2a91/c1",
		"PISNIP://tok/0f3e2a91/c1",
	])("rejects the foreign URL %s", (url) => {
		expect(parseChipUrl(url)).toBeNull();
	});
});
