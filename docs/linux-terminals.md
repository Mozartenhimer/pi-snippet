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

| Terminal | OSC 8 | Ctrl+click | Painted by pi-tui today | Detected by `osc8.ts` |
|---|---|---|---|---|
| Ghostty | yes | yes | yes | yes |
| kitty | yes | yes (configurable) | yes | yes |
| WezTerm | yes | yes | yes | yes |
| Warp | yes | yes | yes | yes |
| iTerm2 / Windows Terminal | yes | yes | yes | yes (non-Linux/Windows) |
| VS Code | yes | yes | yes | yes |
| **gnome-terminal (VTE)** | **yes** (VTE ≥ 0.48) | **yes** | **no** | **no** |
| Konsole | yes | yes | no | no |
| xterm | yes (recent builds) | yes | no | no |
| foot | yes | yes | no | no |
| Alacritty | verify | verify | yes (hmm — see below) | yes |
| tmux / GNU screen | forwards only if client advertises `hyperlinks` | outer terminal's gesture | conditional | conditional (`osc8.ts` asks tmux) |

"Painted by pi-tui today" is the load-bearing column, and it is why a VTE-based
terminal does not work merely by being able to: **pi-tui decides whether to
emit OSC 8 at all**, from its own capability table (`getCapabilities()`,
measured in the 0.84.x snap binary: kitty, ghostty, wezterm, warp, iTerm2,
Windows Terminal, VS Code — unknown terminal ⇒ no hyperlinks). `osc8.ts`
mirrors that table on purpose. Guess more generously than pi-tui and every chip
trails a visible `(pisnip://a1b2c3d4/ff2ee691/c1)` — pi-tui falls back to
printing the href in parentheses wherever it decided not to emit OSC 8. Guess
more stingily and a terminal that could have worked gets nothing.

Entries marked *verify* are reported-by-documentation rather than measured
here; each has a ten-second test below.

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
2. **`osc8.ts` must mirror it.** Add the same variables to `detectOsc8()` —
   in the same commit as the pi-tui change, or one of the two tables will
   disagree for the gap between releases and either parens or missing chips
   appear. That mirroring is a stated invariant of this extension
   (`osc8.ts`'s header); the check `npm run gen:widths` used to enforce for
   glyph widths is manual review for this table.
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

## The same test for any other terminal

The `printf` probe above plus `link-register.py --probe` is the whole
checklist for the "should this go in the table" decision. If both pass, the
terminal is a candidate; add it to pi-tui's table and to `detectOsc8()` in the
same commit. If OSC 8 paints but Ctrl+click does nothing, the terminal's
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
