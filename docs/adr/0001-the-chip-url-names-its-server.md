# ADR 0001: The chip URL names its server, and SSH always paints

**Status: accepted, implemented.** Supersedes the "the host never comes from
the URL" rule that `docs/ssh-back-handler.md` §Security and PRD §12.1 used to
state; both now describe what is below.

Shipped as described, with two notes where the build settled a detail:
`PI_SNIPPET_HOST` is the escape-hatch env var named under *Assumptions*, and
the handler compares host names on their first label (case-insensitively, with
`localhost` always meaning this machine) to decide whether the named host is
itself. The container harness (`scripts/ssh-click-docker.py`) covers the flow
and both negative cases under *Testing*; a second DNS name for the same sshd is
what makes the `known_hosts` case testable.

## Context

Clicking works over SSH today, by the ssh-back relay: the client's desktop
dispatches `pisnip://<token>/<msg>/cN` to a handler, the handler finds no local
socket, reads a host list from `~/.pi/agent/pi-snippet-remotes.json`, and
tunnels the click back through `ssh <host> '<fixed python one-liner>' <url>`.

That works, and it costs two pieces of per-machine setup and four pieces of
machinery to support them:

- The **host list** on the client, because the URL does not say where the
  session lives. Written by a bootstrap line pasted once per client machine.
- The **walk and the cache**, because a list is not an answer: the handler
  tries hosts in order until a session answers, then remembers which one did in
  `$XDG_RUNTIME_DIR/pi-snippet-relay-<token>` so the next click skips ahead.
- The **stamp** on the server (`pi-snippet-relay-clients/<address>`), because
  the server will not paint a URL it has no reason to believe anyone can
  dispatch. Written by the second half of that same bootstrap line.
- The **gate** in the extension that reads it (`syncRelay`, `relayed`), and the
  two `/snippets` rows that set the other two up.

All four exist to answer one question the server already knows the answer to:
*which machine is this session on*. The server declines to say, and the two
ends spend a config file, a directory of stamps and a search to rediscover it.

## Decision

**1. The chip URL carries the server's own name.**
`pisnip://<host>/<token>/<msg>/cN` — the token moves out of the netloc and into
the path, and the netloc becomes the host. The handler relays to that host.

**2. One shape, everywhere.** A local session paints its own hostname too. The
handler tries local sockets first as it does now, so a local click never
touches the network and never notices the difference; the host in the URL only
matters once the local scan misses. When the named host *is* this machine, the
relay is skipped rather than ssh-ing to ourselves, which keeps a click on dead
local scrollback instant and silent.

**3. Over SSH, chips always paint URLs.** There is nothing left to gate on:
the URL is self-routing, so no evidence about the client is needed before
painting one. `linkOn()` stops branching on SSH entirely — a remote session
becomes indistinguishable from a local one.

**4. Setup collapses to registering the handler, once per client machine.**
That is the floor: a click can only be received by something the desktop
already knows how to dispatch to, so *something* has to be installed before the
first click. Everything above it goes.

### What replaces the allowlist

The rule this reverses existed because a `pisnip://` URL is reachable by things
that are not us. Anything that can put a clickable link in front of the user —
a web page, a fetched document, and most realistically **a model reply, since
pi-tui renders markdown links as OSC 8** — could name a host, and the click
would become `ssh <that host> …`.

What makes that acceptable is that ssh already keeps an allowlist, and this
design leans on it deliberately: the relay runs `BatchMode=yes`, which turns
`StrictHostKeyChecking`'s "ask" into a hard failure, so a host that is not
already in `known_hosts` is refused at the host-key check — before
authentication, before the agent is ever offered. The reachable set is
therefore "machines this user has connected to before", maintained by ssh, not
by us. Against one of those, the fixed one-liner can connect to a unix socket
named by an 8-hex token and write a path to it; inserting text still requires
that token to match a session live on that host at that moment.

We swap an allowlist we maintain for one ssh maintains. That is the whole of
the security argument, and it is why the guards below are not optional.

### Guards that ship with this, not after it

- **No leading `-` in the host, and `--` before it in the argv.** `ssh -o … -J
  evil.com <cmd> <url>` makes ssh read the host slot as an option and shift the
  destination to the next argument. The current host pattern
  (`^[A-Za-z0-9._@-]{1,255}$`) accepts `-Jevil.com`. Harmless while only the
  user could write that string; remotely triggerable the moment it comes from a
  URL.
- **The netloc is validated as a host, not by `isalnum()`.** It stops being a
  hex token and starts being a hostname, and it reaches an `ssh` argv.
- **The path pattern grows a segment and stays strict.** URL shape is still
  checked *before* anything shells out, because `ssh host cmd arg` re-parses
  the command line in a remote shell. That remains the security boundary; the
  fixed argv remains defence in depth.
- **The token is still resolved against live link targets in-process.** Nothing
  about this changes what a delivered click can address.

## Assumptions

**Hosts are reachable by hostname.** The server paints what it calls itself,
and the client dials it. This is stated as an assumption because the two ends
genuinely cannot negotiate it: `hostname` may be meaningless off-box
(`ip-10-0-3-14`), and `SSH_CONNECTION`'s address may be a NAT or a tunnel
endpoint. Where it does not hold, a click times out after `ConnectTimeout=3`
and says nothing — the same silence as a dead session, with nothing to debug.
If that ever bites, the cheap escape hatch is one string on the *server* (an
env var naming what to paint), not a config file back on the client.

## Consequences

**Deleted:** `remotesPath` / `readRelayHosts` / `addRelayHost` and the file
they own; `relayClientsDir` / `relayClientSeen` and the stamp directory;
`relayBootstrapLine` and `HOST_PLACEHOLDER`; `syncRelay` and the `relayed`
flag; both `/snippets` rows (*SSH relay setup* on the server, *SSH relay hosts*
on the client); the handler's `relay_hosts` / `remembered` / `remember` and the
token→host cache; `explain_once` and its rate-limit stamp, whose one job was to
report the unconfigured state that no longer exists. The container harness
loses the bootstrap-scrape and two-host phases.

**Better:** no setup beyond the handler; no walk, so a click is one ssh instead
of up to N; nothing per session, nothing per project; and one URL shape with
one parser story instead of a local shape and a remote one.

**Worse:** a click that cannot be delivered is silent in one more way than
before. With `explain_once` gone, a laptop with no handler does nothing
visible, and an unreachable host costs three seconds of nothing. The server
also loses the ability to say honestly whether clicking will work here — it
paints URLs unconditionally and finds out never.

**Cutover:** the URL shape changes, so the handler must be re-registered on
each client. Not versioned, not negotiated, and not worth either while the
user count is one.

## Alternatives considered

- **A literal `pisnip://remote/…` marker, with the client discovering the host**
  from its own live `ssh` processes or `known_hosts`. Keeps the old invariant
  exactly, and still gets to zero config. Rejected as more machinery for the
  same result: discovery is a search with its own failure modes, and the server
  already knows the answer.
- **The server's SSH host key fingerprint as a selector**, matched against
  `known_hosts` to find the alias to dial, never dialled directly. Strictly
  safer — the URL selects among machines the client already knows rather than
  naming one — and it dodges the naming assumption above. Rejected for now as
  paying for a threat the `known_hosts` gate already blunts, and for putting a
  lookup between the click and the connection. This is the fallback if the
  naming assumption fails.
- **Keeping the stamp and the config file** (the status quo). Rejected: it is
  the setup this ADR exists to remove.
- **`http://server:port` chip URLs.** Zero client setup, since every desktop
  has a browser. Rejected: a tab per click, and a network listener on the
  server.
- **Mouse reporting**, the original design. Genuinely zero-setup and in-band.
  Rejected before, for taking the scroll wheel and text selection away from the
  terminal; unchanged here.

## Testing

The container harness gets shorter and stricter: no line to paste, so the flow
is *start pi over SSH → send a message → chips carry URLs → click → text lands*,
with no setup phase at all. Two negative cases are worth adding as the guards
above are the whole safety argument: a URL whose host is not in `known_hosts`
must produce no delivery, and a host with a leading `-` must be refused before
`ssh` is spawned.
