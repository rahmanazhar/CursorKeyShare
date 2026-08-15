'use strict';
// Detects this machine's LAN identity so the config UI can fill in the machine
// name and the address other machines connect to — instead of making the user
// read it off `ifconfig` / `ipconfig`.
//
// A machine usually exposes several IPv4 interfaces: the real LAN ones (Wi-Fi,
// Ethernet) plus virtual ones from VPNs, Docker, VMs and AirDrop. We enumerate
// the non-loopback ones and rank them so the address most likely reachable by
// LAN peers comes first.

const os = require('os');
const { zoneFor } = require('./net/zone');

// Interface-name fragments that are almost never the LAN address to hand a peer:
// VPN tunnels (utun/tun/tap/ppp/wireguard/WARP/Tailscale/ZeroTier/commercial
// VPNs), AirDrop/AWDL, bridges, and VM/container NICs. Matched anywhere in the
// name (not just the prefix) so Windows adapter names like "CloudflareWARP" and
// "OpenVPN TAP-Windows" are caught too.
const VIRTUAL = /(utun|tun\d|tap|ppp|awdl|llw|anpi|ap\d|bridge|vmnet|vboxnet|docker|veth|gif|stf|ham|cloudflare|warp|wireguard|wg\d|tailscale|zerotier|^zt|nordlynx|proton|mullvad|expressvpn|windscribe|wintun|openvpn)/i;

function isPrivateLan(ip) {
  return (
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}
function isLinkLocal(ip) {
  return /^169\.254\./.test(ip); // self-assigned; only reachable as a last resort
}

// All non-internal IPv4 interfaces, as { name, address, netmask }.
function candidates() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) {
        out.push({ name, address: a.address, netmask: a.netmask });
      }
    }
  }
  return out;
}

// Is `ip` on the same IPv4 subnet as `address`/`netmask`?
function sameSubnet(ip, address, netmask) {
  if (!ip || !address || !netmask) return false;
  const toInt = (s) => {
    const p = String(s).split('.');
    if (p.length !== 4) return null;
    return ((+p[0] << 24) | (+p[1] << 16) | (+p[2] << 8) | +p[3]) >>> 0;
  };
  const a = toInt(address), m = toInt(netmask), t = toInt(ip);
  if (a == null || m == null || t == null) return false;
  return ((a & m) >>> 0) === ((t & m) >>> 0);
}

// Lower score = better candidate. This ordering is the one real judgment call
// in the module — adjust it if your environment needs a different interface
// preferred (e.g. you always want Ethernet over Wi-Fi).
function score(c) {
  let s = 0;
  if (VIRTUAL.test(c.name)) s += 1000; // virtual / VPN NICs go last
  if (isLinkLocal(c.address)) s += 500; // self-assigned worse than routable
  else if (!isPrivateLan(c.address)) s += 100; // public/unknown after private LAN
  const tail = (c.name.match(/(\d+)$/) || [])[1]; // en0 before en1, etc.
  if (tail != null) s += Number(tail);
  return s;
}

// Ranked, best-first list of { name, address } NICs (may be empty if offline).
function rankedInterfaces() {
  return candidates().sort((a, b) => score(a) - score(b));
}

// Ranked, best-first list of LAN IPv4 strings (may be empty if offline).
function detectLocalIPv4s() {
  return rankedInterfaces().map((c) => c.address);
}

// The single best LAN NIC, or null.
function bestInterface() {
  return rankedInterfaces()[0] || null;
}

/**
 * Resolve the config `bindInterface` setting to the NIC name to scope sockets
 * to, or null for "use normal OS routing".
 *   'off'        -> null (don't bind)
 *   'auto' | ''  -> the NIC on the peer's subnet if known, else best LAN NIC
 *   '<name>'     -> that name if it currently exists, else fall through to auto
 *                   (don't strand the user on a NIC that went away)
 *
 * @param {string} setting  the configured bindInterface value
 * @param {string} [peerIp] the address we're connecting to (client role); when
 *                          given, an interface on that peer's subnet wins — this
 *                          reliably picks the physical LAN NIC over a VPN tunnel.
 */
function resolveBindInterface(setting, peerIp) {
  if (setting === 'off') return null;
  const ranked = rankedInterfaces();
  if (!ranked.length) return null;
  if (setting && setting !== 'auto') {
    const match = ranked.find((c) => c.name === setting);
    if (match) return match.name;
  }
  if (peerIp) {
    const onSubnet = ranked.find((c) => sameSubnet(peerIp, c.address, c.netmask));
    if (onSubnet) return onSubnet.name;
  }
  return ranked[0].name;
}

/**
 * Physical NICs that carry an IPv6 link-local address, best-first.
 *
 * This is the VPN-proof path. A full-tunnel VPN defeats the on-link IPv4 route
 * by installing more-specific ones (WARP carves a LAN into /31s and /30s, so
 * only the gateway and the host itself still resolve to the physical NIC), but
 * fe80::/10 is not routed at all — the zone selects the interface directly, so
 * there is no route to make more specific.
 *
 * The VIRTUAL filter matters more here than for IPv4: every VPN tunnel also has
 * an fe80:: address, and beaconing on one would push discovery straight into
 * the tunnel we exist to escape.
 *
 * @param {string} [platform] defaults to the running platform
 * @param {object} [table]    defaults to os.networkInterfaces(); injectable for tests
 * @returns {Array<{name:string, address:string, scopeid:number, zone:string, sendable:string}>}
 */
function linkLocalInterfaces(platform, table) {
  const plat = platform || process.platform;
  const ifaces = table || os.networkInterfaces();
  const out = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (VIRTUAL.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family !== 'IPv6' || a.internal) continue;
      if (!/^fe80:/i.test(a.address)) continue;
      const iface = { name, scopeid: a.scopeid };
      const zone = zoneFor(iface, plat);
      // No usable zone means no usable address: Windows silently accepts zone 0
      // and then treats the address as ambiguous, burning neighbour-discovery
      // timeouts across every adapter instead of failing fast.
      if (!zone) continue;
      const address = a.address.replace(/%.*$/, '');
      out.push({ name, address, scopeid: a.scopeid, zone, sendable: `${address}%${zone}` });
    }
  }
  // Reuse the IPv4 ranking heuristic for a stable, sensible order (en0 before en1).
  return out.sort((a, b) => score({ name: a.name, address: '' }) - score({ name: b.name, address: '' }));
}

// Hostname without the noisy mDNS ".local" suffix macOS appends.
function detectName() {
  return os.hostname().replace(/\.local$/i, '') || 'machine';
}

module.exports = {
  detectLocalIPv4s,
  detectName,
  candidates,
  score,
  rankedInterfaces,
  bestInterface,
  resolveBindInterface,
  linkLocalInterfaces,
};
