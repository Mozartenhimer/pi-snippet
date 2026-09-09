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

| Terminal | OSC 8 | Ctrl+click | Painted by pi-tui today |
|---|---|---|---|
| Ghostty | yes | yes | yes |
| kitty | yes | yes (configurable) | yes |
| WezTerm | yes | yes | yes |
| Warp | yes | yes | yes |
| iTerm2 / Windows Terminal | yes | yes | yes |
| VS Code | yes | yes | yes |
| **gnome-terminal (VTE)** | **yes** (VTE ≥ 0.48) | **yes** | **no** |
| Konsole | yes | yes | no |
| xterm | yes (recent builds) | yes | no |
| foot | yes | yes | no |
| **Alacritty** | **yes** (0.13.2, measured) | **yes — plain click, no modifier** | **no** (see below) |
| tmux / GNU screen | forwards only if client advertises `hyperlinks` | outer terminal's gesture | conditional (pi-tui asks tmux) |

There is only one detection column because there is only one table: the
extension gates on pi-tui's `getCapabilities().hyperlinks` rather than on a
copy of its answers.

"Painted by pi-tui today" is the load-bearing column, and it is why a VTE-based
terminal does not work merely by being able to: **pi-tui decides whether to
emit OSC 8 at all**, from its own capability table (`getCapabilities()`,
measured in the 0.84.x snap binary: kitty, ghostty, wezterm, warp, iTerm2,
Windows Terminal, VS Code, and an Alacritty entry that never fires — unknown
terminal ⇒ no hyperlinks). The extension
asks that same function, so the two can no longer disagree. Guess more
generously than pi-tui and every chip trails a visible
`(pisnip://a1b2c3d4/ff2ee691/c1)` — pi-tui falls back to printing the href in
parentheses wherever it decided not to emit OSC 8. Guess more stingily and a
terminal that could have worked gets nothing.

`PI_HYPERLINKS=1` and `=0` force pi-tui's answer either way, which is the
quickest way to see both regimes without changing terminal.

Ghostty and Alacritty are measured here — Ghostty in the clicks doc, Alacritty
by `scripts/alacritty-click.py`, which drives a real window. The rest are
reported-by-documentation; each has the ten-second test below.

## gnome-terminal, specifically

VTE (the widget gnome-terminal is built on) has rendered OSC 8 hyperlinks since
0.48 (2017, so any gnome-terminal from 3.26 onward), and activation is
**Ctrl+left click** — plain click keeps its selection meaning, which is exactly
the trade the clicks doc describes wanting. Under GNOME, the opened URL goes
through `gtk_show_uri` → the freedesktop portal → gio's default-handler lookup,
which is the same dispatch path the Ghostty probe exercised via `gdbus call …
OpenURI`. In other words: gnome-terminal needs no configuration, honours the
same `mimeapps.list` registration our installer writes, and would work
end-to-end today if pi-tui would paint the URLs.

Why it does not work today, and what it takes:

1. **pi-tui must emit OSC 8.** gnome-terminal identifies itself through the
   environment variables it sets in its children — `GNOME_TERMINAL_SCREEN` and
   `GNOME_TERMINAL_SERVICE` — not through `TERM_PROGRAM` (it sets none;
   `TERM` is the unspecific `xterm-256color`). Those two variables are the
   reliable detection signal; `COLORTERM=truecolor` is common to many
   terminals and too generous to key on. The change is one entry in
   pi-tui's capability table (upstream `@earendil-works/pi-tui`).
2. **Nothing to mirror here.** The extension reads
   `getCapabilities().hyperlinks`, so an upstream entry is the whole change —
   bump the dependency and the chips light up. (There used to be a second
   table in `osc8.ts` that had to move in the same commit; it drifted anyway,
   and was deleted.)
3. **Measure before enabling.** With pi running in gnome-terminal:
   - `scripts/osc8-probe.py` shows what pi-tui actually paints for a chip URL
     — an OSC 8 sequence, or the paren fallback.
   - The renderer-independent test, no pi involved:

     ```sh
     printf '\x1b]8;;pisnip://probe000/0000/ping\x07click me\x1b]8;;\x07\n'
     ```

     Ctrl+click the underlined text while
     `python3 scripts/link-register.py --probe` is listening; a `ok` line for
     the portal proves paint *and* dispatch in one gesture.
   - Note the snap: a strictly-confined pi and the desktop may not share a
     namespace, so if the probe hears nothing, point both sides at a shared
     directory with `PI_SNIPPET_SOCKET_DIR` (clicks doc §9d) before concluding
     the terminal is at fault.

**One VTE-family caveat that is easy to misread as a bug:** gnome-terminal
underlines hyperlinks only on hover (and only some themes show any affordance
at rest). A chip that never looks clickable is still clickable.

## Alacritty, specifically

Alacritty is the one row in the table that was wrong in both directions: it was
listed as painted-by-pi-tui when it never is, and its two terminal obligations
were listed as unverified when in fact it honours both. Both halves were
measured on 0.13.2 with `scripts/alacritty-click.py`, which puts a real window
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

**pi-tui never paints the links there, and cannot.** Its Alacritty entry is
`TERM_PROGRAM === "alacritty"`, and **Alacritty sets no `TERM_PROGRAM`** — not
in 0.13.2 (it exports `ALACRITTY_WINDOW_ID`, `ALACRITTY_SOCKET`,
`ALACRITTY_LOG`, `COLORTERM=truecolor` and `TERM`, and nothing else), and not
upstream either: the string appears nowhere in `alacritty_terminal/src/tty/`
or in the changelog through 0.18.0-dev. So the entry is dead code that can only
fire for someone who sets the variable by hand. `TERM` is no help as a
substitute either — Alacritty falls back to `TERM=xterm-256color` whenever its
own terminfo entry is not installed (`terminfo_exists("alacritty")`), which is
the common case on a distro that keeps it in a separate package.

What a stock session looks like, then: the chip paints as a bare superscript
label — correctly, with **no** trailing `(pisnip://…)`, since the extension
gates on the same `getCapabilities().hyperlinks` that said no — and a click
reaches nothing at all. `alacritty-click.py --stock` asserts exactly that, so
the day pi-tui learns to detect Alacritty, the harness fails and says so.

Two fixes, one of them not ours:

1. **Upstream, one line**: key the entry on `ALACRITTY_WINDOW_ID` the way kitty
   and WezTerm are keyed on `KITTY_WINDOW_ID` and `WEZTERM_PANE`, rather than
   on a variable Alacritty does not set. Nothing in this repo moves; bump the
   dependency and the chips light up.
2. **Today, for a user**: `PI_HYPERLINKS=1` in the environment pi runs in.
   Measured end to end — chip, click, insertion — with no other change and
   without pretending to be a different terminal.

## The same test for any other terminal

The `printf` probe above plus `link-register.py --probe` is the whole
checklist for the "should this go in the table" decision. If both pass, the
terminal is a candidate; add it to pi-tui's table upstream. If OSC 8 paints but Ctrl+click does nothing, the terminal's
gesture may be a different modifier (check its mouse-action documentation) —
the URL is still painted, and the paren-fallback risk is zero, but the click
will not reach us until the right gesture is known.

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
