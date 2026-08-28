# Handoff: terminal-resolved clicking

Written for whichever agent picks this up next. Read `CLAUDE.md` first (project
conventions, harness commands, terminal facts already measured); this document
is the state of one specific feature, not a repeat of that file.

## What this feature is

pi-snippet renders `<snippet>` suggestions as clickable chips in the TUI.
Clicking used to mean terminal-wide mouse reporting (`tui-mouse.ts`) — it
works, but it costs the wheel (scrollback stops responding) and makes
click-drag selection need Shift, so it defaulted off.

This work adds a second delivery path: make the chip's markdown href a real
`pisnip://` URL. Where the terminal renders OSC 8 hyperlinks (Ghostty does),
Ctrl+click resolves through the terminal itself — no mouse mode, no cost — and
the OS dispatches the URL to a handler we register once, which forwards it to
a per-session unix socket the extension listens on. Full design, rationale and
every measurement: `docs/terminal-resolved-clicks.md`. Read that before
touching `link-*.ts` — it explains *why*, this file only says *where things
stand*.

As of the last commit, **this is the default**: `clickEnabled` and `linkMode`
both start `true`. Two guards make that safe (see below); neither is
optional.

## Where things stand

Branch `claude/terminal-resolution-text-injection-mbdij7`, clean, pushed, all
260 tests passing (`npm test`). Built and verified end-to-end *inside a
container with no terminal and no desktop* — real pi via
`@earendil-works/pi-coding-agent@0.84.3` from npm, driven over a pty, with
`test/fixtures/mock-llm.js` standing in for the model. What that proved:

- Real pi paints `pisnip://<token>/<msg>/c1` as a genuine OSC 8 hyperlink when
  the environment says Ghostty, and paints plain `chip:1` with no URL at all
  when it doesn't (`scripts/osc8-probe.py`).
- A line written to the socket in the handler's exact wire format lands in a
  live editor (`scripts/link-click-live.py`) — proven by checking the
  suggestion text appears *without* its superscript prefix, which only the
  editor insertion produces (a chip label always carries one).
- The generated handler script round-trips against a real `LinkServer` and
  exits quietly (code 1, no stderr) on a dead session.
- Registration (`.desktop` + `mimeapps.list`, no `xdg-utils` dependency)
  dispatches correctly through both `gio open` and `xdg-open` in a container
  that has neither `DISPLAY` nor a D-Bus session bus for the portal itself.
- With pure defaults and no settings file: a Ghostty-identified terminal gets
  `pisnip://` URLs; an unidentified terminal gets neither a URL nor
  `DECSET 1000` (mouse-on) — the two safety guards, checked live.

**Never run on a real terminal or a real desktop.** That is exactly what this
machine has and the container didn't: real Ghostty (1.3.1, snap), real pi
(0.84.2, snap), `libghostty-vt` present at
`/snap/ghostty/current/include/ghostty/vt.h`. Every remaining open item below
needs this machine and only this machine.

## Do this first: rebuild

```bash
npm install
npm run build          # dist/extension/pi-snippet-tui.js — what pi actually loads
npm test               # should be 260 passing; confirm before changing anything
```

Rebuild after *any* source edit before trusting a live/pty test — `dist/` is
what's loaded, not `src/`. This bit a previous session; see CLAUDE.md's
"Rebuild before any live or pty test" note.

## Open items, in the order I'd tackle them

### 1. Does registration actually work on this machine? (5 minutes, do this first)

```bash
python3 scripts/link-register.py --install
python3 scripts/link-register.py --probe
python3 scripts/link-register.py --status
```

Expect `--probe` to print `ok` for `gio` and `xdg-open`, and either `ok` or
`skip` for `gdbus` (skip is fine — it only means no D-Bus session bus was
reachable from wherever this runs; a real desktop session should have one and
turn it into `ok`).

**The one real unknown this answers:** both pi and Ghostty are **snap**
builds here. If either is strictly confined, this is where it shows up:

- Ghostty's portal call might land on snapd's own `userd` launcher instead of
  `xdg-desktop-portal`, which has its own scheme allowlist — `pisnip://` may
  simply not be in it, regardless of registration.
- Confinement can also split `$XDG_RUNTIME_DIR` between the snap and the
  desktop session, meaning the handler and the extension would compute
  *different* socket directories despite matching code. Check with:

  ```bash
  echo $XDG_RUNTIME_DIR                                    # your shell
  pi -e dist/extension/pi-snippet-tui.js   # then, inside pi's bash mode:
  echo $XDG_RUNTIME_DIR
  ```

  If they differ, `PI_SNIPPET_SOCKET_DIR` (read by both `link-server.ts` and
  the generated handler) needs to be set to a directory both sides can
  reach — export it before launching pi, and again in whatever environment
  the desktop session's handler will run in.

### 2. The actual Ctrl+click, in real Ghostty

```bash
pi -e dist/extension/pi-snippet-tui.js
```

Get the model to produce a `<snippet>` (or just ask something that would
prompt one — the real model, not the mock, so use whatever provider you have
configured). Ctrl+click the chip. It should insert with no visible mouse-mode
side effects (wheel keeps scrolling elsewhere in the terminal if you test
that).

If item 1 passed but this doesn't work, the likely next suspect is Ghostty
config: `link-osc8 = true` is the default but can be turned off by a user
config (`~/.config/ghostty/config`), and OSC 8 links are just plain unclicked
if so — check that first before assuming it's a code bug.

`PI_SNIPPET_CLICK_DEBUG=/tmp/click.log` doesn't apply to this path (it's the
mouse-mode debug log); there's currently no equivalent tracing for the link
path. If you need one, `link-server.ts`'s `handle()` is the single choke
point — a debug log there mirroring `tui-mouse.ts`'s `debugLog()` pattern
would be the natural addition, gated the same way (an env var, silent
failure).

### 3. Latency

Subjective for now — does the chip feel instant, or is there a visible beat
between Ctrl+click and text appearing? Portal round-trip + handler process
spawn (python3 interpreter startup, ~25ms measured in isolation) is the whole
budget. If it's laggy, that's a product call (keep as an opt-in compatibility
mode vs. investigate) rather than an obvious bug to fix.

### 4. Whatever `--probe` actually reports

If item 1 fails in a way not covered above, the failure message names the
step (no opener found / registered but no round trip / etc.) — start there
rather than re-deriving from source what `docs/terminal-resolved-clicks.md`
§9 already worked out from Ghostty's own Zig source (Linux uses the XDG
portal with `ask: false`, so no confirmation dialog is expected — if one
appears, something is off from what was measured).

## Things already decided, don't relitigate without reason

- **macOS is explicitly out of scope.** Ghostty's macOS apprt puts a
  confirmation dialog in front of *every* custom-scheme OSC 8 click
  (`UntrustedURL.decision` → `.confirm`), which would be worse than the mouse
  mode this replaces. If macOS support ever gets picked up, the `file://`
  transport variant is sketched in `docs/terminal-resolved-clicks.md` §9c —
  it was deliberately not built.
- **`linkMode` rides beside `clickEnabled`, not replacing it.** They answer
  different questions (whether clicking is on vs. how it's delivered) so a
  machine that loses its handler registration falls back to mouse rather than
  to nothing. Don't collapse them into a single tri-state without a reason
  better than "cleaner."
- **The URL is keyed by a hash of the message text (`messageKey` in
  `link-url.ts`), not by position or a counter.** This is what lets a chip
  clicked in old scrollback still resolve to what it meant. Deliberately
  wider than `Alt+N`, which stays latest-message-only. Don't "simplify" this
  back to an index without re-reading why (`link-url.ts` header comment, and
  `docs/terminal-resolved-clicks.md` §4).
- **The inference layer's cost gate reads `clickActive()`, not `clickOn()`.**
  These split apart when link mode could be selected-but-unreachable (no OSC
  8 support). If you touch the gate, check `docs/terminal-resolved-clicks.md`'s
  "Things already decided" note under §17 and `pi-snippet-tui.ts`'s comment
  on `clickActive()` before changing which one anything reads.
- **`osc8.ts`'s terminal list deliberately mirrors pi-tui's own
  `getCapabilities()` detection**, not a superset. Guessing more generously
  than the renderer means a chip visibly trails `(pisnip://...)` on a
  terminal pi-tui itself doesn't consider hyperlink-capable. If a terminal is
  missing from the list, check what pi-tui does first
  (`@earendil-works/pi-tui`'s `terminal-image.js`) before adding it here.

## Recently touched files, if you need the map

New: `src/shared/link-url.ts`, `src/extension/link-server.ts`,
`src/extension/link-install.ts`, `src/extension/osc8.ts`,
`scripts/link-register.py`, `scripts/osc8-probe.py`,
`scripts/link-click-live.py`, plus matching tests
(`test/link-url.test.ts`, `test/link-server.test.ts`, `test/osc8.test.ts`,
`test/link-mode.test.ts`).

Modified: `src/extension/pi-snippet-tui.ts` (wiring: token, message-keyed
target registry, `syncMouse` now routes between mouse/link delivery,
`/snippets` gained "Click method" and "Register click handler" rows),
`src/extension/settings.ts` (new `linkMode` field, new defaults),
`src/shared/tui-markdown.ts` (transformer threads a `linkToken` through to
build hrefs), `PRD.md` §12.1a, `CLAUDE.md` (harness list + two architecture
notes).
