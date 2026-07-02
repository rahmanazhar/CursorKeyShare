'use strict';
// Interface-scoped sockets (VPN bypass), backed by the native addon's
// IP_BOUND_IF support. When the app is pinned to a physical NIC, its traffic
// egresses that NIC regardless of the routing table — so a full-tunnel VPN that
// has hijacked the default route can't swallow LAN traffic to a side-by-side
// peer. If the native addon is missing (JS input backend), everything here
// degrades to no-ops and the app just uses normal OS routing.

const net = require('net');
const { loadAddon } = require('../input_native');

const addon = loadAddon();

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
  if (!available() || typeof addon.connectBoundTcp !== 'function') {
    throw new Error('native interface binding unavailable');
  }
  const fd = await addon.connectBoundTcp(host, port, ifName, timeoutMs || 4000);
  return new net.Socket({ fd, readable: true, writable: true });
}

module.exports = { available, bindSocketToInterface, connectBoundTcp };
