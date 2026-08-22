# pi-clik

Inline suggestion snippets for [pi](https://github.com/badlogic/pi-mono): a web UI where the model marks spans of its own prose as *suggested user replies*, rendered as clickable chips. Clicking a chip inserts its text into the composer — it never sends. See [PRD.md](./PRD.md) for the full spec.

```
Agent:  Which do you prefer — [rename the function] or [leave it as is]?
```

## Run

```bash
npm install
npm run build
node bin/pi-clik.js            # starts server on :3141, opens the browser
```

The server spawns `pi --mode rpc` in the current directory with the pi-clik extension loaded and bridges the RPC protocol to the browser over a WebSocket. Options:

```
pi-clik [--port 3141] [--cwd dir] [--pi-bin pi] [--no-open] [--isolate] [-- <extra pi args>]
```

Extra pi args pass through, e.g. `node bin/pi-clik.js -- --model claude-haiku-4-5 --no-session`.

## TUI variant

The same feature works in the plain pi terminal UI, no server needed:

```bash
pi -e /path/to/pi-clik/dist/extension/pi-clik-tui.js
```

Suggestions render as bold accent-colored spans led by a small superscript number — `Want me to ¹rebuild the solution or ²run the tests?` — via pi's markdown transformer hook, which is display-only: stored messages keep their raw `<pi:suggest>` tags, so sessions stay compatible with the web client. `Alt+N` inserts the Nth suggestion of the most recent finalized assistant message into the editor (only that message is addressable). Ten digit keys address ten suggestions; for more, hold Alt and type two digits — `Alt` held while pressing `1` then `2` inserts the twelfth. A single digit commits immediately unless a longer number is still reachable, so the two-digit wait only exists when the message really has ten or more suggestions. `/suggestions` toggles the feature or just the hotkeys; `--no-suggestions` disables it for a session. **Clicking a chip inserts it too**: terminal mouse reporting is engaged automatically while the latest message has suggestions (during that window the wheel belongs to pi and text selection needs Shift), and `/suggestions` can turn click-to-insert off. Install globally with `pi install` pointing at the built file, or pass `-e` per run.

## How it works

| Piece | File | Role |
|---|---|---|
| Parser | `src/shared/suggestions.ts` | Pure function: raw assistant markdown → text/suggestion token stream. All sanitization rules (code fences, inline code, unclosed/nested tags, 120-char cap, 10-per-message cap) plus `visibleStreamingPrefix()` so partial tags are never painted mid-stream. |
| Prompt snippet | `src/shared/prompt-snippet.ts` | The model-side contract (when to emit `<pi:suggest>`, worked good/bad examples). |
| Extension | `src/extension/pi-clik.ts` | pi extension appending the snippet to the system prompt. Injects via both the chained `systemPrompt` return (direct providers) and `systemPromptOptions.appendSystemPrompt` (provider bridges like pi-claude-bridge that rebuild their own prompt). |
| Web renderer | `src/web/chips.ts` | Stateless: parse → markdown with private-use sentinels → `marked` (raw HTML escaped) → DOM walk replacing sentinels with `<button class="chip">`. Chip text is set via `textContent`, so content can never inject markup. Chips inside link labels degrade to text (link wins). |
| Composer | `src/web/composer.ts` | Insert-at-cursor with smart spacing; `execCommand("insertText")` so Ctrl+Z undoes an insertion as one unit. |
| App | `src/web/main.ts` | WebSocket client, streaming accumulation, message list, Alt+N hotkeys (multi-digit), settings toggles (chips / hotkeys, persisted in localStorage), visited state. |
| Server | `src/server/server.ts` | Spawns pi RPC, serves the client, bridges JSONL ⇄ WebSocket verbatim. |

Chips are inert while a message streams and become clickable when it finalizes. The hotkey-addressable set is derived once per finalized message, outside the render path.

### Global-extension conflicts

The server uses pi's normal extension discovery. If a globally installed extension interferes with the suggestion tags — e.g. a TUI suggestion extension that rewrites `<pi:suggest>` spans in stored messages into bracket form at `message_end` — run with `--isolate`: pi then starts with `--no-extensions` and only the extension packages from `~/.pi/agent/settings.json` (provider bridges keep working) plus pi-clik are loaded.

## Testing against a real terminal

Two parts of this feature cannot be honestly faked: what bytes a terminal sends
for a key gesture, and how many cells a glyph occupies. Both are answered by
linking Ghostty's own library (`libghostty-vt`, shipped with the Ghostty snap):

```bash
bash scripts/ghostty-env.sh      # locate libghostty-vt, build the helpers
npm run check:widths             # our width table vs Ghostty's, codepoint by codepoint
npm run gen:widths               # regenerate src/extension/char-width.ts from it
python3 scripts/chord-live.py    # Alt+digit gestures, keystrokes encoded by Ghostty
python3 scripts/click-offset-repro.py  # clicking with pi started mid-screen
```

The two Python harnesses drive a real `pi` under a pty with a small terminal
emulator (they answer cursor-position queries, track a grid) and assert what
lands in the editor. They need `pi` with a working provider; the Ghostty
helpers are optional and the chord harness falls back to legacy key encodings
without them.

## Tests

```bash
npm test          # 66 unit/DOM/integration tests (parser matrix, renderer, composer, app)
npm run test:e2e  # live end-to-end against Claude Haiku 4.5 through pi RPC
```

The e2e test spawns pi exactly as the server does, asks a two-option question, and asserts the model emits well-formed tags our parser accepts — and that a plain informational answer contains none. Configure with `PI_CLIK_TEST_PROVIDER` / `PI_CLIK_TEST_MODEL` (defaults: `claude-bridge` / `claude-haiku-4-5`).

## Known notes

- `pi -p` (print mode) with claude-bridge intermittently fails to exit on this machine; RPC mode — which pi-clik uses — is unaffected.
- Visited-chip state is in-memory only and resets on reload (PRD OQ2).
- Phase 3 items (Cmd+click insert-and-send, TUI transformer parity, export surfacing) are not implemented; the shipped scope is PRD Phases 1–2.
