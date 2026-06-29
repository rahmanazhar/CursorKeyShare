'use strict';
// Length-prefixed framing for the TCP control/reliable channel.
//
// On the wire each frame is: [ uint32 length | sealed blob ]
// where the sealed blob decrypts to a protocol plaintext packet.
//
// FrameReader accumulates raw socket chunks and yields complete sealed blobs.

class FrameReader {
  constructor() {
    this._buf = Buffer.alloc(0);
  }

  /**
   * Feed a chunk; returns an array of complete sealed-blob Buffers (may be empty).
   * @param {Buffer} chunk
   * @returns {Buffer[]}
   */
  push(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    const out = [];
    while (this._buf.length >= 4) {
      const len = this._buf.readUInt32LE(0);
      if (len > 64 * 1024 * 1024) {
        throw new Error('frame too large: ' + len);
      }
      if (this._buf.length < 4 + len) break;
      out.push(this._buf.subarray(4, 4 + len));
      this._buf = this._buf.subarray(4 + len);
    }
    return out;
  }
}

/** Wrap a sealed blob with its 4-byte length prefix. */
function frame(sealedBlob) {
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32LE(sealedBlob.length, 0);
  return Buffer.concat([head, sealedBlob]);
}

module.exports = { FrameReader, frame };
