import { SNIPPET_TAG, SUGGESTED_PER_MESSAGE } from "./suggestions.js";

/**
 * The model-side contract (PRD §6). Appended to the system prompt by the
 * pi-snippet extension. Teaches the model the tag and when to use it.
 */
export function buildPromptSnippet(tagName: string = SNIPPET_TAG): string {
	return `## Suggested replies

The user's client renders spans wrapped in <${tagName}>...</${tagName}> as clickable chips that insert the wrapped text into the user's message composer. Use this to save the user typing. This allows the user to compose and edit snippets suggested by the agent.

Rules:
- Wrap a span in <${tagName}>...</${tagName}> only when the wrapped text would be plausible sentence fragment or complete response for the user to reply with.
- Use it most when you have just asked a question with suggested options.
- Never emit the tag inside a code block, inline code span, file content, or a diff.
- Never wrap text that isn't a plausible user utterance — don't wrap nouns, filenames, or fragments that only make sense inside your own sentence. Exception: when you've just offered a short list of named options as the answer to a question, the bare name of each option is a complete reply and may be wrapped on its own.
- Zero suggestions is normal and correct for most messages. Don't force them.
- The user may ignore all of them. Never assume a suggestion was taken, and never write text that only makes sense if one was.
- The wrapped text must read as a grammatical continuation of your sentence; the chips replace nothing and the message must read naturally as prose.

## Good example

The build failed in three places. Want me to <${tagName}>fix them one at a time</${tagName}>, or <${tagName}>show me all three errors first</${tagName}>?


### Options from a list

Would you like to:
1. <${tagName}> Refactor the codebase</${tagName}>?
2. <${tagName}> Run the tests?</${tagName}>?

(Question marks are part of the question, but not part of the answer.)

###  bare option names:

A few name ideas: <${tagName}>pi-chip</${tagName}>, <${tagName}>pi-reply</${tagName}>, or <${tagName}>pi-nudge</${tagName}>. Which do you like?
(Each name alone is a complete answer to "which do you like".)

## Bad examples:

I'll edit <${tagName}>src/main.rs</${tagName}> next.
(A filename is not a user reply.)

\`\`\`html
<select><${tagName}>option A</${tagName}></select>
\`\`\`
(Never inside code.)

Since you'll want to <${tagName}>rebuild</${tagName}>, I'll start now.
(Don't suggest and then act as if it was chosen.)
`;
}
