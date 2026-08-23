// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { MAX_SUGGESTIONS_PER_MESSAGE } from "../src/shared/suggestions.js";
import { renderAssistantMarkdown } from "../src/web/chips.js";

const base = { live: true, streaming: false, chipsEnabled: true };

const render = (text: string, opts: Partial<Parameters<typeof renderAssistantMarkdown>[1]> = {}) =>
	renderAssistantMarkdown(text, { ...base, ...opts });

describe("renderAssistantMarkdown — chips", () => {
	it("renders a suggestion as a button chip with exact text", () => {
		const el = render("Want me to <pi:snippet>rebuild the solution</pi:snippet> first?");
		const chips = el.querySelectorAll("button.chip");
		expect(chips.length).toBe(1);
		expect(chips[0]!.textContent).toBe("rebuild the solution");
		expect(el.textContent).toContain("Want me to ");
		expect(el.textContent).toContain(" first?");
	});

	it("never shows raw markup (B2)", () => {
		const cases = [
			"a <pi:snippet>ok</pi:snippet> b",
			"a <pi:snippet>unclosed",
			"a </pi:snippet> stray",
			"a <pi:snippet></pi:snippet> empty",
			`over <pi:snippet>${"x".repeat(150)}</pi:snippet>`,
		];
		for (const c of cases) {
			const el = render(c);
			expect(el.textContent).not.toContain("<pi:snippet");
			expect(el.textContent).not.toContain("</pi:snippet>");
			expect(el.innerHTML).not.toContain("<pi:snippet");
		}
	});

	it("keeps the literal tag visible inside fenced code (10.5, E1)", () => {
		const el = render(
			"Template:\n\n```html\n<select>\n  <pi:snippet>this is not a real tag</pi:snippet>\n</select>\n```\n",
		);
		expect(el.querySelectorAll("button.chip").length).toBe(0);
		const code = el.querySelector("pre code, pre");
		expect(code).toBeTruthy();
		expect(code!.textContent).toContain("<pi:snippet>this is not a real tag</pi:snippet>");
	});

	it("keeps the literal tag visible in inline code", () => {
		const el = render("Use `<pi:snippet>` for suggestions.");
		expect(el.querySelectorAll("button.chip").length).toBe(0);
		expect(el.querySelector("code")!.textContent).toBe("<pi:snippet>");
	});

	it("renders at most MAX_SUGGESTIONS_PER_MESSAGE chips, rest plain (E3)", () => {
		const cap = MAX_SUGGESTIONS_PER_MESSAGE;
		const md = Array.from({ length: cap + 1 }, (_, i) => `<pi:snippet>option ${i + 1}</pi:snippet>`).join(
			" and ",
		);
		const el = render(md);
		expect(el.querySelectorAll("button.chip").length).toBe(cap);
		expect(el.textContent).toContain(`option ${cap + 1}`);
	});

	it("cannot inject markup through suggestion content (E5)", () => {
		const payloads = [
			"<pi:snippet>hello <b>world</b></pi:snippet>",
			'<pi:snippet>x &lt;img src=x onerror=alert(1)&gt;</pi:snippet>',
		];
		for (const p of payloads) {
			const el = render(p);
			expect(el.querySelector("script, img, b")).toBeNull();
		}
		// Script tags anywhere in prose are shown as text, never parsed.
		const el2 = render('hi <script>window.x=1</script> there');
		expect(el2.querySelector("script")).toBeNull();
		expect(el2.textContent).toContain("<script>");
	});

	it("suppresses a chip inside a link label — link wins", () => {
		const el = render("[click <pi:snippet>me</pi:snippet>](https://example.com)");
		const link = el.querySelector("a");
		expect(link).toBeTruthy();
		expect(link!.querySelector("button")).toBeNull();
		expect(link!.textContent).toBe("click me");
	});

	it("renders chips inside blockquotes and list items", () => {
		const el = render("> Want to <pi:snippet>continue</pi:snippet>?\n\n- <pi:snippet>option A</pi:snippet>\n");
		expect(el.querySelectorAll("button.chip").length).toBe(2);
	});

	it("chips disabled: tags stripped, plain text, no chips (H1, F5)", () => {
		const el = render("Want me to <pi:snippet>rebuild</pi:snippet>?", { chipsEnabled: false });
		expect(el.querySelectorAll("button.chip").length).toBe(0);
		expect(el.textContent).toContain("Want me to rebuild?");
		expect(el.innerHTML).not.toContain("pi:snippet");
	});

	it("marks visited chips", () => {
		const el = render("A <pi:snippet>one</pi:snippet> B <pi:snippet>two</pi:snippet>", {
			visited: new Set([1]),
		});
		const chips = el.querySelectorAll("button.chip");
		expect(chips[0]!.classList.contains("chip-visited")).toBe(false);
		expect(chips[1]!.classList.contains("chip-visited")).toBe(true);
	});

	it("strips private-use sentinel chars arriving in model output", () => {
		const el = render("weird \uE000\uE100 text <pi:snippet>ok</pi:snippet>");
		expect(el.textContent).not.toMatch(/[\uE000-\uF8FF]/);
		expect(el.querySelectorAll("button.chip").length).toBe(1);
	});
});

describe("renderAssistantMarkdown — streaming (C1, C3)", () => {
	it("hides partial tags while streaming", () => {
		const el = render("Want me to <pi:sni", { live: false, streaming: true });
		expect(el.textContent).not.toContain("<");
		expect(el.textContent).toContain("Want me to");
	});

	it("streams a complete tag as an inert chip", () => {
		const el = render("Want me to <pi:snippet>rebuild</pi:snippet> or", {
			live: false,
			streaming: true,
		});
		const chip = el.querySelector("button.chip")!;
		expect(chip.classList.contains("chip-inert")).toBe(true);
		expect(chip.getAttribute("aria-disabled")).toBe("true");
	});

	it("clicking an inert chip is a no-op", () => {
		let clicked = 0;
		const el = render("<pi:snippet>go</pi:snippet>", {
			live: false,
			streaming: true,
			onInsert: () => clicked++,
		});
		(el.querySelector("button.chip") as HTMLButtonElement).click();
		expect(clicked).toBe(0);
	});

	it("live chip invokes onInsert with its text", () => {
		let got = "";
		const el = render("<pi:snippet>run the tests</pi:snippet>", {
			onInsert: (t) => {
				got = t;
			},
		});
		(el.querySelector("button.chip") as HTMLButtonElement).click();
		expect(got).toBe("run the tests");
	});

	it("finalized render of aborted text shows inner text plainly (C4)", () => {
		const el = render("Sure — want me to <pi:snippet>rebuild the sol");
		expect(el.textContent!.trim()).toBe("Sure — want me to rebuild the sol");
		expect(el.querySelectorAll("button.chip").length).toBe(0);
	});
});
