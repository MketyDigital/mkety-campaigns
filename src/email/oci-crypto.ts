function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength); copy.set(bytes); return copy.buffer;
}

function derLength(length: number): Uint8Array {
  if (length < 128) return new Uint8Array([length]);
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>>= 8) bytes.unshift(value & 0xff);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, value: Uint8Array): Uint8Array {
  return new Uint8Array([tag, ...derLength(value.length), ...value]);
}

/** Accept both PKCS#8 and the traditional RSA PEM produced by openssl genrsa. */
export async function importOciRsaPrivateKey(pem: string): Promise<CryptoKey> {
  const normalized = pem.trim();
  const pkcs8 = normalized.match(/^-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----$/);
  const pkcs1 = normalized.match(/^-----BEGIN RSA PRIVATE KEY-----([\s\S]+?)-----END RSA PRIVATE KEY-----$/);
  if (!pkcs8 && !pkcs1) throw new Error("OCI_EMAIL_PRIVATE_KEY must be an unencrypted RSA private key in PEM format");
  let encoded = base64ToBytes((pkcs8 ?? pkcs1)![1]);
  if (pkcs1) {
    const algorithm = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
    const version = new Uint8Array([0x02, 0x01, 0x00]);
    const privateKey = der(0x04, encoded);
    encoded = der(0x30, new Uint8Array([...version, ...algorithm, ...privateKey]));
  }
  return crypto.subtle.importKey("pkcs8", toArrayBuffer(encoded), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}
