export const USER_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
export const MESSAGE_NAMESPACE = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';
export const SCROLL_BOTTOM_THRESHOLD = 48;
export const POLL_INTERVAL = 2500;
export const WEBRTC_RETRY_INTERVAL = 10000;
export const SETTINGS_APPLY_DELAY = 250;

export function sanitizeNickname(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\w.-]/g, '')
    .slice(0, 40);
}

export function sanitizeHost(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/g, '')
    .replace(/\/.*$/g, '');
}

export function sanitizePort(value) {
  return String(value || '').replace(/[^\d]/g, '').slice(0, 5);
}

export function sanitizePath(value, fallback = '/messages_v1') {
  let path = String(value || '').trim();
  if (!path) return fallback;
  if (!path.startsWith('/')) path = '/' + path;
  path = '/' + path.split('/').filter(Boolean).join('/');
  return path || '/';
}

export function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

export function getInitial(value) {
  const s = String(value || '?').trim();
  return (s[0] || '?').toUpperCase();
}

export function formatTime(tsSeconds) {
  if (!tsSeconds) return '';
  const date = new Date(Number(tsSeconds) * 1000);
  if (Number.isNaN(date.getTime())) return '';

  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (sameDay) {
    return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

export function formatDateChip(tsSeconds) {
  if (!tsSeconds) return '';
  const date = new Date(Number(tsSeconds) * 1000);
  if (Number.isNaN(date.getTime())) return '';

  return date.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  });
}

export function shortGuid(value) {
  if (!value) return '—';
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

export function makeId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function parseRetryAfter(headers) {
  const raw = headers && headers.get ? headers.get('Retry-After') : '';
  const n = parseInt(raw || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function copyText(text) {
  const value = String(text || '');

  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(value);
    return true;
  }

  const ta = document.createElement('textarea');
  ta.value = value;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  return true;
}

function uuidToBytes(uuid) {
  const hex = String(uuid || '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new Error('Некорректный UUID namespace');
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToUuid(bytes) {
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ].join('-');
}

function rotl(value, bits) {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function sha1Fallback(bytes) {
  const words = [];
  const bitLength = bytes.length * 8;

  for (let i = 0; i < bytes.length; i++) {
    words[i >> 2] = (words[i >> 2] || 0) | (bytes[i] << (24 - (i % 4) * 8));
  }

  words[bitLength >> 5] = (words[bitLength >> 5] || 0) | (0x80 << (24 - (bitLength % 32)));
  words[(((bitLength + 64) >> 9) << 4) + 15] = bitLength;

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Array(80);

  for (let i = 0; i < words.length; i += 16) {
    for (let t = 0; t < 16; t++) {
      w[t] = (words[i + t] || 0) >>> 0;
    }

    for (let t = 16; t < 80; t++) {
      w[t] = rotl((w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16]) >>> 0, 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let t = 0; t < 80; t++) {
      let f;
      let k;

      if (t < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (t < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (t < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }

      const temp = (rotl(a, 5) + f + e + k + w[t]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  return new Uint8Array([
    (h0 >>> 24) & 255, (h0 >>> 16) & 255, (h0 >>> 8) & 255, h0 & 255,
    (h1 >>> 24) & 255, (h1 >>> 16) & 255, (h1 >>> 8) & 255, h1 & 255,
    (h2 >>> 24) & 255, (h2 >>> 16) & 255, (h2 >>> 8) & 255, h2 & 255,
    (h3 >>> 24) & 255, (h3 >>> 16) & 255, (h3 >>> 8) & 255, h3 & 255,
    (h4 >>> 24) & 255, (h4 >>> 16) & 255, (h4 >>> 8) & 255, h4 & 255
  ]);
}

async function sha1Bytes(data) {
  if (window.crypto && crypto.subtle) {
    const buffer = await crypto.subtle.digest('SHA-1', data);
    return new Uint8Array(buffer);
  }

  return sha1Fallback(data);
}

export async function uuidV5(namespaceUuid, name) {
  const namespaceBytes = uuidToBytes(namespaceUuid);
  const nameBytes = new TextEncoder().encode(String(name));
  const data = new Uint8Array(namespaceBytes.length + nameBytes.length);

  data.set(namespaceBytes, 0);
  data.set(nameBytes, namespaceBytes.length);

  const hash = await sha1Bytes(data);
  const bytes = hash.slice(0, 16);

  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  return bytesToUuid(bytes);
}
