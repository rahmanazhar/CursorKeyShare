# CursorKeyShare

A software KVM — share **one keyboard and mouse across several Mac and Windows
machines** on your local network. Move the mouse off the edge of one screen and
it appears on the next machine; type and click on whichever machine the cursor
is currently on. All traffic is encrypted.

It uses a mix of **TCP** (reliable: key presses, clicks, control) and **UDP**
(fast: mouse motion) so input feels as immediate as if the devices were plugged
in directly. The screen layout is arranged in a config window by dragging, and
your arrangement is remembered between runs.

**It keeps working when a machine is on a full-tunnel VPN.** Most LAN tools break
there, because a VPN captures the local network. CursorKeyShare reaches its peers
over IPv6 link-local addresses, which are scoped to a network interface rather
than routed — so there is no route for a VPN to override. Machines find each
other automatically; you don't type an address. See
[VPNs and how peers find each other](#vpns-and-how-peers-find-each-other).

> Built with Electron + native addons. Cross-platform: **macOS** and **Windows**.

---

## How it works

```
            ┌──────────────── SERVER (has the keyboard & mouse) ───────────────┐
 physical   │  input backend ──► core ──► layout (virtual cursor & edges)       │
 mouse/kbd ─┼─► capture+suppress      │            │                            │
            │                         │            ├─ on local screen: pass     │
            │                         │            │  through (no network)      │
            │                         │            └─ on remote screen:         │
            │                         ▼               translate to that machine │
            │              NetServer (AES-256-GCM)     and send                 │
            └──────────────┬───────────────────────────────┬───────────────────┘
                  TCP (keys, clicks)              UDP (mouse motion)
                           │                               │
            ┌──────────────▼───────────────────────────────▼──────────┐
            │  CLIENT: NetClient ──► core ──► input backend (inject)   │
            └──────────────────────────────────────────────────────────┘
```

- **Roles.** The machine whose keyboard & mouse you want to share runs as the
  **server**; every other machine runs as a **client**.
- **Virtual cursor.** The server keeps one cursor in a global coordinate space
  made of every machine's screens. Physical mouse deltas move it. The machine
  whose rectangle currently holds the cursor is the *active* one.
- **Edge crossing.** When the virtual cursor crosses from one machine's screen
  rectangle into another's, control switches. Local input is suppressed and
  forwarded to the active machine, translated into *its* coordinate system.
- **Encryption.** Every TCP frame and UDP datagram is sealed with AES-256-GCM
  using a key derived (scrypt) from a shared passphrase + group name. A peer
  without the passphrase can't connect, eavesdrop, or inject input.
- **Discovery.** Machines announce themselves once a second over IPv6 link-local
  multicast, sealed with the same group key — so opening a beacon *is*
  authenticating it, and a machine using a different passphrase is invisible
  rather than merely rejected. Clients dial whichever server they discover.
- **VPN-resilient transport.** Peers are preferred over IPv6 link-local
  (`fe80::…%en0`), which no VPN can capture. Routed IPv4 remains as a fallback
  for peers on another subnet.
- **Layout memory.** Closing the app saves each machine's position; reopening
  restores the exact arrangement.

## Project layout

```
native/                C++ N-API addon — true low-level capture + suppression
  input.cc             N-API glue + threadsafe event bridge
  input_win.cc         Windows: WH_MOUSE_LL / WH_KEYBOARD_LL + SendInput
  input_mac.mm         macOS: CGEventTap + CGEventPost
src/main/
  main.js              Electron main: lifecycle, tray, IPC, screen detection
  core.js              orchestrator: ServerCore / ClientCore state machines
  layout.js            global coordinate space, edge crossing, transforms
  config.js            persistence + layout memory (passphrase via safeStorage)
  input.js             backend selector (native → JS fallback)
  input_native.js      wraps the C++ addon
  input_js.js          uiohook-napi capture + nut.js injection (fallback)
  keymap.js            uiohook ⇄ canonical key codes (cross-OS)
  keymap_os.js         Windows VK / macOS CGKeyCode ⇄ canonical
  netinfo.js           interface enumeration + ranking (IPv4 and link-local IPv6)
  net/
    crypto.js          scrypt KDF + AES-256-GCM seal/open
    protocol.js        compact binary + JSON message codec
    frame.js           length-prefixed TCP framing
    zone.js            IPv6 zone-ids (macOS name vs Windows index) + address forms
    discovery.js       link-local multicast beacon (sealed with the group key)
    netbind.js         interface-scoped sockets (IPv4 VPN bypass)
    server.js          NetServer (dual-stack TCP + UDP, role=server)
    client.js          NetClient (role=client)
src/renderer/          config window (draggable layout editor)
```

## Install & run

Requires **Node 18+**. Native low-level capture is optional but recommended.

```bash
npm install          # installs deps; tries to build the native addon (optional)
npm start            # launch the app
npm run dev          # launch with devtools
```

`npm install` runs a best-effort native build. If you don't have a C/C++
toolchain it is skipped and the app falls back to the JS input backend — see
**Input backends** below. To build/rebuild the native addon against Electron:

```bash
npm run rebuild      # electron-rebuild the native addon
```

### Build tool prerequisites (only for the native addon)

- **Windows:** Visual Studio Build Tools (Desktop C++), Python 3.
- **macOS:** Xcode command line tools (`xcode-select --install`).

## Building the macOS installer (.dmg)

> A signed/notarized `.dmg` with native addons **must be built on macOS** —
> `hdiutil`, `codesign`, `notarytool` and `lipo` are macOS-only. You cannot
> cross-build it from Windows or Linux. Use a Mac, or the macOS CI below.

The build produces **two per-arch DMGs** (`arm64` + `x64`). Per-arch is the
reliable path because the app bundles native `.node` modules that
`@electron/universal` won't auto-merge. The one custom addon is itself compiled
as a **universal** binary (`scripts/build-native-mac.sh` → `lipo`) so it works in
both DMGs; `uiohook-napi` ships both darwin prebuilds and `libnut-darwin` is
already universal.

On a Mac:

```bash
npm ci
bash scripts/build-mac.sh     # icon + universal addon + per-arch DMGs in dist/
```

That yields, in `dist/`:

```
CursorKeyShare-0.1.0-arm64.dmg     # Apple Silicon
CursorKeyShare-0.1.0-x64.dmg       # Intel
```

**Unsigned vs signed.** With no Apple credentials the script builds an *unsigned*
DMG you can still run after clearing quarantine:

```bash
xattr -dr com.apple.quarantine /Applications/CursorKeyShare.app   # or right-click > Open
```

For a **signed + notarized** release, export before building (or set as CI
variables): `CSC_LINK` (base64 of a *Developer ID Application* `.p12`),
`CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
Notarization runs only when both the signing cert and Team ID are present.

**Keeping macOS permissions across rebuilds.** An unsigned build gets a new code
identity every time, so macOS forgets the Accessibility / Input Monitoring grant
on each reinstall and re-prompts. If you don't have an Apple Developer account,
run this once to create a stable self-signed identity:

```bash
bash scripts/make-signing-cert.sh   # one-time; authenticate when asked
```

`build-mac.sh` then signs every build with it, so the permission sticks across
rebuilds. (The app still isn't notarized, so clear quarantine on first launch as
above.)

### CI (recommended — this is the "build on a Mac" path)

- **GitLab** (`.gitlab-ci.yml`): builds on a hosted Apple-silicon runner
  (`saas-macos-medium-m1`) on a version **tag** push. Requires a Premium/Ultimate
  namespace (macOS runners are paid, billed at 6× minutes). Set the
  `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD` / `APPLE_*` CI/CD variables for signing.
  Artifacts (the DMGs) are attached to the job.
- **GitHub** (`.github/workflows/mac.yml`): if mirrored to GitHub, builds on
  `macos-14` (free for public repos) on a tag push and uploads/attaches the DMGs.

```bash
git tag v0.1.0 && git push origin v0.1.0      # triggers the macOS build pipeline
```

### Publishing built apps via Git LFS

`dist/` is git-ignored, and installer binaries (`*.dmg`, `*.exe`, `*.zip`, …) are
tracked by **Git LFS** (`.gitattributes`). To publish a built app to the repo:

```bash
git lfs install
git add -f dist/CursorKeyShare-0.1.0-arm64.dmg
git commit -m "release: macOS arm64 0.1.0"
git push
```

(Prefer CI artifacts / a GitLab Release for routine distribution — committing
large binaries grows history and LFS quota. LFS is wired up here for when you
explicitly want the built apps in the repo.)

## Permissions

- **macOS:** grant the app **Accessibility** *and* **Input Monitoring** under
  *System Settings → Privacy & Security*. Without these, capture/injection
  silently does nothing. (When running from source, the host is `Electron`.)
- **Windows:** to capture input from elevated apps the server must also run
  elevated. SmartScreen/AV may flag low-level hooks the first time. **Allow the
  app through Windows Firewall** when prompted — inbound UDP is blocked by
  default and discovery silently finds nothing without it (see
  [When it still won't connect](#when-it-still-wont-connect)).

## Usage

1. On the machine with the keyboard & mouse, set **Role = Server**, choose a
   **Group name** and **Passphrase**, and click **Start sharing**.
2. On each other machine, set **Role = Client**, enter the **same Group name and
   Passphrase**, then **Start sharing**. The server's address is discovered
   automatically — leave it blank unless the machines are on different subnets.
3. Connected clients appear in the **Screen layout** editor. **Drag** each screen
   to match your physical arrangement; edges snap together. Positions are saved.
4. Move your mouse off the matching edge to jump to the next machine. Type/click
   normally. Press **Ctrl/Cmd+Alt+Home** to yank control back to the server.

## VPNs and how peers find each other

A full-tunnel VPN normally breaks LAN tools, and not just by taking the default
route. Cloudflare WARP, for example, carves the local subnet into a tree of more
specific routes — `192.168.68.2/31`, `192.168.68.4/30`, and so on — which beat
the on-link route, so every LAN host except the gateway is pulled into the
tunnel and becomes unreachable.

**IPv6 link-local addresses (`fe80::/10`) are immune to this**, because they are
not routed at all. The address carries a *zone* naming the interface
(`fe80::1c2d%en0`), and the kernel sends straight out of that interface without
consulting the routing table. There is no route for a VPN to override.

That is why peers are discovered rather than configured: a link-local address is
derived from the interface, changes with MAC randomisation, and is written
differently on each platform (macOS uses the interface *name*, Windows the
numeric *index*), so it cannot be typed into a config field or exchanged between
machines. Instead each machine announces itself over link-local multicast, and
the receiver derives the peer's address from the packet it arrived on.

**Address priority:** link-local IPv6 → routed IPv4 → the manually configured
server address.

Set **Server address** manually only when link-local cannot reach — most often
when the machines are on **different subnets**, which link-local cannot cross.
The **Check connectivity** button reports whether a peer is actually reachable.

### When it still won't connect

- **Windows Firewall** blocks inbound UDP by default, and Wi-Fi networks default
  to the *Public* profile — so beacons leave but never arrive. This is the most
  common cause. In an admin PowerShell:

  ```powershell
  New-NetFirewallRule -DisplayName "CursorKeyShare" -Direction Inbound `
    -Protocol UDP -LocalPort 24801,24802 -Action Allow -Profile Any
  New-NetFirewallRule -DisplayName "CursorKeyShare TCP" -Direction Inbound `
    -Protocol TCP -LocalPort 24800 -Action Allow -Profile Any
  ```

- **AP client isolation** (common on guest and hotspot networks) blocks
  station-to-station traffic at layer 2. Nothing in the app can work around it —
  use a different network, or wire one machine to Ethernet.
- **IPv6 disabled** on the adapter removes the link-local path entirely; the app
  falls back to routed IPv4, which a VPN may capture.
- **Mismatched builds** won't discover each other — the app logs this explicitly.
- **Clocks more than 30s apart** cause beacons to be rejected as replays. The app
  logs this too.

## Input backends

| Backend | Capture | Injection | True suppression |
| --- | --- | --- | --- |
| **Native** (`native/*`) | low-level OS hooks | SendInput / CGEventPost | ✅ yes |
| **JS fallback** | uiohook-napi | nut.js | ⚠️ soft (mouse parked; keys/clicks still reach local apps) |

The native addon is the proper KVM path: it can *swallow* local events while you
drive a remote machine. The JS fallback always works and is ideal for the
**client** side (which only injects). For the **server** side, build the native
addon for a correct experience.

## Security notes

- All transport is AES-256-GCM; the GCM tag authenticates every packet, so a
  wrong-passphrase peer is rejected.
- The passphrase is stored encrypted via the OS keychain (Electron
  `safeStorage`). If the keychain is unavailable a documented insecure plaintext
  fallback is used (dev only).
- Use a strong, unique passphrase. Anyone with it on your LAN can control your
  machines — that is the whole point of the tool, so guard it. Note that with
  discovery, holding the passphrase is enough to be found and connected to; you
  no longer have to know a machine's address.
- Discovery beacons are sealed with the group key and **bound to the address they
  were sent from**, so a beacon captured off the wire cannot be replayed from
  somewhere else to redirect a client. Beacons older than 30s are rejected.
- Beacons are sent to `ff02::1` (all-nodes) and are therefore visible to every
  device on the link. They are encrypted, but their *size* and 1 Hz cadence are
  not hidden — an observer on your LAN can tell the app is running.

## Roadmap / known limitations

- N-client mesh works; clipboard sync is text-only and on-switch.
- Link-local discovery cannot cross a router, so machines on **different
  subnets** still need the server address set manually.
- **AP client isolation** blocks the app entirely and cannot be worked around
  from inside it.
- The Windows installer does not yet add its own firewall rules, so inbound UDP
  must be allowed manually or via the first-run prompt.
- Per-machine DPI scaling is mapped 1:1 in pixels; mixed-DPI setups may want a
  scale factor (planned).

## License

MIT
