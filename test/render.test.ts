// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { renderAssistantMarkdown } from "../src/web/chips.js";

const base = { live: true, streaming: false, chipsEnabled: true };

const render = (text: string, opts: Partial<Parameters<typeof renderAssistantMarkdown>[1]> = {}) =>
	renderAssistantMarkdown(text, { ...base, ...opts });

describe("renderAssistantMarkdown — chips", () => {
	it("renders a suggestion as a button chip with exact text", () => {
		const el = render("Want me to <pi:suggest>rebuild the solution</pi:suggest> first?");
		const chips = el.querySelectorAll("button.chip");
		expect(chips.length).toBe(1);
		expect(chips[0]!.textContent).toBe("rebuild the solution");
		expect(el.textContent).toContain("Want me to ");
		expect(el.textContent).toContain(" first?");
	});

	it("never shows raw markup (B2)", () => {
		const cases = [
			"a <pi:suggest>ok</pi:suggest> b",
			"a <pi:suggest>unclosed",
			"a </pi:suggest> stray",
			"a <pi:suggest></pi:suggest> empty",
			`over <pi:suggest>${"x".repeat(150)}</pi:suggest>`,
		];
		for (const c of cases) {
			const el = render(c);
			expect(el.textContent).not.toContain("<pi:suggest");
			expect(el.textContent).not.toContain("</pi:suggest>");
			expect(el.innerHTML).not.toContain("<pi:suggest");
		}
	});

	it("keeps the literal tag visible inside fenced code (10.5, E1)", () => {
		const el = render(
			"Template:\n\n```html\n<select>\n  <pi:suggest>this is not a real tag</pi:suggest>\n</select>\n```\n",
		);
		expect(el.querySelectorAll("button.chip").length).toBe(0);
		const code = el.querySelector("pre code, pre");
		expect(code).toBeTruthy();
		expect(code!.textContent).toContain("<pi:suggest>this is not a real tag</pi:suggest>");
	});

	it("keeps the literal tag visible in inline code", () => {
		const el = render("Use `<pi:suggest>` for suggestions.");
		expect(el.querySelectorAll("button.chip").length).toBe(0);
		expect(el.querySelector("code")!.textContent).toBe("<pi:suggest>");
	});

	it("renders at most four chips (E3)", () => {
		const md = [1, 2, 3, 4, 5].map((n) => `<pi:suggest>option ${n}</pi:suggest>`).join(" and ");
		const el = render(md);
		expect(el.querySelectorAll("button.chip").length).toBe(4);
		expect(el.textContent).toContain("option 5");
	});

	it("cannot inject markup through suggestion content (E5)", () => {
		const payloads = [
			"<pi:suggest>hello <b>world</b></pi:suggest>",
			'<pi:suggest>x &lt;img src=x onerror=alert(1)&gt;</pi:suggest>',
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
		const el = render("[click <pi:suggest>me</pi:suggest>](https://example.com)");
		const link = el.querySelector("a");
		expect(link).toBeTruthy();
		expect(link!.querySelector("button")).toBeNull();
		expect(link!.textContent).toBe("click me");
	});

	it("renders chips inside blockquotes and list items", () => {
		const el = render("> Want to <pi:suggest>continue</pi:suggest>?\n\n- <pi:suggest>option A</pi:suggest>\n");
		expect(el.querySelectorAll("button.chip").length).toBe(2);
	});

	it("chips disabled: tags stripped, plain text, no chips (H1, F5)", () => {
		const el = render("Want me to <pi:suggest>rebuild</pi:suggest>?", { chipsEnabled: false });
		expect(el.querySelectorAll("button.chip").length).toBe(0);
		expect(el.textContent).toContain("Want me to rebuild?");
		expect(el.innerHTML).not.toContain("pi:suggest");
	});

	it("marks visited chips", () => {
		const el = render("A <pi:suggest>one</pi:suggest> B <pi:suggest>two</pi:suggest>", {
			visited: new Set([1]),
		});
		const chips = el.querySelectorAll("button.chip");
		expect(chips[0]!.classList.contains("chip-visited")).toBe(false);
		expect(chips[1]!.classList.contains("chip-visited")).toBe(true);
	});

	it("strips private-use sentinel chars arriving in model output", () => {
		const el = render("weird \uE000\uE100 text <pi:suggest>ok</pi:suggest>");
		expect(el.textContent).not.toMatch(/[\uE000-\uF8FF]/);
		expect(el.querySelectorAll("button.chip").length).toBe(1);
	});
});

describe("renderAssistantMarkdown — streaming (C1, C3)", () => {
	it("hides partial tags while streaming", () => {
		const el = render("Want me to <pi:sug", { live: false, streaming: true });
		expect(el.textContent).not.toContain("<");
		expect(el.textContent).toContain("Want me to");
	});

	it("streams a complete tag as an inert chip", () => {
		const el = render("Want me to <pi:suggest>rebuild</pi:suggest> or", {
			live: false,
			streaming: true,
		});
		const chip = el.querySelector("button.chip")!;
		expect(chip.classList.contains("chip-inert")).toBe(true);
		expect(chip.getAttribute("aria-disabled")).toBe("true");
	});

	it("clicking an inert chip is a no-op", () => {
		let clicked = 0;
		const el = render("<pi:suggest>go</pi:suggest>", {
			live: false,
			streaming: true,
			onInsert: () => clicked++,
		});
		(el.querySelector("button.chip") as HTMLButtonElement).click();
		expect(clicked).toBe(0);
	});

	it("live chip invokes onInsert with its text", () => {
		let got = "";
		const el = render("<pi:suggest>run the tests</pi:suggest>", {
			onInsert: (t) => {
				got = t;
			},
		});
		(el.querySelector("button.chip") as HTMLButtonElement).click();
		expect(got).toBe("run the tests");
	});

	it("finalized render of aborted text shows inner text plainly (C4)", () => {
		const el = render("Sure — want me to <pi:suggest>rebuild the sol");
		expect(el.textContent!.trim()).toBe("Sure — want me to rebuild the sol");
		expect(el.querySelectorAll("button.chip").length).toBe(0);
	});
});
