# pi-clik

Inline suggestion snippets for [pi](https://github.com/badlogic/pi-mono). The model marks spans of its own prose as *suggested user replies* by wrapping them in `<pi:suggest>…</pi:suggest>`; the client renders those spans so you can insert them into the composer with a click or a keystroke. Inserting never sends — you can edit the text, add to it, or ignore it.

Two surfaces share one parser and one prompt: a **web client** (server + browser) and a **TUI extension** for pi's normal terminal UI. See [PRD.md](./PRD.md) for the full spec and the reasoning behind the design.

What the model writes:

```
Want me to <pi:suggest>rebuild the solution</pi:suggest> or <pi:suggest>run the tests</pi:suggest>?
```

What you see — in the browser, two clickable chips inline in the sentence; in the terminal, bold accent-colored spans led by a small superscript number:

```
Want me to ¹rebuild the solution or ²run the tests?
```

## Build

```bash
npm install
npm run build     # bundles the web client, the server, and both extensions into dist/
```

## Web client

```bash
node bin/pi-clik.js              # serves on :3141 and opens a browser
```

The server spawns `pi --mode rpc` in the working directory with the pi-clik extension loaded, and bridges pi's JSONL protocol to the browser over a WebSocket.

```
pi-clik [--port 3141] [--cwd dir] [--pi-bin pi] [--no-open] [--isolate] [-- <extra pi args>]
```

Extra pi args pass through: `node bin/pi-clik.js -- --model claude-haiku-4-5 --no-session`.

In the browser, chips are inert while a message is still streaming and become clickable when it finalizes. Clicking inserts at the cursor with sensible spacing, focuses the composer, and leaves a single undo step — `Ctrl+Z` removes the whole insertion, not one character at a time. `Alt+N` inserts the Nth suggestion of the most recent finalized message (chips carry no visible number in the browser; they count left to right through the message). Two checkboxes, persisted in `localStorage`, turn chips or the hotkeys off. Chips you have used are marked as visited, in memory only — a reload forgets them.

## TUI

The same feature in pi's terminal UI, no server involved:

```bash
pi -e /path/to/pi-clik/dist/extension/pi-clik-tui.js
```

Install it permanently with `pi install /path/to/pi-clik/dist/extension/pi-clik-tui.js`, or keep passing `-e` per run.

Suggestions render through pi's markdown transformer hook, which is **display-only**: stored messages keep their raw `<pi:suggest>` tags, so a session stays readable by the web client and anything else that consumes the transcript.

- **Click a chip** to insert it. Mouse reporting is a terminal-wide mode, so it is engaged only while the latest message actually has suggestions; during that window the scroll wheel belongs to pi and text selection needs Shift held.
- **`Alt+N`** inserts the Nth suggestion of the most recent finalized message — only that message is addressable, so a number never means two things. Ten digit keys address ten suggestions; beyond that, hold Alt and type two digits (Alt held across `1` then `2` inserts the twelfth). A single digit commits immediately unless a longer number is still reachable, so the brief wait only exists on a message with ten or more suggestions. `Alt+0` still means the tenth.
- **`/suggestions`** toggles three things independently: the feature, the `Alt` shortcuts, and click-to-insert. `--no-suggestions` disables everything for a session.

## How it works

| Piece | File | Role |
|---|---|---|
| Parser | `src/shared/suggestions.ts` | Pure function: raw assistant markdown → text/suggestion token stream. Holds every sanitization rule (code fences, inline code, unclosed and nested tags, blank-line spans, the 120-character length cap, the per-message cap) plus `visibleStreamingPrefix()`, so a partial tag is never painted mid-stream. |
| Prompt snippet | `src/shared/prompt-snippet.ts` | The model-side contract: when to emit a tag, with worked good and bad examples. |
| Digit addressing | `src/shared/digit-chord.ts` | Pure rules for turning typed digits into a suggestion number, shared by both surfaces. |
| TUI markdown | `src/shared/tui-markdown.ts` | Suggestion nodes → `**\`¹text\`**`, which pi paints as bold text in the inline-code accent color. |
| Extensions | `src/extension/pi-clik.ts`, `pi-clik-tui.ts`, `common.ts` | The web variant only injects the prompt snippet; the TUI variant adds the transformer, the shortcuts, and click handling. Injection goes through both the chained `systemPrompt` return (direct providers) and `systemPromptOptions.appendSystemPrompt` (bridges like pi-claude-bridge, which rebuild their own prompt and ignore the former). |
| Terminal clicking | `src/extension/tui-mouse.ts` | SGR mouse reporting plus hit-testing against the rendered text. Screen rows are mapped to buffer lines using a cursor-position report, because pi never clears the screen and its first line is wherever your shell prompt was. |
| Glyph widths | `src/extension/char-width.ts` | Generated, not hand-written — see below. |
| Web renderer | `src/web/chips.ts` | Stateless: parse → markdown with private-use sentinels → `marked` with raw HTML escaped → DOM walk replacing sentinels with `<button class="chip">`. Chip text is set via `textContent`, so suggestion content can never inject markup. A chip inside a link label degrades to text; the link wins. |
| Composer | `src/web/composer.ts` | Insert-at-cursor with spacing rules, via `execCommand("insertText")` so undo treats it as one unit. |
| App | `src/web/main.ts` | WebSocket client, streaming accumulation, message list, hotkeys, settings, visited state, session restore on reload. |
| Server | `src/server/server.ts` | Spawns pi in RPC mode, serves the client, bridges JSONL ⇄ WebSocket verbatim. |

The parser is pure and the renderers are stateless: the set of addressable suggestions is derived once, when a message finalizes, and kept outside the render path. Rendering runs on every stream tick and resize, so anything stateful built there would drift from what you see.

### Caps

`MAX_SUGGESTION_LENGTH` (120 characters) and `MAX_SUGGESTIONS_PER_MESSAGE` (99) are runaway guards, not style rules — 99 is simply what two-digit `Alt` addressing can reach. What the model is actually told is `SUGGESTED_PER_MESSAGE`: two to four is normal, ten is a lot. Over-cap suggestions degrade to plain text rather than disappearing.

### Global-extension conflicts

The server uses pi's normal extension discovery. If a globally installed extension mangles the tags — for instance one that rewrites `<pi:suggest>` spans in *stored* messages at `message_end` — start with `--isolate`: pi then runs with `--no-extensions` plus only the extension packages listed in `~/.pi/agent/settings.json` (so provider bridges keep working) and pi-clik.

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
- **"Commit on Alt release" is not available in the terminal.** At the Kitty keyboard flags pi requests (7), Ghostty encodes a standalone Alt press or release as no bytes at all; modifier events need flag 8. The TUI therefore settles a two-digit chord on a short timeout, and the release watcher stays dormant. The browser gets a real `keyup` and commits the moment Alt lifts.

The two Python harnesses drive a real `pi` under a pty with a small terminal emulator (tracking a grid, answering cursor-position queries) and assert what lands in the editor. They need `pi` with a working provider; the Ghostty helpers are optional, and `chord-live.py` falls back to legacy key encodings without them.

## Tests

```bash
npm test          # 120 unit/DOM/integration tests
npm run check     # tsc --noEmit
npm run test:e2e  # live, against a real model through pi RPC
```

The unit suite covers the parser edge-case matrix, the web renderer and composer against a DOM, the app against a fake WebSocket, the TUI transformer, digit addressing, and terminal hit-testing against a stand-in TUI.

The e2e test spawns pi exactly as the server does, asks a question with two obvious answers, and asserts the model emits well-formed tags the parser accepts — and that a plain informational question draws none. Configure with `PI_CLIK_TEST_PROVIDER` and `PI_CLIK_TEST_MODEL` (defaults `claude-bridge` and `claude-haiku-4-5`).

## Known limits

- `pi -p` (print mode) with the claude-bridge provider hangs on this machine and has to be killed. RPC mode, which pi-clik uses everywhere including tests, is unaffected.
- Visited-chip state is in-memory and resets on reload (PRD OQ2).
- Not implemented from PRD Phase 3: Cmd/Ctrl+click to insert **and** send, and surfacing suggestions in export/JSON modes. The other Phase 3 items — visited state and the TUI transformer path — did ship.
