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

// Interface-name prefixes that are almost never the LAN address to hand a peer:
// VPN tunnels (utun/tun/tap/ppp), AirDrop/AWDL, bridges, and VM/container NICs.
const VIRTUAL = /^(utun|tun|tap|ppp|awdl|llw|anpi|ap\d|bridge|vmnet|vboxnet|docker|veth|gif|stf|ham)/i;

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

// All non-internal IPv4 interfaces, as { name, address }.
function candidates() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
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
 *   'auto' | ''  -> best detected LAN NIC name
 *   '<name>'     -> that name if it currently exists, else best (don't strand
 *                   the user on a NIC that went away)
 */
function resolveBindInterface(setting) {
  if (setting === 'off') return null;
  const ranked = rankedInterfaces();
  if (!ranked.length) return null;
  if (!setting || setting === 'auto') return ranked[0].name;
  const match = ranked.find((c) => c.name === setting);
  return match ? match.name : ranked[0].name;
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
};
