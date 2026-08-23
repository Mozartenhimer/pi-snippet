# PRD: Inline Suggestion Snippets for pi-web-ui

**Status:** Draft
**Owner:** TBD
**Surface:** `@mariozechner/pi-web-ui` (+ `pi-coding-agent` extension running in RPC mode)

---

## 1. Summary

Let the model mark spans of its own prose as *suggested user replies*. The web client renders those spans as clickable chips inline in the message. Clicking one inserts its text into the composer — it does not send it. The user can edit, extend, or ignore it entirely.

```
Agent:  I've finished the refactor. Do you want me to [rebuild the solution]
        or [run the test suite] first?
```

Clicking `rebuild the solution` puts that text in the composer. Typing over it is always available. Nothing is modal, nothing blocks, nothing is forced.

---

## 2. Problem

Agent conversations are full of short, predictable user replies. "yes", "rebuild it", "run the tests", "show me the diff", "use the second approach". The user knows what they want to say; they just have to type it. On a long session that is hundreds of keystrokes of pure transcription.

Existing mitigations are all worse:

- **Blocking pickers** (`ctx.ui.select`) hijack the turn. The user must answer, and answer from a fixed menu. This is correct for permission gates and wrong for convenience.
- **Detached suggestion widgets** put orphaned strings in a tray below the composer. They lose the sentence they came from — "the second one" means nothing outside the paragraph that listed them.
- **Slash commands / macros** require the user to know and remember them.

We want the affordance to be *ambient*: visible where the suggestion was made, ignorable at zero cost, and free when taken.

---

## 3. Goals and Non-Goals

### Goals

- G1. Model can mark suggested replies inline, mid-sentence, in its own prose.
- G2. User can insert a suggestion into the composer with one click.
- G3. Typing freely is always the default state. No mode, no focus steal, no forced choice.
- G4. Suggestions never block the agent turn or add a round-trip.
- G5. Raw markup is never visible to the user in any web surface.
- G6. Degrades cleanly when the model misbehaves (unclosed tags, tags in code, no tags at all).

### Non-Goals

- NG1. **Not** auto-send on click. Insertion only. (Revisit in Phase 3 with an explicit modifier — see §13.)
- NG2. **Not** a permission or confirmation mechanism. Those stay with `ctx.ui.confirm`.
- NG3. **Not** a structured action system. A suggestion is plain text destined for the composer, nothing more. It cannot call tools, set flags, or change modes.
- NG4. **Not** required for the model to function. An agent that never emits a suggestion tag works exactly as it does today.
- NG5. ~~Terminal click support~~ *(originally descoped; since implemented via terminal mouse reporting — see §12)*. The TUI keeps the keyboard-addressable variant as the default affordance.

---

## 4. Background: why the web client

Two designs were considered and rejected before landing here.

**A blocking `suggest_snippet` tool.** The tool would call `ctx.ui.select()` and return the pick as the tool result. Structurally sound — the pause is real, not prompted — but it forces a choice from a menu, which is the opposite of "save the user some typing."

**A non-blocking tool that populates a widget.** Fixes the forcing, but a tool call doesn't end the turn: `execute()` returns, the result goes back to the model, and the loop continues. The model has to emit *another* message immediately after asking its question, producing a trailing "let me know what you'd like!" on every suggestion set. Also detaches the suggestion from its sentence.

**Inline markup in the assistant text** (this PRD) has neither problem. There is no tool call, so there is no round-trip and no control-flow risk. The suggestion sits exactly where the model made it.

The web client is the right surface because a rendered message is already a tree of DOM nodes. Attaching a click handler to a span is free. The terminal has no such tree: pi-tui parses input into keys and routes them to the focused component. Clicking there requires terminal mouse reporting plus hit-testing the rendered screen — possible (§12), but with real costs the web surface doesn't pay.

---

## 5. Design

### 5.1 Wire format

The model emits a namespaced tag inside its normal prose:

```
Do you want me to <pi:snippet>rebuild the solution</pi:snippet> first?
```

**Why namespaced.** The obvious choice, `<option>`, is a real HTML element. A coding agent reads, writes, and discusses files full of `<option>` tags every day. `<pi:snippet>` will effectively never appear in source code by accident, and if it does, §5.3 covers it.

The inserted text is always exactly the element's text content — what you see is what lands in the composer. Attributes on the tag are ignored.

### 5.2 Components

| Component | Responsibility |
|---|---|
| **Extension prompt snippet** | Teaches the model the tag and when to use it. Ships with the extension. |
| **Parser** | Turns raw assistant markdown into a token stream of `text` and `suggestion` nodes. Shared between web and TUI. Pure function, no state. |
| **Web renderer** | Renders suggestion nodes as `<button>` chips inside the message body. |
| **Composer integration** | Insert-at-cursor, focus management, undo. |
| **Suggestion state store** | Tracks which message is "live" for keyboard addressing. Derived from finalized messages only. |

**Hard rule: the parser is pure and the renderer is stateless.** Rendering may run many times per message — on stream ticks, on resize, on theme change, on scroll virtualization. Any state built during render will drift out of sync with what the user sees. The set of addressable suggestions is derived once, when a message finalizes, and stored outside the render path.

### 5.3 Sanitization rules

Applied by the parser, in order:

1. Content inside fenced code blocks (```) is never parsed for suggestion tags.
2. Content inside inline code spans (`` ` ``) is never parsed.
3. A `<pi:snippet>` with no matching close tag before end-of-message is **not** rendered as a chip; its inner text is emitted as ordinary text and the opening tag is dropped. The rest of the message renders normally.
4. Nested `<pi:snippet>` is invalid. The outer tag wins; inner tags are stripped as text.
5. Suggestion text is capped at 120 characters. Over the cap, the tag is discarded and the text rendered plainly.
6. Suggestion text is escaped as text content, never as HTML. A chip cannot inject markup.

---

## 6. Model-side contract

Shipped as the extension's prompt snippet. Should include worked positive and negative examples.

**Instructions to the model:**

- Wrap a span in `<pi:snippet>...</pi:snippet>` when the wrapped text would be a sensible, complete thing for the user to say back to you.
- Use it most when you have just asked a question with a small number of likely answers.
- Never emit the tag inside a code block, inline code span, file content, or diff.
- Never wrap text that isn't a plausible user utterance — don't wrap nouns, filenames, or fragments that only make sense in your sentence.
- Zero suggestions is normal and correct for most messages. Don't force them.
- Cap at ten suggestions per message.
- The user may ignore all of them. Never assume a suggestion was taken, and never write text that only makes sense if one is.

**Positive example given to the model:**

```
The build failed in three places. Want me to <pi:snippet>fix them one at a
time</pi:snippet>, or <pi:snippet>show me all three errors first</pi:snippet>?
```

**Negative examples given to the model:**

```
❌ I'll edit <pi:snippet>src/main.rs</pi:snippet> next.
   (A filename is not a user reply.)

❌ ```html
   <select><pi:snippet>option A</pi:snippet></select>
   ```
   (Never inside code.)

❌ Since you'll want to <pi:snippet>rebuild</pi:snippet>, I'll start now.
   (Don't suggest and then act as if it was chosen.)
```

---

## 7. Rendering spec

**Resting state.** A chip is visually distinct from surrounding prose but subordinate to it — a subtle tinted background, inherited font size and family, no shadow, no bold. It reads as part of the sentence, not as a call-to-action button. Line-height must not change; a paragraph with chips must not be taller than the same paragraph without.

**Hover.** Background tint deepens. Cursor becomes pointer. A small inline glyph (↵ or +) appears at the chip's trailing edge to signal insertion. Tooltip after 500ms: "Insert into message".

**Focus.** Standard focus ring, keyboard-reachable via Tab.

**Active/inserted.** Brief 150ms flash, then the chip returns to resting state and is marked visited (slightly dimmed) for the remainder of the session. Chips are not disabled after use — inserting the same suggestion twice is legitimate.

**Wrapping.** Chips must wrap across lines like normal text. A five-word suggestion at the end of a line breaks mid-chip; both fragments keep the background tint. No `white-space: nowrap`.

**Streaming.** While a message streams, a partially-received tag must never flash raw markup. Buffer from the first `<` that could begin `<pi:snippet` until the token is resolved as either the tag or ordinary text. On resolution, render. Chips are inert (rendered, not clickable) until the message finalizes.

---

## 8. Interaction spec

| Action | Result |
|---|---|
| Click chip | Text inserted at composer cursor. Composer gains focus. Cursor lands at end of inserted text. |
| Click chip, composer already has content | Text inserted at cursor position, with a single space added before it if the preceding character isn't whitespace. Existing content is never replaced. |
| Click chip, text is selected in composer | Selection is replaced (standard insertion semantics). |
| Cmd/Ctrl+click chip | Insert **and** send. (Phase 3.) |
| Tab to chip, Enter | Same as click. |
| `Alt+1..9`, `Alt+0` | Insert the Nth suggestion (0 = tenth) of the most recent finalized assistant message. |
| `Alt` held, two digits | Insert suggestion 10 and above: hold Alt, type `1` then `2` for the twelfth. |
| Ctrl+Z after insertion | Undoes the insertion as a single unit, not character-by-character. |
| Click chip in a scrolled-away older message | Works. Inserts, focuses composer, scrolls composer into view. |

**Focus discipline.** The composer is the default focus and returns to it after every insertion. Chips are in the tab order but the page never focuses one automatically. There is no "suggestion mode."

---

## 9. User stories

### Epic A — Core insertion

**A1.** As a user, I want to click a highlighted suggestion in the agent's message so that its text appears in my composer without typing it.
*Accept:* Click inserts exact text; composer is focused; nothing is sent.

**A2.** As a user, I want the inserted text to land at my cursor rather than replacing what I've written, so that I can combine a suggestion with my own words.
*Accept:* Composer containing `also ` + click on `run the tests` → `also run the tests`.

**A3.** As a user, I want to edit the text after inserting it, so that a near-miss suggestion is still useful.
*Accept:* Inserted text is ordinary editable content with no special styling or protection.

**A4.** As a user, I want to click two suggestions in a row and get both, so that I can compose a compound reply.
*Accept:* Two clicks → `rebuild the solution run the tests` with a single separating space. (See open question OQ3 on separator.)

**A5.** As a user, I want to ignore every suggestion and type something unrelated, so that the feature never constrains me.
*Accept:* Typing works identically with or without suggestions present. No dismissal required.

**A6.** As a user, I want to undo an insertion in one keystroke, so that a misclick costs nothing.
*Accept:* Ctrl+Z removes the whole inserted string.

**A7.** As a user, I want to click a suggestion from a message three turns back, so that I can return to an option I passed on.
*Accept:* Chips in scrolled history remain live and clickable for the whole session.

### Epic B — Reading and comprehension

**B1.** As a user, I want to read the agent's message as normal prose, so that suggestions don't fragment the writing.
*Accept:* A message with chips is legible read aloud with no awkwardness; chips are grammatical continuations of the sentence.

**B2.** As a user, I never want to see `<pi:snippet>` or any raw markup.
*Accept:* No web surface renders the literal tag, including mid-stream, on error, and on session restore.

**B3.** As a user, I want to be able to tell at a glance which parts of the message are clickable.
*Accept:* Chip styling is distinguishable from links, inline code, and bold at a normal reading distance.

**B4.** As a user, I don't want the layout to shift when a message finishes streaming.
*Accept:* Chip dimensions are identical in inert (streaming) and live (finalized) states.

**B5.** As a user, I want suggestions to feel optional, not like an unanswered form.
*Accept:* No badge, count, pulse, or persistent highlight that implies pending action.

### Epic C — Streaming and lifecycle

**C1.** As a user, I never want to see a half-written tag flicker on screen while the message streams.
*Accept:* Raw `<pi:sug` is never painted. Buffering is invisible.

**C2.** As a user, I want chips to become clickable as soon as the message is done, without a manual refresh.
*Accept:* Finalization activates chips within one frame.

**C3.** As a user, I don't want to click a suggestion that's still streaming and get partial text.
*Accept:* Chips are inert until finalize; clicks are no-ops with no visual feedback.

**C4.** As a user, if the agent's response is cancelled mid-sentence inside a tag, I want the message to still be readable.
*Accept:* Unclosed tag → inner text renders plainly, remaining message unaffected, no chip.

**C5.** As a user, I want a restored session to look exactly like the live one.
*Accept:* Reload → chips render and function identically. No re-parse artifacts.

### Epic D — Keyboard and accessibility

**D1.** As a keyboard user, I want to insert a suggestion without reaching for the mouse.
*Accept:* `Alt+1..9` and `Alt+0` (tenth) address the latest message's suggestions; holding Alt across two digits addresses 10 and above.

**D2.** As a keyboard user, I want to Tab through chips in reading order.
*Accept:* Chips are `<button>` elements in document order.

**D3.** As a screen reader user, I want the suggestion announced as an actionable control with its text.
*Accept:* `role="button"`, accessible name = insert text, `aria-describedby` pointing at a hint node reading "inserts this text into your message."

**D4.** As a screen reader user, I want the sentence to remain intelligible with chips inline.
*Accept:* The message body is a single continuous reading; chips don't interrupt with landmark or list announcements.

**D5.** As a user with reduced-motion set, I don't want the insertion flash.
*Accept:* `prefers-reduced-motion` disables the 150ms flash; the visited state still applies.

**D6.** As a low-vision user, I want chip contrast to meet AA.
*Accept:* Chip background/foreground ≥ 4.5:1 in both light and dark themes.

### Epic E — Model behavior and content safety

**E1.** As a user discussing HTML, I don't want my code mangled by the parser.
*Accept:* A message containing a literal `<pi:snippet>` inside a fenced block renders it verbatim as code.

**E2.** As a user, I don't want a chip that inserts something different from what it says.
*Accept:* The inserted text is always exactly the chip's visible text content.

**E3.** As a user, I don't want to be shown a wall of suggestions.
*Accept:* Parser renders at most ten per message; extras degrade to plain text.

**E4.** As a user, I don't want the agent to suggest things and then act as though I chose one.
*Accept:* Prompt snippet forbids it; caught in prompt eval suite (§14).

**E5.** As a user, I don't want a chip injecting markup or scripts into the transcript.
*Accept:* Suggestion content is escaped as text. Fuzz test with tag/script/entity payloads.

**E6.** As an operator, I want a message with no suggestions to be the common case.
*Accept:* Measured suggestion-bearing message rate stays under 40% on a representative session corpus.

### Epic F — Surface parity

**F1.** As a TUI user, I want the same extension to work in the terminal, even without clicking.
*Accept:* Chips become bold accent-colored spans led by a superscript number; `Alt+N` inserts. (§12)

**F2.** As a user of print mode (`-p`), I don't want tags in my piped output.
*Accept:* Tags stripped to plain text before write.

**F3.** As a user of `/export` or HTML export, I want clean output.
*Accept:* Export strips tags; HTML export may optionally render chips as static styled spans.

**F4.** As a user in JSON mode, I want the suggestions available as structured data.
*Accept:* Parsed suggestions surface as a field on the message rather than inline markup.

**F5.** As a developer embedding pi-web-ui, I want to disable the feature entirely.
*Accept:* Single config flag; when off, tags are stripped and no chips render.

### Epic G — Failure and degradation

**G1.** As a user, if the model emits malformed markup, I want the message to still be readable.
*Accept:* Every malformed case in §11 degrades to plain readable text.

**G2.** As a user, if the parser throws, I want to see the raw message rather than nothing.
*Accept:* Parser is wrapped; on throw, fall back to rendering unparsed content with tags stripped by regex.

**G3.** As an operator, I want parser failures to be observable.
*Accept:* Failures increment a counter and log the message id, not the content.

### Epic H — Configuration

**H1.** As a user, I want to turn suggestions off if I find them noisy.
*Accept:* Setting in the web UI settings panel, persisted to `SettingsStore`.

**H2.** As a user, I want to disable the hotkeys but keep the chips.
*Accept:* Separate toggle.

**H3.** As an operator, I want to swap the tag name for a rebranded distribution.
*Accept:* Tag name is configurable; parser and prompt snippet read from the same constant.

---

## 10. Worked examples

### 10.1 Basic binary question

**Model emits:**
```
The refactor touched 14 files and everything compiles. Want me to
<pi:snippet>rebuild the solution</pi:snippet> or
<pi:snippet>run the test suite</pi:snippet> first?
```

**User sees:**
> The refactor touched 14 files and everything compiles. Want me to `rebuild the solution` or `run the test suite` first?

**User clicks "run the test suite".** Composer contains `run the test suite`, cursor at end, nothing sent.

---

### 10.2 Suggestion mid-sentence, single

**Model emits:**
```
I can't reproduce it locally. If you can
<pi:snippet>paste the full stack trace</pi:snippet> I'll take another look.
```

Reads naturally as prose. One chip. User pastes their trace after clicking, ending up with `paste the full stack trace` — then deletes it and pastes the actual trace, which is fine; the chip cost nothing.

*(This example is in the PRD deliberately: it's a case where the suggestion is mildly useless. That's acceptable. The failure mode of this feature is "ignored," not "harmful.")*

---

### 10.3 Four options, list form

**Model emits:**
```
Three tests fail for what look like three unrelated reasons. Pick a thread:

- <pi:snippet>start with the auth test</pi:snippet> — most likely a real bug
- <pi:snippet>start with the timezone test</pi:snippet> — probably environmental
- <pi:snippet>start with the flaky socket test</pi:snippet> — may just be timing
- <pi:snippet>show me all three failures in full</pi:snippet>
```

Chips inside list items render normally. Alt+1 through Alt+4 map top to bottom (Alt+5..9 and Alt+0 address any further suggestions).

---

### 10.4 Zero suggestions (the common case)

**Model emits:**
```
Done — the migration ran clean and all 47 rows moved over.
```

No chips. No tray. No empty state. The feature is invisible.

---

### 10.5 Code block containing the tag

**Model emits:**
````
Here's the template you asked about:

```html
<select>
  <pi:snippet>this is not a real tag</pi:snippet>
</select>
```
````

**User sees:** the code block verbatim, tag and all, syntax-highlighted as HTML. No chip. This is the single most important negative case — a coding agent will hit it.

---

### 10.6 Unclosed tag from a cancelled response

**Model emits (stream aborted):**
```
Sure — want me to <pi:snippet>rebuild the sol
```

**User sees:** > Sure — want me to rebuild the sol

No chip, no raw tag, no swallowed text.

---

### 10.7 Tag spanning stream chunks

**Chunks arrive as:** `Want me to <pi` / `:suggest>rebuild</pi:sug` / `gest> now?`

**User sees, frame by frame:** `Want me to ` → `Want me to ` → `Want me to rebuild now?` with the chip appearing at resolution. At no point is `<pi` painted.

---

### 10.8 Combining two suggestions

**Model emits:**
```
I could <pi:snippet>rebuild the solution</pi:snippet> and then
<pi:snippet>run the test suite</pi:snippet>, or just do one.
```

**User clicks both.** Composer: `rebuild the solution run the test suite`. User edits to `rebuild the solution then run the test suite` and sends. Two clicks and three typed words replaced a full sentence.

---

### 10.9 Suggestion that gets ignored entirely

**Model emits:**
```
Want me to <pi:snippet>revert the last commit</pi:snippet>?
```

**User types:** `no, keep it but drop the changes to config.toml`

The chip is never clicked, never dismissed, and leaves no residue. This must be as frictionless as the click path.

---

### 10.10 Chip wrapping across a line break

At a narrow viewport, `show me all three failures in full` breaks after "three". Both halves keep the tint; the chip remains one clickable control via `display: inline`.

---

### 10.11 Over-eager model, eleven suggestions

**Model emits** eleven tags. Parser renders the first ten as chips; the eleventh renders as plain text. No error surfaced to the user. Counter incremented for prompt-tuning telemetry.

---

### 10.12 Model wraps a filename (bad suggestion)

**Model emits:**
```
Next I'll edit <pi:snippet>src/main.rs</pi:snippet>.
```

This is a prompt-compliance failure, not a parser failure. It renders as a chip that inserts `src/main.rs`. Harmless, but tracked — a rising rate of non-utterance suggestions signals prompt drift.

---

### 10.13 Session restore

User reloads mid-conversation. All prior messages re-render from stored raw text through the same parser. Chips reappear, visited state is lost (acceptable), hotkeys re-bind to the last message.

---

## 11. Edge case matrix

| Case | Behavior |
|---|---|
| Unclosed tag | Inner text plain, no chip, rest of message intact |
| Close tag with no open | Dropped silently |
| Nested tags | Outer wins, inner stripped as text |
| Empty content `<pi:snippet></pi:snippet>` | Dropped entirely |
| Whitespace-only content | Dropped entirely |
| Content > 120 chars | Rendered as plain text, no chip |
| More than 10 per message | First 10 chip, rest plain |
| Inside fenced code | Verbatim, no parse |
| Inside inline code | Verbatim, no parse |
| Inside a link label | Chip suppressed; link wins |
| Inside a blockquote | Chip renders normally |
| Inside a table cell | Chip renders normally |
| HTML entities in content | Escaped, rendered literally |
| Markdown inside content (`**bold**`) | Rendered as literal text, not formatted |
| Tag split across stream chunks | Buffered, resolved, then painted |
| Parser throws | Fallback regex strip, message renders, error counted |
| Feature disabled | Tags stripped, plain text, no chips |

---

## 12. TUI parity

The parser is shared. The terminal path uses pi's markdown transformer hook, which receives assistant text (and an `isStreaming` flag distinguishing partial updates from finalized and restored messages) and returns markdown that pi's built-in renderer then draws.

Consequences of that hook returning *markdown* rather than components:

- Chips become bold spans in the theme's inline-code accent color, led by a small superscript number: `Want me to ¹rebuild the solution or ²run the tests?` (rendered via bold + code-span markdown; no brackets).
- There is no hover. Click (§12.1) and `Alt+N` (§12.2) are the affordances.
- The transformer must stay pure — the addressable set is derived on message finalize and held in extension state, never built during transformation.
- Scrolled-away suggestions remain hotkey-addressable but invisible. Only the most recent finalized message is addressable, to avoid `2` meaning two different things.

### 12.1 Click to insert

The TUI also supports real clicking, via terminal mouse reporting (DECSET 1000 + SGR 1006):

- Hit testing matches the *rendered text* of each `ⁿlabel` span on the visible screen — no position markers are embedded in the message, so the session file and the model's context stay clean. Both halves of a span wrapped across lines are clickable.
- Mouse reporting is terminal-wide: while on, the wheel is delivered to the application (terminal scrollback stops responding) and click-drag selection needs Shift. To keep that cost small, reporting is engaged only while the latest finalized message actually has suggestions, and can be toggled off entirely in `/suggestions`.
- Wheel, right-button, motion, and release events are swallowed while reporting is on, so no escape sequences leak into the editor as typed garbage.
- Screen-to-buffer mapping is anchored with a cursor-position report (DSR, `ESC[6n`) issued at click time: pi never clears the screen and draws with relative cursor moves only, so when pi is launched below an existing shell prompt its first buffer line is not screen row 0. The DSR answer, correlated with pi-tui's buffer-relative cursor bookkeeping, gives the exact offset; a terminal that never answers falls back to a bottom-aligned mapping. After an insertion the TUI is asked to repaint — consumed input bypasses pi's own render pass.

### 12.2 Addressing more than ten suggestions

A terminal has ten digit keys, so `Alt+N` alone tops out at ten. Digits are therefore accumulated into a number:

- Hold Alt and type `1` then `2` to address the twelfth suggestion. The two presses arrive about a millisecond apart, which is what makes the gesture legible.
- A digit commits **immediately** when no longer number could exist — with four suggestions on screen, `Alt+3` inserts at once, because no 30-something is addressable. The wait only happens when the message really has ten or more.
- An ambiguous prefix settles after 350 ms, or the moment the modifier lifts on surfaces that report it. The browser reports `keyup`; terminals mostly do not (see below).
- `Alt+0` still means the tenth suggestion — zero addresses nothing on its own, so the existing muscle memory costs nothing.
- The parser cap (`MAX_SUGGESTIONS_PER_MESSAGE`) is a runaway guard, not a style rule, and matches what two-digit addressing reaches. Taste is the prompt's job: the model is told two to four is normal.

**On "release Alt to commit".** The obvious design — settle when the user lets go of Alt — is not available in the terminal today, and this was measured rather than assumed. Ghostty's own key encoder (linked via `scripts/ghostty-keys.c`) reports a standalone modifier only under the Kitty keyboard protocol's `REPORT_ALL` flag (8); pi requests flags 7, at which Alt press and release encode to **no bytes at all**. So the TUI settles on the timeout, and the release watcher stays dormant until pi raises its flags. The web client, which gets a real `keyup`, commits the instant Alt lifts.

Web and TUI share: the parser, the tag constant, the prompt snippet, the cap, the digit-addressing rules, and the sanitization rules. They differ only in the render target and the input event.

### 12.3 Agreeing with the terminal about glyph widths

Click hit-testing turns a character index into a screen column, so our width table has to match the terminal's exactly — a glyph measured as one cell and drawn as two puts every later chip on that line one column off. A hand-written table was wrong for over a thousand codepoints, including emoji outside `U+1F300..1F9FF` (⌚, ⏩, ⚡ are all double-width) and combining marks outside Latin. `src/extension/char-width.ts` is therefore **generated** from Ghostty's own table (`ghostty::CodepointWidth` in libghostty-vt) by `npm run gen:widths`, and `npm run check:widths` verifies it still agrees.

---

## 13. Phasing

**Phase 1 — Read-only correctness.** Parser, sanitization, chip rendering, streaming buffer. Chips render but are not clickable. Ships behind a flag. Goal: prove we never show raw markup and never mangle code.

**Phase 2 — Insertion.** Click and `Alt+N` insert into composer. Undo integration. Settings toggle. Accessibility pass. This is the shippable product.

**Phase 3 — Refinements.** Cmd+click to insert-and-send. Visited state. Export/JSON-mode surfacing. TUI transformer path.

**Phase 4 — Evaluation.** Prompt tuning against measured suggestion quality; consider model-side self-critique of suggestion relevance.

---

## 14. Measurement

- **Take rate** — suggestions clicked ÷ suggestions rendered. Expect low (10–25%); this is a convenience, not a funnel. A very high rate would suggest the model is asking closed questions too often.
- **Edit-after-insert rate** — how often inserted text is modified before send. High is fine (composability working); ~100% means suggestions are consistently near-misses.
- **Suggestion density** — % of assistant messages carrying at least one. Target under 40%. Rising density is prompt drift.
- **Non-utterance rate** — sampled manual review of whether a suggestion was a plausible complete user reply (example 10.12 failing).
- **Parser error count** — should be flat at zero.
- **Raw-markup escapes** — any instance of a visible tag is a P1. Should be structurally impossible; measure anyway.
- **Disable rate** — % of users who turn it off. The honest signal for whether this is noise.

---

## 15. Open questions

- **OQ1.** Should a chip clicked in an older message scroll the transcript, or silently insert and leave the view alone? Leaning silent-insert with the composer scrolled into view.
- **OQ2.** Should visited state persist across reload? Leaning no — the session store shouldn't carry UI ephemera.
- **OQ3.** What separator joins two consecutively-clicked suggestions? A space is the simplest; ", " reads better for lists; " and " is presumptuous. Leaning space, revisit with usage data.
- **OQ4.** Does the model see its own tags in context on subsequent turns? Currently yes (raw text is what's stored). This probably reinforces the pattern usefully, but should be measured — it may also cause over-emission.
- **OQ5.** Should suggestions be suppressed while the agent is mid-task (tool calls in flight) rather than at a natural stopping point? As things stand there's no signal to suppress *with*: `message_end` fires once per finalized assistant message, including ones that also carry `tool_use` blocks, and the extension listens for nothing else (`turn_start`, `tool_call`, `agent_end`). So a message that tags a suggestion *and* calls a tool in the same turn makes that chip addressable (Alt+N and click both) while the tool is still running in the background, and the system prompt gives the model no guidance against that pattern. Believed rare in practice — a model asking the user something while also invoking a tool is an odd shape — so left unaddressed rather than adding a listener for a case with no observed occurrence yet.
- **OQ6.** Should there be a "none of these, just typing" affordance, or is the composer itself sufficient? Strong prior: sufficient. Adding one reintroduces the picker.

---

## 16. Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Blocking `select()` tool | Forces a choice; wrong primitive for a convenience feature |
| Non-blocking tool + widget tray | Extra model round-trip; suggestions detached from their sentence |
| `<option>` as the tag name | Collides with real HTML that a coding agent handles constantly |
| Auto-send on click | Removes the edit step, which is where most of the value is; one misclick sends a wrong instruction to an agent with write access |
| Client-side suggestion generation (second model call) | Latency and cost for something the primary model already knows |
| Structured JSON sidecar instead of inline tags | Loses inline position, which is the whole point |
