/**
 * Minimal pure-JS `crypto` shim for `crypto-js` random byte generation inside React Native Hermes.
 * Only implements `getRandomValues` and `randomBytes`.
 */
function fillRandomBytes(arr) {
  if (
    typeof globalThis !== "undefined" &&
    globalThis.crypto &&
    typeof globalThis.crypto.getRandomValues === "function"
  ) {
    return globalThis.crypto.getRandomValues(arr);
  }
  for (let i = 0; i < arr.length; i++) {
    arr[i] = Math.floor(Math.random() * 256);
  }
  return arr;
}

module.exports = {
  getRandomValues: fillRandomBytes,
  randomBytes(size) {
    const buf = new Uint8Array(size);
    fillRandomBytes(buf);
    buf.readInt32LE = function (offset = 0) {
      return (
        buf[offset] |
        (buf[offset + 1] << 8) |
        (buf[offset + 2] << 16) |
        (buf[offset + 3] << 24)
      );
    };
    return buf;
  },
};
