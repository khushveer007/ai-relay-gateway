// Crypto helpers built on WebCrypto (native in Workers, so they cost almost no billed CPU).

const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(input)));
}

const aesKeyCache = new Map<string, Promise<CryptoKey>>();

function aesKey(secret: string): Promise<CryptoKey> {
  let p = aesKeyCache.get(secret);
  if (!p) {
    p = crypto.subtle
      .digest('SHA-256', enc.encode(secret))
      .then((raw) => crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']));
    aesKeyCache.set(secret, p);
  }
  return p;
}

/** Encrypts plaintext with AES-256-GCM. Output: base64(iv[12] || ciphertext+tag). */
export async function encrypt(plaintext: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), enc.encode(plaintext));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return toB64(out);
}

export async function decrypt(payload: string, secret: string): Promise<string> {
  const bytes = fromB64(payload);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12) },
    await aesKey(secret),
    bytes.slice(12),
  );
  return dec.decode(pt);
}

const hmacKeyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let p = hmacKeyCache.get(secret);
  if (!p) {
    p = crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    hmacKeyCache.set(secret, p);
  }
  return p;
}

export async function hmacSign(data: string, secret: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data));
  return toB64(sig).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Constant-time string comparison (compares SHA-256 digests so lengths never leak). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function randomToken(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let s = '';
  for (let i = 0; i < length; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

/** "sk-abcdef…wxyz" style hint that never reveals the full key. */
export function keyHint(key: string): string {
  const k = key.trim();
  if (k.length <= 10) return `${k.slice(0, 2)}…`;
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}
