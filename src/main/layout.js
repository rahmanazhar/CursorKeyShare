'use strict';
// Screen layout & coordinate translation.
//
// The layout is a set of "nodes" (one per participating machine). Each node owns
// a rectangle in a shared GLOBAL coordinate space. The GUI lets the user drag
// these rectangles around freely; their positions are what gets persisted as the
// "layout memory".
//
// A single virtual cursor lives in global space. The node whose rectangle
// contains the virtual cursor is the ACTIVE machine — the one currently being
// controlled. As the physical mouse moves, we apply its deltas to the virtual
// cursor, detect when it crosses from one node's rectangle into another, and
// translate the global position into the active machine's own local screen
// coordinates before sending it there.
//
// Node fields:
//   id          stable machine id
//   name        display name
//   width,height size of the machine's combined desktop, in px
//   originX,originY  top-left of the machine's desktop in ITS OWN coordinate
//                    system (Windows virtual-screen origin may be negative;
//                    macOS global space). Used to map global -> machine-local.
//   layoutX,layoutY  top-left of this node's rectangle in GLOBAL space (GUI/persisted)
//   isLocal     true for the server's own machine
//   online      connection state (display only)

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

class Layout {
  constructor() {
    /** @type {Map<string, any>} */
    this.nodes = new Map();
    this.localId = null;
  }

  setLocal(id) {
    this.localId = id;
  }

  upsert(node) {
    const prev = this.nodes.get(node.id) || {};
    const merged = {
      id: node.id,
      name: node.name ?? prev.name ?? node.id,
      width: node.width ?? prev.width ?? 1920,
      height: node.height ?? prev.height ?? 1080,
      originX: node.originX ?? prev.originX ?? 0,
      originY: node.originY ?? prev.originY ?? 0,
      // Keep a previously-chosen layout position (layout memory) unless the
      // caller explicitly supplies one.
      layoutX: node.layoutX ?? prev.layoutX ?? 0,
      layoutY: node.layoutY ?? prev.layoutY ?? 0,
      isLocal: node.isLocal ?? prev.isLocal ?? false,
      online: node.online ?? prev.online ?? false,
    };
    // If this node is brand new and has no chosen position, place it to the
    // right of everything else so it doesn't overlap.
    if (!this.nodes.has(node.id) && node.layoutX == null && node.layoutY == null) {
      merged.layoutX = this._rightmost();
      merged.layoutY = 0;
    }
    this.nodes.set(node.id, merged);
    return merged;
  }

  remove(id) {
    this.nodes.delete(id);
  }

  get(id) {
    return this.nodes.get(id);
  }

  list() {
    return [...this.nodes.values()];
  }

  setPosition(id, x, y) {
    const n = this.nodes.get(id);
    if (n) {
      n.layoutX = Math.round(x);
      n.layoutY = Math.round(y);
    }
  }

  setOnline(id, online) {
    const n = this.nodes.get(id);
    if (n) n.online = !!online;
  }

  _rightmost() {
    let max = 0;
    for (const n of this.nodes.values()) max = Math.max(max, n.layoutX + n.width);
    return max;
  }

  // Rectangle helpers (right/bottom are exclusive).
  _contains(n, x, y) {
    return (
      x >= n.layoutX &&
      x < n.layoutX + n.width &&
      y >= n.layoutY &&
      y < n.layoutY + n.height
    );
  }

  /** The node whose rectangle contains the global point, or null. */
  nodeAt(x, y) {
    for (const n of this.nodes.values()) {
      if (this._contains(n, x, y)) return n;
    }
    return null;
  }

  /** Center of a node in global coords. */
  center(node) {
    return {
      x: node.layoutX + Math.floor(node.width / 2),
      y: node.layoutY + Math.floor(node.height / 2),
    };
  }

  /**
   * Apply a physical mouse delta to the virtual cursor.
   * Allows the cursor to slide along shared edges and to cross into an adjacent
   * node when only one axis transitions. Movement into a gap is blocked (the
   * cursor sticks to the current node's edge).
   *
   * @returns {{node, x, y, switched:boolean, from}}
   */
  applyDelta(fromNode, gx, gy, dx, dy) {
    if (!fromNode) {
      const any = this.nodeAt(gx, gy) || this.list()[0];
      return { node: any, x: gx, y: gy, switched: false, from: fromNode };
    }
    // Fast path: full move lands somewhere valid.
    let t = this.nodeAt(gx + dx, gy + dy);
    if (t) {
      return {
        node: t,
        x: gx + dx,
        y: gy + dy,
        switched: t.id !== fromNode.id,
        from: fromNode,
      };
    }

    // Per-axis resolution so we can slide along edges / cross on a single axis.
    let cur = fromNode;
    let cx;
    const tx = this.nodeAt(gx + dx, gy);
    if (tx) {
      cx = gx + dx;
      cur = tx;
    } else {
      cx = clamp(gx + dx, cur.layoutX, cur.layoutX + cur.width - 1);
    }

    let cy;
    const ty = this.nodeAt(cx, gy + dy);
    if (ty) {
      cy = gy + dy;
      cur = ty;
    } else {
      cy = clamp(gy + dy, cur.layoutY, cur.layoutY + cur.height - 1);
    }

    const fin = this.nodeAt(cx, cy) || cur;
    return {
      node: fin,
      x: cx,
      y: cy,
      switched: fin.id !== fromNode.id,
      from: fromNode,
    };
  }

  /** Map a global point into a node's own local screen coordinates. */
  toLocal(node, gx, gy) {
    return {
      x: node.originX + (gx - node.layoutX),
      y: node.originY + (gy - node.layoutY),
    };
  }

  /** Map a node-local screen point into global coordinates. */
  toGlobal(node, lx, ly) {
    return {
      x: node.layoutX + (lx - node.originX),
      y: node.layoutY + (ly - node.originY),
    };
  }

  // ---- persistence ---------------------------------------------------------

  /** Positions only — what we remember between runs (layout memory). */
  serializePositions() {
    const out = {};
    for (const n of this.nodes.values()) {
      out[n.id] = { name: n.name, layoutX: n.layoutX, layoutY: n.layoutY };
    }
    return out;
  }

  applyPositions(saved) {
    if (!saved) return;
    for (const [id, pos] of Object.entries(saved)) {
      const n = this.nodes.get(id);
      if (n) {
        n.layoutX = pos.layoutX ?? n.layoutX;
        n.layoutY = pos.layoutY ?? n.layoutY;
      }
    }
  }
}

module.exports = { Layout };
