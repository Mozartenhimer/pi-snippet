/**
 * Layer 2 (restored, reshaped): the second model that tags what the primary
 * model didn't.
 *
 * Layer 1 needs the primary model to notice it has asked something and wrap
 * the answer as it writes. When it doesn't, a small fixed model reads the
 * finished message — tags included, so it can see what is already covered —
 * and returns it with more `<snippet>` tags added around the spans the user
 * could plausibly send back. The wrapped text itself is the reply — no
 * anchor/reply JSON like the removed §17 layer had — so a layer-2 chip is the
 * same shape as a layer-1 chip: numbered, Alt+N addressable,
 * click-to-insert. Nothing in the UI distinguishes them.
 *
 * Everything here is pure. The model call lives in `extension/infer.ts`; this
 * module decides what is worth asking about, what to ask, and — the part that
 * matters — what to believe of the answer.
 *
 * ## Why the anchor must be verbatim
 *
 * The small model is asked to copy the message and add tags only; a model
 * that paraphrases anyway produces an anchor that is not literally in the
 * message, and an anchor that is not literally in the message is unclickable
 * and would underline something the assistant never wrote. So a tag whose
 * content does not appear verbatim in the message's non-code text is dropped
 * rather than repaired: the failure mode is a missing chip, never a wrong one.
 */

import { fencedRegions, MAX_SUGGESTIONS_PER_MESSAGE, parseSuggestions } from "./suggestions.js";

/** Regions of `text` that are code, where a question mark means nothing. */
export function codeRegions(text: string): Array<{ start: number; end: number }> {
	const regions = fencedRegions(text);
	const inline = /`+[^`\n]*`+/g;
	let m: RegExpExecArray | null;
	while ((m = inline.exec(text)) !== null) {
		regions.push({ start: m.index, end: m.index + m[0].length });
	}
	return regions;
}

function inAnyRegion(regions: Array<{ start: number; end: number }>, pos: number): boolean {
	return regions.some((r) => pos >= r.start && pos < r.end);
}

/**
 * Cheap gate on whether a message is worth spending a model call on.
 *
 * Deliberately generous in one direction only: a message that asks nothing
 * must never reach the model (that is the whole cost control), but a message
 * that merely might is allowed through — the model returns the message
 * unchanged and we cache that. A question mark outside code is the signal; a
 * coding agent's "should I …", "want me to …" always carries one.
 */
export function asksSomething(text: string): boolean {
	const regions = codeRegions(text);
	for (let i = text.indexOf("?"); i !== -1; i = text.indexOf("?", i + 1)) {
		if (!inAnyRegion(regions, i)) return true;
	}
	return false;
}

/** Instruction for the second model. Kept separate so it can be tuned alone. */
export const INFER_SYSTEM_PROMPT = `You add to an AI coding assistant's message the replies its user could plausibly send back.

You are given the assistant's message. Some spans may already be wrapped in <snippet></snippet> tags — leave those exactly as they are. Add <snippet></snippet> tags around every other span the user could plausibly send back as their next message. The text you wrap is exactly what the user sends when they pick it, so wrap the shortest span that reads as a complete reply on its own.

What to wrap:
- Each branch of an either/or question: "Do you want to rebuild or commit?" -> rebuild, commit.
- An offer the user could accept: "Want me to fix them one at a time?" -> fix them one at a time.
- The bare name of an option in a list, when the name alone is a complete reply.
- A binary question's affirmative: "Shall I proceed?" -> proceed.

Tag freely: there is no limit on the number of tags — more options are better than fewer. But never wrap a noun, a filename, or a fragment that only makes sense inside the assistant's own sentence; the wrapped text must stand alone as the user's words. A message that invites nothing new comes back exactly as you received it.

Hard rules:
- Copy the message exactly. The ONLY change is adding <snippet> and </snippet> around new spans. No paraphrasing, no added or dropped words, no punctuation fixes, nothing.
- Never remove, move, or alter an existing <snippet> tag, and never wrap text that is already inside one.
- Never wrap text inside a code block or code span.
- Reply with the marked-up message and nothing else: no prose, no code fence, no quotes.

Example message:
The build failed in three places. Want me to <snippet>fix them one at a time</snippet>, or show you all three errors first?

Example reply:
The build failed in three places. Want me to <snippet>fix them one at a time</snippet>, or <snippet>show you all three errors first</snippet>?

Example message:
I've pushed the branch and CI is green.

Example reply:
I've pushed the branch and CI is green.`;

export function buildInferPrompt(messageText: string): string {
	return `<assistant_message>\n${messageText}\n</assistant_message>`;
}

/** Strips a ``` fence the model may have wrapped its answer in. */
export function unfence(raw: string): string {
	const fenced = /^\s*```(?:json|markdown)?\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(raw);
	return fenced?.[1] ?? raw;
}

/** A located chip: where an anchor sits in the text it was found in. */
export interface LocatedAnchor {
	text: string;
	start: number;
	end: number;
}

/**
 * Locate each anchor verbatim in `text`, skipping code regions and spans the
 * given layer-1 chips already cover.
 *
 * This is the authority on where a layer-2 chip paints: an anchor is located
 * against the exact text the transformer was handed (which may be one text
 * block of a message, or the whole message — both forms are located
 * independently), so a chip appears wherever its words actually are. An
 * anchor that overlaps an existing chip or an earlier anchor is dropped: the
 * failure mode is a missing chip, never a doubled one.
 */
export function locateAnchors(
	text: string,
	anchors: readonly string[],
	existing: ReadonlyArray<LocatedAnchor> = [],
): LocatedAnchor[] {
	const regions = codeRegions(text);
	const taken: Array<{ start: number; end: number }> = [...existing];
	const found: LocatedAnchor[] = [];
	for (const anchor of anchors) {
		if (anchor.length === 0) continue;
		let placed = false;
		for (
			let start = text.indexOf(anchor);
			start !== -1;
			start = text.indexOf(anchor, start + 1)
		) {
			const end = start + anchor.length;
			if (regions.some((r) => start < r.end && end > r.start)) continue;
			if (taken.some((t) => start < t.end && end > t.start)) continue;
			found.push({ text: anchor, start, end });
			taken.push({ start, end });
			placed = true;
			break;
		}
		if (!placed) {
			// Not found: dropped. The caller's list may name an anchor that
			// belongs to another form of the message (a different text block);
			// that is ordinary, not an error.
		}
	}
	found.sort((a, b) => a.start - b.start);
	return found;
}

/**
 * Validate a second model's answer and return the anchors worth painting.
 *
 * `messageText` is the original message *with* its layer-1 tags — the exact
 * text the second model received. The tags it was asked to preserve come back
 * in its reply and parse as suggestions like any other; each one matches a
 * chip in `existing` (the texts layer 1 already painted) and is dropped here,
 * so only genuinely new spans survive. A new tag must still be verbatim in
 * the message's non-code text and must not overlap a chip that exists.
 *
 * There is no per-message limit beyond the runaway guard the parser itself
 * applies: more tags are better than fewer, and the cap exists only so a
 * stuck model emitting tag soup cannot fill the keyboard's numbering.
 */
export function extractAnchors(
	raw: string,
	messageText: string,
	existing: readonly string[] = [],
): string[] {
	const layer1Nodes = parseSuggestions(messageText).nodes.filter((n) => n.type === "suggestion");
	const accepted: Array<{ text: string; start: number; end: number }> = layer1Nodes.map((n) => ({
		text: n.text,
		start: n.start,
		end: n.start + n.text.length,
	}));

	const reply = unfence(raw);
	const { nodes } = parseSuggestions(reply);

	const anchors: string[] = [];
	for (const node of nodes) {
		if (node.type !== "suggestion") continue;
		if (accepted.length >= MAX_SUGGESTIONS_PER_MESSAGE) break;
		// The tags the model was told to preserve come back as suggestions of
		// their own; they match a chip layer 1 already paints and end here.
		// So does any re-wrap of the same words — the same words cannot be two
		// replies.
		if (accepted.some((a) => a.text === node.text)) continue;
		const located = locateAnchors(messageText, [node.text], accepted);
		if (located.length === 0) continue; // invented or paraphrased: drop it
		accepted.push(located[0]!);
		anchors.push(node.text);
	}
	return anchors;
}
