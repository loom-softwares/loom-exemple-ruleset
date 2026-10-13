// Combatant badges (the `combatantLabel` hook), the shared resource cache, and the sweeper that
// reads each combatant's cast/actor on a slow, capped, round-robin cadence.
//
// Engine facts this module relies on (verified in E:\modules\LoomVTT):
// - `combatantLabel` is a synchronous LoomHooks.call; the listener writes `ctx.label`
//   (client/screens/game-hud/sidebar.ts:1943-1947). The badge cannot wait for a fetch, so the
//   listener answers from the cache and asks the sweeper to read in the background.
// - `combatantLabelsChanged` is listened to by the sidebar (sidebar.ts:1393) and re-renders it.
//   Nothing in the engine emits it, so this module emits it when a badge text changes.
// - A combatant's id is the cast id. Linked casts (`isLinked`) keep their data on the actor
//   (project rule 6), unlinked casts keep it on the cast (server/applications/api/cast.ts:131-140).
// - The engine's ApiError (client/core/api.ts:28) carries only `status`; response headers such as
//   Retry-After are not reachable from `api.get`.
//
// One cache serves both the tracker panel and the badges (getSharedSweeper). The sweeper reads a
// combatant at most once per RECORD_CADENCE_MS, at most REFRESH_CAP combatants per pass, at most
// REQUEST_CONCURRENCY combatant reads in flight, and reads a combatant right away only when it has
// no data yet or its hp/maxHp changed in the combat row.
//
// Pure functions here run in plain Node. Nothing touches `window` at import time.

import { resourceList, loadConfig as defaultLoadConfig } from '../lib/config.mjs';
import { clamp, isPlainObject } from '../lib/helpers.mjs';

export const LABEL_MAX = 60;
export const RESOURCE_CAP = 999; // same cap as the config limits (LIMITS.resourceMax)
export const RECORD_CADENCE_MS = 9000; // a combatant's resources are read at most this often
export const REFRESH_CAP = 12; // combatants read per resource pass
export const REQUEST_CONCURRENCY = 4; // combatant reads in flight at once (one request each)
export const RATE_LIMIT_DEFAULT_MS = 30000;
const RATE_LIMIT_MAX_MS = 600000;
const CONFIG_TTL_MS = 30000;
const DRIVER_MS = 3000; // badge driver tick when no panel drives the reads
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function loomGlobal() {
  return typeof globalThis !== 'undefined' ? globalThis.window?.Loom : undefined;
}

/** Localized text with a fallback. Works without an engine (returns the fallback). */
export function t(key, fallback) {
  try {
    const text = loomGlobal()?.i18n?.localize?.(key);
    return typeof text === 'string' && text && text !== key ? text : fallback;
  } catch {
    return fallback;
  }
}

/** Plain-text cleanup: control characters and angle brackets become spaces, whitespace collapses,
 * and the result is capped at `max` characters (ending with an ellipsis when cut). */
export function cleanText(value, max = LABEL_MAX) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f<>]/g, ' ').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}\u2026`;
}

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

function toCount(value, fallback, cap) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return fallback;
  return clamp(Math.trunc(n), 0, cap);
}

/** Current value and max of one resource for a combatant. Missing or NaN values count as full
 * (the same default defaultActorData uses); values are clamped to 0..max; a null max means the
 * config max. Never throws, so hostile or partial data gives numbers that are safe to display. */
export function resourceNumbers(def, systemData) {
  const configMax = toCount(def?.max, 0, RESOURCE_CAP);
  const bucket = isPlainObject(systemData) && isPlainObject(systemData.res) ? systemData.res : {};
  const key = typeof def?.key === 'string' ? def.key : '';
  const entry = key && hasOwn(bucket, key) && isPlainObject(bucket[key]) ? bucket[key] : {};
  const max = entry.max === null || entry.max === undefined ? configMax : toCount(entry.max, configMax, RESOURCE_CAP);
  const raw = toNumber(entry.value);
  const value = Number.isFinite(raw) ? clamp(Math.trunc(raw), 0, max) : max;
  return { value, max };
}

/** Compact badge text for a combatant: the resources with `showInCombat`, for example
 * "Health 12/20 · Mana 5/10". Plain text, capped at LABEL_MAX characters. Empty when no
 * resource is shown in combat. */
export function formatCombatLabel(cfg, systemData) {
  try {
    const parts = [];
    for (const def of resourceList(cfg)) {
      if (!isPlainObject(def) || def.showInCombat !== true) continue;
      const { value, max } = resourceNumbers(def, systemData);
      const name = cleanText(def.label, 40) || cleanText(def.key, 24) || '?';
      parts.push(`${name} ${value}/${max}`);
    }
    return cleanText(parts.join(' \u00b7 '), LABEL_MAX);
  } catch {
    return '';
  }
}

/** Reads what a combatant needs: its cast, and the system data that belongs to it.
 * Linked casts read the actor (rule 6); a missing actor gives `missingActor: true` and empty data.
 * Returns null for an unsafe or unknown id. Throws only when the cast itself cannot be read. */
export async function readCombatantRecord(castId, api) {
  if (typeof castId !== 'string' || !ID_RE.test(castId)) return null;
  if (!api || typeof api.get !== 'function') return null;
  const cast = await api.get(`/cast/${encodeURIComponent(castId)}`);
  if (!isPlainObject(cast)) return null;
  const linked = cast.isLinked === true && typeof cast.actorId === 'string' && ID_RE.test(cast.actorId);
  if (!linked) {
    return { cast, systemData: isPlainObject(cast.systemData) ? cast.systemData : {}, missingActor: false };
  }
  let actor = null;
  try {
    actor = await api.get(`/actors/${encodeURIComponent(cast.actorId)}`);
  } catch {
    actor = null;
  }
  if (!isPlainObject(actor)) return { cast, systemData: {}, missingActor: true };
  return { cast, systemData: isPlainObject(actor.systemData) ? actor.systemData : {}, missingActor: false };
}

// ---------------------------------------------------------------------------
// Rate limits (HTTP 429)
// ---------------------------------------------------------------------------

/** True for an engine ApiError (or anything else) carrying HTTP status 429. */
export function isRateLimited(err) {
  return !!err && typeof err === 'object' && err.status === 429;
}

/** How long to stop polling after a 429: an explicit `retryAfterMs` or `retryAfter` (seconds) when
 * the error carries one, otherwise RATE_LIMIT_DEFAULT_MS (30 s). Zero for any other error. */
export function rateLimitWaitMs(err) {
  if (!isRateLimited(err)) return 0;
  let ms = NaN;
  if (typeof err.retryAfterMs === 'number') {
    ms = err.retryAfterMs;
  } else if (err.retryAfter !== undefined && err.retryAfter !== null && err.retryAfter !== '') {
    const seconds = Number(err.retryAfter);
    if (Number.isFinite(seconds)) ms = seconds * 1000;
  }
  if (!Number.isFinite(ms) || ms <= 0) ms = RATE_LIMIT_DEFAULT_MS;
  return clamp(Math.trunc(ms), 1000, RATE_LIMIT_MAX_MS);
}

// ---------------------------------------------------------------------------
// Resource sweeper (shared cache, round-robin, capped)
// ---------------------------------------------------------------------------

const signatureOf = (c) => `${c.hp ?? ''}|${c.maxHp ?? ''}`;

/**
 * Cache of combatant records plus the pass that refreshes them.
 * - setRoster(combatants): the combat row's order. A combatant with no entry, or whose hp/maxHp
 *   differs from the last read, becomes a priority read (no wait for its slot).
 * - want(castId): a combatant seen outside the panel (badges). Priority only when it has no entry.
 * - tick(): runs one pass when one is due. A pass reads priority combatants first, then fills the
 *   rest of REFRESH_CAP round-robin from a cursor. Passes come at most once per cadenceMs, except
 *   when priority reads are waiting. Never overlaps. A 429 stops the pass (the rest goes back to
 *   the priority queue) and rethrows the error so the caller can back off.
 */
export function createResourceSweeper({
  api = () => undefined,
  loadConfig = defaultLoadConfig,
  now = () => Date.now(),
  cadenceMs = RECORD_CADENCE_MS,
  cap = REFRESH_CAP,
  concurrency = REQUEST_CONCURRENCY,
  onTextChange = () => {},
} = {}) {
  const entries = new Map(); // castId -> { record, text, at, sig }
  const rows = new Map(); // castId -> signature seen in the combat row
  const roster = []; // castIds in combat order
  const priority = new Set(); // castIds to read before their round-robin slot
  let cursor = 0;
  let lastPass = -Infinity;
  let passing = false;
  let driven = false;
  let configMemo = { cfg: null, at: -Infinity };

  async function currentConfig() {
    const at = now();
    if (configMemo.cfg && at - configMemo.at < CONFIG_TTL_MS) return configMemo.cfg;
    const cfg = await loadConfig({ fresh: true });
    configMemo = { cfg, at };
    return cfg;
  }

  function setRoster(combatants) {
    const seen = new Set();
    roster.length = 0;
    for (const c of Array.isArray(combatants) ? combatants : []) {
      const id = isPlainObject(c) && typeof c.id === 'string' && ID_RE.test(c.id) ? c.id : null;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      roster.push(id);
      const sig = signatureOf(c);
      rows.set(id, sig);
      const entry = entries.get(id);
      if (!entry || entry.sig !== sig) priority.add(id);
    }
    for (const id of [...priority]) if (!seen.has(id)) priority.delete(id);
    if (cursor >= roster.length) cursor = 0;
  }

  function want(castId) {
    if (typeof castId !== 'string' || !ID_RE.test(castId)) return;
    if (!roster.includes(castId)) roster.push(castId);
    if (!entries.has(castId)) priority.add(castId);
  }

  /** Forces a read of one combatant on the next tick (used after a GM write). */
  function markDirty(castId) {
    if (typeof castId === 'string' && ID_RE.test(castId)) priority.add(castId);
  }

  function isFresh(castId) {
    const entry = entries.get(castId);
    return !!entry && now() - entry.at < cadenceMs;
  }

  function hasWork() {
    return roster.length > 0 || priority.size > 0;
  }

  function due() {
    if (passing || !hasWork()) return false;
    return priority.size > 0 || now() - lastPass >= cadenceMs;
  }

  function pickBatch() {
    const batch = [];
    for (const id of priority) {
      if (batch.length >= cap) break;
      batch.push(id);
    }
    const n = roster.length;
    if (n === 0) return batch;
    const start = cursor;
    let visited = 0;
    while (visited < n && batch.length < cap) {
      const id = roster[(start + visited) % n];
      if (!batch.includes(id)) batch.push(id);
      visited += 1;
    }
    cursor = (start + visited) % n;
    return batch;
  }

  /** Runs one pass if one is due. Resolves true when a pass ran. Throws only a 429. */
  async function tick() {
    const client = api();
    if (!client || typeof client.get !== 'function') return false;
    if (!due()) return false;
    const batch = pickBatch();
    if (batch.length === 0) return false;
    for (const id of batch) priority.delete(id);
    lastPass = now();
    passing = true;
    let rateErr = null;
    try {
      const cfg = await currentConfig();
      let next = 0;
      const worker = async () => {
        while (!rateErr && next < batch.length) {
          const id = batch[next];
          next += 1;
          const sig = rows.get(id) ?? '';
          const at = now();
          const prev = entries.get(id);
          let entry;
          try {
            const record = await readCombatantRecord(id, client);
            entry = { record, text: record ? formatCombatLabel(cfg, record.systemData) : '', at, sig };
          } catch (err) {
            if (isRateLimited(err)) {
              rateErr = err;
              priority.add(id);
              break;
            }
            // Keep the last good record on a transient error; retry on a later pass.
            entry = prev ? { ...prev, at, sig } : { record: null, text: '', at, sig };
          }
          entries.set(id, entry);
          const before = prev ? prev.text : '';
          if (before !== entry.text) {
            try {
              onTextChange(id, entry.text, before);
            } catch {
              // A broken listener must not stop the cache.
            }
          }
        }
      };
      const workers = [];
      for (let i = 0; i < Math.min(concurrency, batch.length); i += 1) workers.push(worker());
      await Promise.all(workers);
      if (rateErr) {
        for (const id of batch.slice(next)) priority.add(id);
      }
    } finally {
      passing = false;
    }
    if (rateErr) throw rateErr;
    return true;
  }

  return {
    setRoster,
    want,
    markDirty,
    tick,
    isFresh,
    hasWork,
    due,
    get: (castId) => entries.get(castId),
    setDriven(value) {
      driven = value === true;
    },
    isDriven: () => driven,
    get passing() {
      return passing;
    },
    get rosterSize() {
      return roster.length;
    },
    get prioritySize() {
      return priority.size;
    },
  };
}

// ---------------------------------------------------------------------------
// Shared instance and badge registration (combatantLabel hook)
// ---------------------------------------------------------------------------

let activeLoader = defaultLoadConfig;
let activeHooks = null;
let installed = false;
let sharedSweeper = null;
let driverTimer = null;

/** The one cache shared by the tracker panel and the badges. */
export function getSharedSweeper() {
  if (!sharedSweeper) {
    sharedSweeper = createResourceSweeper({
      api: () => loomGlobal()?.api,
      loadConfig: (opts) => activeLoader(opts),
      onTextChange: (castId) => {
        try {
          activeHooks?.callAll?.('combatantLabelsChanged', { castId });
        } catch {
          // A broken listener must not stop the cache.
        }
      },
    });
  }
  return sharedSweeper;
}

/** Forgets cached records and badges (used by tests and after a world change). */
export function clearLabelCache() {
  sharedSweeper = null;
  if (driverTimer !== null) {
    clearTimeout(driverTimer);
    driverTimer = null;
  }
}

/** Badge driver: reads in the background while no panel drives the reads. */
function startLabelDriver() {
  if (driverTimer !== null) return;
  driverTimer = setTimeout(async () => {
    driverTimer = null;
    const sweeper = getSharedSweeper();
    if (sweeper.isDriven() || !sweeper.hasWork()) return;
    try {
      await sweeper.tick();
    } catch {
      // A 429 here only pauses the badge reads; the next driver tick tries again.
    }
    if (sweeper.hasWork()) startLabelDriver();
  }, DRIVER_MS);
  driverTimer.unref?.();
}

/** Installs the `combatantLabel` listener. Returns false when there is no engine hook bus. */
export function registerCombatLabels(options = {}) {
  try {
    if (installed) return true;
    const hooks = loomGlobal()?.LoomHooks ?? globalThis.window?.LoomHooks;
    if (!hooks || typeof hooks.on !== 'function') return false;
    activeHooks = hooks;
    if (typeof options.loadConfig === 'function') activeLoader = options.loadConfig;
    hooks.on('combatantLabel', (ctx) => {
      try {
        const castId = ctx?.combatant?.id;
        if (typeof castId !== 'string' || !ID_RE.test(castId)) return;
        const sweeper = getSharedSweeper();
        const entry = sweeper.get(castId);
        if (entry) ctx.label = entry.text;
        if (!entry || !sweeper.isFresh(castId)) {
          sweeper.want(castId);
          if (!sweeper.isDriven()) {
            // No data yet: read it now. Stale data waits for the driver's next pass.
            if (!entry) void sweeper.tick().catch(() => {});
            startLabelDriver();
          }
        }
      } catch {
        // Never block the tracker row over a badge.
      }
    });
    installed = true;
    return true;
  } catch {
    return false;
  }
}
