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
- G4. Suggestions never block the agent turn or add a round-trip *to it*. (The second model of §17 runs after `message_end`, never during the turn, and never blocks anything on its result — see §17.)
- G5. Raw markup is never visible to the user in any web surface.
- G6. Degrades cleanly when the model misbehaves (unclosed tags, tags in code, no tags at all).
- G7. A question the primary model never tagged still gets suggested replies, from the second model of §17 — same chips, same numbering, same keyboard path, indistinguishable in the UI.

### Non-Goals

- NG1. **Not** auto-send on click. Insertion only. (Revisit in Phase 3 with an explicit modifier — see §13.)
- NG2. **Not** a permission or confirmation mechanism. Those stay with `ctx.ui.confirm`.
- NG3. **Not** a structured action system. A suggestion is plain text destined for the composer, nothing more. It cannot call tools, set flags, or change modes.
- NG4. **Not** required for the model to function. An agent that never emits a suggestion tag works exactly as it does today.
- NG5. ~~Terminal click support~~ *(originally descoped; implemented first via terminal mouse reporting, then re-implemented as terminal-resolved Ctrl+click, which replaced mouse reporting outright — see §12.1)*.

---

## 4. Background: why the web client

Two designs were considered and rejected before landing here.

**A blocking `suggest_snippet` tool.** The tool would call `ctx.ui.select()` and return the pick as the tool result. Structurally sound — the pause is real, not prompted — but it forces a choice from a menu, which is the opposite of "save the user some typing."

**A non-blocking tool that populates a widget.** Fixes the forcing, but a tool call doesn't end the turn: `execute()` returns, the result goes back to the model, and the loop continues. The model has to emit *another* message immediately after asking its question, producing a trailing "let me know what you'd like!" on every suggestion set. Also detaches the suggestion from its sentence.

**Inline markup in the assistant text** (this PRD) has neither problem. There is no tool call, so there is no round-trip and no control-flow risk. The suggestion sits exactly where the model made it.

The web client is the right surface because a rendered message is already a tree of DOM nodes. Attaching a click handler to a span is free. The terminal has no such tree: pi-tui parses input into keys and routes them to the focused component. Clicking there was first built with terminal mouse reporting plus hit-testing (§12.1, since removed), and now rides the terminal's own hyperlink resolution (§12.1a) instead.

---

## 5. Design

### 5.1 Wire format

The model emits a tag inside its normal prose:

```
Do you want me to <snippet>rebuild the solution</snippet> first?
```

**Why `<snippet>`.** The obvious choice, `<option>`, is a real HTML element. A coding agent reads, writes, and discusses files full of `<option>` tags every day. `<snippet>` is unlikely to appear in source code by accident, and if it does, §5.3 covers it.

The inserted text is always exactly the element's text content — what you see is what lands in the composer. Attributes on the tag are ignored.

### 5.2 Components

| Component | Responsibility |
|---|---|
| **Extension prompt snippet** | Teaches the model the tag and when to use it. Ships with the extension. |
| **Parser** | Turns raw assistant markdown into a token stream of `text` and `suggestion` nodes. Shared between web and TUI. Pure function, no state. |
| **Web renderer** | Renders suggestion nodes as `<button>` chips inside the message body. |
| **Composer integration** | Insert-at-cursor, focus management, undo. |
| **Suggestion state store** | Tracks which message is "live" for keyboard addressing. Fed by the message lifecycle — updated as suggestions complete mid-stream, and again when the message finalizes. |

**Hard rule: the parser is pure and the renderer is stateless.** Rendering may run many times per message — on stream ticks, on resize, on theme change, on scroll virtualization. Any state built during render will drift out of sync with what the user sees. The set of addressable suggestions is derived in the message lifecycle handlers (`message_update` while the model writes, `message_end` when it stops) and stored outside the render path — never built during rendering.


### 5.3 Sanitization rules

Applied by the parser, in order:

1. Content inside fenced code blocks (```) is never parsed for suggestion tags.
2. Content inside inline code spans (`` ` ``) is never parsed.
3. A `<snippet>` with no matching close tag before end-of-message is **not** rendered as a chip; its inner text is emitted as ordinary text and the opening tag is dropped. The rest of the message renders normally.
4. Nested `<snippet>` is invalid. The outer tag wins; inner tags are stripped as text.
5. Suggestion text is capped at 120 characters. Over the cap, the tag is discarded and the text rendered plainly.
6. Suggestion text is escaped as text content, never as HTML. A chip cannot inject markup.

---

## 6. Model-side contract

Shipped as the extension's prompt snippet. Should include worked positive and negative examples.

**Instructions to the model:**

- Wrap a span in `<snippet>...</snippet>` when the wrapped text would be a sensible, complete thing for the user to say back to you.
- Use it most when you have just asked a question with a small number of likely answers.
- Never emit the tag inside a code block, inline code span, file content, or diff.
- Never wrap text that isn't a plausible user utterance — don't wrap nouns, filenames, or fragments that only make sense in your sentence.
- Zero suggestions is normal and correct for most messages. Don't force them.
- Cap at ten suggestions per message.
- The user may ignore all of them. Never assume a suggestion was taken, and never write text that only makes sense if one is.

**Positive example given to the model:**

```
The build failed in three places. Want me to <snippet>fix them one at a
time</snippet>, or <snippet>show me all three errors first</snippet>?
```

**Negative examples given to the model:**

```
❌ I'll edit <snippet>src/main.rs</snippet> next.
   (A filename is not a user reply.)

❌ ```html
   <select><snippet>option A</snippet></select>
   ```
   (Never inside code.)

❌ Since you'll want to <snippet>rebuild</snippet>, I'll start now.
   (Don't suggest and then act as if it was chosen.)
```

---

## 7. Rendering spec

**Resting state.** A chip is visually distinct from surrounding prose but subordinate to it — a subtle tinted background, inherited font size and family, no shadow, no bold. It reads as part of the sentence, not as a call-to-action button. Line-height must not change; a paragraph with chips must not be taller than the same paragraph without.

**Hover.** Background tint deepens. Cursor becomes pointer. A small inline glyph (↵ or +) appears at the chip's trailing edge to signal insertion. Tooltip after 500ms: "Insert into message".

**Focus.** Standard focus ring, keyboard-reachable via Tab.

**Active/inserted.** Brief 150ms flash, then the chip returns to resting state and is marked visited (slightly dimmed) for the remainder of the session. Chips are not disabled after use — inserting the same suggestion twice is legitimate.

**Wrapping.** Chips must wrap across lines like normal text. A five-word suggestion at the end of a line breaks mid-chip; both fragments keep the background tint. No `white-space: nowrap`.

**Streaming.** While a message streams, a partially-received tag must never flash raw markup. Buffer from the first `<` that could begin `<snippet` until the token is resolved as either the tag or ordinary text. On resolution, render — and make it live. A chip goes live at exactly the moment it is painted, which is the moment its closing tag arrives; the rest of the message can keep streaming (or call tools) for a long time afterwards, and there is no reason to make the user wait it out. What is never live is a half-received suggestion: an unresolved `<snippet>` is neither painted nor addressable, so a chip can never insert a partial sentence.

A suggestion, once accepted, keeps its number for the life of the message — later text cannot un-accept it — so numbering never shifts under the user's fingers mid-stream. While a new assistant message is streaming, the previous message's chips stay addressable until the new one paints a chip of its own; the handover happens on that first chip, not when the message starts, so a long tool-calling turn does not strip the chips still on screen above it.

---

## 8. Interaction spec

| Action | Result |
|---|---|
| Click chip | Text inserted at composer cursor. Composer gains focus. Cursor lands at end of inserted text. |
| Click chip, composer already has content | Text inserted at cursor position, with a single space added before it if the preceding character isn't whitespace. Existing content is never replaced. |
| Click chip, text is selected in composer | Selection is replaced (standard insertion semantics). |
| Cmd/Ctrl+click chip | Insert **and** send. (Phase 3.) |
| Tab to chip, Enter | Same as click. |
| `Alt+1..9`, `Alt+0` | Insert the Nth suggestion (0 = tenth) of the most recent assistant message, streaming or finished. |
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
*Accept:* Chips in scrolled history remain live and clickable for the whole session — and across a restart of the pi process (`pi --session <file>` or `/resume`), not just within one. This takes two things, and the token alone is not enough: the socket path must be reproducible (the session-id token, §12.2), and the table the URL resolves against must be rebuilt for every repainted message when the session loads, not only for messages seen live.

### Epic B — Reading and comprehension

**B1.** As a user, I want to read the agent's message as normal prose, so that suggestions don't fragment the writing.
*Accept:* A message with chips is legible read aloud with no awkwardness; chips are grammatical continuations of the sentence.

**B2.** As a user, I never want to see `<snippet>` or any raw markup.
*Accept:* No web surface renders the literal tag, including mid-stream, on error, and on session restore.

**B3.** As a user, I want to be able to tell at a glance which parts of the message are clickable.
*Accept:* Chip styling is distinguishable from links, inline code, and bold at a normal reading distance.

**B4.** As a user, I don't want the layout to shift when a message finishes streaming.
*Accept:* A chip is drawn identically while the message streams and after it finalizes — nothing about finalization changes its dimensions.

**B5.** As a user, I want suggestions to feel optional, not like an unanswered form.
*Accept:* No badge, count, pulse, or persistent highlight that implies pending action.

### Epic C — Streaming and lifecycle

**C1.** As a user, I never want to see a half-written tag flicker on screen while the message streams.
*Accept:* Raw `<sni` is never painted. Buffering is invisible.

**C2.** As a user, I want to take a suggestion the moment I see it, without waiting for the model to stop writing.
*Accept:* A chip is addressable (`Alt+N` and click) in the same frame it is first painted, mid-stream, and stays addressable after the message finalizes.

**C3.** As a user, I don't want to trigger a suggestion that's still streaming and get partial text.
*Accept:* A `<snippet>` whose closing tag has not arrived is neither painted nor addressable — there is nothing to click and no number that reaches it. Only complete suggestions are insertable.

**C4.** As a user, if the agent's response is cancelled mid-sentence inside a tag, I want the message to still be readable.
*Accept:* Unclosed tag → inner text renders plainly, remaining message unaffected, no chip.

**C5.** As a user, I want a restored session to look exactly like the live one.
*Accept:* Reload → chips render and function identically. No re-parse artifacts.

### Epic D — Keyboard and accessibility

**D1.** As a keyboard user, I want to insert a suggestion without reaching for the mouse.
*Accept:* `Alt+1..9` and `Alt+0` (tenth) address the latest message's suggestions, whether it is still streaming or finished; holding Alt across two digits addresses 10 and above.

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
*Accept:* A message containing a literal `<snippet>` inside a fenced block renders it verbatim as code.

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
*Accept:* Chips become link-colored spans led by a superscript number; `Alt+N` inserts. (§12)

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

**H5.** As a user, I want to choose which of the two suggestion layers run, not just whether suggestions are on.
*Accept:* One setting, `mode`, with the four combinations — `off`, `tags` (layer 1 only), `both` (the default), `infer` (layer 2 only) — chosen from a `select` that `/snippets` → "Suggestions" opens. Four options rather than a switch and a sub-switch because the layers are independent and cost different things: layer 1 costs a system-prompt injection on every turn, layer 2 costs a request per question-bearing message. `infer` is the mode that buys chips without putting anything in the primary model's prompt — the injection *is* layer 1, so that mode skips it and the second model does all the tagging; tags the primary writes anyway are still painted, since a tag left unparsed would show up as raw markup. `off` does neither and paints nothing. Layer 2's model pin is stored separately from the mode, so standing the layer down and back up remembers which model it was pointed at. A `mode` a hand-edit made unrecognisable falls back to the default; a settings file from before the modes is read for its boolean `enabled: false` alone, which becomes `off` — silently turning suggestions back on for someone who had switched them off is the one migration worth the two lines.

**H4.** As a user, I want the choices I make in `/snippets` to still hold the next time I start pi.
*Accept:* The settings (`mode` — which layers run, see H5 — the hotkey toggle, and the second model's pin; click-to-insert stopped being a preference when clicking became always-on and terminal-resolved) are written to `~/.pi/agent/pi-snippet.json` — pi's agent directory, resolved as pi resolves it (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`), overridable outright with `PI_SNIPPET_SETTINGS` — as they are changed, and read back at load. pi exposes no settings or key-value API to extensions (`ExtensionAPI` has only `appendEntry()`, which is session-scoped and branch-aware, so it is the wrong shape for a preference); a JSON file beside pi's own `settings.json` is the convention its shipped `preset.ts` example follows. The file lives outside the session store — these are preferences about the tool, not state of one conversation, so a fork or a resume finds the same answer as a fresh start. A missing, malformed, or unreadable file falls back to defaults rather than failing to load; a write that fails leaves the toggle in force for the session and says so in the notification. `--no-suggestions` is a session override and never rewrites the stored preference. Global only, deliberately: a project-local override would have to decide which file a toggle writes back to, and picking wrong reproduces exactly the bug this story fixes.

---

## 10. Worked examples

### 10.1 Basic binary question

**Model emits:**
```
The refactor touched 14 files and everything compiles. Want me to
<snippet>rebuild the solution</snippet> or
<snippet>run the test suite</snippet> first?
```

**User sees:**
> The refactor touched 14 files and everything compiles. Want me to `rebuild the solution` or `run the test suite` first?

**User clicks "run the test suite".** Composer contains `run the test suite`, cursor at end, nothing sent.

---

### 10.2 Suggestion mid-sentence, single

**Model emits:**
```
I can't reproduce it locally. If you can
<snippet>paste the full stack trace</snippet> I'll take another look.
```

Reads naturally as prose. One chip. User pastes their trace after clicking, ending up with `paste the full stack trace` — then deletes it and pastes the actual trace, which is fine; the chip cost nothing.

*(This example is in the PRD deliberately: it's a case where the suggestion is mildly useless. That's acceptable. The failure mode of this feature is "ignored," not "harmful.")*

---

### 10.3 Four options, list form

**Model emits:**
```
Three tests fail for what look like three unrelated reasons. Pick a thread:

- <snippet>start with the auth test</snippet> — most likely a real bug
- <snippet>start with the timezone test</snippet> — probably environmental
- <snippet>start with the flaky socket test</snippet> — may just be timing
- <snippet>show me all three failures in full</snippet>
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
  <snippet>this is not a real tag</snippet>
</select>
```
````

**User sees:** the code block verbatim, tag and all, syntax-highlighted as HTML. No chip. This is the single most important negative case — a coding agent will hit it.

---

### 10.6 Unclosed tag from a cancelled response

**Model emits (stream aborted):**
```
Sure — want me to <snippet>rebuild the sol
```

**User sees:** > Sure — want me to rebuild the sol

No chip, no raw tag, no swallowed text.

---

### 10.7 Tag spanning stream chunks

**Chunks arrive as:** `Want me to <sn` / `ippet>rebuild</sni` / `ppet> now?`

**User sees, frame by frame:** `Want me to ` → `Want me to ` → `Want me to rebuild now?` with the chip appearing at resolution. At no point is `<sn` painted.

---

### 10.8 Combining two suggestions

**Model emits:**
```
I could <snippet>rebuild the solution</snippet> and then
<snippet>run the test suite</snippet>, or just do one.
```

**User clicks both.** Composer: `rebuild the solution run the test suite`. User edits to `rebuild the solution then run the test suite` and sends. Two clicks and three typed words replaced a full sentence.

---

### 10.9 Suggestion that gets ignored entirely

**Model emits:**
```
Want me to <snippet>revert the last commit</snippet>?
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
Next I'll edit <snippet>src/main.rs</snippet>.
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
| Empty content `<snippet></snippet>` | Dropped entirely |
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
| Tag split across stream chunks | Buffered, resolved, then painted — and addressable from that frame on |
| Suggestion completed mid-stream | Addressable immediately; the rest of the message keeps streaming |
| Parser throws | Fallback regex strip, message renders, error counted |
| Feature disabled | Tags stripped, plain text, no chips |

---

## 12. TUI parity

The parser is shared. The terminal path uses pi's markdown transformer hook, which receives assistant text (and an `isStreaming` flag distinguishing partial updates from finalized and restored messages) and returns markdown that pi's built-in renderer then draws.

Consequences of that hook returning *markdown* rather than components:

- Where the terminal paints OSC 8 hyperlinks, chips render as markdown links in the theme's link color, led by a small superscript number: `Want me to [¹rebuild the solution](pisnip://…) or [²run the tests](pisnip://…)?` — and the URL is load-bearing (§12.1). Where the terminal paints no hyperlinks, there is no link at all: the bare `¹rebuild the solution` label, since pi-tui prints any href it cannot emit as OSC 8 in visible parens, and a URL that resolves no click is noise.
- There is no hover. Click (§12.1) and `Alt+N` (§12.2) are the affordances.
- The transformer must stay pure — the addressable set is derived in the `message_update` and `message_end` handlers and held in extension state, never built during transformation.
- Scrolled-away suggestions remain hotkey-addressable but invisible. Only the most recent message is addressable, to avoid `2` meaning two different things.

### 12.1 Click to insert

*Vacated in this form.* Clicking was first built here with terminal mouse
reporting (DECSET 1000 + SGR 1006) plus text hit-testing — DSR-anchored
screen-to-buffer mapping, a glyph-width table, a `/snippets` toggle because
mouse mode took the wheel and selection hostage. All of it went with the mode:
the terminal that paints a chip already knows which cells belong to it, so
§12.1a hands hit-testing back and keeps nothing.

### 12.1a Click without mouse mode (Linux)

Mouse reporting buys clicking at the price of a terminal-wide mode. Where the
terminal supports OSC 8 hyperlinks it already knows which cells belong to a
chip — it has to, to underline one under the pointer — so the second delivery
path hands the click back to it:

- A chip's href stops being inert and becomes `pisnip://<token>/<msg>/<id>`.
  pi-tui paints it into an OSC 8 hyperlink, Ghostty resolves Ctrl+click
  (`ctrlOrSuper`, no other modifier), and the desktop dispatches the URL to a
  handler registered once per machine, which forwards it to a per-session unix
  socket the extension listens on.
- `<token>` is pi's own session id (hashed to the socket-safe shape the
  handler's `isalnum()` check requires), not a value drawn fresh per launch.
  A session id survives `/resume`, so a chip painted before a restart still
  names a socket the resumed process rebinds — falling back to a random
  token disambiguates a session with no id, at the old cost: that chip dies
  with the process. Keying on the working directory instead was considered
  and rejected: two sessions open in the same project is an ordinary thing to
  do, and directory-keying would make the second one's clicks land in the
  first one's composer instead of failing openly.
  A reproducible socket path is necessary but not sufficient: the restart
  must also rebuild the resolver table. `pi --session <file>` fires
  `session_start` with `reason: "startup"` — `"resume"` is only for /resume
  inside a running process — so hydration runs on both, and it indexes every
  assistant message in the branch, since pi repaints them all and each carries
  the URL it had before (messageKey and the token are both deterministic).
- **No terminal-wide mode, and no fallback.** The wheel keeps scrolling the
  terminal's own scrollback and selection needs no Shift, which is the entire
  cost this removes. There is exactly one delivery path: a terminal that
  cannot paint hyperlinks gets the bare label and no clicking, and over SSH
  the click is dispatched on the local desktop, where no socket for the remote
  session exists — so it fails openly rather than inserting into the wrong
  composer.
- **The URL carries an index, never text**, so nothing reaching the socket can
  put words in the composer that the model did not write; and it is **keyed by
  message**, so a chip clicked in old scrollback still resolves to what it
  meant rather than to the current message's Nth suggestion. That widens
  §12.1 deliberately: digits stay latest-message-only because a number must
  not mean two things, while a URL is unambiguous.
- **This is the default.** Click-to-insert used to be off by default, and the
  reason was entirely mouse mode's cost; link mode removes that cost, so the
  reason went with it. Two guards keep the default honest: link mode paints no
  URL where the terminal cannot render a hyperlink (so `(pisnip://…)` can never
  trail a chip), and it never silently falls back to mouse reporting — a
  terminal that cannot paint a hyperlink gets no clicking, rather than a
  terminal-wide mode nobody asked for. `H4` still applies: the choice persists.
- Registration is a `/snippets` action and is only believed when a probe URL
  completes the whole round trip; until then, Ctrl+click fails openly. A fresh
  install says so once, when chips first appear and everything else is ready.
  Linux only for now — on macOS Ghostty routes OSC 8 through a safe-open policy
  that puts a confirmation dialog in front of every custom-scheme click.

Support on terminals other than Ghostty — gnome-terminal in particular — is
catalogued in `docs/linux-terminals.md`. Design, measurements and open items:
`docs/terminal-resolved-clicks.md`.

**Over SSH** the delivery path inverts: the click is resolved on the machine
in front of the user, whose desktop has no socket for this session — the
socket lives here. Without an explicit opt-in the chips therefore paint as
bare labels (`Alt+N` still works — it is in-band), and `/snippets` offers
*Remote clicking*: session-scoped, it paints URLs again and puts the
`ssh -L` command that forwards this session's socket to the client into the
composer, verified by the user's own first click. `docs/ssh-back-handler.md` designs the
zero-setup successor — a client-side handler that relays unresolvable clicks
back over SSH — which removes the per-session forward at the cost of a
one-time client configuration.

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

*Vacated.* This section existed for mouse hit-testing, which turned a character
index into a screen column and needed a glyph-width table matching the
terminal's exactly (a hand-written one was wrong for 1171 codepoints). With
terminal-resolved clicks the terminal does the hit-testing, the table is gone,
and nothing in the extension needs to agree with the terminal about widths.
History in git.

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
- **OQ5.** Should suggestions be suppressed while the agent is mid-task (tool calls in flight) rather than at a natural stopping point? Mid-stream addressing (§7) makes this concrete rather than incidental: a chip goes live as soon as it is written, so a message that tags a suggestion *and* then calls a tool offers that chip while the tool is still running — deliberately, since the alternative is making the user wait out work they were just asked about. The extension now listens to `message_start` and `message_update` as well as `message_end`, so a suppression signal (`tool_call`, `turn_start`) would be cheap to add if this ever reads wrong. The system prompt still gives the model no guidance against the pattern, and no bad case has been observed.
- **OQ6.** Should there be a "none of these, just typing" affordance, or is the composer itself sufficient? Strong prior: sufficient. Adding one reintroduces the picker.

---

## 16. Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Blocking `select()` tool | Forces a choice; wrong primitive for a convenience feature |
| Non-blocking tool + widget tray | Extra model round-trip; suggestions detached from their sentence |
| `<option>` as the tag name | Collides with real HTML that a coding agent handles constantly |
| Auto-send on click | Removes the edit step, which is where most of the value is; one misclick sends a wrong instruction to an agent with write access |
| Client-side suggestion generation (second model call), *as a replacement for inline tags* | Latency and cost for something the primary model already knows. **Reversed in part, then reversed back, then restored in a new shape** — adopted as the §17 fallback, removed with §17, and returned (§17) as an *enhancement* of inline tags rather than a replacement: the second model now re-emits the message with `<snippet>` tags, producing first-class chips, not a second-class sidecar. |
| Structured JSON sidecar instead of inline tags | Loses inline position, which is the whole point |

---
## 17. The second model (restored, reshaped)

An earlier version of this section described an inference layer that was removed
outright. It is back, in a different shape, because the reasons it was removed
no longer hold: the model costs about four hundredths of a cent per thousand
messages, and its chips are no longer second-class.

**What it does.** When an assistant message ends, a small fixed model —
OpenRouter's `qwen/qwen3.7-flash`, pinned in `extension/infer.ts`;
`PI_SNIPPET_MODEL` overrides — receives the message as
stored, layer-1 tags included, and re-emits it character-for-character with
more `<snippet>` tags added around the spans the user could plausibly send
back. It is told to leave the tags it received exactly where they are; any tag
it echoes anyway matches a chip layer 1 already paints and is dropped at
validation time. The wrapped text itself is the reply, exactly as in layer 1.

**What the user sees.** Nothing new. The anchors are located verbatim in the
stored message and painted as ordinary chips — numbered, Alt+N addressable,
click-to-insert — merged into the same numbering as the tagged ones. Nothing in
the UI distinguishes which layer painted a chip, and the stored transcript is
never rewritten; the anchors live in extension state and die with the session.

**Numbering is by layer, then by arrival — never by document position.**
Layer-1 chips number first, in document order (which is also the order their
tags closed while streaming); layer-2 anchors number after all of them, in the
order the second model emitted them. The anchors arrive one at a time after
the message is on screen, so an anchor landing *before* an existing chip in
the text must not push that chip's superscript off the number the user already
saw. The painted order can therefore differ from the numbered order — ³ may
sit left of ² — and that is the trade working as intended.

**Render wiring (two ways this layer has actually broken).** The transformer
is handed one trimmed text block at a time and looks its anchors up by the
hash of exactly what it was handed, so the anchors are indexed under every
form of the message — each block raw and trimmed, and the joined text — not
just under the joined text. And because the transformer runs inside pi-tui's
render, a finished message's Markdown component caches its output on (text,
width): when an anchor lands, the components must be invalidated before
`requestRender`, or the render loop walks straight back into the caches and
the new chip stays invisible. (Layer 1 never needs the invalidate — pi
rebuilds the message component on every `message_update` while streaming.)

**The rules it keeps from the removed layer** (still the right rules):

- **Verbatim or nothing.** A tag whose content is not verbatim in the
  message's non-code text is dropped, not repaired. Paraphrase costs a chip,
  never produces a wrong one.
- **Cache by message text.** A resize, a re-render, a `/tree` walk back to a
  message never pays twice.
- **Stand down on dead credentials.** `hasConfiguredAuth()` says configured,
  not working; three consecutive failures stop the layer for the session.
- **Never surface a failure in the message.** No auth, a timeout, tag soup —
  the message gains no error markup and no wrong chips, exactly as if the
  layer were off. The one visible trace is the footer status (below), which
  exists precisely because the message cannot carry the news.

**What changed from the removed layer:** the model defaults to a fixed choice
but is a preference now — `inferModel` in the settings file, typed as a
`provider/id` and validated against the registry at entry time (a picker was
tried and removed — the catalogue is hundreds of models long, unusable as a
menu). Entry is `/snippets model`, a subcommand whose
`getArgumentCompletions` tab-completes against the registry with pi's own
fuzzy matcher (`@earendil-works/pi-tui`'s `fuzzyFilter`, bundled at build
time, not a runtime dependency — the same one `/model` itself uses), because
`ui.input()` — the blocking dialog `/snippets` → "Second model" used to open
directly — has no autocomplete in `ExtensionUIContext` at all; only a slash
command's own argument completions get pi's dropdown. (It was a standalone
`/snippet-model` command at first; folded into `/snippets` as a subcommand
because two top-level commands for one feature was the annoyance — pi passes
a slash command's `getArgumentCompletions` everything typed after the command
name, so `model` is just the first word of that string, matched and stripped
by hand.) In the TUI, that menu entry now prefills `/snippets model <current
pin>` in the composer and hands focus back rather than opening the dialog;
outside the TUI (RPC, print, where there is no composer to prefill) it still
opens the old typed prompt. With
`PI_SNIPPET_MODEL` as a session-level override above it (the key is named
`inferModel`, not `model`, so a stale pin from the removed layer stays dead);
there is no per-message cap on its tags (more options are better than fewer;
only the runaway guard of 99 total per message applies); its chips are
first-class, so no anchor/reply JSON — the tag re-emit is the whole protocol;
and it runs on every question-bearing message, seeing the tags layer 1 already
painted so it adds to them rather than restarting from a blind position.

**Cost control.** The gate is a question mark outside code (`asksSomething`):
a status update pays nothing. The call goes out at `message_end`, streams via
the provider's `streamSimple`, and each anchor becomes a chip as its closing
tag arrives — chips light up while the second model is still writing.

**Cheap beats free.** The default was OpenRouter's free nemotron until a
live run showed why free is the wrong axis: OpenRouter meters free models per
*account per day*, so after fifty calls every request 429s for the rest of the
day — and this layer surfaces no failure, so the user sees a feature that
quietly stopped working. `qwen/qwen3.7-flash` costs about $0.00004 per call
(a few hundred tokens in, a hundred out) and has no such ceiling.

**The call carries the session's credentials.** `getProvider()` returns a
bare transport that knows its base URL and nothing about auth, so the key and
headers are fetched per call from the registry (`getApiKeyAndHeaders`) and
passed in the call options. Without them the request dies locally with "No API
key for provider: …" before reaching the network — which this layer swallows
like any other failure, so the symptom is a second model that never adds a
chip and never says why.

**The footer line.** The built-in footer carries one extension status
(`ctx.ui.setStatus("pi-snippet", …)`) saying where the layer stands for the
message on screen: `snippet: not sent` while the primary streams or the gate
said no, `snippet: sent (waiting)` while the reply streams, and then the
report — `snippet: 2 new chips` — counted live as the anchors land, zero
included when a reply genuinely arrived and added nothing. A request that got
no answer says `snippet: second model failed` — it was asked; "not sent"
would credit the layer with a decision it never made.

When there is no second model to call at all — nothing resolves, the model
that does resolve has no configured auth, or three consecutive failures have
stood the layer down — the line says `snippet: second model unavailable`
instead, checked before the question-mark gate because it is a condition of
the session rather than of the message. The two failure lines exist because
all three otherwise look identical from outside: a session whose second model
cannot run would report `not sent` after every question it ever asked,
reading as a working layer that keeps declining. The reason itself is still
never shown — only that there wasn't one.

**Testing.** Fixed strings only: the engine and the contract are tested
against canned replies through a fake registry (`test/inferred.test.ts`,
`test/infer-engine.test.ts`). No test makes a live model call.

The design of the *removed* layer remains in git history (PRD §17 as of before
the removal, plus `src/extension/magic.ts` and `src/shared/inferred.ts`);
`magic.ts` is still the reference for model-picking heuristics if the fixed
model ever needs to become a choice again.
