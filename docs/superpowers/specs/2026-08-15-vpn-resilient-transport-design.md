# VPN-resilient Mac↔Windows transport

**Status:** design approved, pending spec review
**Date:** 2026-08-15

## Problem

When the Mac (server) is on a full-tunnel VPN, the link to a Windows client
disconnects continuously despite both machines sitting on the same LAN.

Four defects in the current code compound into a permanent disconnect loop:

1. `BindToInterface` returns `true` on Windows while doing nothing
   (`native/input.cc:170-180`). `netbind.available()` and every call site
   therefore believe pinning succeeded. The Windows UDP socket is never pinned.
2. The server applies `IP_BOUND_IF` to the **listening** socket after `listen()`
   (`src/main/net/server.js:41-48`) and to **already-established** accepted
   sockets (`server.js:90`). Routing is decided at connect/accept time; both
   calls are too late to have any effect.
3. `bindIf` is resolved once at engine start (`src/main/main.js:155`). A VPN
   connecting or reconnecting rewrites the routing table and nothing
   re-evaluates.
4. On teardown the client retries the same **static** `serverHost` every 1.5 s
   (`src/main/net/client.js:153`) while 7 s reapers on both sides keep tearing
   the link down.

## Research: how macOS Universal Control survives this

Universal Control runs on Apple's Continuity stack over **AWDL** (Apple Wireless
Direct Link), a peer-to-peer Wi-Fi protocol on the virtual `awdl0` interface.
Peers are found via BLE/mDNS and then communicate over **IPv6 link-local
addresses** (`fe80::…`) derived from the interface MAC.

**Why a full-tunnel VPN cannot break it.** A link-local address is scoped to an
interface rather than routed. `fe80::abc%en1` names both an address and the NIC
it lives on; the kernel sends straight out that NIC and **never consults the
routing table**. A VPN takes over connectivity by owning the default route (or
installing `0.0.0.0/1` + `128.0.0.0/1`). There is no route to steal for
link-local traffic — not because it is whitelisted, but because routing is not
involved.

This app does the opposite: routed IPv4 to a static address, which is exactly
the traffic a full-tunnel VPN captures.

**What is and is not transferable.** AWDL itself is Apple-proprietary and
Windows cannot join it. The transferable core is *link-local IPv6 over the
physical NIC, plus interface-scoped discovery*, which both platforms support.

**Prior art.** Nobody in this space has solved it. Deskflow explicitly declines
auto-discovery, Synergy removed Bonjour for instability, and Barrier directs
users to change their VPN settings. There is no library to copy.

## Verified findings

Tagged by how they were established. `verified` = executed and observed on this
machine; `documented` = vendor/RFC/source citation.

### Transport mechanics

- **[verified]** Node connects and listens over `fe80::…%en1` with no native
  addon, and `dgram` udp6 supports `setMulticastInterface('::%en1')` plus
  `addMembership('ff02::fb','::%en1')`.
- **[verified]** Zone-id syntax is **not portable**. macOS accepts the interface
  *name* (`%en1`) and rejects the numeric form (`%7` → timeout/`EHOSTUNREACH`).
  libuv uses `if_nametoindex()` on POSIX and `atoi()` under `_WIN32`
  (`uv-common.c:294-298`), so Windows accepts **only** the numeric index.
- **[verified]** Consequently **link-local address strings cannot be exchanged
  between machines.** `rinfo.address` is `fe80::…%13` on Windows and
  `fe80::…%en1` on macOS; each platform rejects the other's form. A beacon must
  never advertise its own link-local address as a usable string.
- **[documented]** A lost `%zone` is unrecoverable in pure Node — no
  `IPV6_PKTINFO` exposure. Probing candidate interfaces via `dgram.send()` is
  not a substitute: `send()` reports success for undeliverable destinations
  (one agent measured 9 false-positive interfaces for a single address).
- **[verified]** `net.isIP('fe80::1%Ethernet') === 6` — a name-form zone passes
  Node validation, then silently degrades to scope 0 on Windows. Zone ids must
  be validated as `/^\d+$/` on win32 before use.
- **[documented]** Windows keeps two indices per adapter (`IfIndex` for IPv4,
  `Ipv6IfIndex` for IPv6). Node's `os.networkInterfaces().scopeid` is
  `sin6_scope_id`, which is the IPv6 one — the correct value to use.
- **[documented]** Zone ids are **not stable**: Microsoft states they "may
  change when an adapter is disabled and then enabled" and "should not be
  considered persistent". They cannot be cached across VPN up/down, sleep, or
  Wi-Fi toggle.
- **[documented]** A dual-stack `::` listener accepts link-local inbound on
  Windows; `IPV6_PROTECTION_LEVEL` permits "same site" at all levels, and libuv
  forces `IPV6_V6ONLY=0`. Binding directly to a scoped address requires a
  nonzero zone, so **listen on `'::'`**, not on `fe80::…`.
- **[documented]** `autoSelectFamily` cannot implement the race: it is bypassed
  entirely when the host is an IP literal, which is this design's dialing mode.

### Environment constraints

- **[documented]** macOS 15+ Local Network privacy gates multicast send/receive,
  UDP unicast to local addresses, and TCP to local addresses (Apple TN3179).
  Requires `NSLocalNetworkUsageDescription` (and `NSBonjourServices` for mDNS)
  in the Info.plist, plus correct signing. `package.json` `build.mac` currently
  has no `extendInfo`.
- **[documented]** Windows Defender Firewall defaults to Block inbound on all
  profiles, and Wi-Fi defaults to the Public profile. A **non-admin who is
  prompted gets Block rules created no matter what they click**, and the prompt
  never reappears. This collides with commit `0eec665` ("keep per-user install
  scope"), which leaves the installer unelevated and unable to write rules.
- **[documented]** RFC 4541 §3 gives no flooding guarantee to any IPv6 multicast
  group except `ff02::1`; a conformant MLD-snooping switch may prune a custom
  beacon group.
- **[documented]** AP client isolation is an L2 filter and blocks IPv4 and IPv6
  identically — no fallback ladder survives it. It is on by default on
  guest/hotspot SSIDs. Must be detected and reported, not worked around.
- **[documented]** Cisco peer-to-peer blocking does **not** apply to multicast,
  so discovery succeeds while unicast is silently dropped. "Peer appeared in
  discovery" must never imply "peer is reachable" — a unicast round-trip is
  required before a peer counts as live.
- **[documented]** Full-tunnel WireGuard on Windows blocks link-local outright
  via WFP kill-switch filters, while permitting NDP — so discovery appears to
  work while the session silently fails.
- **[documented]** Node cannot set `IPV6_UNICAST_IF`/`IP_UNICAST_IF` on Windows:
  `LibuvStreamWrap::GetFD()` returns -1 under `_WIN32`. That path requires the
  native addon to own its own socket.

### Live bugs in current code

- **[verified]** `seqNewer()` (`client.js:244`) is not wrap-aware. `& 0xffffffff`
  coerces to **signed** int32, so the function returns `true` for every input —
  `seqNewer(100, 105) === true`. The stale-datagram drop has never worked; every
  out-of-order motion packet is applied. **This causes cursor jitter today.**
- **[verified]** A udp6 socket cannot send to a `::ffff:`-stripped IPv4 literal:
  `send(…, '127.0.0.1')` → `EINVAL`; `'::ffff:127.0.0.1'` succeeds. The strips at
  `server.js:96` and `server.js:199` become fatal the moment the motion socket
  is udp6.
- **[verified]** The input backend is a module-level singleton (`input.js:8-11`).
  `ServerCore.start()` attaches six anonymous listeners (`core.js:65-71`) and
  `stop()` never detaches them (`core.js:79-85`), so **every engine restart
  leaks a full set** and duplicates every input event.
- **[verified]** `server.stop()` clears `this.peers` synchronously before the
  sockets' async `close` fires, so `peer-disconnected` never emits
  (`server.js:73-79` vs `:131-136`). Layout nodes stay `online: true` and the
  cursor can cross into a dead peer.
- **[verified]** Duplicate `localId` silently evicts the earlier peer with no
  disconnect event and both sockets left open (`server.js:142-152`).
- **[verified]** Each socket's close handler arms its own reconnect timer but
  only one handle is tracked (`client.js:148-155`); `stop()` clears one.
- **[verified]** `deriveKey()` runs a ~49 ms blocking `scryptSync` on the
  Electron main thread on every `startEngine()` (`main.js:137`) — the same
  thread native input events marshal onto.
- **[verified]** CI never runs the tests. `.gitlab-ci.yml` declares only
  `stages: [build]`, and `package.json` chains the five test files with `&&`, so
  an early failure silently skips the rest.

## Staging

Two phases. Phase 1 is independently shippable and fixes real problems in
today's build; Phase 2 builds on it and is gated on a two-machine probe.

---

## Phase 1 — prerequisite correctness fixes

Shippable on its own. No new features, no config changes, no new dependencies.
Each item is a verified defect with a concrete acceptance test.

| # | Fix | Location | Acceptance |
|---|-----|----------|------------|
| 1.1 | `seqNewer` → `(((a-b) >>> 0) < 0x80000000) && a !== b` | `client.js:244` | `seqNewer(100,105)===false`, `seqNewer(1,50000)===false`, `seqNewer(105,100)===true`, `seqNewer(5,0xfffffffb)===true` |
| 1.2 | Reset `_lastMoveSeq = 0` in `_onConnected()` | `client.js:~97` | Motion resumes after a reconnect; without this, 1.1 turns each restart into a permanent freeze because the server's `_motionSeq` resets in its constructor while the client's high-water mark does not |
| 1.3 | Detach backend listeners in `ServerCore.stop()` / `ClientCore.stop()` | `core.js:65-71,79-85` | After 3 start/stop cycles, `backend.listenerCount('mousemove') === 0` when stopped and `=== 1` when started |
| 1.4 | Emit `peer-disconnected` for every peer in `server.stop()`; mark non-local layout nodes offline in `stopEngine()` | `server.js:73-79`, `main.js` | `stop()` with 2 peers emits 2 `peer-disconnected`; no layout node remains `online` after `stopEngine()` |
| 1.5 | Reject duplicate-id HELLO with `BYE 'duplicate-id'` instead of evicting | `server.js:142-152` | Second client with a colliding id is refused; the first peer's session is untouched |
| 1.6 | Idempotent reconnect: guard `if (this._reconnectTimer) return;`, null it inside the callback; add an `_attemptId` epoch checked by socket callbacks | `client.js:148-155` | N close events schedule exactly 1 reconnect |
| 1.7 | Cache the derived key by `passphrase+group`; reuse across restarts | `main.js:137`, `crypto.js:29-35` | Second `startEngine()` with unchanged credentials performs no `scryptSync` |
| 1.8 | CI runs the suite; test files run independently, not `&&`-chained | `.gitlab-ci.yml`, `package.json:9` | A failure in test 1 does not hide failures in tests 2-5; CI fails the pipeline |

**Testing.** Follow the existing `test/` pattern (plain Node scripts, no
framework). 1.1 and 1.2 get unit tests in `test/net-liveness.js`, which
currently has zero coverage of `seqNewer`. 1.3-1.6 get a loopback
start/stop/reconnect harness. 1.8 is verified by deliberately breaking an early
test and confirming later ones still report.

---

## Phase 2 — link-local transport and discovery

**Gated on the two-machine probe** (see Open Questions). Design-level only; the
probe result may change its shape.

### Trust model

Discovery inverts the current trust direction. Today a client can only be driven
from the one IP the user typed; with a beacon it would accept whoever holds the
group passphrase — so anyone who ever had it can inject keystrokes. This is not
avoidable by dropping discovery, because link-local addresses cannot be typed
into a config field (see verified findings). **Link-local requires discovery,
and discovery requires identity.**

- Each install generates a long-lived keypair, persisted beside `localId`.
- The beacon carries `{pubkey, sig, localId, name, tcpPort, udpPort, counter, unixMs}`.
- Peer identity is `sha256(pubkey)`. The HELLO id becomes display metadata only
  and is never trusted for keying.
- First contact prompts once ("Allow *MacBook-Pro* to control this machine?"),
  then the peer is pinned and silent thereafter.
- The passphrase becomes "who can see the beacon", not "who can type into my
  machine".

Replay and exposure defences:

- Reject a beacon with `|now − unixMs| > 30s` or `counter <= lastSeen[senderId]`.
- Derive a separate discovery subkey via `HKDF(masterKey, 'discovery')` so a
  beacon compromise does not yield the session key.
- Debounce candidate re-resolution to at most 1 per 3 s regardless of beacon
  arrival rate; cap concurrent racers at 2.
- Announce fast then decay: 1 s for the first ~10 s after start or a netwatch
  event, decaying to a 10-30 s heartbeat; suppress entirely on an interface with
  a healthy established session. (At 1 Hz forever, a 25-desk office emits ~25
  multicast frames/s at the lowest basic rate, and WPA2 multicast is readable by
  every associated station — an offline oracle against the passphrase.)

### Discovery

- **One socket bound per interface**, so the receiving interface is known by
  construction. The peer's address is reconstructed locally from
  `rinfo.address` plus that socket's own zone. Advertised addresses are ignored.
- Beacon group: `ff02::1` (the only group with a flooding guarantee) plus an
  IPv4 admin-scoped group, distinguished by port and a magic prefix.
- Drop any beacon whose `localId` equals ours — `IPV6_MULTICAST_LOOP` defaults
  on, so a machine otherwise ranks *itself* first in its own candidate list.
- Dedupe strictly on `localId`; addresses form a candidate set hanging off one
  peer, never separate peers.
- mDNS advertisement runs alongside for `dns-sd` debuggability, but is **not**
  authoritative: `bonjour-service` publishes unzoned `fe80::` AAAA records for
  every interface including `awdl0` and every VPN `utun`, none of which are
  connectable as advertised.
- A peer is not "live" until a **unicast round-trip** succeeds. Discovery
  reachability is not connectivity (Cisco P2P blocking permits multicast and
  drops unicast, producing phantom peers).

### Transport and the race

- Server listens on `'::'` (dual-stack, serves link-local IPv6 and IPv4-mapped
  clients) and gains a udp6 motion socket.
- **Delete both `::ffff:` strips** (`server.js:96`, `:199`) and store
  `rinfo.address` / `sock.remoteAddress` verbatim as the peer handle. Add one
  `normalizeForUdp6(addr)` helper that re-adds `::ffff:` to a bare dotted quad;
  strip only at the display layer.
- Candidate order: link-local (per shared zone) → shared-subnet IPv4 →
  last-known-good → manual `serverHost`.
- Race with a ~200 ms head start for link-local. Cancellation is
  `sock.removeAllListeners(); sock.destroy();` executed synchronously on a
  winner, plus a per-attempt `settled` flag (the pattern `netbind.js:31` already
  uses) so a late `connect` on a cancelled attempt cannot double-connect. A
  blackholed link-local connect stays pending >25 s with no error event, so
  cancellation must not rely on the socket erroring.
- Give the race a **hard deadline**: per-attempt `setTimeout(2000)` and an
  overall ~5 s attempt deadline, after which the race is torn down and backoff
  armed regardless of socket state. The current ordinary connect path
  (`client.js:84`) has no timeout at all, so a zero-completion race would wedge
  silently.
- Never cache a scoped link-local string across a netwatch event; invalidate any
  `peer.ip` whose zone is no longer present in `os.networkInterfaces()`.
- `resolveBindInterface` must be family-aware: return `null` for an IPv6 peer
  hint (the `%zone` already pins the interface) rather than falling through to
  `ranked[0]` and pinning the wrong NIC.
- Native `connectBoundTcp` is AF_INET-only and hard-fails on v6 literals
  (`input.cc:183-196`). Link-local does not need pinning — the zone *is* the
  pinning — but the native path must stop rejecting v6 addresses.

### netwatch

Prerequisites 1.3, 1.4 and 1.7 must land first: one VPN connect produces 3+
distinct interface snapshots within ~4 s, which without them means 3+ engine
restarts, 3 leaked listener sets, 3× 49 ms main-thread stalls, and layout nodes
stuck online. Debounce the diff (~1 s quiet period) and restart at most once per
settled change.

### "Physical NIC" predicate

The existing `VIRTUAL` regex (`netinfo.js:15`) is a **name** heuristic, and on
Windows `os.networkInterfaces()` keys are adapter FriendlyNames — "Corp VPN",
"Zscaler", "Cisco AnyConnect Virtual Miniport Adapter" do not match it, so the
beacon would leak into corporate tunnels. Define the predicate positively and
test it against fixture interface tables for both platforms: non-internal, has a
non-internal `fe80::` address with `scopeid > 0`, has a non-zero MAC, and is not
the interface owning the default route while a tunnel is up.

### Observability

The entire justification is "link-local survives the VPN", so the user must be
able to tell a fixed setup from a lucky one:

- Report the **resolved** endpoint from `sock.remoteAddress` with a per-transport
  path label (`{tcp: 'link-local en1', udp: 'ipv4-lan'}`). Today `client.js:98`
  emits the *requested* host, which after this change would be misleading.
- A TCP/UDP path-family mismatch is a first-class error state, not a warning.
- Replace `net:testReach` (which takes a host from the `#serverHost` field this
  design removes, and whose `/:\d+$/` regex mangles IPv6 literals at
  `main.js:447`) with a per-candidate diagnostic emitting one row per candidate:
  `{label, address, zone, pinned-NIC, tcp result, unicast-UDP round-trip,
  elapsed}`.
- "0 peers" currently collapses six unrelated causes. Instrument the drop paths
  separately: beacons received-but-undecryptable → "a device here is using a
  different passphrase"; own beacons echoed back → distinguishes "multicast
  leaves this machine" from "nothing gets out".

### Migration

`config.load()` does a shallow merge and never reads `cfg.version` (zero hits).
Add a v1→v2 migration: a hand-pinned `bindInterface` (per the current README VPN
workaround) must reset to `'auto'` with a one-time visible explanation, since a
pin would exclude every link-local candidate; `serverHost` moves to
`candidates.manual`.

### Permissions and packaging

- macOS: add `build.mac.extendInfo` with `NSLocalNetworkUsageDescription` and
  `NSBonjourServices`.
- Windows: either the installer elevates once to add inbound allow rules
  (TCP + UDP, `Profile=Any`), or the app detects the blocked condition
  (advertising but zero inbound for N seconds) and offers an elevated one-click
  repair. The runtime prompt is a trap, not a fallback. **This conflicts with
  commit `0eec665` (per-user install scope) and needs an explicit decision.**

---

## Risks and what would falsify this

**The load-bearing assumption is that link-local reaches Mac↔Windows across the
user's actual network.** It has been verified same-machine only. The specific
unknown: whether Windows attaches `%<index>` to `rinfo.address` for an inbound
link-local peer. If it does not, the design changes shape.

Conditions under which this delivers nothing:

- **AP client isolation** blocks L2 peer-to-peer — no addressing trick helps.
- **Different subnets** — link-local cannot cross a router; needs VPN
  split-tunnel config instead.
- **WireGuard-style kill switches on Windows** block link-local outright while
  permitting NDP, so discovery works and the session silently fails.

In all three the correct behaviour is to **detect and report clearly**, not to
retry. Phase 1 delivers value regardless of the probe outcome.

## Open questions

1. **Two-machine probe result** — gates Phase 2. Probe script written
   (`ll-probe.js`); needs a run on both machines, VPN off then on.
2. **Windows install scope** — per-user (`0eec665`) versus the elevation needed
   for firewall rules. Product decision.
3. **mDNS library** — or hand-rolled, given `bonjour-service`'s unusable AAAA
   records. Deferred; mDNS is non-authoritative either way.
