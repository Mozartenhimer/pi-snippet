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
 * ## Why both fields must be verbatim
 *
 * A small model asked for spans will occasionally paraphrase one. A chip
 * whose anchor is not literally in the message is unclickable (hit testing
 * matches rendered text) and, worse, would underline something the user
 * never wrote. So an anchor that does not appear verbatim in the
 * non-code text of the message is dropped rather than repaired: the failure
 * mode is a missing chip, never a wrong one.
 *
 * The reply is held to the same rule, and for a sharper reason. While it was
 * free text, the model wrote it — and a model asked to write the user's
 * answer will answer for them. Measured against a live small model, an
 * either/or question came back as one entry per question rather than one per
 * branch, anchored on the whole question with a reply that picked a side:
 * "Should it stream or buffer?" produced "Stream the input." Clicking that
 * composes a decision the user never made, with the alternative nowhere on
 * screen. The anchor was verbatim, so rule 5 never saw it.
 *
 * Requiring the reply to be a quote too removes the ability to invent rather
 * than asking the model not to use it. The model's whole job becomes
 * selection: point at the words, don't compose them. That is a much smaller
 * ask of a small model, and it is checkable here rather than hoped for in a
 * prompt.
 */

import { fencedRegions, MAX_SUGGESTION_LENGTH, MAX_SUGGESTIONS_PER_MESSAGE } from "./suggestions.js";

/**
 * A span of the assistant's own prose, and what the user would say if they
 * clicked it.
 */
export interface InferredSuggestion {
	/** Exact substring of the message — what gets underlined and hit-tested. */
	anchor: string;
	/**
	 * What lands in the composer. Also an exact substring of the message —
	 * usually the anchor itself, sometimes a shorter quote inside it.
	 */
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
export const INFER_SYSTEM_PROMPT = `You pick out the words in an AI coding assistant's message that its user could send straight back as a reply.

You do not write replies. You quote them. Every character you return is copied from the message you were given.

Reply with JSON only: an array of {"anchor": string, "reply": string}. No prose, no code fence.

- Both fields MUST be copied character-for-character from the message. Never paraphrase, never fix a typo, never add or remove punctuation, never use a word that is not already there. If you cannot copy a span exactly, leave the entry out.
- "anchor" is the span that gets underlined in the message. "reply" is what lands in the user's composer when they click it. Usually they are the same span. Make "reply" a shorter quote only when the anchor carries words the user would not be sending, like a leading "Want me to".
- Anchor the shortest span that carries one option or one question.
- A question that offers a choice gets one entry per branch, each anchored on its own branch. Never pick a branch for the user by returning only one of them.
- Cover every span that invites a reply. Do not stop at a fixed number, and do not drop a question because the message asks several.
- Keep each reply under ${MAX_SUGGESTION_LENGTH} characters, one line.
- If the message invites nothing — it is a status update, a finished answer, or it asks nothing of the user — reply with exactly [].

Example message:
The build failed in three places. Want me to fix them one at a time, or show you all three errors first?

Example output:
[{"anchor":"fix them one at a time","reply":"fix them one at a time"},{"anchor":"show you all three errors first","reply":"show you all three errors first"}]

Example message:
A few name ideas: pi-chip, pi-reply, or pi-nudge. Which do you like?

Example output:
[{"anchor":"pi-chip","reply":"pi-chip"},{"anchor":"pi-reply","reply":"pi-reply"},{"anchor":"pi-nudge","reply":"pi-nudge"}]

Example message:
Want me to apply the migration to staging now?

Example output:
[{"anchor":"apply the migration to staging now?","reply":"apply the migration to staging"}]

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
 * code block, a reply the model composed instead of quoting, an empty or
 * oversized reply, and overlapping anchors (which would underline the same
 * words twice) all drop the entry and keep the rest.
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

	// An anchor the model used more than once is a question it pointed at, not
	// an option: it answered "stream or buffer?" with two entries on the whole
	// clause, differing only in their replies. Underlining that clause twice is
	// impossible, so each entry is moved onto its own reply — which is a
	// verbatim span of the message like any other anchor. Without this the
	// second branch is lost, and losing a branch is how the user ends up with
	// one side of a choice presented as the answer.
	const anchorUses = new Map<string, number>();
	for (const entry of data) {
		const anchor = (entry as { anchor?: unknown })?.anchor;
		if (typeof anchor === "string") anchorUses.set(anchor, (anchorUses.get(anchor) ?? 0) + 1);
	}

	for (const entry of data) {
		if (accepted.length >= MAX_INFERRED_PER_MESSAGE) break;
		if (typeof entry !== "object" || entry === null) continue;
		const anchor = (entry as { anchor?: unknown }).anchor;
		const rawReply = (entry as { reply?: unknown }).reply;
		if (typeof anchor !== "string") continue;
		// A model that returns only the span has still done the whole job now
		// that the reply is a quote of it. Treat the anchor as the reply.
		if (rawReply !== undefined && typeof rawReply !== "string") continue;
		const reply = rawReply ?? anchor;

		const trimmedReply = reply.trim();
		if (trimmedReply.length === 0 || trimmedReply.length > MAX_SUGGESTION_LENGTH) continue;
		if (/\n/.test(trimmedReply)) continue;
		if (anchor.length === 0 || anchor.length > MAX_ANCHOR_LENGTH) continue;
		if (/\n[ \t]*\n/.test(anchor)) continue; // a chip cannot cross a block boundary
		// The reply is a quote, not a composition: whatever the model would
		// have written for the user, it has to find in the message first.
		if (anchorIndex(messageText, trimmedReply, regions) === -1) continue;

		// Where to underline. The anchor is the model's choice; the reply is a
		// second, equally valid candidate, because it is now a verbatim span of
		// the message too — and underlining exactly the words that will be
		// inserted is no worse an affordance than underlining the clause
		// around them. That fallback is what saves an either/or answered as
		// two entries sharing one anchor: the branches differ in their replies,
		// so the second lands on its own branch instead of being dropped as a
		// duplicate. A span is still never underlined twice.
		const shared = (anchorUses.get(anchor) ?? 0) > 1;
		const placement = (shared ? [trimmedReply, anchor] : [anchor, trimmedReply])
			.map((span) => ({ span, start: anchorIndex(messageText, span, regions) }))
			.find(
				({ span, start }) =>
					start !== -1 &&
					!accepted.some((a) => start < a.end && start + span.length > a.start),
			);
		if (!placement) continue; // invented, paraphrased, or nowhere left to sit

		accepted.push({
			anchor: placement.span,
			reply: trimmedReply,
			start: placement.start,
			end: placement.start + placement.span.length,
		});
	}

	return accepted.map(({ anchor, reply }) => ({ anchor, reply }));
}
