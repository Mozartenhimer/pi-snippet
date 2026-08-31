# Linux, Windows, and what each one still needs

`docs/terminal-resolved-clicks.md` designed clicking against Ghostty on Linux
and measured it there. `docs/linux-terminals.md` widened that to other Linux
terminals. This doc answers the next question — **what would it take to support
Windows, and what is Linux still missing** — and it separates, at every step,
what has been read out of a source tree from what still needs a real machine.

**Nothing here was run on Windows.** There is no Windows host in this project's
loop. Every Windows claim below is source-level evidence (Windows Terminal's own
`TerminalPage.cpp`, pi's shipped bundle) or a documented platform rule, and each
open question is marked. Treat the work items as a plan to be confirmed by the
first person with a Windows box, not as findings.

## What "support" actually means

Only *clicking* is platform-bound. The extension's other half — `<snippet>`
parsing, the chips, `Alt+N` insertion, the second-model layer, `/snippets` —
is in-band: it is text pi paints and keys pi delivers, and it works anywhere pi
runs. A platform that supports nothing below still gets numbered chips and
`Alt+N`.

Clicking is a chain of four obligations, and a platform needs all four:

| Link | Obligation | Linux today | Windows |
|---|---|---|---|
| **Paint** | pi-tui emits OSC 8 for the chip href | yes, per terminal | yes in Windows Terminal / VS Code; no in conhost |
| **Dispatch** | terminal resolves Ctrl+click and hands the URL to the OS | yes | yes — behind a per-click confirmation dialog, removable |
| **Register** | the OS knows which program handles `pisnip://` | `.desktop` + `mimeapps.list` | `HKCU\Software\Classes`, no admin |
| **Deliver** | the handler reaches this session's pi | unix socket in a 0700 dir | named pipe — different API, different security story |

Break any link and the chip is inert; paint without the other three and the
chip is *worse* than inert, because it looks clickable. That failure mode is
live in the code today — see work item 0.

## Linux

Supported, and the remaining work is about **terminal coverage**, not about the
mechanism. The mechanism is measured end to end (clicks doc §6, §9a, §9b).

What is left:

1. **The capability table is upstream.** The extension gates on pi-tui's
   `getCapabilities().hyperlinks`, and that function is env-sniffing in pi's
   own bundle. Read out of `@earendil-works/pi-coding-agent@0.84.4`
   (`dist/bundle/chunks/chunk-OMWWHBTG.js`, `detectCapabilitiesFromEnvironment`),
   the order is: `TMUX`/`TERM=tmux*` → asks tmux for `client_termfeatures`;
   `TERM=screen*` → false; `KITTY_WINDOW_ID`/`TERM_PROGRAM=kitty` → true;
   ghostty (`TERM_PROGRAM`, `TERM`, or `GHOSTTY_RESOURCES_DIR`) → true;
   `WEZTERM_PANE`/wezterm → true; warp → true; `ITERM_SESSION_ID`/iterm.app →
   true; **`WT_SESSION` → true**; `TERM_PROGRAM=vscode` → true;
   `TERM_PROGRAM=alacritty` → true; JetBrains → false; `process.platform ===
   "win32"` → false; everything else → false.

   So gnome-terminal, Konsole, xterm and foot get nothing — not because they
   cannot do it (VTE has painted OSC 8 since 0.48 and activates on Ctrl+click),
   but because pi-tui does not recognise them. `docs/linux-terminals.md` has
   the detection signals (`GNOME_TERMINAL_SCREEN`/`GNOME_TERMINAL_SERVICE`) and
   the ten-second probe. **The change is one entry in pi-tui, upstream; nothing
   in this repo moves.**

2. **Two things still unmeasured** (clicks doc §9d): portal round-trip latency
   on real hardware, and whether the portal silently dispatches a scheme with
   exactly one registered handler or shows a chooser on first use. If it
   prompts every time, Linux inherits the macOS problem.

3. **Namespaced installs.** A strictly-confined snap does not share `/tmp` with
   the desktop; `PI_SNIPPET_SOCKET_DIR` points both sides at a shared directory.
   Documented, not automated.

## Windows

### Paint — free, in the terminals people use

`WT_SESSION` is Windows Terminal's own marker and pi-tui maps it to
`hyperlinks: true`; `TERM_PROGRAM=vscode` covers the VS Code terminal. Legacy
conhost falls to the `win32 → false` branch and correctly gets bare labels.
Note the ordering: the `win32` branch is *last*, so it only catches consoles
that failed every other test — running under Windows is not by itself a "no".

`WT_SESSION` also propagates into WSL: Windows Terminal adds it to `WSLENV`
(microsoft/terminal#4157), so a pi running inside a distro paints URLs too.
That is the right answer for paint and the wrong one for delivery — see
*The WSL split* below.

### Dispatch — Windows Terminal allows it, then asks

Windows Terminal's `_OpenHyperlinkHandler`
(`src/cascadia/TerminalApp/TerminalPage.cpp`) runs two checks:

- `_IsUriSupported` — `http`/`https` yes; `file` yes when the host is empty,
  `wsl$` or `wsl.localhost`; **any other scheme yes**, with the comment *"the
  app manually output a URI other than file:// or http(s)://. We'll trust the
  user knows what they're doing when clicking on those sorts of links"*
  (GH#7562). `pisnip://` passes.
- `_IsUriConsideredSomewhatSafe` — `http`/`https` true; `file` true unless the
  path ends in a `PATHEXT` extension; otherwise **true only if the scheme is in
  the `safeUriSchemes` setting**. Fail it and the user gets a modal —
  *"This link may lead to an unsafe location…"* — with an **Open anyway**
  button, per click. Pass it and `ShellExecuteW(…, L"open", …)` fires straight
  away.

This is the same shape as the macOS problem (clicks doc §9b) with one decisive
difference: **the user can turn it off.** `safeUriSchemes` is a documented
global in `profiles.schema.json` — *"Specifies a list of URI schemes that are
considered safe. No confirmation will be required to open URIs with these
schemes."* Adding `"pisnip"` to it in `settings.json` makes Windows Terminal
behave exactly like Ghostty on Linux. macOS has no such escape hatch, which is
why macOS needs a different transport and Windows does not.

So `/snippets` → *Register click handler* on Windows is a two-part action: write
the registry keys, and tell the user (or offer to edit) the `safeUriSchemes`
line. Registration that does not mention the dialog would ship a feature that
works and feels broken.

The gesture matches Linux. `ControlInteractivity::PointerPressed` fires the
hyperlink only when `IsLeftButtonDown && ctrlEnabled && !hyperlink.empty()` and
`clickCount == 1` — Ctrl+left click, first click only, prioritised over VT
mouse events (GH#9396). Plain click keeps its selection meaning.

### Register — per-user, no admin, one awkward detail

The Windows equivalent of the `.desktop` + `mimeapps.list` pair is four
registry values under `HKCU\Software\Classes` (no elevation, per-user):

```
HKCU\Software\Classes\pisnip
    (Default)      = "URL:pi-snippet chip"
    "URL Protocol" = ""
HKCU\Software\Classes\pisnip\shell\open\command
    (Default)      = "<handler> \"%1\""
```

Writable from Node with `reg add`, and removable with `reg delete` — the
uninstall story is simpler than Linux's, where three files and a daemon cache
all have to be swept.

**The awkward detail is the console window.** `ShellExecuteW` opens the handler
with `SW_SHOWNORMAL`, so a console-subsystem program flashes a window on every
click. `node.exe` is console-subsystem. A click that blinks a black rectangle
is not the "no terminal-mode funniness" this design was chosen for. Options, in
the order worth trying:

1. `pythonw.exe` if present — the windowless Python host, and the existing
   handler is already a python3 script whose only POSIX-specific lines are the
   AF_UNIX socket and `os.getuid()`. Closest to zero new code.
2. A `wscript.exe` shim (`WScript.Shell.Run(cmd, 0, false)`) launching the real
   handler hidden — reliable, but two process spawns per click and Windows
   Script Host is disabled by policy in some managed environments.
3. A GUI-subsystem stub — correct, and this project ships no binaries.

Unmeasured and worth measuring first: click-to-insertion latency for whichever
of these is chosen. Two spawns plus an interpreter start could be a visible
beat, and the clicks doc already lists latency as the thing that decides whether
clicking is *the* path or a compatibility option.

### Deliver — a named pipe, not a socket

Node's `net` module speaks IPC on both platforms with the same API; only the
path shape changes. On Windows it must be under `\\.\pipe\` or `\\?\pipe\`.
Concretely:

- `socketDirCandidates()` (`link-server.ts`) becomes platform-split: the
  `XDG_RUNTIME_DIR` / `tmpdir()/pi-snippet-<uid>` list has no Windows meaning.
  A single name — `\\.\pipe\pi-snippet-<token>` — replaces the whole ordered
  list, because a pipe name is a namespace entry, not a file.
- `process.getuid` does not exist on Windows. The existing code already guards
  it (`typeof process.getuid === "function" ? … : 0`), which on Windows would
  put every user's socket dir at the same path — dead code once the pipe branch
  exists, but a real collision if the POSIX branch is left reachable.
- `clearStaleSocket()` becomes a no-op: a named pipe has no filesystem entry to
  strand, and vanishes with its process. The stale-socket problem the Linux
  code solves does not exist here.
- The handler's directory walk collapses to one name, and the
  `handlerSource()` ↔ `socketDirCandidates()` agreement (which the ssh-back
  design already stretches across three processes) gains a fourth shape.

**The security model does not carry over, and this is the one open risk.** On
Linux the guarantee is a `0700` directory: nothing else on the machine can
reach the socket. A Windows named pipe gets the default security descriptor,
and Node exposes no way to set an ACL on it (nodejs/node#30823 asks for exactly
this and is open). What the default DACL grants another logged-in user on the
same machine — and specifically whether it permits the *write* our protocol
needs — has to be measured before this ships, not assumed. The payload is only
an index and a message key, never text, so the worst case is another local user
inserting a suggestion the model already wrote into this session's composer;
that is a small hole, but it should be a known one.

### The WSL split — the SSH problem again, with a better verb

The common Windows setup is not native at all: Windows Terminal on the Windows
side, pi inside a WSL distro. Then paint and dispatch happen on Windows, while
the socket lives in Linux — the exact inversion `docs/ssh-back-handler.md`
describes, with `wsl.exe` where that doc has `ssh`.

Facts that shape it:

- `WT_SESSION` reaches the distro through `WSLENV`, so pi paints URLs and
  believes clicking is available.
- WSL2 **cannot** share AF_UNIX sockets with the Windows host — that interop
  was a WSL1 feature. Bridges (npiperelay + socat) exist precisely because of
  this gap.
- So the handler must be registered on the **Windows** side and relay inward:
  `wsl.exe -d <distro> -e <handler> <url>` runs the existing python3 handler
  inside the distro, where the unix socket is an ordinary local socket. No
  bridge, no forwarding flag, no per-session setup — strictly better than the
  SSH case, which needs `ssh -L` today.
- pi already detects this environment for its own keybindings:
  `useWindowsKeybindings()` treats `win32` and `linux + (WSL_DISTRO_NAME ||
  WSL_INTEROP)` alike. The extension's `overSsh()` needs the same companion —
  and the distro name for the relay comes from `WSL_DISTRO_NAME`.

### `Alt+N` on Windows — probably free, worth confirming

Two things that could have broken the chord do not:

- **Windows Terminal binds no `alt+<digit>`.** Its `defaults.json` uses Alt for
  `alt+f4`, `alt+enter`, `alt+space`, `alt+<arrow>` and `alt+shift+*` only, so
  `Alt+0`–`Alt+9` reach the application.
- **The kitty keyboard protocol now exists on Windows Terminal**
  (`src/terminal/input/terminalInput.cpp` implements the flag stacks and
  encoding). pi negotiates it — `DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS = 7`,
  queried with `CSI > 7 u` `CSI ? u` `CSI c` and parsed, with a legacy fallback
  when nothing answers — so pi gets unambiguous keys where the protocol is
  present and ESC-prefixed digits where it is not.

Flags 7 still excludes key-release events (flag 8), so the two-digit chord
commits on its 350 ms timeout on Windows exactly as it does on Linux. Nothing
to change; something to verify once.

### Testing — the harnesses do not travel

`npm test` is platform-neutral (vitest, fake pi, fake registry, settings
redirected by `PI_SNIPPET_SETTINGS`). The Python harnesses in `scripts/` are
not: they fork a pty, which is POSIX-only. A Windows equivalent needs ConPTY
(pywinpty, or node-pty), and would be a second implementation of the same
emulator — worth it only for `link-click-live.py` and `osc8-probe.py`, the two
that actually test the platform-specific chain.

## macOS

Out of scope for this ask and already researched: clicks doc §9b measured that
Ghostty's generic opener refuses OSC 8 outright on macOS
(`error.UnsafeOSC8Link`) and its native apprt sorts targets through
`UntrustedURL.decision`, where every custom scheme lands on `.confirm` — a
modal per click, with no user setting to disable it. §9c designs the way out: a
`file://` URL naming a real, boring, zero-byte `.pisnip` file, which
`fileDecision` allows outright. The contrast with Windows is the whole point of
splitting this doc from that one: **Windows's dialog is a setting the user can
change; macOS's is not.**

## Work items

Ordered by what blocks what. Nothing below item 0 is worth doing first.

0. **Stop painting dead links off Linux.** `linkOn()`
   (`pi-snippet-tui.ts`) is `isEnabled() && getCapabilities().hyperlinks &&
   (!overSsh() || remoteClicks)` — no platform term. On macOS today, and on
   Windows the moment anyone runs it, chips paint real `pisnip://` hrefs that
   nothing can resolve: a modal, then silence. `hintIfUnregistered()` is
   suppressed off Linux too, so nothing explains it. This is a bug on `main`
   independent of any Windows work.
1. **Split the URL/transport layer by platform** — `socketDirCandidates()` →
   one pipe name on `win32`, `clearStaleSocket()` → no-op, `handlerSource()`
   → a Windows variant. The `link-url.ts` shape (`pisnip://<token>/<msg>/<id>`)
   is unchanged; that is the point of an index-not-text URL.
2. **Measure the named-pipe DACL** on a real Windows box before shipping item 1.
   It decides whether the pipe needs its own handshake.
3. **Registry install/uninstall** in a `link-install-win.ts` sibling, plus the
   `safeUriSchemes` step in `/snippets` — the registration is not finished
   without it, and, like the Linux installer, it should prove the round trip
   rather than claim success.
4. **Pick a windowless handler host** and measure click-to-insertion latency.
5. **WSL relay**: detect `WSL_DISTRO_NAME`/`WSL_INTEROP` alongside `overSsh()`,
   register on the Windows side, relay with `wsl.exe -d <distro> -e`. Fold into
   the ssh-back handler's config rather than inventing a second mechanism.
6. **Linux terminal coverage** is an upstream pi-tui patch (gnome-terminal
   first), not work in this repo — and it is the single highest-value change
   for Linux users.
