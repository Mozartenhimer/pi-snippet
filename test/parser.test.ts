import { describe, expect, it } from "vitest";
import {
	parseSuggestions,
	visibleStreamingPrefix,
} from "../src/shared/suggestions.js";

const chipTexts = (input: string, opts?: Parameters<typeof parseSuggestions>[1]) =>
	parseSuggestions(input, opts).suggestions;

const flatText = (input: string) =>
	parseSuggestions(input)
		.nodes.map((n) => (n.type === "text" ? n.text : `[${n.text}]`))
		.join("");

describe("parseSuggestions — basics", () => {
	it("parses a simple suggestion", () => {
		const res = parseSuggestions("Want me to <pi:suggest>rebuild the solution</pi:suggest> first?");
		expect(res.suggestions).toEqual(["rebuild the solution"]);
		expect(res.nodes).toEqual([
			{ type: "text", text: "Want me to " },
			{ type: "suggestion", text: "rebuild the solution", index: 0 },
			{ type: "text", text: " first?" },
		]);
	});

	it("parses multiple suggestions in one message", () => {
		const res = parseSuggestions(
			"Do <pi:suggest>this</pi:suggest> or <pi:suggest>that</pi:suggest>?",
		);
		expect(res.suggestions).toEqual(["this", "that"]);
	});

	it("returns plain text untouched when no tags", () => {
		const text = "Done — the migration ran clean and all 47 rows moved over.";
		const res = parseSuggestions(text);
		expect(res.suggestions).toEqual([]);
		expect(res.nodes).toEqual([{ type: "text", text }]);
	});

	it("ignores attributes on the open tag", () => {
		const res = parseSuggestions('Try <pi:suggest foo="bar">this thing</pi:suggest>.');
		expect(res.suggestions).toEqual(["this thing"]);
	});

	it("trims suggestion whitespace", () => {
		expect(chipTexts("<pi:suggest>  run tests \n</pi:suggest>")).toEqual(["run tests"]);
	});

	it("supports a configurable tag name (H3)", () => {
		expect(chipTexts("<x:opt>go</x:opt>", { tagName: "x:opt" })).toEqual(["go"]);
		expect(chipTexts("<pi:suggest>go</pi:suggest>", { tagName: "x:opt" })).toEqual([]);
	});
});

describe("parseSuggestions — edge case matrix (PRD §11)", () => {
	it("unclosed tag: inner text plain, no chip, rest intact", () => {
		const res = parseSuggestions("Sure — want me to <pi:suggest>rebuild the sol");
		expect(res.suggestions).toEqual([]);
		expect(res.nodes.map((n) => n.text).join("")).toBe("Sure — want me to rebuild the sol");
	});

	it("close tag with no open: dropped silently", () => {
		expect(flatText("weird </pi:suggest> output")).toBe("weird  output");
	});

	it("nested tags: outer wins, inner stripped", () => {
		const res = parseSuggestions("<pi:suggest>outer <pi:suggest>inner</pi:suggest> tail");
		expect(res.suggestions).toEqual(["outer inner"]);
		expect(flatText("<pi:suggest>outer <pi:suggest>inner</pi:suggest> tail")).toBe(
			"[outer inner] tail",
		);
	});

	it("empty content: dropped entirely", () => {
		expect(flatText("a <pi:suggest></pi:suggest> b")).toBe("a  b");
	});

	it("whitespace-only content: dropped entirely", () => {
		expect(flatText("a <pi:suggest>   </pi:suggest> b")).toBe("a  b");
	});

	it("content over 120 chars: rendered as plain text, no chip", () => {
		const long = "x".repeat(121);
		const res = parseSuggestions(`<pi:suggest>${long}</pi:suggest>`);
		expect(res.suggestions).toEqual([]);
		expect(res.nodes).toEqual([{ type: "text", text: long }]);
	});

	it("content of exactly 120 chars: still a chip", () => {
		const exact = "x".repeat(120);
		expect(chipTexts(`<pi:suggest>${exact}</pi:suggest>`)).toEqual([exact]);
	});

	it("more than 10 per message: first 10 chip, rest plain (10.11)", () => {
		const nums = Array.from({ length: 12 }, (_, i) => i + 1);
		const input = nums.map((n) => `<pi:suggest>option ${n}</pi:suggest>`).join(" ");
		const res = parseSuggestions(input);
		expect(res.suggestions).toEqual(nums.slice(0, 10).map((n) => `option ${n}`));
		expect(flatText(input)).toBe(
			`${nums.slice(0, 10).map((n) => `[option ${n}]`).join(" ")} option 11 option 12`,
		);
	});

	it("respects acceptedSoFar for multi-block messages", () => {
		expect(chipTexts("<pi:suggest>a</pi:suggest> <pi:suggest>b</pi:suggest>", { acceptedSoFar: 9 })).toEqual([
			"a",
		]);
	});

	it("inside fenced code: verbatim, no parse (10.5)", () => {
		const input =
			"Here's the template:\n\n```html\n<select>\n  <pi:suggest>this is not a real tag</pi:suggest>\n</select>\n```\n";
		const res = parseSuggestions(input);
		expect(res.suggestions).toEqual([]);
		expect(res.nodes.map((n) => n.text).join("")).toBe(input);
	});

	it("inside ~~~ fenced code: verbatim", () => {
		const input = "~~~\n<pi:suggest>nope</pi:suggest>\n~~~";
		expect(chipTexts(input)).toEqual([]);
	});

	it("unclosed fence swallows the rest of the message", () => {
		const input = "```\n<pi:suggest>nope</pi:suggest>";
		expect(chipTexts(input)).toEqual([]);
	});

	it("inside inline code: verbatim, no parse", () => {
		const input = "Use `<pi:suggest>not a chip</pi:suggest>` in your markup.";
		const res = parseSuggestions(input);
		expect(res.suggestions).toEqual([]);
		expect(res.nodes.map((n) => n.text).join("")).toBe(input);
	});

	it("double-backtick inline code protects tags", () => {
		expect(chipTexts("`` <pi:suggest>x</pi:suggest> ``")).toEqual([]);
	});

	it("a lone backtick does not disable parsing after it", () => {
		expect(chipTexts("a ` b <pi:suggest>go on</pi:suggest>")).toEqual(["go on"]);
	});

	it("tag after a closed code span parses", () => {
		expect(chipTexts("`code` then <pi:suggest>a real one</pi:suggest>")).toEqual(["a real one"]);
	});

	it("content spanning a blank line: plain text, no chip", () => {
		const res = parseSuggestions("<pi:suggest>first part\n\nsecond paragraph</pi:suggest>");
		expect(res.suggestions).toEqual([]);
	});

	it("suggestion inside a blockquote parses", () => {
		expect(chipTexts("> Should I <pi:suggest>continue</pi:suggest>?")).toEqual(["continue"]);
	});

	it("suggestions in list items parse (10.3)", () => {
		const input =
			"- <pi:suggest>start with the auth test</pi:suggest> — most likely\n- <pi:suggest>show me all three</pi:suggest>\n";
		expect(chipTexts(input)).toEqual(["start with the auth test", "show me all three"]);
	});

	it("markdown inside content stays literal (chip text keeps the asterisks)", () => {
		expect(chipTexts("<pi:suggest>**bold** move</pi:suggest>")).toEqual(["**bold** move"]);
	});

	it("close tag inside a fence does not close an outside open tag", () => {
		const input = "<pi:suggest>pick A\n```\n</pi:suggest>\n```\nreal close</pi:suggest>";
		const res = parseSuggestions(input);
		// The close inside the fence is skipped; content includes the fence,
		// which spans a blank-line-free block but is multiline. It contains no
		// blank line, is under 120 chars — accepted with fence inside content.
		expect(res.suggestions).toEqual(["pick A\n```\n</pi:suggest>\n```\nreal close"]);
	});
});

describe("visibleStreamingPrefix — streaming buffer (PRD §7, 10.7)", () => {
	it("hides a partial open tag at end of stream", () => {
		expect(visibleStreamingPrefix("Want me to <pi")).toBe("Want me to ");
		expect(visibleStreamingPrefix("Want me to <pi:suggest")).toBe("Want me to ");
		expect(visibleStreamingPrefix("Want me to <")).toBe("Want me to ");
	});

	it("hides an open tag whose close has not arrived", () => {
		expect(visibleStreamingPrefix("Want me to <pi:suggest>rebuild</pi:sug")).toBe("Want me to ");
		expect(visibleStreamingPrefix("Want me to <pi:suggest>rebuild")).toBe("Want me to ");
	});

	it("passes through a complete tag", () => {
		const s = "Want me to <pi:suggest>rebuild</pi:suggest> now?";
		expect(visibleStreamingPrefix(s)).toBe(s);
	});

	it("frame-by-frame matches PRD 10.7", () => {
		const chunks = ["Want me to <pi", ":suggest>rebuild</pi:sug", "gest> now?"];
		let acc = "";
		const frames: string[] = [];
		for (const c of chunks) {
			acc += c;
			frames.push(visibleStreamingPrefix(acc));
		}
		expect(frames[0]).toBe("Want me to ");
		expect(frames[1]).toBe("Want me to ");
		expect(frames[2]).toBe("Want me to <pi:suggest>rebuild</pi:suggest> now?");
	});

	it("does not hide ordinary html-ish text", () => {
		expect(visibleStreamingPrefix("Use <div> tags")).toBe("Use <div> tags");
		expect(visibleStreamingPrefix("a < b")).toBe("a < b");
	});

	it("does not buffer inside code fences", () => {
		const s = "```\n<pi:suggest>streaming code";
		expect(visibleStreamingPrefix(s)).toBe(s);
	});

	it("does not buffer inside inline code", () => {
		const s = "here `<pi:suggest>` is the tag";
		expect(visibleStreamingPrefix(s)).toBe(s);
	});

	it("gives up hiding when content can no longer be a valid chip", () => {
		const s = `before <pi:suggest>${"y".repeat(200)}`;
		expect(visibleStreamingPrefix(s)).toBe(s);
	});

	it("hides a partial close tag mid-suggestion", () => {
		expect(visibleStreamingPrefix("ok <pi:suggest>go</")).toBe("ok ");
	});
});

describe("parse of streamed-then-finalized text", () => {
	it("aborted stream inside a tag degrades to plain text (10.6)", () => {
		const aborted = "Sure — want me to <pi:suggest>rebuild the sol";
		const streaming = visibleStreamingPrefix(aborted);
		expect(streaming).toBe("Sure — want me to ");
		// At finalize the full text is parsed instead: text flows plainly.
		const res = parseSuggestions(aborted);
		expect(res.suggestions).toEqual([]);
		expect(res.nodes.map((n) => n.text).join("")).toBe("Sure — want me to rebuild the sol");
	});
});
