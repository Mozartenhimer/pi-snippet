/**
 * Composer integration (PRD §8): insert-at-cursor with focus management and
 * single-unit undo.
 *
 * Uses `document.execCommand("insertText")` when available so the insertion
 * joins the textarea's native undo stack (Ctrl+Z removes it in one step,
 * PRD A6). Falls back to `setRangeText` in environments without execCommand.
 */

export function insertSuggestion(textarea: HTMLTextAreaElement, text: string): void {
	textarea.focus();
	const start = textarea.selectionStart ?? textarea.value.length;
	const end = textarea.selectionEnd ?? start;
	const before = textarea.value.slice(0, start);
	const after = textarea.value.slice(end);
	// A single separating space on either side when the neighboring character
	// isn't whitespace (PRD §8, OQ3). Existing content is never replaced
	// (except an explicit selection, which follows standard semantics).
	const needsLead = before.length > 0 && !/\s$/.test(before);
	const needsTrail = after.length > 0 && !/^\s/.test(after);
	const insert = (needsLead ? " " : "") + text + (needsTrail ? " " : "");

	let inserted = false;
	const doc = textarea.ownerDocument;
	if (typeof doc.execCommand === "function") {
		try {
			inserted = doc.execCommand("insertText", false, insert);
		} catch {
			inserted = false;
		}
	}
	if (!inserted) {
		textarea.setRangeText(insert, start, end, "end");
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
	}
	// Cursor lands at the end of the inserted text (before any added trailing
	// space), regardless of environment quirks in selection handling.
	const pos = start + insert.length - (needsTrail ? 1 : 0);
	textarea.setSelectionRange(pos, pos);
	// Cursor lands at the end of the inserted text; composer keeps focus.
	textarea.scrollIntoView({ block: "nearest" });
}
