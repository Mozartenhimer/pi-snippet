/**
 * The URL a chip carries in link mode is a contract between three processes
 * that never speak otherwise — the transformer that paints it, the handler the
 * desktop launches, and the socket that resolves it. These are the rules that
 * keep those three agreeing.
 */
import { describe, expect, it } from "vitest";
import {
	buildChipUrl,
	isLinkHost,
	isOwnHost,
	messageKey,
	parseChipPath,
	parseChipUrl,
	sessionToken,
} from "../src/shared/link-url.js";

describe("chip URLs", () => {
	it("round-trips what it builds", () => {
		const url = buildChipUrl("mybox", "a1b2c3d4", messageKey("hello"), 3);
		expect(parseChipUrl(url)).toEqual({
			host: "mybox",
			token: "a1b2c3d4",
			msg: messageKey("hello"),
			index: 3,
		});
	});

	it("names its server first, then the session, then the chip", () => {
		// The netloc is the machine to deliver to (ADR 0001); the token that
		// used to sit there moved one segment right.
		expect(buildChipUrl("mybox", "tok", "0f3e2a91", 2)).toBe("pisnip://mybox/tok/0f3e2a91/c2");
	});

	it("reaches two-digit chips, matching what Alt addressing reaches", () => {
		expect(parseChipUrl(buildChipUrl("mybox", "tok", "0f3e2a91", 99))?.index).toBe(99);
	});
});

/**
 * The host is the one field that now arrives from outside and reaches an `ssh`
 * argv, so its shape is the guard — see ADR 0001 §"Guards that ship with this".
 */
describe("the host in the URL", () => {
	it("accepts ssh aliases and hostnames", () => {
		for (const host of ["mybox", "box.example.com", "user@host", "a-b_c.d", "h1", "localhost"]) {
			expect(isLinkHost(host), host).toBe(true);
		}
	});

	it("refuses anything a shell could act on", () => {
		for (const host of ["", "a b", "a;b", "a$(id)", "a|b", "a&b", "a>b", "a\nb"]) {
			expect(isLinkHost(host), JSON.stringify(host)).toBe(false);
		}
		expect(isLinkHost("h".repeat(256))).toBe(false);
	});

	it("refuses a host ssh would read as an option", () => {
		// `ssh … -Jevil.com cmd url` shifts the destination to the next argument.
		// Harmless while only the user could write the string; remotely
		// triggerable the moment it comes from a URL.
		for (const host of ["-Jevil.com", "-oProxyCommand=x", "--", "-"]) {
			expect(isLinkHost(host), host).toBe(false);
			expect(parseChipUrl(`pisnip://${host}/tok/0f3e2a91/c1`), host).toBeNull();
		}
	});
});

describe("recognising our own machine", () => {
	// A local session paints its own hostname too, so a click on dead local
	// scrollback must stop here rather than ssh back to ourselves.
	it("matches on the first label, whatever the case or the domain", () => {
		expect(isOwnHost("mybox", "mybox")).toBe(true);
		expect(isOwnHost("MyBox.example.com", "mybox")).toBe(true);
		expect(isOwnHost("mybox", "mybox.internal.example.com")).toBe(true);
		expect(isOwnHost("user@mybox", "mybox")).toBe(true);
		expect(isOwnHost("localhost", "mybox")).toBe(true);
	});

	it("does not match a different machine", () => {
		expect(isOwnHost("work", "mybox")).toBe(false);
		expect(isOwnHost("mybox2", "mybox")).toBe(false);
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
		"https://example.com/mybox/tok/0f3e2a91/c1",
		"pisnip:/mybox/tok/0f3e2a91/c1",
		"pisnip://my!box/tok/0f3e2a91/c1",
		"PISNIP://mybox/tok/0f3e2a91/c1",
		"pisnip://mybox/tok!/0f3e2a91/c1",
		"pisnip://mybox/0f3e2a91/c1",
	])("rejects the foreign URL %s", (url) => {
		expect(parseChipUrl(url)).toBeNull();
	});
});

/**
 * A URL whose host and token are fine but whose path is not. The scheme regex
 * admits any path after the token, so the path parse is the second gate and
 * has to be able to say no on its own.
 */
describe("parseChipUrl — a well-formed host and token with a malformed path", () => {
	it("rejects a path that names no chip", () => {
		expect(parseChipUrl("pisnip://mybox/a1b2c3d4/nonsense")).toBeNull();
	});

	it("rejects chip zero", () => {
		expect(parseChipUrl("pisnip://mybox/a1b2c3d4/0f3e2a91/c0")).toBeNull();
		expect(parseChipPath("/0f3e2a91/c000")).toBeNull();
	});

	it("still accepts the highest addressable chip", () => {
		expect(parseChipPath("/0f3e2a91/c999")).toEqual({ msg: "0f3e2a91", index: 999 });
	});
});
