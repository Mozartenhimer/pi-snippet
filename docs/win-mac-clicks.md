# Sketch: terminal-resolved clicks on Windows and macOS

`docs/terminal-resolved-clicks.md` designed and measured the Linux transport.
This doc is the per-platform sketch — what carries over unchanged, what each
OS forces to be different, and which parts are measured versus inferred. The
shape of the whole thing stays the same on every platform:

```
 chip → OSC 8 URL → terminal resolves the click → OS dispatch
   → registered handler → per-session IPC endpoint → insertion
```

What is per-platform is exactly two things: **the URL the chip carries** (what
the OS will dispatch without complaining) and **the installer** (what
registers the handler). The token, the message key, the chip ids, the
extension-side resolve-and-insert, and the IPC endpoint shape are all shared.

| Platform | Chip URL | Dispatch | IPC |
|---|---|---|---|
| Linux (shipped) | `pisnip://<host>/<token>/<msg>/c<n>` | portal → mimeapps.list | unix socket |
| Windows | `pisnip://<host>/<token>/<msg>/c<n>` | ShellExecute → registry | named pipe |
| macOS, Ghostty | `file:///…/<token>/<msg>-c<n>.pisnip` | LaunchServices | unix socket |
| macOS, iTerm2/kitty/WezTerm | `pisnip://<host>/<token>/<msg>/c<n>` | terminal-native hook | unix socket |

## 1. Windows

### 1a. The scheme survives, unedited

The macOS problem (§9b of the clicks doc) is Ghostty-specific: its native
apprt runs every OSC 8 target through `UntrustedURL.decision`, which
`.confirm`s unknown schemes. Windows has no equivalent gate. Windows Terminal's
hyperlink activation (Ctrl+click) and Alacritty's open-with-modifier both end
in `ShellExecute` on the URL, and ShellExecute resolves a custom scheme
through the registry with no per-click prompt when exactly one handler is
registered. So `pisnip://` ships as-is; `link-url.ts` is untouched.

(Inferred from how ShellExecute and WT are documented to behave, not measured
on a Windows box. The probe in §1d is the acceptance test, same as always.)

### 1b. Registration: three registry values, per-user

No `.desktop` analogue needed to be invented — the registry *is* the
mimeapps.list of Windows, and it is simpler:

```
HKCU\Software\Classes\pisnip
  (Default)      REG_SZ = "URL:pi-snippet chip"
  URL Protocol   REG_SZ = ""                       ← the magic value
HKCU\Software\Classes\pisnip\shell\open\command
  (Default)      REG_SZ = "C:\…\open-handler.cmd" "%1"
```

- **HKCU only** — no elevation, per-user, same principle as `XDG_DATA_HOME`.
- **Effective immediately.** ShellExecute consults the registry per dispatch;
  there is no portal daemon to restart, no `mimeinfo.cache` staleness. The
  uninstall-verification lesson (`link-install.ts` asks the desktop rather
  than trusting its own file writes) collapses to one `reg query`.
- **Quoted `"%1"` is correct here**, the opposite of the Linux Exec-line rule —
  ShellExecute parses the command line properly, and unquoted paths with
  spaces (anything under `C:\Users\<name with a space>\…`) would break.
- The classic pitfalls — DDE registration, `shell\open\ddeexec` — are simply
  not written; the plain command key wins.

### 1c. The IPC endpoint is a named pipe

There is no `AF_UNIX` filesystem namespace for a script to reach, but node
speaks Windows named pipes natively: `server.listen("\\\\.\\pipe\\pi-snippet-<token>")`
is a drop-in for the unix-socket path. `link-server.ts` needs one branch:
where `process.platform === "win32"`, the candidate list yields pipe names
instead of `join(dir, token + ".sock")`, and the stale-socket unlink/probe
logic becomes a no-op (pipes vanish with their server; there is no debris).

Security follows the same shape as the 0700 directory: a named pipe's default
DACL restricts connect to the creating user (plus admins), which is the same
guarantee as §7 of the clicks doc, arrived at by the OS instead of by us.

### 1d. The handler

`process.execPath` is `node.exe` on any npm-installed Windows pi (the
snap-binary case in `link-install.ts`'s comment is a Linux-only concern), so
the generated handler is a node script, written once, deriving token/msg/id
from `argv[2]` — the same stateless shape as the Linux handler:

```js
// open-handler.js — generated at install
const u = new URL(process.argv[2]);
if (u.protocol !== "pisnip:") process.exit(2);
const pipe = net.connect(`\\\\.\\pipe\\pi-snippet-${u.hostname}`);
pipe.write(u.pathname + "\n"); pipe.end(); pipe.on("close", () => process.exit(0));
```

The command line bakes in the absolute node path (found once, at install) plus
the absolute script path. Fallback for a pi that is not node-launched: a
PowerShell one-liner over `System.IO.Pipes.NamedPipeClientStream` — correct
but ~1s of interpreter startup per click, which is why it is the fallback and
not the default.

The probe fires `Start-Process 'pisnip://probe000/0000/ping'` and listens on
the pipe; same round-trip-or-it-doesn't-count rule.

## 2. macOS

### 2a. Ghostty refuses the scheme; the file rule is the way through

Recap of §9b/9c of the clicks doc, which measured this rather than assumed it:
Ghostty's macOS apprt sorts every OSC 8 target through `UntrustedURL.decision`,
and `pisnip://` lands on `.confirm` — a modal per click. Scheme transport is
dead there, not blocked-but-awkward. But the same decision table `.allow`s a
`file://` URL that names an existing, boring, non-executable regular file, and
`NSWorkspace.open` then hands it to whatever claims the extension **with no
dialog**. So on Ghostty/macOS the chip carries a file URL:

```
file:///Users/<u>/Library/Application Support/pi-snippet/sessions/<token>/<msg>-c<n>.pisnip
```

Every constraint of `fileDecision` is met by construction, and the two that
are inferred rather than measured (§9d) are the ones to check first on real
hardware:

- **`.pisnip` classification.** The app bundle declares its own UTI
  (`UTExportedTypeDeclarations`, identifier `dev.pisnip.chip`, extension
  `pisnip`, conforming to `public.data` — never `public.script`, never
  `com.apple.application`). Declared beats dynamic-UTI guessing.
- **Zero-byte, 0644, regular.** No executable bit, no query, no fragment, no
  host, symlink-resolved — the file writer enforces the whole list.

### 2b. Registration: an app bundle, not a plist fragment

LaunchServices routes a document by type to an *application* — there is no
`mimeapps.list` to write. The installer generates a minimal `.app` under
`~/Library/Application Support/pi-snippet/`:

```
pi-snippet-handler.app/
  Contents/Info.plist        ← UTI declaration (above) + CFBundleDocumentTypes
                               claiming it, LSHandlerRank = "Default"
  Contents/MacOS/<script>    ← the handler (2c)
```

then runs `lsregister -f` on it (the per-user equivalent of
`update-desktop-database`, at
`/System/Library/Frameworks/CoreServices.framework/…/LaunchServices.framework/Support/lsregister`).
Uninstall deletes the bundle and runs `lsregister -u`; the verification query
is ` duti`-style or a `LSCopyDefaultApplicationURLForURL` one-liner via
osascript — ask LaunchServices, never trust the file deletion (the exact
lesson `uninstall()` in `link-install.ts` already encodes for the portal).

### 2c. The handler: an applet that curl's the socket

macOS has unix sockets and one universally present tool that can speak to
one: `/usr/bin/curl` (`--unix-socket`). The handler script receives the
opened file's path from the `odoc` Apple event, parses token/msg/id out of the
path, deletes the file, and forwards:

```sh
sock="$HOME/Library/Application Support/pi-snippet/sessions/$token.sock"
curl -s --max-time 2 --unix-socket "$sock" "http://pisnip/$msg/c$n"
```

The one shared-code cost: `LinkServer.handle()` currently expects the bare
`/<msg>/c<n>` line, so it learns to also accept an HTTP request line whose
target parses (`GET /0007/c1 HTTP/1.1` → same `parseChipPath`). Everything
else — resolve, insert, `requestRender()` — is the Linux code verbatim.

The extension side gains the one piece Linux never needed: a **file
materializer**. Files must exist at click time, so the first paint of each
`(msg, id)` writes its zero-byte file under the session directory, bounded by
the same LRU shape as the message map, swept on `session_end`. This replaces
nothing — the socket server, the token, the resolve table are untouched — but
it is real new code, and it only exists on the macOS-Ghostty path.

### 2d. Everyone else on macOS: skip the OS entirely

iTerm2 (the dominant macOS terminal), kitty, and WezTerm all have a
terminal-native hook that runs a command for a clicked URL with no OS
registration at all — clicks doc §6b, and on macOS it stops being a footnote:

- **iTerm2**: Semantic History → "Run command…" with the URL as `\1`. The
  handler gets the *scheme* URL, so the chip carries plain `pisnip://…`, the
  file materializer never runs, and there is no LaunchServices anything.
- **kitty**: `open_actions.conf` mapping `pisnip://` to a command.
- **WezTerm**: the `open-uri` Lua event.

The installer detects `TERM_PROGRAM` ( iTerm2.app / kitty / WezTerm) and
offers the terminal-native registration instead of the app bundle when it
matches, falling back to the bundle + file transport for Ghostty and
everything else. `/snippets` should say which transport it armed, because on
macOS they differ *observably* (URL vs file path in a probe).

### 2e. Gesture

Ghostty's `ctrlOrSuper` is **Cmd+click** on macOS — Ctrl+click is
right-click territory there. The help text cannot reuse the Linux string;
this is a `/snippets` copy change, not a code one.

## 3. What actually changes in the tree

| Piece | Change |
|---|---|
| `link-url.ts` | Untouched. The scheme URL survives on Windows and on the macOS terminal-hook path; the file URL is built by a new platform module. |
| `link-server.ts` | Windows: pipe-name candidates instead of socket paths, no stale-socket unlink. macOS-Ghostty: accept an HTTP request line. Everything else untouched. |
| `link-install.ts` | Splits per platform behind one interface (`install/probe/isInstalled/uninstall` already is that shape): registry writes (Windows), app bundle + `lsregister` (macOS), existing desktop files (Linux). |
| new: chip file store | macOS-Ghostty only. Materialize-on-first-paint, LRU-bounded, swept at session end. |
| `/snippets` | Reports which transport armed and the per-platform gesture string. |

`process.platform` selects at load; `PI_SNIPPET_SOCKET_DIR` keeps its meaning
on every platform (a directory both sides can name).

## 4. Unmeasured, in order of how much they would hurt

1. **Windows: does any terminal prompt on first custom-scheme dispatch?**
   WT's ShellExecute path is expected to be silent, but Edge-style "How do you
   want to open this?" behavior from *some* opener would make Windows the
   macOS problem at one remove. Probe on real hardware before believing §1a.
2. **macOS: `fileDecision`'s real answer for a zero-byte `.pisnip`.** §9d's
   inference; a `.deny` here kills the whole file transport and leaves
   terminal-native hooks as the only macOS path.
3. **Latency on both.** LaunchServices + applet launch (macOS) and
   ShellExecute + node startup (Windows) are both plausibly a visible beat.
   The file transport's applet cold start is the worst suspect.
4. **Windows Terminal's OSC 8 painting of our URLs** — expected verbatim
   (§9a showed pi-tui passes hrefs through and WT is in the capability table),
   but nothing here has watched the bytes on Windows.
