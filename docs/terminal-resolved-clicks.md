# Sketch: let the terminal resolve the click

**Status: implemented and on by default, Linux only.** The design
below is what was built; §9 records what was measured rather than assumed.

Proven in this repo, without a desktop: real pi paints
`pisnip://<token>/<msg>/c1` as an OSC 8 hyperlink
(`scripts/osc8-probe.py`), a forwarded click inserts the suggestion into a live
editor (`scripts/link-click-live.py`), and scheme registration round-trips
through gio and xdg-open (`scripts/link-register.py --probe`).

Untested until it runs on a desktop: the terminal's own dispatch — Ctrl+click →
portal → handler — and whether snap confinement breaks either the scheme
allowlist or the socket path. See §9d.

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
- **The gesture is already the gesture.** Ghostty activates an OSC 8 link on
  `mouse_mods.equal(input.ctrlOrSuper(.{}))` — Ctrl on Linux, Cmd on macOS, and
  *no other modifier held*. Hold Ctrl and click is not an approximation of what
  Ghostty does; it is the condition, verbatim (`src/Surface.zig:4325`).

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

## 6. The install procedure (Linux)

Prototyped and measured end to end in `scripts/link-register.py`
(`--install`, `--probe`, `--status`, `--uninstall`). Everything is user-level:
no root, no system paths, three files.

| File | Purpose |
|---|---|
| `$XDG_DATA_HOME/pi-snippet/open-handler` | the handler, generated at install |
| `$XDG_DATA_HOME/applications/pi-snippet-open.desktop` | declares `MimeType=x-scheme-handler/pisnip;`, `NoDisplay=true` |
| `$XDG_CONFIG_HOME/mimeapps.list` | `[Default Applications]` entry making us the default for the scheme |

**No hard dependency on xdg-utils.** Measured with neither `xdg-utils` nor
`desktop-file-utils` installed: a `.desktop` file plus the `mimeapps.list` entry
is sufficient on its own — `mimeinfo.cache` is not consulted for a *default*
lookup. So `xdg-mime`, `update-desktop-database` and `desktop-file-validate` are
used when present and skipped when not, and the association is written directly
otherwise. This matters: the tools were absent on a stock container.

**The handler lives under `XDG_DATA_HOME`, not the pi agent dir.** The `Exec`
line is baked in at install time and must stay valid for every future session,
while `PI_CODING_AGENT_DIR` moves per session (`test/setup.ts` repoints it on
every test run). Same reasoning as `settings.ts` keeping preferences outside the
session store, one level further out.

**Do not quote the `Exec` path.** The Desktop Entry spec allows it and GLib
parses it correctly, but `xdg-open` reads the line with
`grep ^Exec | cut -d= -f2- | first_word | which` — the quotes arrive attached to
the path and `which` fails. Unquoted works in both parsers. The cost is that a
handler path containing a space cannot satisfy xdg-open at all; the installer
warns rather than pretending otherwise.

**The handler is stateless and written once.** It derives the socket from the
token in the URL, so it serves every future session without re-registration, and
it carries no text — the URL names a slot (§4). A dead session (a chip clicked
in old scrollback) is a failed connect and a silent exit, which is the correct
behavior rather than an error dialog.

### 6a. The probe is the acceptance test

Registration that isn't proven is a guess, so `--probe` fires a real
`pisnip://probe000/0000/ping` at each opener and checks whether the socket hears
it. Openers are tried nearest-to-Ghostty first, because Ghostty's GTK apprt
calls the portal and only falls back to `xdg-open` if the portal errors:

1. `gdbus` → `org.freedesktop.portal.Desktop` `OpenURI` with `ask=false`
2. `gio open`
3. `xdg-open`

Measured here (no D-Bus session bus in a container, so the portal is skipped
rather than failed — an absent environment says nothing about whether the portal
would dispatch the scheme):

```
skip  gdbus      -> skipped: no D-Bus session bus
ok    gio        -> 0000/ping
ok    xdg-open   -> 0000/ping
```

Link mode is offered only on a round trip. The failure message names the step —
no opener, no handler transport, registered but never called — rather than
"something went wrong".

Two quirks worth knowing before debugging a failure by hand:

- `xdg-open`'s scheme lookup is gated behind `has_display`. With no `DISPLAY`
  or `WAYLAND_DISPLAY` it skips `x-scheme-handler` entirely and falls through to
  its browser list, failing with exit 3 — which looks exactly like a broken
  registration and is not one.
- `xdg-open` treats a hyphen in the desktop-file name as a vendor prefix, so
  `pi-snippet-open.desktop` is first looked for at `applications/pi-snippet/open.desktop`
  before the normal glob finds it. Harmless today; it would bite if such a
  directory ever existed.

### 6b. Terminal-native alternative

WezTerm's `open-uri` Lua event, Kitty's `open_actions.conf`, and iTerm2's
semantic-history triggers can invoke a command for a custom scheme with no OS
registration at all — for those the installer appends to the terminal's own
config, which is simpler and more auditable. Ghostty has no such hook, so it
goes through the portal.

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
| `link-osc8 = false` in the user's Ghostty config | OSC 8 links stop being highlighted, previewed, copied or opened. Default is true; nothing detects it from inside, so it fails as a click that does nothing. |
| Session ends, user clicks an old chip in scrollback | Socket is gone; the opener fails quietly. Acceptable — arguably better than inserting into a session that has moved on. |
| Two sessions, one terminal (tabs) | Correct by token; each session's chips reach only that session. |

## 9. Measured

> **Scope: Linux.** macOS is out of scope as of this revision. §9b's macOS
> findings and the `file://` transport in §9c are kept because they are the
> reason the split exists, not because they are being built.

Both halves are now answered — the pi half on a live pty against real pi
0.84.3, the terminal half from Ghostty's own source and test suite.

### 9a. pi-tui hands the href through verbatim — yes

`scripts/osc8-probe.py` forks a pty, runs real pi against the mock LLM, and
reads the bytes. Three runs:

| Regime | Result |
|---|---|
| `TERM_PROGRAM=ghostty`, real `<snippet>` chips | `\x1b]8;;chip:1` and `\x1b]8;;chip:2` on the wire. Real OSC 8, href verbatim, no paren fallback. |
| `TERM_PROGRAM=ghostty`, a markdown link with `pisnip://a1b2c3d4/0007/c1` | Emitted **verbatim**: `\x1b]8;;pisnip://a1b2c3d4/0007/c1`. No scheme validation, no sanitization, no rewriting. |
| `TERM=xterm-256color`, no `TERM_PROGRAM` | Zero OSC 8 opens; `(chip:1)` printed after the label, exactly as documented. |

The renderer's link case is unconditional about it
(`pi-tui/dist/components/markdown.js:532`): if `getCapabilities().hyperlinks`
it emits `hyperlink(styledLink, token.href)` with `token.href` untouched;
otherwise it appends `` (${token.href}) ``. So the URL is ours to choose.

The third row also confirms the detection trick in §5 works: the two regimes
are trivially distinguishable in the painted bytes, so link mode can arm itself
without asking anyone.

`getCapabilities()` (`pi-tui/dist/terminal-image.js`) is env-sniffing, and it is
worth knowing which terminals it says yes to: Ghostty, kitty, WezTerm, Warp,
iTerm2, Windows Terminal, VS Code, Alacritty → `hyperlinks: true`. Under tmux it
shells out to `tmux display-message -p '#{client_termfeatures}'` and requires
`hyperlinks` in the list. screen, JetBrains, and anything unrecognised → false.

### 9b. Ghostty opens a custom scheme — but the platforms differ sharply

`processLinks` → `openUrl` → the apprt, falling back to `internal_os.open`
(`src/Surface.zig:4425`, `src/os/open.zig`).

**Linux (GTK apprt).** `Application.openUrl` sends anything that is not a path
or a `file://` URL to the XDG desktop portal
(`org.freedesktop.portal.OpenURI`), falling back to `xdg-open` if the portal
errors. The portal routes by the system's registered scheme handler, so a
`.desktop` file claiming `x-scheme-handler/pisnip` is exactly the right
registration. **This works as designed.**

**macOS — the problem.** The generic opener refuses OSC 8 outright:

```zig
// src/os/open.zig
if (comptime builtin.os.tag == .macos) {
    if (kind == .osc8) return error.UnsafeOSC8Link;
}
```

The native apprt handles it instead, through `UntrustedURL.decision`
(`macos/Sources/Helpers/UntrustedURL.swift`), which sorts an OSC 8 target three
ways:

| Target | Decision |
|---|---|
| `http`/`https` with a host, `mailto:` with a path | `.allow` — opens immediately |
| `file:` naming an existing, non-executable, non-script regular file or directory | `.allow` — opens immediately |
| **any other scheme** | `.confirm` — a modal alert per click, showing the target |
| malformed, scheme-less, invisible/bidi characters, executable or script files, `.command`/`.app`/`.desktop`/`.url`/… | `.deny` |

Ghostty's own tests pin it: `confirmsCustomSchemes` asserts
`vscode://…` and `ssh://…` land on `.confirm`.

So `pisnip://` is not blocked on macOS — it is *dialogged*, on every single
click. A modal per chip insertion is strictly worse than the mouse mode this
was meant to replace. The whole premise ("no terminal-mode funniness") does not
survive that on macOS.

### 9c. What that means for the design

Linux keeps the custom scheme. macOS needs a transport that lands in `.allow`,
and the file rule is the opening:

**`file://` to a real, boring file.** `fileDecision` allows a URL that names an
existing regular file, resolves symlinks first, has no query or fragment, no
remote host, is not in `unsafePathExtensions` (`app`, `command`, `desktop`,
`url`, `webloc`, `scpt`, `jar`, …), does not conform to `.application`,
`.executable` or `.script`, and does not have the executable bit set. A
zero-byte `0644` file named `…/pi-snippet/<token>/<msg>-c1.pisnip` meets every
one of those, and `NSWorkspace.open` then hands it to whatever app claims the
extension — our handler — **with no dialog**.

The cost is that the extension has to materialize one file per clickable target
and sweep them, and that the URL gets longer. It also means macOS registers a
document type rather than a scheme, which is a different (and slightly fussier)
Info.plist. Worth it: it is the difference between a click and a click-plus-modal.

Recommended split, then:

- **Linux:** `pisnip://<token>/<msg>/<id>` via the portal.
- **macOS:** `file:///…/<token>/<msg>-<id>.pisnip` via LaunchServices.
- Same socket, same handler, same extension-side code; only the URL builder and
  the installer differ per platform.

### 9d. Still unmeasured

- **Latency.** Portal round trip and LaunchServices dispatch, plus interpreter
  startup, on real hardware. If a chip takes a visible beat, link mode is a
  compatibility option rather than the recommended one.
- **The portal's first-run behavior** for a scheme with exactly one registered
  handler — silent dispatch or a chooser. If it prompts every time, Linux has
  the macOS problem too and `file://` becomes the answer on both.
- **`.pisnip` UTI classification** on a real Mac: a dynamic UTI for an unknown
  extension should conform to `public.data`, not `.script`, but that is inferred
  from the code rather than observed.

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

- Ghostty's gesture is settled (§2), but other hyperlink-capable terminals
  differ, so the help text still can't state one chord for everyone.
- ~~Should link mode be default on?~~ **Decided: yes.** Clicking and link mode
  both default on, guarded by the capability check and the no-silent-fallback
  rule (§2). The installer is now the real product decision, as predicted — a
  fresh install paints working hyperlinks the desktop cannot yet dispatch, and
  says so once when chips first appear.
- The inference gate now reads effective reachability (`clickActive()`) rather
  than the toggle, which preserves §17.2's intent — but with clicking on by
  default, a hyperlink-capable terminal now reaches that layer without anyone
  opting in. `magicEnabled` is left at its existing default; whether the paid
  layer should stay opt-in is a cost decision, not a wiring one.
- What does the unnumbered inferred anchor (PRD §17) do here? It is already a
  link, so it comes along for free — and since link mode costs nothing, the
  "inference is gated on click-to-insert as cost control" argument gets weaker.
  Worth re-reading §17 before assuming it still holds.
- Does anything else in pi already own a URL scheme, or want to? A scheme is a
  global per-machine namespace; `pisnip` is squatting.
