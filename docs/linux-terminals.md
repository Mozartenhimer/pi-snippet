# Terminal-resolved clicks on other Linux terminals

`docs/terminal-resolved-clicks.md` measured the Ctrl+click method against
Ghostty. This doc is about everyone else — which terminals can play the same
game, what each one contributes to the chain, and what it would take to switch
one on. **gnome-terminal is the working example**, because it is the terminal
people are most likely to be sitting in front of on a stock Linux desktop, and
because it is the one our detection currently turns away.

The method has one contract, and every terminal that honours it works without
further changes on our side:

```
pi-tui paints OSC 8 → terminal underlines the chip → Ctrl+click
  → terminal dispatches the URL to the desktop default handler
  → gio / xdg-desktop-portal looks up x-scheme-handler/pisnip in mimeapps.list
  → handler script forwards the URL → per-session unix socket → insertion
```

The terminal's only two obligations are **paint** the hyperlink (OSC 8) and
**dispatch** the Ctrl+clicked URL to the system opener. Everything after the
terminal — the scheme lookup, the handler, the socket — is terminal-agnostic
and already measured (§6 of the clicks doc).

## Status per terminal

Everything in bold was measured here, on Ubuntu 24.04 under Xvfb, with real pi
0.84.4 painting real chips and xdotool pressing a real mouse button — chip →
terminal → desktop handler → session socket → composer, end to end
(`scripts/terminal-click.py`). The rest is reported-by-documentation.

| Terminal | Paints OSC 8 | Acts on a `pisnip://` click | Detected by pi-tui | Clicking works today |
|---|---|---|---|---|
| Ghostty | yes | yes (Ctrl+click) | yes | yes |
| **kitty 0.32.2** | **yes** | **yes — plain, Ctrl+Shift, Shift; *not* plain Ctrl** | **yes** (`KITTY_WINDOW_ID`) | **yes, as shipped** |
| WezTerm | yes | yes | yes | yes |
| Warp | yes | yes | yes | yes |
| iTerm2 / Windows Terminal | yes | yes | yes | yes |
| VS Code | yes | yes | yes | yes |
| **gnome-terminal (VTE 0.76)** | **yes** | **yes — Ctrl+click, Ctrl+Shift+click** | **no** | **only with `PI_HYPERLINKS=1`** |
| **Alacritty 0.13.2** | **yes** | **yes — any gesture, no modifier needed** | **no** | **only with `PI_HYPERLINKS=1`** |
| **Konsole 23.08.5** | **paints, but its OSC 8 links are inert** | **no** | **no** | **no** |
| **xterm 390** | **no** | **no** | **no** | **no** |
| foot | yes | yes | no | no |
| tmux / GNU screen | forwards only if client advertises `hyperlinks` | outer terminal's gesture | conditional (pi-tui asks tmux) | conditional |

There is only one detection column because there is only one table: the
extension gates on pi-tui's `getCapabilities().hyperlinks` rather than on a
copy of its answers.

"Detected by pi-tui" is the load-bearing column, and it is why a terminal does
not work merely by being able to: **pi-tui decides whether to emit OSC 8 at
all**, from its own capability table (`getCapabilities()`, measured in the
0.84.x bundle: kitty, ghostty, wezterm, warp, iTerm2, Windows Terminal, VS
Code, and an Alacritty entry that never fires — unknown terminal ⇒ no
hyperlinks). The extension asks that same function, so the two can no longer
disagree. Guess more generously than pi-tui and every chip trails a visible
`(pisnip://a1b2c3d4/ff2ee691/c1)` — pi-tui falls back to printing the href in
parentheses wherever it decided not to emit OSC 8. Guess more stingily and a
terminal that could have worked gets nothing.

`PI_HYPERLINKS=1` and `=0` force pi-tui's answer either way. On a terminal that
renders OSC 8 but pi-tui does not recognise — gnome-terminal and Alacritty
both, measured — `PI_HYPERLINKS=1` is the whole fix, and clicking works from
that moment: it is what the two harness rows above were run with.

**If clicking does nothing in your terminal, this is the order to check it in:**

1. Is a chip a hyperlink at all? Hover it. No underline anywhere and no
   `(pisnip://…)` in the text means pi-tui decided your terminal has no
   hyperlinks — the common case, and `PI_HYPERLINKS=1` answers it.
2. Does the terminal act on OSC 8 at all? The renderer-independent probe
   below, with no pi involved, separates "pi did not paint it" from "the
   terminal ignores it" (Konsole ignores it).
3. Is the handler registered? `/snippets` → *Register click handler*, or
   `python3 scripts/link-register.py --status`.

## gnome-terminal, specifically

**It works — every part of it except the detection.** Measured with
`scripts/terminal-click.py gnome-terminal`: pi painted chips (hyperlinks
forced), a Ctrl+click on one went out through `gtk_show_uri` → the portal →
our `mimeapps.list` registration → the handler → the session socket, and the
suggestion landed in the composer. Ctrl+Shift+click works too; a plain click
and a Shift+click do not, which is the trade the clicks doc wanted: plain click
keeps its selection meaning.

That is VTE, so the same applies to the rest of the family in principle: VTE
has rendered OSC 8 since 0.48 (2017 — any gnome-terminal from 3.26 onward),
and no configuration was needed here beyond a registered scheme handler.

What is missing is only that pi-tui does not know it. gnome-terminal identifies
itself through the variables it sets in its children — `GNOME_TERMINAL_SCREEN`,
`GNOME_TERMINAL_SERVICE`, and `VTE_VERSION` (7600 on the machine measured) —
never through `TERM_PROGRAM`, which it does not set at all; `TERM` is the
unspecific `xterm-256color`. Those variables are the reliable detection signal;
`COLORTERM=truecolor` is common to many terminals and too generous to key on.
The change is one entry in pi-tui's capability table (upstream
`@earendil-works/pi-tui`); the extension reads `getCapabilities().hyperlinks`,
so an upstream entry is the whole change — bump the dependency and the chips
light up. (There used to be a second table in `osc8.ts` that had to move in the
same commit; it drifted anyway, and was deleted.) Until then,
`PI_HYPERLINKS=1`.

**One VTE-family caveat that is easy to misread as a bug:** gnome-terminal
underlines hyperlinks only on hover (and only some themes show any affordance
at rest). A chip that never looks clickable is still clickable.

**Two things that will stop you reproducing this headless**, neither of them
about hyperlinks: gnome-terminal is a thin client of `gnome-terminal-server`,
so a machine with no desktop session needs `dbus-run-session`, and the server
refuses to start in a non-UTF-8 locale with one line on stderr and no window.
`terminal-click.py` handles both, and also hunts for a python that can import
`gi` — the launcher is a python script, and on a box where `/usr/bin/python3`
is not the interpreter `python3-gi` was built for it dies with a confusing
partially-initialised-`gi` ImportError.

## Konsole, specifically

**Konsole is the one terminal here that does not hold up its end**, and it is
worth knowing why before filing it as our bug. Measured on 23.08.5 (Ubuntu
24.04):

- A chip painted by pi (hyperlinks forced) is *inert*: no underline on hover,
  and no gesture — plain, Ctrl, Ctrl+Shift, Shift — reaches the socket.
- It is not the URL scheme, and not the desktop side. Konsole's ordinary
  plain-text URL filter, on a literal `https://…` printed as text, opens on
  Ctrl+click through the very same `mimeapps.list` handler in the very same
  session. Its opener works; its OSC 8 path does nothing.
- It is not just the default, either. Upstream's default is
  `AllowEscapedLinks=false` with `EscapedLinksSchema` of
  `http://;https://;file://` — so out of the box Konsole ignores OSC 8
  entirely, and even a custom scheme would be refused. Turning it on in a
  profile (`[Interaction Options]`, `AllowEscapedLinks=true`, plus `pisnip://`
  added to `EscapedLinksSchema`) changed nothing here: an OSC 8 `https://`
  link stayed inert too, with either terminator (BEL and ST both tried).

So on Konsole, chips are labels. `Alt+N` still addresses them, which is the
whole point of the superscript, and nothing about the display is wrong — pi-tui
does not detect Konsole either, so it never paints a URL there in the first
place and there is no paren fallback to trip over.

## kitty, specifically

**kitty is the terminal that works with nothing set at all**, and the only one
of the four measured here that does. pi-tui detects it (`KITTY_WINDOW_ID`), so
chips paint as OSC 8 in a stock session, and `terminal-click.py kitty --stock`
— nothing forced — clicked one and watched the suggestion arrive in the
composer. If you want clicking today and are choosing a terminal, this is it.

Its gestures are the odd ones: **plain click**, Ctrl+Shift+click and
Shift+click all activate a hyperlink, but plain **Ctrl+click does not** — kitty
binds that combination elsewhere. Worth knowing before concluding that clicking
is broken, since Ctrl+click is the gesture every other terminal here documents.

## Alacritty, specifically

Alacritty is the one row in the table that was wrong in both directions: it was
listed as painted-by-pi-tui when it never is, and its two terminal obligations
were listed as unverified when in fact it honours both. Both halves were
measured on 0.13.2 with `scripts/terminal-click.py`, which puts a real window
on a display, runs real pi in it, and clicks the chip with a real pointer.

**The terminal does everything asked of it.** Its default configuration ships a
hint with `hyperlinks = true` and `command = xdg-open`, so an OSC 8 URL is
matched by the hyperlink itself and never by the hint's URL regex — which is
what lets a scheme the regex has never heard of through. A click on a chip ran
`xdg-open pisnip://vm/2c64141d/ff2ee691/c1`, verbatim, and the suggestion
landed in the composer: paint, dispatch, handler, socket, insertion, all of it.

**The gesture is a plain left click, no modifier.** Alacritty's default hint
sets no mouse mods (`HintMouse { enabled: true, mods: Default::default() }`),
so Ctrl is not needed — though Ctrl+click and Ctrl+Shift+click work too, since
the mods are a floor and not a filter. Selection is not lost to this: a *drag*
across a chip selects and does not activate, because a hint fires on a click
that did not become a drag. Ctrl+Shift+O opens the same hints from the
keyboard. This is the one terminal in the table where the README's "Ctrl+click"
is more ceremony than the terminal requires.

**The first click after the window takes focus is swallowed**, reproducibly:
click, nothing; click again, it fires — and every click after that works, with
or without a modifier. Not worth a bug report, but it is exactly the shape of
"clicking doesn't work" someone would give up over, and it is why the harness
spends one click before it starts measuring gestures.

**pi-tui never paints the links there, and cannot.** Its Alacritty entry is
`TERM_PROGRAM === "alacritty"`, and **Alacritty sets no `TERM_PROGRAM`** — not
in 0.13.2 (it exports `ALACRITTY_WINDOW_ID`, `ALACRITTY_SOCKET`,
`ALACRITTY_LOG`, `COLORTERM=truecolor` and `TERM`, and nothing else), and not
upstream either: the string appears nowhere in `alacritty_terminal/src/tty/`
or in the changelog through 0.18.0-dev. So the entry is dead code that can only
fire for someone who sets the variable by hand. `TERM` is no help as a
substitute in every case either — Alacritty falls back to
`TERM=xterm-256color` whenever its own terminfo entry is not installed
(`terminfo_exists("alacritty")`), which is what a container without
`ncurses-term` looks like. With the entry installed, which is the ordinary
desktop case, it is `TERM=alacritty`.

What a stock session looks like, then: the chip paints as a bare superscript
label — correctly, with **no** trailing `(pisnip://…)`, since the extension
gates on the same `getCapabilities().hyperlinks` that said no — and a click
reaches nothing at all. `terminal-click.py alacritty --stock` asserts exactly
that, so the day pi-tui learns to detect Alacritty, the harness fails and says
so.

Two fixes, one of them not ours:

1. **Upstream, one line: `TERM`.** The entry becomes
   `termProgram === "alacritty" || term.includes("alacritty")`, which is
   exactly the shape the ghostty entry beside it already has. **Verified by
   patching it into a real pi**: with that one clause, a stock Alacritty
   session — nothing forced, no `PI_HYPERLINKS` — painted OSC 8 chips with no
   paren fallback, and every gesture inserted. `terminal-click.py alacritty
   --stock` then reports `UNEXPECTED … has pi-tui learned to detect it?`,
   which is the harness noticing the fix landed.

   `TERM` beats the `ALACRITTY_WINDOW_ID` this doc first suggested, for a
   reason this repo cares about more than most: **`TERM` crosses ssh and that
   variable does not.** ssh carries `TERM` in the pty request itself
   (RFC 4254 §6.2) while `ALACRITTY_*` is dropped unless someone has written
   `SendEnv`/`AcceptEnv` rules for it — and a remote pi painting chips for a
   local Alacritty to click is the whole of the SSH story here (ADR 0001).
   Its one blind spot is the terminfo fallback above: no `alacritty` terminfo
   entry, no `TERM=alacritty`. Keying on both covers that, in that order.

   None of this makes gnome-terminal work: VTE sets `TERM=xterm-256color` and
   always has, so its entry has to be `GNOME_TERMINAL_SERVICE`/`VTE_VERSION`.
   Konsole is the same, and would not benefit anyway.
2. **Today, for a user**: `PI_HYPERLINKS=1` in the environment pi runs in.
   Measured end to end — chip, click, insertion — with no other change and
   without pretending to be a different terminal.

**A warning for whoever tries that patch**, because it cost an hour here: the
capability table exists in *three* copies on a machine, and two of them are
live. esbuild bundles pi-tui into `dist/extension/pi-snippet-tui.js`, so the
extension carries its own copy and that is what decides whether a chip gets an
href; pi's renderer reads pi's own copy, nested at
`pi-coding-agent/node_modules/@earendil-works/pi-tui`, and that is what decides
whether an href is emitted as OSC 8 or printed in parentheses; a third,
inert copy sits inside pi's `dist/bundle/chunks/`, which `dist/cli.js` never
loads. Patch only the extension's and you get precisely the failure this repo
warns about — `¹rebuild the solution (pisnip://…)`, visible parens, because the
two answers disagreed. That is the concrete shape of "the gate has to agree
with the renderer that would print the parens".

## The same test for any other terminal

Two probes, in this order. The first needs no pi at all — print a hyperlink and
click it, with `python3 scripts/link-register.py --probe` listening:

```sh
printf '\x1b]8;;pisnip://probe000/0000/ping\x07click me\x1b]8;;\x07\n'
```

An `ok` line proves paint *and* dispatch in one gesture, and its silence is
what separates a terminal that ignores OSC 8 (Konsole, xterm) from one pi-tui
merely does not recognise. Try the modifiers: the gesture varies more than the
support does — Ctrl on VTE, Ctrl+Shift or nothing on kitty, anything at all on
Alacritty.

Then the whole thing, with pi in the loop:

```sh
DISPLAY=:0 python3 scripts/terminal-click.py <terminal>
```

Adding a terminal to that harness is a `SPEC` entry — how to launch it around a
shell command, its X window class, and the gesture its own documentation names.
If both probes pass, the terminal is a candidate; add it to pi-tui's table
upstream. If OSC 8 paints but no gesture dispatches, the URL is still painted
and the paren-fallback risk is zero, but the click will not reach us.

Note the snap, if the probe hears nothing: a strictly-confined pi and the
desktop may not share a namespace, so point both sides at a shared directory
with `PI_SNIPPET_SOCKET_DIR` (clicks doc §9d) before concluding the terminal is
at fault.

## The desktop side is shared by all of them

Everything below the terminal is per-desktop, not per-terminal, and one lesson
from it is now baked into the uninstaller (`link-install.ts`):

- gio resolves a scheme through `~/.config/mimeapps.list`, then the legacy
  `~/.local/share/applications/mimeapps.list`, then `mimeinfo.cache`. An
  uninstall that cleans only the first leaves the desktop answering "pisnip://
  is handled" — which is exactly what "I removed it and it's still registered"
  looks like. Uninstall now cleans all three, preserves other handlers sharing
  the scheme line, and then asks `xdg-mime query default` rather than claiming
  success.
- Long-lived desktop daemons (the portal, GVfs) cache the handler database.
  When the files are clean but clicks still behave, `systemctl --user restart
  xdg-desktop-portal` is the fix; the `/snippets` remove action says so when
  its own verification is inconclusive.
- Under GNOME the dispatch goes through `xdg-desktop-portal-gtk` with
  `ask=false` semantics for registered schemes; the probe ordering in
  `link-install.ts` (portal, then `gio`, then `xdg-open`) mirrors what a GTK
  apprt actually tries first.
