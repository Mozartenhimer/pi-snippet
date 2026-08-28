# Sketch: let the terminal resolve the click

**Status: sketch.** Nothing here is built. One load-bearing fact is unmeasured
(§9), and it can kill the whole thing — read that section before writing code.

## 1. The idea

Today a click is resolved *inside* pi. We turn on terminal-wide mouse reporting
(DECSET 1000 + 1006), catch the SGR report, ask the terminal where its cursor
is (DSR), subtract pi-tui's `hardwareCursorRow` to find buffer line 0, walk the
rendered lines, and match a chip's visible text column by column through a
generated glyph-width table. It works, and every piece of it exists because the
process has to reconstruct something the terminal already knows.

The terminal already knows it because we already told it. Chips render as
markdown links — `[¹rebuild the solution](chip:1)` — and pi-tui turns that into
an OSC 8 hyperlink wherever the terminal supports one. The terminal is tracking
those cell ranges itself: that is what makes Ctrl+click (Cmd+click on macOS)
light the link up under the pointer.

So: make the URL mean something. Ctrl+click, the terminal resolves the hit and
hands the URI to the OS opener, a handler we register turns that into one line
on a unix socket, and the extension inserts the text. The gesture the user
described — hold Ctrl, click the chip — with no mouse mode at any point.

## 2. What it buys, and what it doesn't

Buys:

- **No terminal-wide mode.** The wheel keeps scrolling the terminal's own
  scrollback, click-drag selection keeps working without Shift, and no escape
  sequences leak into the editor. That cost is the reason click-to-insert is
  off by default (`settings.ts`), and it is the entire cost being removed.
- **Exact hit-testing, for free.** No DSR round trip, no `hardwareCursorRow`
  anchoring, no column arithmetic, so no class of off-by-a-column misses. Wrapped
  chips, double-width glyphs, and combining marks are the terminal's problem, and
  it already solves them to paint the underline.
- **Clicks that survive scrollback.** The mouse path can only hit what is on
  screen and only against the current addressable set. A URL carries its own
  message id, so a chip from five messages back stays clickable and still means
  what it meant then (§4).
- **Right session, no ambiguity.** Two pi windows each mint their own token, so
  a click lands in the pi that painted it.

Doesn't buy:

- **Code deleted.** `tui-mouse.ts`, `char-width.ts`, and the DSR dance stay, as
  the fallback for SSH (§8), for terminals without OSC 8, and for anyone who
  won't install a handler. This adds a path; it does not remove one. The win is
  UX, not lines.
- **Zero install.** Registering a URL scheme is an OS-level act, per platform,
  once per machine (§6). That is the "procedure type thing" — and it is the
  thing most likely to make this a power-user mode rather than the default.

## 3. The three moving parts

```
 chip in a message
   │  transformer (display-only, pure)
   ▼
 [¹rebuild the solution](pisnip://<token>/<msg>/c1)
   │  pi-tui paints OSC 8
   ▼
 terminal: Ctrl+click → OS opener → registered handler for scheme `pisnip`
   │  handler writes one line, exits
   ▼
 unix socket $XDG_RUNTIME_DIR/pi-snippet/<token>.sock
   │  extension: id → text from state, insertText(), requestRender()
   ▼
 editor
```

The handler is stateless and dumb: it knows the socket path (baked in at
install time, or derived from the token) and forwards the path component. All
the meaning lives in the extension.

## 4. Wire format

```
pisnip://<token>/<msg>/<id>
```

- `token` — 8 hex chars, minted per session, names the socket file.
- `msg` — 4 hex chars, the message the chip belongs to.
- `id` — the existing target id: `c3` is the third tagged chip, `a2` the second
  inferred anchor. Same ids `ClickableText` already uses.

Two rules that matter:

**The URL carries an index, never text.** It names a slot the extension looks
up in its own state. A URL cannot inject arbitrary text into the editor, only
text the model already wrote in a message this session (§7).

**The message id is what makes scrollback safe.** `c3` alone would resolve
against whatever is addressable *now*, so clicking a chip from five messages
ago would insert the current message's third suggestion — silently wrong text,
the worst possible failure. Keyed by message, an old chip either resolves to
what it said or misses. The extension keeps a bounded map of message id →
suggestions, the same LRU shape as `anchorsByText` (64 entries).

Note this splits from `Alt+N` deliberately: digits stay latest-message-only
(PRD §12.2 — a number must never mean two things), while a URL is unambiguous
and may reach back. That is a widening of §12.1, not a violation of it.

**Keep it short.** Where pi-tui has no OSC 8 (tmux without `hyperlinks`) it
prints the URL in parentheses after the label, so `¹rebuild the solution
(pisnip://a1b2c3d4/0007/c1)` is what the user would read. That is why link mode
self-detects (§5) instead of being a preference someone can set into an ugly
screen.

## 5. Extension side

Three additions, all in `src/extension/`:

**`link-url.ts` (shared, pure).** `buildChipUrl(token, msg, id)` and
`parseChipUrl(url)`. Pure functions, unit-tested, no I/O — the transformer stays
a pure function of (text, anchors, **link context**), with the token and message
id passed *in* as options next to `anchors`, never read from module state
(PRD §5.2).

**`link-server.ts`.** A `net.createServer` on
`$XDG_RUNTIME_DIR/pi-snippet/<token>.sock` (falling back to
`os.tmpdir()`), mode 0600, unlinked on exit; a stale socket is probed with a
connect and unlinked on ECONNREFUSED. One line per connection, parsed, resolved,
inserted. Reuses exactly the activation path the mouse already uses:

```ts
const activate = (id: string, msg: string) => {
	const text = resolve(msg, id);          // same lookup ClickableText's onActivate does
	if (!text || !lastCtx) return;
	insertText(lastCtx, text);
	tui?.requestRender?.();                 // socket callbacks bypass pi's render pass, same as consumed input
};
```

Nothing here is allowed to be fatal, on the `settings.ts` principle: a runtime
dir that won't take a socket degrades to "mouse mode this session", not to a
dead extension.

**Mode detection, in-process.** Whether to emit long URLs at all is answered
without asking the user and without asking the terminal, by reusing the render
wrapper `ClickableText` already installs: `tui.render(width)` hands back the
painted lines *including* escape sequences. On the first paint that contains a
chip, look at the line —

- contains `\x1b]8;;pisnip://` → pi-tui emitted the hyperlink; link mode is live.
- contains the parenthesised URL instead → no OSC 8 on this terminal; fall back
  to `chip:N` URLs and the mouse path, and never show the user a long URL.

That answers "did pi-tui emit it", not "will the terminal honor it". The second
half is the installer's probe (§6).

**`/snippets` grows a mode, not a fourth toggle.** Click to insert becomes
`off / link (Ctrl+click) / mouse`, plus an `Install click handler…` action.
`link` is only offered once a handler round-trips; `mouse` stays the answer for
SSH and for un-installed machines. Persisted in `pi-snippet.json` beside the
others; `clickEnabled: boolean` becomes `clickMode: "off" | "link" | "mouse"`
with a `merge()` migration from the boolean (`true` → `"mouse"`).

## 6. The install procedure

One action in `/snippets`, writing per-platform registration, then proving it.

**Linux.** `~/.local/share/applications/pi-snippet-open.desktop` with
`Exec=<handler> %u`, `MimeType=x-scheme-handler/pisnip;`, `NoDisplay=true`; then
`update-desktop-database` and `xdg-mime default pi-snippet-open.desktop
x-scheme-handler/pisnip`.

**macOS.** A minimal bundle at `~/Applications/pi-snippet-open.app` — Info.plist
with `CFBundleURLTypes`/`CFBundleURLSchemes`, a shell script in `MacOS/` —
registered with `lsregister -f`. Expect a one-time "allow" prompt.

**The handler itself** is generated at install time, because it has to speak
AF_UNIX from a shell exec and there is no portable way to do that. Probe in
order and bake the winner in: `python3` (three lines, present nearly everywhere),
then `node` (only if a real node is on PATH — `process.execPath` under the snap
is the pi binary, not a node CLI), then `socat`, then `nc -U`. If none exists,
the install fails honestly and link mode is not offered.

**Terminal-native alternative, worth checking first per terminal.** WezTerm's
`open-uri` Lua event, Kitty's `open_actions.conf`, and iTerm2's semantic-history
triggers can all invoke a command for a custom scheme with *no OS registration
at all* — for those the "installer" appends to the terminal's own config, which
is both simpler and more auditable. Ghostty (the terminal this repo is measured
against) has no such hook, so it goes through the OS opener.

**The probe is the acceptance test.** After registering, the installer opens
`pisnip://<token>/0000/ping` through the platform opener and waits ~2s for the
socket to see it. Round-trip or it didn't happen: link mode is enabled only on
success, and the failure message says which step (no opener, no handler
transport, registered but never called) rather than "something went wrong".

## 7. Security

The socket is a local IPC endpoint that types into the user's composer, so:

- **0600, in the per-user runtime dir.** Not world-connectable.
- **Unguessable token**, `randomBytes(4).toString("hex")` at minimum, matched
  against the session's own before anything resolves.
- **Index, not payload** (§4). The worst a hostile local process can do with a
  valid token is insert text the model already wrote, into a composer, where the
  user sees it before it goes anywhere.
- **Never auto-send.** PRD §16 already rejects auto-send on click for the mouse
  path; it is more emphatically right here, where the trigger crosses a process
  boundary. Insertion only.
- The URL appears in a message that a *model* wrote. It is generated by us at
  render time from parsed nodes, never taken from model text — a model that
  writes `[click me](pisnip://…)` in a fenced block gets escaped like any other
  markdown, and the transformer only emits URLs for spans it parsed itself.

## 8. Where it doesn't work

| Situation | What happens |
|---|---|
| SSH / remote pi | Terminal opens the URI on the **local** machine; the socket is on the remote. Broken, and silently. Detect (`SSH_TTY`) and refuse link mode. |
| tmux without `hyperlinks` | No OSC 8 emitted; auto-detected (§5), stays on mouse. |
| Terminal without OSC 8 at all | Same. |
| Terminal that restricts URI schemes | The unmeasured risk. See §9. |
| No handler installed | Link mode not offered; mouse path unchanged. |
| Session ends, user clicks an old chip in scrollback | Socket is gone; the opener fails quietly. Acceptable — arguably better than inserting into a session that has moved on. |
| Two sessions, one terminal (tabs) | Correct by token; each session's chips reach only that session. |

## 9. Measure this before writing anything

**Does Ghostty open a custom scheme?** Terminals validate OSC 8 URIs before
handing them to the OS — a restriction to `http`/`https`/`file`/`mailto` is a
reasonable thing for a terminal to do, and if Ghostty does it, `pisnip://` never
leaves the terminal and this design is dead as written.

Fifteen-minute probe, no code from this repo involved:

```bash
# 1. a logging opener
printf '#!/bin/sh\necho "$@" >> /tmp/opener.log\n' > /tmp/fake-open && chmod +x /tmp/fake-open
# register it for x-scheme-handler/pisnip (desktop file, as in §6)

# 2. paint a hyperlink and Ctrl+click it
printf '\e]8;;pisnip://test/0000/c1\e\\CLICK ME\e]8;;\e\\\n'

# 3. did anything reach the opener?
cat /tmp/opener.log
```

Run it for `pisnip://`, `https://`, and `file://` and compare. If only the
last two fire, the fallbacks are, in order of preference:

1. **`file://` with a registered extension.** Touch `…/pi-snippet/<token>/<msg>-c1.pisnip`
   in the runtime dir, register a MIME type for `.pisnip`, and let the opener
   route by file type. Same handler, same socket, one more thing to clean up.
2. **`http://127.0.0.1:<port>/…`** — accepted by any validator, but the opener
   launches a *browser*, which steals focus. Worse than the mouse mode it is
   meant to replace. Listed for completeness, not recommended.
3. Terminal-native hooks only (§6), i.e. WezTerm/Kitty/iTerm2 get link mode and
   Ghostty doesn't — an awkward inversion, since Ghostty is what this repo
   measures against.

Second thing to measure, once a click round-trips: **latency.** Opener spawn
plus interpreter startup is the whole budget. python3 ≈ 25 ms, node ≈ 40 ms,
`xdg-open` itself is the wildcard (it can be a long shell script). If the chip
takes a visible beat to land, the mouse path stays the better gesture and this
becomes a compatibility option rather than the recommended one.

## 10. Tests

- `test/link-url.test.ts` — build/parse round-trip, rejection of malformed and
  foreign URLs, escaping. Pure, fast.
- `test/link-server.test.ts` — real unix socket, stale-socket recovery,
  unknown-token rejection, unknown-message miss, permissions.
- `test/tui-markdown.test.ts` — URL shape per mode, and that link mode changes
  *only* the href (the label the mouse path hit-tests must stay byte-identical,
  or both paths break at once).
- End-to-end can't be automated here: no terminal emulator in the harnesses
  resolves OSC 8 and shells out. tmux can't Ctrl+click-open. So the probe in §9
  becomes `scripts/link-open-probe.sh`, run by hand against a real Ghostty, in
  the spirit of the other harnesses in `scripts/`.

## 11. Open questions

- Is Ctrl+click even the right gesture to document? It is terminal-specific
  (Cmd on macOS, some terminals plain-click, Ghostty configurable). The help
  text can't state one chord for everyone.
- Should link mode be *default on* once installed? It has none of the mouse
  path's costs, so the reason click-to-insert defaults off (`settings.ts`)
  evaporates. Probably yes — which makes the installer the real product
  decision, not the mode.
- What does the unnumbered inferred anchor (PRD §17) do here? It is already a
  link, so it comes along for free — and since link mode costs nothing, the
  "inference is gated on click-to-insert as cost control" argument gets weaker.
  Worth re-reading §17 before assuming it still holds.
- Does anything else in pi already own a URL scheme, or want to? A scheme is a
  global per-machine namespace; `pisnip` is squatting.
