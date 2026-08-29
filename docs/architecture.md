# Architecture

How pi-snippet is put together: the layers, the data flow, and the invariants that keep them honest. Behavioral detail lives in `PRD.md` (the spec) and `docs/terminal-resolved-clicks.md` (the click-chain measurements); this document is the map.

## What it is

A single pi extension (`src/extension/pi-snippet-tui.ts`) over a shared, terminal-agnostic core (`src/shared/`). The model wraps plausible user replies in `<snippet>...</snippet>` tags; the extension renders them as numbered chips, and lets the user send one back by clicking it or pressing `Alt+N`.

The pipeline, end to end:

```
prompt injection ──► model emits <snippet> tags ──► parser (pure)
                                                        │
        ┌───────────────────────────────────────────────┤
        ▼                                               ▼
markdown transformer                          message lifecycle handlers
(display-only, per render tick)               (derive the addressable set)
        │                                               │
        ▼                                               ▼
numbered chips on screen  ◄──────────────  extension state: addressable[],
        ▲                                  linkTargets (bounded map)
        │
   user input:
   • Alt+N chord (shared/digit-chord.ts) ──► insert text into composer
   • Ctrl+click: terminal resolves pisnip:// URL
         → desktop handler (link-install.ts, registered once per machine)
         → per-session unix socket (link-server.ts)
         → resolve against linkTargets → insert into composer
```

## Hard invariants

These are the rules the layout exists to enforce. Breaking any of them has historically broken the feature in subtle ways.

1. **`src/shared/` is terminal-free.** It holds the parser, the URL shape, the chord logic, and TUI markdown generation — all pure functions. Anything with a terminal opinion belongs in `src/extension/`.
2. **The parser is pure; renderers are stateless.** Rendering runs on every stream tick and resize, so any state built during a render pass drifts from what the user sees. The addressable set is derived in `message_update`/`message_end` handlers and held in extension state, never in the transformer (PRD §5.2).
3. **The transformer is display-only.** Stored messages keep their raw `<snippet>` tags. Never rewrite stored message text in a lifecycle handler — an earlier version did, and corrupted transcripts for every other consumer.
4. **One source of suggestions.** The only chips come from `<snippet>` tags in the message. A client-side inference layer (a second model reading untagged questions) existed and was removed (PRD §17) — fix tagging via the prompt contract, not a second model.
5. **One click delivery path.** Terminal-resolved clicks, always on, no toggle. Mouse reporting was removed; do not reintroduce a fallback. A terminal that cannot paint a hyperlink gets inert chips, never mouse reporting, and never a painted URL (pi-tui's `getCapabilities().hyperlinks`).
6. **Nothing outside the process puts text in the composer.** Chip URLs carry an index and a message key, never text; the text is resolved against a bounded map of messages this process itself indexed.
7. **Nothing is fatal.** Settings, sockets, registrations — every failure degrades to "feature off this session," never to a dead extension.

## Layout

```
src/
  shared/                 pure, terminal-agnostic
    suggestions.ts        the <snippet> parser: sanitization rules, caps
    prompt-snippet.ts     the prompt contract injected into the system prompt
    digit-chord.ts        Alt+N addressing: multi-digit chord decision logic
    tui-markdown.ts       chips as markdown links (¹label), pure transform
    link-url.ts           the pisnip:// URL shape; messageKey, sessionToken
  extension/              terminal- and pi-coupled
    pi-snippet-tui.ts     entry point: state, lifecycle handlers, /snippets
    common.ts             prompt injection (two guarded delivery paths)
    settings.ts           persisted toggles (~/.pi/agent/pi-snippet.json)
    link-url.ts → link-server.ts   the far end of a click (unix socket)
    link-install.ts       register/unregister the desktop scheme handler
    tui.ts                the TuiLike interface (the sliver of pi-tui we touch)
test/                     vitest unit + integration; e2e-*.test.ts excluded
                          from `npm test` and run by `npm run test:e2e`
scripts/                  Python/shell terminal-behavior harnesses (ptys, not mocks)
```

The extension is bundled with esbuild to a single file (`dist/extension/pi-snippet-tui.js`), which is what `package.json`'s `pi.extensions` points at. **Rebuild before any live or pty test** — the harnesses load `dist/`, not the sources.

## The layers in detail

### Prompt contract (`shared/prompt-snippet.ts`, `extension/common.ts`)

`registerPromptSnippet` hooks `before_agent_start` and injects the suggested-replies instructions via **two** delivery paths, both guarded against double-injection:

- the chained `systemPrompt` return, for direct providers;
- `systemPromptOptions.appendSystemPrompt`, mutated in place, for provider bridges (pi-claude-bridge) that rebuild their own prompt and discard the former.

The prompt gives the model no numeric guidance; the only steer is "zero suggestions is normal." `MAX_SUGGESTIONS_PER_MESSAGE` (99) is a runaway-output guard matching what two-digit `Alt` addressing reaches, not a style rule.

### Parser (`shared/suggestions.ts`)

Pure: raw markdown in, token stream out. Sanitization rules (PRD §5.3, §11): no tags inside fenced code blocks or inline code; unclosed tags drop; nested tags take the outer; empty, over-long, or block-crossing content renders plainly; the per-message cap counts across text blocks via `acceptedSoFar`. `visibleStreamingPrefix` cuts a partial stream back to the last complete tag, so a chip appears the instant its closing tag arrives and `Alt+N` can never insert half a sentence.

### Rendering (`shared/tui-markdown.ts`, transformer in `pi-snippet-tui.ts`)

`registerMarkdownTransformer` turns each parsed suggestion into `[\u00B9label](url)`. The URL is `chip:N` (inert placeholder) when clicking is unavailable, or a real `pisnip://token/msg/cN` when it is. The transformer hashes the *same text it was handed* to derive `msg` (`messageKey` — FNV-1a, 32 bits), which is why the lifecycle handlers must index messages in exactly the forms the transformer will hash (whole message, per text block, and the streaming prefix).

### Addressability (lifecycle handlers, `shared/digit-chord.ts`)

`message_update` fires while the model writes and recomputes the addressable set from the streaming prefix — that is what makes a chip triggerable mid-stream. `message_end` finalizes it. Only the most recent assistant message is addressable, so a number never means two things. `setAddressable` resets a pending chord only when the set actually changed, so finalizing a message whose chips match the streamed ones doesn't cancel a gesture mid-typing.

The chord (`digit-chord.ts`) is pure decision logic; timers and key events belong to callers. One digit commits instantly when no longer number could exist (`Alt+3` with four suggestions); two-digit numbers settle on a 350 ms timeout or on a modifier-release event. **Ghostty sends no bytes for standalone Alt press/release** at the Kitty flags pi requests (7), so the release watcher (`ALT_RELEASE`) is dormant by design — kept because it costs one regex while a chord is pending and starts working for free if pi ever raises its flags. Superscript digits (the chip labels) span Latin-1 (`\u00B9\u00B2\u00B3`) and U+2070–2079, so regexes over rendered text must enumerate all ten — `[⁰-⁹]` is a broken class.

### Click delivery (`shared/link-url.ts`, `extension/link-server.ts`, `extension/link-install.ts`)

The chain, described in depth in `docs/terminal-resolved-clicks.md`:

1. The chip's href is a real `pisnip://token/msg/cN` URL; pi-tui paints it as OSC 8.
2. The terminal resolves Ctrl+click and asks the OS to open the URL.
3. A desktop handler — generated once per machine by `link-install.ts` (a `.desktop` entry plus `mimeapps.list`; no xdg-utils dependency) — forwards the URL path to pi.
4. `LinkServer` listens on a unix socket named after the session token. `sessionToken()` hashes pi's session id, so a resumed session rebinds the socket its old scrollback already points at (a fresh random value would name a dead socket after restart). Socket directory candidates, in order: `PI_SNIPPET_SOCKET_DIR`, `$XDG_RUNTIME_DIR/pi-snippet`, `/tmp/pi-snippet-<uid>` — both sides walk the same list, because a confined snap's runtime dir is not the desktop's.
5. The path is strictly parsed (`parseChipPath`: malformed means miss, never coerced) and resolved against `linkTargets`, a bounded (64-entry) map keyed by message hash — which is what lets a chip in old scrollback still mean what it meant.

Gating: the server listens while suggestions are on and the terminal can paint a hyperlink — pi-tui's own `getCapabilities().hyperlinks`, which under tmux asks tmux whether the client advertised `hyperlinks`, and which honours the `PI_HYPERLINKS` override. The question goes to pi-tui rather than to a local copy of its table because pi-tui is the renderer that would print the parens: disagree with it in the generous direction and a visible `(pisnip://…)` trails every chip, in the stingy direction and a terminal that would have worked gets nothing. A copy of the table lived here until it drifted (it never learned `PI_HYPERLINKS`); don't reintroduce one. Insertion from the socket callback calls `tui.requestRender()`, because a socket callback sits outside pi's render pass — without it the text is invisible until the next keypress. The TUI instance itself is captured by borrowing the footer factory (`captureTui`) and restoring it immediately.

Linux only. `/snippets` registers the handler and probes it honestly (`PROBE_KEY`, a message key no real message can collide with, proves the round trip without inserting anything).

### Persistence (`extension/settings.ts`)

pi offers no settings API (`ExtensionAPI` has only session-scoped `appendEntry`), so the `/snippets` toggles (`enabled`, `hotkeysEnabled`) live in `~/.pi/agent/pi-snippet.json`, beside pi's own settings — the pattern of pi's shipped `preset.ts` example. The agent dir is re-derived in three lines (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`) so the bundle keeps no runtime dependency on pi; `PI_SNIPPET_SETTINGS` overrides the path (`test/setup.ts` points it at a temp file).

`--no-suggestions` latches a separate `flagDisabled`, never `state.enabled`, so a flagged session cannot write `off` over the user's stored choice. `merge()` reads only known keys, so settings files from older versions (with `clickEnabled`, `linkMode`, `magicEnabled`, `model`) load cleanly and shed their dead keys.

## Testing

Three tiers, matching how the code fails:

- **Unit (`test/*.test.ts`)** — the parser, chord logic, URL shape, settings merge, link server. DOM-touching files opt in with `// @vitest-environment happy-dom`; happy-dom's `TreeWalker` with `SHOW_TEXT` returns nothing, so walk `childNodes` recursively.
- **e2e (`test/e2e-haiku.test.ts`)** — live model through pi RPC (`--mode rpc`; `pi -p` hangs with claude-bridge). Excluded from `npm test` deliberately, via `--exclude '**/e2e-*.test.ts'` rather than a file list — an earlier hand-written list silently skipped a whole file.
- **Terminal-behavior harnesses (`scripts/*.py`)** — the only way to test terminal interaction end to end. They fork a pty, run real `pi`, emulate a terminal (grid tracking, cursor-position replies), and assert what lands in the editor. `script` starts pi at screen row 0, which masks a whole class of bugs, hence ptys. `scripts/ghostty-env.sh` builds the `libghostty-vt` key-encoding helper the chord harnesses use.

## What is deliberately absent

Removed layers, kept here so they stay removed:

- **Mouse reporting** (`tui-mouse.ts`, DECSET/DSTR, hit-testing, width tables) — replaced by terminal-resolved clicks; keeping both bought a setting and two codepaths and nothing else. The harnesses went with it (`click-offset-repro.py`, `infer-click-tmux.py`); git history has them.
- **The inference layer** (PRD §17) — a small model reading untagged questions to produce second-class chips (no number, no keyboard path) at ongoing per-message cost. `test/fixtures/mock-llm.js`, which registered a provider via `ProviderConfig.streamSimple`, went with it.
- **A click toggle** — clicking is always on where it works at all; there is nothing to opt out of that a user would want to (no terminal-wide mode is ever engaged, so wheel and selection keep working).
