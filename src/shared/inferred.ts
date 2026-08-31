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

import { fencedRegions, MAX_SUGGESTIONS_PER_MESSAGE, parseSuggestions, SNIPPET_TAG } from "./suggestions.js";

/** Regions of `text` that are code, where an anchor must never land. */
function codeRegions(text: string): Array<{ start: number; end: number }> {
	const regions = fencedRegions(text);
	const inline = /`+[^`\n]*`+/g;
	let m: RegExpExecArray | null;
	while ((m = inline.exec(text)) !== null) {
		regions.push({ start: m.index, end: m.index + m[0].length });
	}
	return regions;
}

/**
 * Which shape the second model replies in — a live A/B rather than a settled
 * choice, so both stay reachable from `/snippets`.
 *
 * `reemit` re-emits the whole message with more `<snippet>` tags added — the
 * message itself carries the answer, verbatim, at the position it was found.
 * `options` instead has the model list bare reply lines, one per line, with
 * no re-emission and no tags at all; the extension then finds every verbatim
 * occurrence of a line in the message and lights all of them up under the
 * same chip number, since either occurrence sends the identical reply.
 */
export type InferStyle = "reemit" | "options";

export const INFER_STYLES: readonly InferStyle[] = ["reemit", "options"];

/**
 * What counts as a plausible reply — the one piece of judgment both reply
 * styles need identically. Factored out so the two prompts below can only
 * drift on *format* (tags re-emitted vs. bare lines listed), never on *what
 * to offer*: editing this once keeps both current, rather than two prose
 * blocks that quietly diverge as one gets tuned and the other forgotten.
 */
const INFER_GUIDANCE = `What counts as a plausible reply:
- Each branch of an either/or question: "Do you want to rebuild or commit?" -> rebuild, commit.
- An offer the user could accept: "Want me to fix them one at a time?" -> fix them one at a time.
- The bare name of an option in a list, when the name alone is a complete reply.
- A binary question's affirmative: "Shall I proceed?" -> proceed.

There is no limit on how many you find — more options are better than fewer. But never offer a noun, a filename, or a fragment that only makes sense inside the assistant's own sentence; every reply must stand alone as the user's own words, copied verbatim, and must never come from inside a code block or code span.`;

/**
 * One example message, and the plausible replies a good answer finds in it —
 * the two styles show the same scenarios and disagree only on how a reply is
 * written down, so an example lives here once and each prompt renders its
 * own shape from it. Editing or adding an example now can't update one
 * prompt and forget the other.
 */
interface InferExample {
	/** The assistant's message, exactly as both prompts show it. */
	message: string;
	/** The plausible replies in it, in document order; empty for none at all. */
	replies: string[];
}

const INFER_EXAMPLES: readonly InferExample[] = [
	{
		message:
			"The build failed in three places. Want me to fix them one at a time, or show you all three errors first?",
		replies: ["fix them one at a time", "show you all three errors first"],
	},
	{ message: "I've pushed the branch and CI is green.", replies: [] },
];

/** `reemit`'s shape for one example: the message with every reply wrapped in tags. */
function reemitExampleReply(example: InferExample): string {
	const located = locateAnchors(example.message, example.replies);
	let out = "";
	let cursor = 0;
	for (const anchor of located) {
		out += example.message.slice(cursor, anchor.start) + `<${SNIPPET_TAG}>${anchor.text}</${SNIPPET_TAG}>`;
		cursor = anchor.end;
	}
	return out + example.message.slice(cursor);
}

/** Renders every example as `Example message: … / Example reply: …`, one style's shape at a time. */
function renderExamples(exampleReply: (example: InferExample) => string): string {
	return INFER_EXAMPLES.map(
		(example) => `Example message:\n${example.message}\n\nExample reply:\n${exampleReply(example)}`,
	).join("\n\n");
}

/** Instruction for the second model. Kept separate so it can be tuned alone. */
export const INFER_SYSTEM_PROMPT = `You add to an AI coding assistant's message the replies its user could plausibly send back.

You are given the assistant's message. Some spans may already be wrapped in <snippet></snippet> tags — leave those exactly as they are. Add <snippet></snippet> tags around every other span the user could plausibly send back as their next message. The text you wrap is exactly what the user sends when they pick it, so wrap the shortest span that reads as a complete reply on its own.

${INFER_GUIDANCE}

A message that invites nothing new comes back exactly as you received it.

Hard rules:
- Copy the message exactly. The ONLY change is adding <snippet> and </snippet> around new spans. No paraphrasing, no added or dropped words, no punctuation fixes, nothing.
- Never remove, move, or alter an existing <snippet> tag, and never wrap text that is already inside one.
- Reply with the marked-up message and nothing else: no prose, no code fence, no quotes.

${renderExamples(reemitExampleReply)}`;

/**
 * The `options` style's instruction: instead of re-emitting the message, the
 * model lists bare reply lines. No tags, no re-emission — `extractOptionAnchors`
 * below locates every verbatim occurrence of each line itself, which is what
 * lets the same option light up more than once in the message.
 */
export const INFER_OPTIONS_SYSTEM_PROMPT = `You read an AI coding assistant's message and list the replies its user could plausibly send back.

Reply with the options only, one per line, and nothing else: no numbering, no bullets, no prose, no code fence, no quotes, no blank lines. Each line must be copied verbatim from the assistant's message — the exact words, unmodified — since what you write is exactly what the user sends when they pick it. Write the shortest line that reads as a complete reply on its own.

${INFER_GUIDANCE}

A message that invites nothing new gets an empty reply.

${renderExamples((example) => example.replies.join("\n"))}`;

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
	/**
	 * The anchor's index in the array it was located from — the rank that
	 * decides its chip number (`shared/tui-markdown.ts` numbers layer-2 chips
	 * by arrival order, never by document position, so a late-arriving anchor
	 * cannot renumber one already on screen).
	 */
	order: number;
}

/**
 * Shared walk behind `locateAnchors` and `locateAllOccurrences`: find each
 * anchor verbatim in `text`, skipping code regions and spans already taken by
 * an earlier anchor, an earlier occurrence, or `existing`. `allOccurrences`
 * is the only difference between the two — `reemit` wants the first verbatim
 * spot an anchor occupies, `options` wants every one of them, sharing the
 * same `order` (and so the same chip number) across every occurrence.
 *
 * This is the authority on where a layer-2 chip paints: an anchor is located
 * against the exact text the transformer was handed (which may be one text
 * block of a message, or the whole message — both forms are located
 * independently), so a chip appears wherever its words actually are. An
 * anchor that overlaps an existing chip or an earlier anchor is dropped: the
 * failure mode is a missing chip, never a doubled one.
 */
function placeAnchors(
	text: string,
	anchors: readonly string[],
	existing: ReadonlyArray<{ text: string; start: number; end: number }>,
	allOccurrences: boolean,
): LocatedAnchor[] {
	const regions = codeRegions(text);
	const taken: Array<{ start: number; end: number }> = [...existing];
	const found: LocatedAnchor[] = [];
	for (const [order, anchor] of anchors.entries()) {
		if (anchor.length === 0) continue;
		for (
			let start = text.indexOf(anchor);
			start !== -1;
			start = text.indexOf(anchor, start + 1)
		) {
			const end = start + anchor.length;
			if (regions.some((r) => start < r.end && end > r.start)) continue;
			if (taken.some((t) => start < t.end && end > t.start)) continue;
			found.push({ text: anchor, start, end, order });
			taken.push({ start, end });
			if (!allOccurrences) break;
		}
	}
	found.sort((a, b) => a.start - b.start);
	return found;
}

/**
 * Locate each anchor at its first verbatim spot in `text` — the `reemit`
 * style's shape, where an anchor is a span the model wrapped once.
 */
export function locateAnchors(
	text: string,
	anchors: readonly string[],
	existing: ReadonlyArray<{ text: string; start: number; end: number }> = [],
): LocatedAnchor[] {
	return placeAnchors(text, anchors, existing, false);
}

/**
 * Locate every verbatim occurrence of each anchor — the `options` style's
 * shape, where a reply line the model listed once may appear more than once
 * in the message ("Should we rebuild or commit?" answered elsewhere with
 * "rebuild it now"): every occurrence gets painted, and every one shares the
 * anchor's chip number, since clicking any of them sends the identical reply.
 */
export function locateAllOccurrences(
	text: string,
	anchors: readonly string[],
	existing: ReadonlyArray<{ text: string; start: number; end: number }> = [],
): LocatedAnchor[] {
	return placeAnchors(text, anchors, existing, true);
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

/**
 * The `options` style's counterpart to `extractAnchors`: the model's reply is
 * bare lines, not tags, so validation is simpler — a line is worth a chip once
 * it appears verbatim anywhere in the message's non-code text. Where it
 * actually paints (once, or every occurrence) is decided later, at render
 * time, by `locateAllOccurrences`; this only decides which distinct lines
 * survive and in what order they are numbered.
 *
 * `complete: false` marks a still-streaming reply: the last line has not seen
 * its terminating newline yet and may still grow, so it is held back rather
 * than painted as "reb" before "rebuild" finishes arriving. The caller passes
 * `complete: false` on every partial and leaves it unset for the final text.
 */
export function extractOptionAnchors(
	raw: string,
	messageText: string,
	existing: readonly string[] = [],
	opts?: { complete?: boolean },
): string[] {
	const layer1Texts = parseSuggestions(messageText).nodes
		.filter((n) => n.type === "suggestion")
		.map((n) => n.text);
	const covered = new Set([...layer1Texts, ...existing]);

	const segments = unfence(raw).split("\n");
	const candidates = opts?.complete === false ? segments.slice(0, -1) : segments;
	const lines = candidates.map((line) => line.trim()).filter((line) => line.length > 0);

	const anchors: string[] = [];
	for (const line of lines) {
		if (covered.size >= MAX_SUGGESTIONS_PER_MESSAGE) break;
		// Already a chip — layer 1's, an earlier line this same reply, or one
		// the caller already painted — or nowhere in the message at all
		// (invented, paraphrased, or only inside a code region).
		if (covered.has(line)) continue;
		if (locateAnchors(messageText, [line]).length === 0) continue;
		covered.add(line);
		anchors.push(line);
	}
	return anchors;
}
