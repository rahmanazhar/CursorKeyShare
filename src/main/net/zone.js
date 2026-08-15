'use strict';
// IPv6 link-local zone-id handling.
//
// This is the whole reason link-local survives a VPN. A full-tunnel VPN takes
// over connectivity by installing routes more specific than the on-link one —
// Cloudflare WARP, for instance, carves a LAN with a binary tree of /31s, /30s
// and so on, so only the gateway and the host itself still resolve to the
// physical NIC. There is no equivalent attack on fe80::/10, because a
// link-local address is not routed at all: the zone names the interface, and
// the kernel sends straight out of it without consulting the routing table.
//
// The catch is that the zone is spelled differently per platform. libuv parses
// it with if_nametoindex() on POSIX and atoi() under _WIN32, so macOS/Linux
// want the interface NAME ("%en1") and Windows wants the numeric INDEX ("%12"),
// and each rejects the other's form. Verified on macOS: "%7" times out where
// "%en1" connects.
//
// The consequence shapes the whole discovery design: a zoned address is
// meaningful ONLY on the machine that produced it. A peer must never send its
// own link-local address and expect it to be usable — the receiver has to
// rebuild it from the interface the packet actually arrived on.

const LINK_LOCAL = /^fe80:/i;

/** Is this a link-local IPv6 address? Tolerates an attached zone. */
function isLinkLocal(addr) {
  return typeof addr === 'string' && LINK_LOCAL.test(addr);
}

/** Remove any "%zone" suffix, yielding the bare address. */
function stripZone(addr) {
  if (typeof addr !== 'string') return addr;
  const i = addr.indexOf('%');
  return i === -1 ? addr : addr.slice(0, i);
}

/**
 * The zone string to use for `iface` on `platform`.
 * Returns null when it cannot be determined — better to skip a candidate than
 * to build an address with zone 0, which Windows silently accepts and then
 * treats as ambiguous, burning ~60s of neighbour-discovery across every NIC.
 *
 * @param {{name:string, scopeid?:number}} iface
 * @param {string} [platform] defaults to the running platform
 * @returns {string|null}
 */
function zoneFor(iface, platform) {
  if (!iface) return null;
  const plat = platform || process.platform;
  if (plat === 'win32') {
    // Windows accepts ONLY the numeric index. os.networkInterfaces() keys are
    // adapter FriendlyNames ("Wi-Fi", "Ethernet 2") which are not valid zones —
    // and some contain spaces, which Node's net.isIP() rejects outright.
    const id = iface.scopeid;
    return typeof id === 'number' && id > 0 ? String(id) : null;
  }
  return iface.name || null;
}

/**
 * Attach `iface`'s zone to a link-local address, replacing any zone already
 * present (a zone from another machine is meaningless here). Non-link-local
 * addresses are returned untouched. Returns null if the zone is unknowable.
 */
function withZone(addr, iface, platform) {
  if (!isLinkLocal(addr)) return addr;
  const zone = zoneFor(iface, platform);
  if (!zone) return null;
  return stripZone(addr) + '%' + zone;
}

/**
 * Make an address safe to hand to a dual-stack udp6 socket.
 *
 * A udp6 socket cannot send to a bare dotted quad — verified: send to
 * "127.0.0.1" fails EINVAL while "::ffff:127.0.0.1" succeeds. Inbound IPv4
 * peers already arrive as "::ffff:…", so the rule is simply: never strip the
 * prefix off a stored peer address, and add it to any bare IPv4 literal.
 */
function normalizeForUdp6(addr) {
  if (typeof addr !== 'string') return addr;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(addr) ? '::ffff:' + addr : addr;
}

/**
 * Human-readable form: drop the ::ffff: prefix and any zone. Display only —
 * never feed the result back into a socket.
 */
function displayAddr(addr) {
  if (typeof addr !== 'string') return addr;
  return stripZone(addr).replace(/^::ffff:/i, '');
}

module.exports = { isLinkLocal, stripZone, zoneFor, withZone, normalizeForUdp6, displayAddr };
