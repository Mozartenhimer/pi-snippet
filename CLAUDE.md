# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # bundles web client, server, AND both extensions into dist/
npm test               # all tests except the live-model e2e
npm run check          # tsc --noEmit
npm run test:e2e       # live model through pi RPC (slow, needs a provider)

npx vitest run test/parser.test.ts            # one file
npx vitest run test/tui.test.ts -t "streaming" # one test by name
```

`npm test` deliberately uses `--exclude '**/e2e-*.test.ts'` rather than listing files: an earlier hand-written list silently skipped a whole test file for several commits. Don't convert it back to a list.

**Rebuild before any live or pty test.** The harnesses and the e2e test load `dist/extension/*.js`, not the TypeScript sources, so a source edit is invisible to them until `npm run build` runs.

### Terminal-behavior harnesses

```bash
bash scripts/ghostty-env.sh            # build the libghostty-vt helpers into scripts/.build/
npm run check:widths                   # our glyph-width table vs Ghostty's
npm run gen:widths                     # regenerate src/extension/char-width.ts
python3 scripts/chord-live.py          # Alt+digit gestures, keystrokes encoded by real Ghostty
python3 scripts/click-offset-repro.py  # clicking, with pi launched mid-screen
PI_SNIPPET_CLICK_DEBUG=/tmp/click.log pi -e dist/extension/pi-snippet-tui.js  # log click mapping
```

The Python harnesses fork a pty, run real `pi`, emulate a terminal (tracking a grid, answering cursor-position queries), and assert what lands in the editor. They are the only way to test terminal interaction end to end — there is no tmux on this machine, and `script` starts pi at screen row 0, which masks the whole class of offset bugs.

## Environment constraints

- pi is the **snap** build (`/snap/pi-coding-agent`, 0.84.2). npm's pi is far older. Docs live at `/snap/pi-coding-agent/current/bin/docs/`.
- **`pi -p` (print mode) hangs** with the claude-bridge provider and must be killed. Use `--mode rpc` for anything automated; that is what the server and every test do.
- claude-bridge is the only provider with working auth here; `claude-haiku-4-5` is the test model.

## Architecture

Two surfaces — a web client (server + browser) and a pi TUI extension — over one shared, surface-agnostic core.

**`src/shared/` must stay free of DOM and terminal concerns.** It holds the parser, the prompt snippet, digit-addressing rules, and TUI markdown generation. Both surfaces import it; nothing in it imports them.

**The parser is pure and renderers are stateless (PRD §5.2, a hard rule).** Rendering runs on every stream tick and resize, so anything stateful built during render drifts from what the user sees. The set of addressable suggestions is derived exactly once, in the `message_end` handler, and held in extension/app state.

**The server is a verbatim bridge.** `src/server/server.ts` spawns `pi --mode rpc` and forwards JSONL lines to WebSocket clients without interpreting them. Protocol knowledge lives in the browser client.

**Prompt injection needs both mechanisms.** `src/extension/common.ts` sets the snippet via the chained `systemPrompt` return *and* by mutating `systemPromptOptions.appendSystemPrompt`. Provider bridges such as pi-claude-bridge rebuild their own prompt and discard the former, so the model never sees it otherwise. Both paths are guarded against double-injection.

**The TUI transformer is display-only.** `registerMarkdownTransformer` changes what is painted; stored messages keep their raw `<pi:snippet>` tags, which is what keeps sessions readable by the web client. Never write a `message_end` handler that rewrites stored message text — a previously installed extension did exactly that and corrupted transcripts for every other consumer.

**Caps are guards, not style.** `MAX_SUGGESTIONS_PER_MESSAGE` (99) matches what two-digit `Alt` addressing reaches; `SUGGESTED_PER_MESSAGE` (10) is what the prompt tells the model. Keep those roles separate.

## Terminal facts this code depends on

These were established by measurement (against `libghostty-vt` and live ptys) and are expensive to rediscover:

- **pi never clears the screen** and moves the cursor only relatively, so buffer row 0 is not screen row 0 when pi starts under a shell prompt. Clicks are mapped by issuing a DSR query (`ESC[6n`) and anchoring the reply to pi-tui's buffer-relative `hardwareCursorRow`, with a bottom-aligned fallback on timeout.
- **`setEditorText` from a consumed input listener does not repaint.** Call `tui.requestRender()` or the inserted text stays invisible until the next keypress.
- **Ghostty sends no bytes at all for a standalone Alt press or release** at the Kitty flags pi requests (7); modifier events need flag 8. So "commit on modifier release" is unavailable in the terminal, and the two-digit chord settles on a timeout instead. The browser gets a real `keyup`.
- **`src/extension/char-width.ts` is generated** from `ghostty::CodepointWidth` — never hand-edit it. A hand-written table was wrong on 1171 codepoints (double-width emoji outside `U+1F300..1F9FF`, non-Latin combining marks), each one an off-by-a-column click miss.
- **Superscript digits are not one contiguous range.** `¹²³` are Latin-1 (U+00B9/B2/B3), the rest are U+2070–2079, so `[⁰-⁹]` is a broken character class. Chip labels use these, so regexes over rendered text must enumerate all ten.

## Conventions

- Tabs for indentation, TypeScript strict with `noUncheckedIndexedAccess`.
- `PRD.md` is the spec and is kept current — when behavior changes, update the relevant section rather than letting it drift.
- Tests needing a DOM opt in per file with `// @vitest-environment happy-dom`. happy-dom's `TreeWalker` with `SHOW_TEXT` returns nothing; walk `childNodes` recursively instead.
