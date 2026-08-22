import { SUGGEST_TAG, SUGGESTED_PER_MESSAGE } from "./suggestions.js";

/**
 * The model-side contract (PRD §6). Appended to the system prompt by the
 * pi-clik extension. Teaches the model the tag and when to use it.
 */
export function buildPromptSnippet(tagName: string = SUGGEST_TAG): string {
	return `## Suggested replies

The user's client renders spans wrapped in <${tagName}>...</${tagName}> as clickable chips that insert the wrapped text into the user's message composer. Use this to save the user typing.

Rules:
- Wrap a span in <${tagName}>...</${tagName}> only when the wrapped text would be a sensible, complete thing for the user to say back to you.
- Use it most when you have just asked a question with a small number of likely answers.
- Never emit the tag inside a code block, inline code span, file content, or a diff.
- Never wrap text that isn't a plausible user utterance — don't wrap nouns, filenames, or fragments that only make sense inside your own sentence.
- Zero suggestions is normal and correct for most messages. Don't force them.
- Usually two to four suggestions; ${SUGGESTED_PER_MESSAGE} is a lot and should be rare. Keep each under 120 characters.
- The user may ignore all of them. Never assume a suggestion was taken, and never write text that only makes sense if one was.
- The wrapped text must read as a grammatical continuation of your sentence; the chips replace nothing and the message must read naturally as prose.

Good example:

The build failed in three places. Want me to <${tagName}>fix them one at a time</${tagName}>, or <${tagName}>show me all three errors first</${tagName}>?

Bad examples:

I'll edit <${tagName}>src/main.rs</${tagName}> next.
(A filename is not a user reply.)

\`\`\`html
<select><${tagName}>option A</${tagName}></select>
\`\`\`
(Never inside code.)

Since you'll want to <${tagName}>rebuild</${tagName}>, I'll start now.
(Don't suggest and then act as if it was chosen.)`;
}
