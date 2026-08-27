/**
 * Inferred suggestions: the layer that fills in the questions the model
 * didn't tag.
 *
 * Mode 1 (`<snippet>`) needs the primary model to cooperate — to notice it
 * has asked something and to wrap the answer as it writes. It often doesn't,
 * and a provider bridge that rebuilds the system prompt may never have shown
 * it the contract at all. This layer covers that gap: a small, fast model
 * reads the finished message and says which spans invite a reply and what
 * the user would plausibly say back.
 *
 * Everything here is pure. The model call itself lives in
 * `extension/magic.ts`; this module decides what is worth asking about, what
 * to ask, and — the part that matters — what to believe of the answer.
 *
 * ## Why the anchor must be verbatim
 *
 * A small model asked for spans will occasionally paraphrase one. A chip
 * whose anchor is not literally in the message is unclickable (hit testing
 * matches rendered text) and, worse, would underline something the user
 * never wrote. So an anchor that does not appear verbatim in the
 * non-code text of the message is dropped rather than repaired: the failure
 * mode is a missing chip, never a wrong one.
 */

import { fencedRegions, MAX_SUGGESTION_LENGTH, MAX_SUGGESTIONS_PER_MESSAGE } from "./suggestions.js";

/**
 * A span of the assistant's own prose, and what the user would say if they
 * clicked it.
 */
export interface InferredSuggestion {
	/** Exact substring of the message — what gets underlined and hit-tested. */
	anchor: string;
	/** What lands in the composer. Resolved into the user's voice. */
	reply: string;
}

/**
 * Runaway guard on inferred suggestions per message — a guard, not a style
 * rule, exactly as `MAX_SUGGESTIONS_PER_MESSAGE` is for tagged chips.
 *
 * It was 4, and the prompt asked for at most 4. That cost real chips: a
 * message asking five questions got four of them underlined and the fifth
 * silently dropped, with nothing to tell the user which one was missing.
 * Digit addressing is what bounds the tagged layer at 99; an inferred anchor
 * carries no number and is reached only by clicking, so addressing bounds it
 * not at all. How many spans are worth underlining is a judgement about the
 * message, which is why the prompt asks for all of them and this number only
 * stops a broken model from returning a thousand.
 */
export const MAX_INFERRED_PER_MESSAGE = MAX_SUGGESTIONS_PER_MESSAGE;

/** An anchor longer than this is a paragraph, not a span worth pointing at. */
export const MAX_ANCHOR_LENGTH = 200;

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
 * that merely might is allowed through — the model answers `[]` and we cache
 * that. A question mark outside code is the signal; a coding agent's
 * "should I …", "want me to …" always carries one.
 */
export function asksSomething(text: string): boolean {
	const regions = codeRegions(text);
	for (let i = text.indexOf("?"); i !== -1; i = text.indexOf("?", i + 1)) {
		if (!inAnyRegion(regions, i)) return true;
	}
	return false;
}

/** Instruction for the small model. Kept separate so it can be tuned alone. */
export const INFER_SYSTEM_PROMPT = `You turn an AI coding assistant's message into the replies its user would plausibly type back.

You are given the assistant's message. Find the spans that invite a reply — questions, offers, lists of options — and for each one write what the user would say.

Reply with JSON only: an array of {"anchor": string, "reply": string}. No prose, no code fence.

- "anchor" MUST be copied character-for-character from the message. Never paraphrase it, never fix its typos, never add or drop punctuation. If you cannot copy a span exactly, leave it out.
- Anchor the shortest span that carries the question or the option — usually the question clause itself, or the name of one option.
- "reply" is what the USER types, in the user's voice: an instruction or an answer, not a restatement of the question. Resolve pronouns using the message ("it" -> what it refers to).
- One entry per distinct thing the user could say. An either/or question gets one entry per branch, each anchored on its own branch.
- Cover every span that invites a reply. Do not stop at a fixed number, and do not drop a question because the message asks several.
- Keep each reply under ${MAX_SUGGESTION_LENGTH} characters, one line.
- If the message invites nothing — it is a status update, a finished answer, or it asks nothing of the user — reply with exactly [].

Example message:
I'm done the model, do you want to see it?

Example output:
[{"anchor":"do you want to see it?","reply":"Show me the model."}]

Example message:
The build failed in three places. Want me to fix them one at a time, or show you all three errors first?

Example output:
[{"anchor":"fix them one at a time","reply":"Fix them one at a time."},{"anchor":"show you all three errors first","reply":"Show me all three errors first."}]

Example message:
I've pushed the branch and CI is green.

Example output:
[]`;

/** The user turn for the inference call: just the message being read. */
export function buildInferPrompt(messageText: string): string {
	return `<assistant_message>\n${messageText}\n</assistant_message>`;
}

/** Strips a ```json fence the model may have wrapped its answer in. */
function unfence(raw: string): string {
	const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(raw);
	return fenced?.[1] ?? raw;
}

/**
 * First occurrence of `anchor` in `text` that is not inside code, or -1.
 */
function anchorIndex(text: string, anchor: string, regions: Array<{ start: number; end: number }>): number {
	for (let i = text.indexOf(anchor); i !== -1; i = text.indexOf(anchor, i + 1)) {
		if (!inAnyRegion(regions, i)) return i;
	}
	return -1;
}

/**
 * Validate a small model's answer against the message it was asked about.
 *
 * Every rule here exists to make a bad answer produce *fewer* chips rather
 * than wrong ones: malformed JSON, an invented anchor, an anchor inside a
 * code block, an empty or oversized reply, and overlapping anchors (which
 * would underline the same words twice) all drop the entry and keep the rest.
 */
export function parseInferred(raw: string, messageText: string): InferredSuggestion[] {
	let data: unknown;
	try {
		data = JSON.parse(unfence(raw));
	} catch {
		return [];
	}
	if (!Array.isArray(data)) return [];

	const regions = codeRegions(messageText);
	const accepted: Array<InferredSuggestion & { start: number; end: number }> = [];

	for (const entry of data) {
		if (accepted.length >= MAX_INFERRED_PER_MESSAGE) break;
		if (typeof entry !== "object" || entry === null) continue;
		const anchor = (entry as { anchor?: unknown }).anchor;
		const reply = (entry as { reply?: unknown }).reply;
		if (typeof anchor !== "string" || typeof reply !== "string") continue;

		const trimmedReply = reply.trim();
		if (trimmedReply.length === 0 || trimmedReply.length > MAX_SUGGESTION_LENGTH) continue;
		if (/\n/.test(trimmedReply)) continue;
		if (anchor.length === 0 || anchor.length > MAX_ANCHOR_LENGTH) continue;
		if (/\n[ \t]*\n/.test(anchor)) continue; // a chip cannot cross a block boundary

		const start = anchorIndex(messageText, anchor, regions);
		if (start === -1) continue; // invented or paraphrased: drop it
		const end = start + anchor.length;
		if (accepted.some((a) => start < a.end && end > a.start)) continue; // overlaps a kept anchor
		if (accepted.some((a) => a.anchor === anchor)) continue;

		accepted.push({ anchor, reply: trimmedReply, start, end });
	}

	return accepted.map(({ anchor, reply }) => ({ anchor, reply }));
}
