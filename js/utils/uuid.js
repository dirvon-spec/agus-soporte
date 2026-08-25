// Generador de UUID v7 (ordenable por tiempo, útil como PRIMARY KEY sin AUTOINCREMENT).
// Layout: 48 bits timestamp (ms desde epoch) + 4 bits versión (7) + 12 bits random_a
//         + 2 bits variante (10) + 62 bits random_b.

function bytesAHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Genera un UUID v7 como string, ej. "018f4d2e-5c3a-7f21-8b1a-2f6e9d0c1a3b".
 * @returns {string}
 */
export function uuidV7() {
  const timestampMs = Date.now();
  const bytes = new Uint8Array(16);

  // 48 bits de timestamp en los primeros 6 bytes (big-endian).
  bytes[0] = (timestampMs / Math.pow(2, 40)) & 0xff;
  bytes[1] = (timestampMs / Math.pow(2, 32)) & 0xff;
  bytes[2] = (timestampMs / Math.pow(2, 24)) & 0xff;
  bytes[3] = (timestampMs / Math.pow(2, 16)) & 0xff;
  bytes[4] = (timestampMs / Math.pow(2, 8)) & 0xff;
  bytes[5] = timestampMs & 0xff;

  const random = new Uint8Array(10);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(random);
  } else {
    for (let i = 0; i < random.length; i++) random[i] = Math.floor(Math.random() * 256);
  }

  bytes.set(random, 6);

  // Versión 7 en los 4 bits altos del byte 6.
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  // Variante RFC 4122 (10xxxxxx) en los 2 bits altos del byte 8.
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytesAHex(bytes);
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32)
  );
}
