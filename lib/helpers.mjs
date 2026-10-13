// Pure helpers shared by the sandbox modules.
// No DOM, no `window`, no engine globals: safe to import in plain Node.

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes a value for HTML text and attribute contexts. Never throws. */
export function esc(value) {
  let text;
  try {
    text = value === null || value === undefined ? '' : String(value);
  } catch {
    text = '';
  }
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/**
 * Builds a slug that matches the config key grammar `^[a-z][a-z0-9_]{0,23}$`.
 * Accents are removed, separators become `_`, leading digits/underscores are dropped.
 * Returns '' when nothing usable is left.
 */
export function slug(value) {
  let text;
  try {
    text = value === null || value === undefined ? '' : String(value);
  } catch {
    return '';
  }
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[0-9_]+/, '')
    .slice(0, 24)
    .replace(/_+$/, '');
}

/**
 * Clamps a number into [min, max]. A non-numeric input returns `min`.
 * If `min > max` the bounds are swapped so the result is always inside both.
 */
export function clamp(value, min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const n = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/** Returns a new id with the given prefix. Uses crypto when available. */
export function uid(prefix = '') {
  let random;
  const cryptoApi = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    random = cryptoApi.randomUUID().replace(/-/g, '').slice(0, 16);
  } else {
    random = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  }
  const head = typeof prefix === 'string' ? prefix : '';
  return `${head}${Date.now().toString(36)}${random}`;
}

/** True for objects created by `{}`, `new Object()` or `Object.create(null)`. */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const CLONE_MAX_DEPTH = 64;

/**
 * Deep-copies plain objects and arrays. Own keys are copied with defineProperty, so a
 * key named `__proto__` stays data and never changes a prototype. Cycles and depth
 * beyond 64 are cut off (undefined) instead of throwing.
 */
export function deepClone(value) {
  const seen = new WeakMap();
  const walk = (node, depth) => {
    if (node === null || typeof node !== 'object') return node;
    if (depth > CLONE_MAX_DEPTH) return undefined;
    if (seen.has(node)) return seen.get(node);
    if (Array.isArray(node)) {
      const out = [];
      seen.set(node, out);
      for (let i = 0; i < node.length; i++) out[i] = walk(node[i], depth + 1);
      return out;
    }
    if (!isPlainObject(node)) return node;
    const out = {};
    seen.set(node, out);
    for (const key of Object.keys(node)) {
      Object.defineProperty(out, key, {
        value: walk(node[key], depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  };
  return walk(value, 0);
}
