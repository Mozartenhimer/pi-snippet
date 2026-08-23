# Human generated content
 The idea here is that the questionaire type things are too limited, and I found myself copy and pasting content into my answer. Why can't the LLM make that a bit easier by suggesting snippets that might be good replies? See Human Compatible by Stuart Russell. 

So that's what this does.

An earlier version also had a web UI, but the best interface is the TUI for me at the moment. Mostly since it doesn't change my workflow now.

Below is what the machine created. Fable 5 did the initial design costing about 93 $ in credits, refinement with opus 5 and sonnet 5.

# pi-snippet

Inline suggestion snippets for [pi](https://github.com/earendil-works/pi-mono). The model marks spans of its own prose as *suggested user replies* by wrapping them in `<snippet>…</snippet>`; the extension renders those spans in pi's terminal UI so you can insert them into the composer with a click or a keystroke. Inserting never sends — you can edit the text, add to it, or ignore it.

What the model writes:

```
Want me to <snippet>rebuild the solution</snippet> or <snippet>run the tests</snippet>?
```

What you see in the terminal — link-styled text led by a small superscript number. The transformer's actual output is a markdown link (`[¹rebuild the solution](chip:1)`) whose URL is inert and never navigated; GitHub's sanitizer strips the `href` from that `chip:` scheme entirely, so the examples below use plain `#N` anchors instead, purely so this page renders them link-styled the way the terminal does:

Want me to [¹rebuild the solution](#1) or [²run the tests](#2)?

More than ten in one message still each get their own number, and `Alt` addresses all of them (see below):

- [¹check the logs](#1)
- [²clear the cache](#2)
- [³restart the server](#3)
- [⁴roll back the deploy](#4)
- [⁵grep the error](#5)
- [⁶bump the version](#6)
- [⁷open a ticket](#7)
- [⁸ping the on-call](#8)
- [⁹skip for now](#9)
- [¹⁰rerun the pipeline](#10)
- [¹¹diff the config](#11)

## Build

```bash
npm install
npm run build     # bundles the TUI extension into dist/
```

## TUI

```bash
pi -e /path/to/pi-snippet/dist/extension/pi-snippet-tui.js
```

Install it permanently with `pi install /path/to/pi-snippet/dist/extension/pi-snippet-tui.js`, or keep passing `-e` per run.

Suggestions render through pi's markdown transformer hook, which is **display-only**: stored messages keep their raw `<snippet>` tags, so a session stays readable by anything else that consumes the transcript.

- **Click a chip** to insert it. Mouse reporting is a terminal-wide mode, so it is engaged only while the latest message actually has suggestions; during that window the scroll wheel belongs to pi and text selection needs Shift held.
- **`Alt+N`** inserts the Nth suggestion of the most recent finalized message — only that message is addressable, so a number never means two things. Ten digit keys address ten suggestions; **beyond ten**, hold Alt and type two digits (Alt held across `1` then `2` inserts the twelfth). A single digit commits immediately unless a longer number is still reachable, so the brief wait only exists on a message with ten or more suggestions. `Alt+0` still means the tenth. The cap is 99 — see below.
- **`/snippets`** toggles three things independently: the feature, the `Alt` shortcuts, and click-to-insert. `--no-suggestions` disables everything for a session.

## How it works

| Piece | File | Role |
|---|---|---|
| Parser | `src/shared/suggestions.ts` | Pure function: raw assistant markdown → text/suggestion token stream. Holds every sanitization rule (code fences, inline code, unclosed and nested tags, blank-line spans, the 120-character length cap, the per-message cap) plus `visibleStreamingPrefix()`, so a partial tag is never painted mid-stream. |
| Prompt snippet | `src/shared/prompt-snippet.ts` | The model-side contract: when to emit a tag, with worked good and bad examples. |
| Digit addressing | `src/shared/digit-chord.ts` | Pure rules for turning typed digits into a suggestion number. |
| TUI markdown | `src/shared/tui-markdown.ts` | Suggestion nodes → `[¹text](chip:N)`, which pi paints as link-colored text; the `chip:N` URL is inert and never navigated. |
| Extension | `src/extension/pi-snippet-tui.ts`, `common.ts` | Injects the prompt snippet, installs the markdown transformer, and wires up the `Alt+N` shortcuts and click handling. Injection goes through both the chained `systemPrompt` return (direct providers) and `systemPromptOptions.appendSystemPrompt` (bridges like pi-claude-bridge, which rebuild their own prompt and ignore the former). |
| Terminal clicking | `src/extension/tui-mouse.ts` | SGR mouse reporting plus hit-testing against the rendered text. Screen rows are mapped to buffer lines using a cursor-position report, because pi never clears the screen and its first line is wherever your shell prompt was. |
| Glyph widths | `src/extension/char-width.ts` | Generated, not hand-written — see below. |

The parser is pure and the transformer is stateless: the set of addressable suggestions is derived once, when a message finalizes, and kept outside the render path. Rendering runs on every stream tick and resize, so anything stateful built there would drift from what you see.

### Caps

`MAX_SUGGESTION_LENGTH` (120 characters) and `MAX_SUGGESTIONS_PER_MESSAGE` (99) are runaway guards, not style rules — 99 is simply what two-digit `Alt` addressing can reach. Over-cap suggestions degrade to plain text rather than disappearing.

## Ground truth from a real terminal

Two things here cannot be honestly guessed: the bytes a terminal sends for a key gesture, and how many cells a glyph occupies. Both come from Ghostty's own library (`libghostty-vt`, shipped with the Ghostty snap) rather than from a hand-written table.

```bash
bash scripts/ghostty-env.sh            # locate libghostty-vt, build the helpers
npm run check:widths                   # our width table vs Ghostty's, codepoint by codepoint
npm run gen:widths                     # regenerate src/extension/char-width.ts from it
python3 scripts/chord-live.py          # Alt+digit gestures, keystrokes encoded by Ghostty
python3 scripts/click-offset-repro.py  # clicking, with pi launched mid-screen
```

Two findings worth keeping in mind:

- **A hand-written width table was wrong on 1171 codepoints**, including double-width emoji outside `U+1F300..1F9FF` (⌚, ⏩, ⚡) and non-Latin combining marks. Each one would shift every later chip on its line by a column and make clicks miss, so `char-width.ts` is generated from `ghostty::CodepointWidth` and checked.
- **"Commit on Alt release" is not available in the terminal.** At the Kitty keyboard flags pi requests (7), Ghostty encodes a standalone Alt press or release as no bytes at all; modifier events need flag 8. The extension therefore settles a two-digit chord on a short timeout, and the release watcher stays dormant.

The two Python harnesses drive a real `pi` under a pty with a small terminal emulator (tracking a grid, answering cursor-position queries) and assert what lands in the editor. They need `pi` with a working provider; the Ghostty helpers are optional, and `chord-live.py` falls back to legacy key encodings without them.

## Tests

```bash
npm test          # unit and integration tests
npm run check     # tsc --noEmit
npm run test:e2e  # live, against a real model through pi RPC
```

The unit suite covers the parser edge-case matrix, the TUI transformer, digit addressing, and terminal hit-testing against a stand-in TUI.

The e2e test spawns pi in RPC mode with the extension loaded, asks a question with two obvious answers, and asserts the model emits well-formed tags the parser accepts — and that a plain informational question draws none. Configure with `PI_SNIPPET_TEST_PROVIDER` and `PI_SNIPPET_TEST_MODEL` (defaults `claude-bridge` and `claude-haiku-4-5`).

## Known limits

- `pi -p` (print mode) with the claude-bridge provider hangs on this machine and has to be killed. RPC mode, which the e2e test uses, is unaffected.
- Not implemented from PRD Phase 3: surfacing suggestions in export/JSON modes.
