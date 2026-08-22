// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { insertSuggestion } from "../src/web/composer.js";

let ta: HTMLTextAreaElement;

beforeEach(() => {
	document.body.innerHTML = "";
	ta = document.createElement("textarea");
	document.body.appendChild(ta);
});

describe("insertSuggestion (PRD §8, Epic A)", () => {
	it("inserts exact text into an empty composer, cursor at end (A1)", () => {
		insertSuggestion(ta, "run the test suite");
		expect(ta.value).toBe("run the test suite");
		expect(ta.selectionStart).toBe(ta.value.length);
		expect(ta.selectionEnd).toBe(ta.value.length);
	});

	it("inserts at cursor without replacing content, adding one space (A2)", () => {
		ta.value = "also";
		ta.selectionStart = ta.selectionEnd = 4;
		insertSuggestion(ta, "run the tests");
		expect(ta.value).toBe("also run the tests");
	});

	it("does not add a space after existing whitespace", () => {
		ta.value = "also ";
		ta.selectionStart = ta.selectionEnd = 5;
		insertSuggestion(ta, "run the tests");
		expect(ta.value).toBe("also run the tests");
	});

	it("inserts mid-text at the cursor", () => {
		ta.value = "prefix suffix";
		ta.selectionStart = ta.selectionEnd = 7; // after "prefix "
		insertSuggestion(ta, "X");
		expect(ta.value).toBe("prefix X suffix");
	});

	it("replaces a selection (standard insertion semantics)", () => {
		ta.value = "keep THIS end";
		ta.selectionStart = 5;
		ta.selectionEnd = 9; // "THIS"
		insertSuggestion(ta, "that");
		expect(ta.value).toBe("keep that end");
	});

	it("two inserts in a row produce a single separating space (A4, 10.8)", () => {
		insertSuggestion(ta, "rebuild the solution");
		insertSuggestion(ta, "run the test suite");
		expect(ta.value).toBe("rebuild the solution run the test suite");
	});

	it("no leading space when inserting at position 0; trailing space separates", () => {
		ta.value = "tail";
		ta.selectionStart = ta.selectionEnd = 0;
		insertSuggestion(ta, "head");
		expect(ta.value).toBe("head tail");
		expect(ta.selectionStart).toBe(4); // cursor at end of inserted text
	});
});
