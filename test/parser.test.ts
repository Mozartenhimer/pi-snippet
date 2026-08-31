import { describe, expect, it } from "vitest";
import {
	fencedRegions,
	MAX_SUGGESTIONS_PER_MESSAGE,
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
		const res = parseSuggestions("Want me to <snippet>rebuild the solution</snippet> first?");
		expect(res.suggestions).toEqual(["rebuild the solution"]);
		expect(res.nodes).toEqual([
			{ type: "text", text: "Want me to ", start: 0 },
			{ type: "suggestion", text: "rebuild the solution", index: 0, start: 20 },
			{ type: "text", text: " first?", start: 50 },
		]);
	});

	it("parses multiple suggestions in one message", () => {
		const res = parseSuggestions(
			"Do <snippet>this</snippet> or <snippet>that</snippet>?",
		);
		expect(res.suggestions).toEqual(["this", "that"]);
	});

	it("returns plain text untouched when no tags", () => {
		const text = "Done — the migration ran clean and all 47 rows moved over.";
		const res = parseSuggestions(text);
		expect(res.suggestions).toEqual([]);
		expect(res.nodes).toEqual([{ type: "text", text, start: 0 }]);
	});

	it("ignores attributes on the open tag", () => {
		const res = parseSuggestions('Try <snippet foo="bar">this thing</snippet>.');
		expect(res.suggestions).toEqual(["this thing"]);
	});

	it("trims suggestion whitespace", () => {
		expect(chipTexts("<snippet>  run tests \n</snippet>")).toEqual(["run tests"]);
	});

	it("supports a configurable tag name (H3)", () => {
		expect(chipTexts("<x:opt>go</x:opt>", { tagName: "x:opt" })).toEqual(["go"]);
		expect(chipTexts("<snippet>go</snippet>", { tagName: "x:opt" })).toEqual([]);
	});
});

describe("parseSuggestions — edge case matrix (PRD §11)", () => {
	it("unclosed tag: inner text plain, no chip, rest intact", () => {
		const res = parseSuggestions("Sure — want me to <snippet>rebuild the sol");
		expect(res.suggestions).toEqual([]);
		expect(res.nodes.map((n) => n.text).join("")).toBe("Sure — want me to rebuild the sol");
	});

	it("close tag with no open: dropped silently", () => {
		expect(flatText("weird </snippet> output")).toBe("weird  output");
	});

	it("nested tags: outer wins, inner stripped", () => {
		const res = parseSuggestions("<snippet>outer <snippet>inner</snippet> tail");
		expect(res.suggestions).toEqual(["outer inner"]);
		expect(flatText("<snippet>outer <snippet>inner</snippet> tail")).toBe(
			"[outer inner] tail",
		);
	});

	it("empty content: dropped entirely", () => {
		expect(flatText("a <snippet></snippet> b")).toBe("a  b");
	});

	it("whitespace-only content: dropped entirely", () => {
		expect(flatText("a <snippet>   </snippet> b")).toBe("a  b");
	});

	it("content over 120 chars: rendered as plain text, no chip", () => {
		const long = "x".repeat(121);
		const res = parseSuggestions(`<snippet>${long}</snippet>`);
		expect(res.suggestions).toEqual([]);
		expect(res.nodes).toEqual([{ type: "text", text: long, start: 9 }]);
	});

	it("content of exactly 120 chars: still a chip", () => {
		const exact = "x".repeat(120);
		expect(chipTexts(`<snippet>${exact}</snippet>`)).toEqual([exact]);
	});

	it("caps a message at MAX_SUGGESTIONS_PER_MESSAGE, rest plain (10.11)", () => {
		const cap = MAX_SUGGESTIONS_PER_MESSAGE;
		const nums = Array.from({ length: cap + 2 }, (_, i) => i + 1);
		const input = nums.map((n) => `<snippet>option ${n}</snippet>`).join(" ");
		const res = parseSuggestions(input);
		expect(res.suggestions).toEqual(nums.slice(0, cap).map((n) => `option ${n}`));
		expect(flatText(input)).toBe(
			`${nums.slice(0, cap).map((n) => `[option ${n}]`).join(" ")} option ${cap + 1} option ${cap + 2}`,
		);
	});

	it("the cap is explicit, not a hardcoded ten", () => {
		const input = Array.from({ length: 6 }, (_, i) => `<snippet>o${i}</snippet>`).join(" ");
		expect(parseSuggestions(input, { maxPerMessage: 4 }).suggestions).toHaveLength(4);
	});

	it("respects acceptedSoFar for multi-block messages", () => {
		expect(
			chipTexts("<snippet>a</snippet> <snippet>b</snippet>", {
				acceptedSoFar: MAX_SUGGESTIONS_PER_MESSAGE - 1,
			}),
		).toEqual(["a"]);
	});

	it("inside fenced code: verbatim, no parse (10.5)", () => {
		const input =
			"Here's the template:\n\n```html\n<select>\n  <snippet>this is not a real tag</snippet>\n</select>\n```\n";
		const res = parseSuggestions(input);
		expect(res.suggestions).toEqual([]);
		expect(res.nodes.map((n) => n.text).join("")).toBe(input);
	});

	it("inside ~~~ fenced code: verbatim", () => {
		const input = "~~~\n<snippet>nope</snippet>\n~~~";
		expect(chipTexts(input)).toEqual([]);
	});

	it("unclosed fence swallows the rest of the message", () => {
		const input = "```\n<snippet>nope</snippet>";
		expect(chipTexts(input)).toEqual([]);
	});

	it("inside inline code: verbatim, no parse", () => {
		const input = "Use `<snippet>not a chip</snippet>` in your markup.";
		const res = parseSuggestions(input);
		expect(res.suggestions).toEqual([]);
		expect(res.nodes.map((n) => n.text).join("")).toBe(input);
	});

	it("double-backtick inline code protects tags", () => {
		expect(chipTexts("`` <snippet>x</snippet> ``")).toEqual([]);
	});

	it("a lone backtick does not disable parsing after it", () => {
		expect(chipTexts("a ` b <snippet>go on</snippet>")).toEqual(["go on"]);
	});

	it("tag after a closed code span parses", () => {
		expect(chipTexts("`code` then <snippet>a real one</snippet>")).toEqual(["a real one"]);
	});

	it("a backtick run of the wrong length does not close a code span", () => {
		// The span opened by one backtick is closed only by a run of exactly one,
		// so the ``  in the middle is span content and the tag inside it is inert.
		expect(chipTexts("`a``b<snippet>x</snippet>`")).toEqual([]);
	});

	it("an unclosed tag leaves the following text node anchored at the content", () => {
		const res = parseSuggestions("<snippet>hanging");
		expect(res.nodes).toEqual([{ type: "text", text: "hanging", start: 9 }]);
	});

	it("content spanning a blank line: plain text, no chip", () => {
		const res = parseSuggestions("<snippet>first part\n\nsecond paragraph</snippet>");
		expect(res.suggestions).toEqual([]);
	});

	it("suggestion inside a blockquote parses", () => {
		expect(chipTexts("> Should I <snippet>continue</snippet>?")).toEqual(["continue"]);
	});

	it("suggestions in list items parse (10.3)", () => {
		const input =
			"- <snippet>start with the auth test</snippet> — most likely\n- <snippet>show me all three</snippet>\n";
		expect(chipTexts(input)).toEqual(["start with the auth test", "show me all three"]);
	});

	it("markdown inside content stays literal (chip text keeps the asterisks)", () => {
		expect(chipTexts("<snippet>**bold** move</snippet>")).toEqual(["**bold** move"]);
	});

	it("close tag inside a fence does not close an outside open tag", () => {
		const input = "<snippet>pick A\n```\n</snippet>\n```\nreal close</snippet>";
		const res = parseSuggestions(input);
		// The close inside the fence is skipped; content includes the fence,
		// which spans a blank-line-free block but is multiline. It contains no
		// blank line, is under 120 chars — accepted with fence inside content.
		expect(res.suggestions).toEqual(["pick A\n```\n</snippet>\n```\nreal close"]);
	});
});

describe("visibleStreamingPrefix — streaming buffer (PRD §7, 10.7)", () => {
	it("hides a partial open tag at end of stream", () => {
		expect(visibleStreamingPrefix("Want me to <sn")).toBe("Want me to ");
		expect(visibleStreamingPrefix("Want me to <snippet")).toBe("Want me to ");
		expect(visibleStreamingPrefix("Want me to <")).toBe("Want me to ");
	});

	it("hides an open tag whose close has not arrived", () => {
		expect(visibleStreamingPrefix("Want me to <snippet>rebuild</sni")).toBe("Want me to ");
		expect(visibleStreamingPrefix("Want me to <snippet>rebuild")).toBe("Want me to ");
	});

	it("passes through a complete tag", () => {
		const s = "Want me to <snippet>rebuild</snippet> now?";
		expect(visibleStreamingPrefix(s)).toBe(s);
	});

	it("frame-by-frame matches PRD 10.7", () => {
		const chunks = ["Want me to <sn", "ippet>rebuild</sni", "ppet> now?"];
		let acc = "";
		const frames: string[] = [];
		for (const c of chunks) {
			acc += c;
			frames.push(visibleStreamingPrefix(acc));
		}
		expect(frames[0]).toBe("Want me to ");
		expect(frames[1]).toBe("Want me to ");
		expect(frames[2]).toBe("Want me to <snippet>rebuild</snippet> now?");
	});

	it("does not hide ordinary html-ish text", () => {
		expect(visibleStreamingPrefix("Use <div> tags")).toBe("Use <div> tags");
		expect(visibleStreamingPrefix("a < b")).toBe("a < b");
	});

	it("does not buffer inside code fences", () => {
		const s = "```\n<snippet>streaming code";
		expect(visibleStreamingPrefix(s)).toBe(s);
	});

	it("does not buffer inside inline code", () => {
		const s = "here `<snippet>` is the tag";
		expect(visibleStreamingPrefix(s)).toBe(s);
	});

	it("gives up hiding when content can no longer be a valid chip", () => {
		const s = `before <snippet>${"y".repeat(200)}`;
		expect(visibleStreamingPrefix(s)).toBe(s);
	});

	it("hides a partial close tag mid-suggestion", () => {
		expect(visibleStreamingPrefix("ok <snippet>go</")).toBe("ok ");
	});

	it("a lone backtick does not stop the scan", () => {
		// The backtick opens no span (nothing closes it), so it is a literal run
		// and the unclosed tag after it must still be hidden.
		expect(visibleStreamingPrefix("a ` b <snippet>go")).toBe("a ` b ");
	});

	it("shows a close tag that never had an open", () => {
		const s = "done</snippet> and on to the next thing";
		expect(visibleStreamingPrefix(s)).toBe(s);
	});

	it("keeps hiding when a second tag opens after one gave up", () => {
		// The first construct is past any length a chip could be, so it resolves
		// as text and the scan continues into it — where a fresh open tag is
		// hidden as usual.
		const s = `before <snippet>${"y".repeat(200)} <snippet>short`;
		expect(visibleStreamingPrefix(s)).toBe(`before <snippet>${"y".repeat(200)} `);
	});
});

describe("parse of streamed-then-finalized text", () => {
	it("aborted stream inside a tag degrades to plain text (10.6)", () => {
		const aborted = "Sure — want me to <snippet>rebuild the sol";
		const streaming = visibleStreamingPrefix(aborted);
		expect(streaming).toBe("Sure — want me to ");
		// At finalize the full text is parsed instead: text flows plainly.
		const res = parseSuggestions(aborted);
		expect(res.suggestions).toEqual([]);
		expect(res.nodes.map((n) => n.text).join("")).toBe("Sure — want me to rebuild the sol");
	});
});

/**
 * Fence and backtick edge cases, reached by MC/DC rather than by a bug report.
 *
 * `npm run test:mcdc` showed these conditions had never been both true and
 * false across the whole suite: an opening fence rejected for backticks in its
 * info string, a closing candidate rejected for its char, its length or its
 * trailing text, and a run of backticks that never closes. Each is a way the
 * scanner can misjudge where code ends — and a tag inside code that is judged
 * to be prose becomes a chip the model never asked for.
 */
describe("fencedRegions — what does and does not close a fence", () => {
	it("refuses to open a ``` fence whose info string contains a backtick", () => {
		// ```` ```js `x` ```` is inline code in a paragraph, not a code block.
		const text = "```js `x`\n<snippet>still a chip</snippet>\n";
		expect(fencedRegions(text)).toEqual([]);
		expect(chipTexts(text)).toEqual(["still a chip"]);
	});

	it("opens a ~~~ fence, whose info string may contain backticks", () => {
		const text = "~~~js `x`\n<snippet>inert</snippet>\n~~~\n";
		expect(fencedRegions(text)).toHaveLength(1);
		expect(chipTexts(text)).toEqual([]);
	});

	it("does not close a ``` fence with a ~~~ line", () => {
		const text = "```\ncode\n~~~\n<snippet>inert</snippet>\n";
		expect(fencedRegions(text)).toEqual([{ start: 0, end: text.length }]);
		expect(chipTexts(text)).toEqual([]);
	});

	it("does not close a longer fence with a shorter marker", () => {
		const text = "````\n```\n<snippet>inert</snippet>\n````\ndone\n";
		const [region] = fencedRegions(text);
		expect(text.slice(region!.start, region!.end)).toBe("````\n```\n<snippet>inert</snippet>\n````");
		expect(chipTexts(text)).toEqual([]);
	});

	it("does not close a fence with a marker that carries an info string", () => {
		const text = "```\ncode\n``` trailing\n<snippet>inert</snippet>\n";
		expect(fencedRegions(text)).toEqual([{ start: 0, end: text.length }]);
		expect(chipTexts(text)).toEqual([]);
	});

	it("treats an unclosed run of backticks as literal text, not a span", () => {
		// No second run of exactly two, so ``foo is a literal run: everything
		// after it is ordinary prose and its tags are real.
		const text = "``foo <snippet>a chip</snippet>";
		expect(chipTexts(text)).toEqual(["a chip"]);
		expect(flatText(text)).toBe("``foo [a chip]");
	});
});

describe("visibleStreamingPrefix — a `<` that cannot become a tag", () => {
	it("shows a stray `<snippet` followed by `>` as text", () => {
		// `<snippetx>` is not an open tag and cannot become one: the `>` closed
		// the possibility. It is prose and must appear immediately.
		expect(visibleStreamingPrefix("see <snippetx> here")).toBe("see <snippetx> here");
	});

	it("shows a stray `<snippet` followed by another `<` as text", () => {
		expect(visibleStreamingPrefix("see <snippet<b")).toBe("see <snippet<b");
	});

	it("still withholds a `<snippet` that could yet become a tag", () => {
		expect(visibleStreamingPrefix("see <snippet")).toBe("see ");
		expect(visibleStreamingPrefix("see <snippet class=")).toBe("see ");
	});
});
