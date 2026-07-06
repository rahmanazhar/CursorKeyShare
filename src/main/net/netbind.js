'use strict';
// Interface-scoped sockets (VPN bypass), backed by the native addon's
// IP_BOUND_IF support. When the app is pinned to a physical NIC, its traffic
// egresses that NIC regardless of the routing table — so a full-tunnel VPN that
// has hijacked the default route can't swallow LAN traffic to a side-by-side
// peer. If the native addon is missing (JS input backend), everything here
// degrades to no-ops and the app just uses normal OS routing.

const net = require('net');
const { loadAddon } = require('../input_native');
const netinfo = require('../netinfo');

const addon = loadAddon();

/** The current IPv4 address of a NIC by name, or null. */
function ipv4ForInterface(ifName) {
  if (!ifName) return null;
  const c = netinfo.rankedInterfaces().find((x) => x.name === ifName);
  return c ? c.address : null;
}

/**
 * Connect with the socket's SOURCE address bound to `localAddress` before the
 * SYN. Node's net.createConnection binds localAddress prior to connect(), so a
 * LAN peer is reached over that NIC's on-link route even when a full-tunnel VPN
 * owns the default route. Resolves to a connected net.Socket.
 */
function connectViaLocalAddress(host, port, localAddress, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const sock = net.createConnection({ host, port, localAddress });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(new Error('connect timed out'));
    }, timeoutMs);
    sock.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      reject(e);
    });
  });
}

/** Is native interface binding available on this build/platform? */
function available() {
  return !!(addon && typeof addon.bindToInterface === 'function');
}

// Node sockets (net.Socket, net.Server, dgram.Socket) expose the OS fd at
// `_handle.fd` once bound/connected. Internal, but stable on macOS.
function fdOf(sock) {
  return sock && sock._handle && typeof sock._handle.fd === 'number' ? sock._handle.fd : -1;
}

/**
 * Scope an already-bound socket/server to a NIC by name (e.g. "en0").
 * Returns true if the bind was applied. Safe to call with a null ifName.
 */
function bindSocketToInterface(sock, ifName) {
  if (!available() || !ifName) return false;
  const fd = fdOf(sock);
  if (fd < 0) return false;
  try {
    return !!addon.bindToInterface(fd, ifName);
  } catch {
    return false;
  }
}

/**
 * Open a TCP connection scoped to a NIC. The connect happens natively so the
 * socket is bound to the interface BEFORE the SYN is sent (the only reliable
 * way under a full-tunnel VPN). Resolves to a connected net.Socket.
 */
async function connectBoundTcp(host, port, ifName, timeoutMs) {
  const timeout = timeoutMs || 4000;
  // macOS: scope the socket to the NIC natively (IP_BOUND_IF) before the SYN —
  // the strongest guarantee, works even for non-LAN destinations.
  if (process.platform === 'darwin' && available() && typeof addon.connectBoundTcp === 'function') {
    const fd = await addon.connectBoundTcp(host, port, ifName, timeout);
    return new net.Socket({ fd, readable: true, writable: true });
  }
  // Windows/Linux: no IP_BOUND_IF, so bind the source to the NIC's IPv4 address.
  // Enough to keep a same-subnet LAN peer on that NIC's on-link route rather than
  // a VPN that only hijacked the default route.
  const localAddress = ipv4ForInterface(ifName);
  if (!localAddress) throw new Error(`interface ${ifName} has no IPv4 address`);
  return connectViaLocalAddress(host, port, localAddress, timeout);
}

module.exports = { available, bindSocketToInterface, connectBoundTcp };
