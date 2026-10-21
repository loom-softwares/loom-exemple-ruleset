// Player-visible combat panel.
//
// Engine facts this module relies on (verified in E:\modules\LoomVTT):
// - Combat events (combat.started/next/updated/ended) reach GM sockets only
//   (server/index.ts:1334-1345). Players never get live combat updates, so this panel POLLS
//   GET /api/combat/:worldId (server/applications/api/combat.ts:52-60: any world member, returns the
//   row or null) while it is open and visible.
// - Turn and round come from the server row: `currentTurn` indexes the stored `combatants` array
//   (combat.ts:200-223). The panel shows that order, not the client's initiative sort.
// - Next, previous and end are GM routes: POST /api/combat/:worldId/next | previous | end
//   (combat.ts:200, 230, 254).
// - Resources: a linked cast (`isLinked`) writes to the actor (PUT /api/actors/:id); an unlinked
//   cast writes to the cast (PUT /api/cast/:id). Both deep-merge `systemData`, so sending only
//   `res.<key>.value` keeps `max` (server/applications/utils/helpers.ts:65-90).
// - BaseWindow exists only at runtime (window.Loom.BaseWindow), so the window class is built on
//   first use. Nothing here touches `window` at import time.
//
// Polling rules: never overlapping requests, stops when the window closes, stops while the tab is
// hidden (resumes on visibilitychange), backs off after errors. The combat row is polled every
// POLL_BASE_MS; each combatant's cast/actor is read by the shared sweeper (labels.mjs) on a slower,
// capped cadence. An HTTP 429 stops polling for its wait (Retry-After when present, else 30 s).

import { loadConfig as defaultLoadConfig, resourceList } from '../lib/config.mjs';
import { clamp, esc, isPlainObject } from '../lib/helpers.mjs';
import { cleanText, getSharedSweeper, rateLimitWaitMs, resourceNumbers, t } from './labels.mjs';

export const WINDOW_ID = 'loom-demo-combat-panel';
export const POLL_BASE_MS = 3000;
export const POLL_MAX_MS = 30000;
const CONFIG_REFRESH_MS = 30000;
const MAX_ROWS = 40;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const SLUG_RE = /^[a-z][a-z0-9_]{0,23}$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const FALLBACK_COLOR = '#6b7280';
const OWNER_LEVEL = 3;

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// ---------------------------------------------------------------------------
// Polling (pure, injectable timers)
// ---------------------------------------------------------------------------

/** Delay before the next poll. Success keeps `base`; each failure doubles it, capped at `max`. */
export function nextPollDelay({ failures = 0, base = POLL_BASE_MS, max = POLL_MAX_MS } = {}) {
  const n = Number.isFinite(failures) && failures > 0 ? Math.min(Math.floor(failures), 10) : 0;
  if (n === 0) return base;
  return Math.min(max, base * 2 ** n);
}

/**
 * Poll loop with no overlap. `task` returns a promise; a rejection counts as a failure.
 * - start(): runs now, then on the delay schedule.
 * - stop(): clears the timer; a poll already in flight finishes but schedules nothing.
 * - wake(): runs now (or right after the poll in flight), used after a GM write or when the tab is shown.
 * - While `isHidden()` is true, a scheduled tick does not run and does not reschedule.
 * - `cooldownFor(err)` returns a wait in ms after a failure (0 = normal backoff). A non-zero wait is a
 *   hard stop: nothing runs, not even wake(), until it has passed; then polling resumes.
 */
export function createPoller({
  task,
  base = POLL_BASE_MS,
  max = POLL_MAX_MS,
  isHidden = () => false,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
  now = () => Date.now(),
  cooldownFor = () => 0,
} = {}) {
  let running = false;
  let busy = false;
  let pendingWake = false;
  let failures = 0;
  let timer = null;
  let cooldownUntil = -Infinity;

  const clear = () => {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  };
  const arm = (delay) => {
    clear();
    if (!running) return;
    timer = schedule(() => {
      timer = null;
      void run();
    }, delay);
  };
  async function run() {
    if (!running || busy) return;
    if (now() < cooldownUntil) {
      // A timer can fire a little early; wait out the rest of the cooldown instead of dropping the loop.
      arm(cooldownUntil - now());
      return;
    }
    if (isHidden()) return;
    busy = true;
    let ok = true;
    let wait = 0;
    try {
      await task();
    } catch (err) {
      ok = false;
      wait = Math.max(0, Number(cooldownFor(err)) || 0);
    } finally {
      busy = false;
    }
    if (!running) return;
    failures = ok ? 0 : failures + 1;
    if (wait > 0) {
      // Hard stop: a queued wake is dropped, the timer alone resumes polling.
      pendingWake = false;
      cooldownUntil = now() + wait;
      arm(wait);
      return;
    }
    if (pendingWake) {
      pendingWake = false;
      arm(0);
      return;
    }
    arm(nextPollDelay({ failures, base, max }));
  }

  return {
    start() {
      if (running) return;
      running = true;
      failures = 0;
      void run();
    },
    stop() {
      running = false;
      pendingWake = false;
      clear();
    },
    wake() {
      if (!running) return;
      if (now() < cooldownUntil) return;
      if (busy) {
        pendingWake = true;
        return;
      }
      clear();
      void run();
    },
    get running() {
      return running;
    },
    get failures() {
      return failures;
    },
  };
}

// ---------------------------------------------------------------------------
// Rendering helpers (pure)
// ---------------------------------------------------------------------------

/** Permission level a user has on a cast ownership map (JSON text or object). */
export function ownershipLevel(ownership, userId) {
  let map = ownership;
  if (typeof map === 'string') {
    try {
      map = JSON.parse(map);
    } catch {
      return 0;
    }
  }
  if (!isPlainObject(map) || typeof userId !== 'string' || !userId) return 0;
  const level = hasOwn(map, userId) ? map[userId] : map.default;
  const n = Number(level);
  return Number.isFinite(n) ? n : 0;
}

/** A combatant is the viewer's own when they can edit its cast (ownership level 3, as canEdit). */
export function isOwnCast(cast, userId) {
  return isPlainObject(cast) && ownershipLevel(cast.ownership, userId) >= OWNER_LEVEL;
}

/** Only #rrggbb colors reach the style attribute; anything else gets the fallback. */
export function safeColor(value) {
  return typeof value === 'string' && HEX_RE.test(value) ? value : FALLBACK_COLOR;
}

/** Bar fill in percent, clamped to 0..100. Non-numbers and a zero max give 0. */
export function barPercent(value, max) {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return clamp(Math.round((value / max) * 1000) / 10, 0, 100);
}

/** Resource definitions shown in combat (showInCombat === true). */
export function combatResourceDefs(cfg) {
  return resourceList(cfg).filter((def) => isPlainObject(def) && def.showInCombat === true);
}

/** Combatants of the server row, keeping their stored index (the turn marker uses it). */
function combatantRows(combat) {
  const list = combat && Array.isArray(combat.combatants) ? combat.combatants.slice(0, MAX_ROWS) : [];
  const rows = [];
  list.forEach((c, index) => {
    if (isPlainObject(c)) rows.push({ c, index });
  });
  return rows;
}

/**
 * One poll cycle: the combat row (every cycle, the cheap call that gives round and turn), then at
 * most one sweeper pass (only when one is due). Returns `{ combat, error }`; `error` is a 429 from
 * the resource reads, which the caller rethrows so the poller backs off. Throws when the combat
 * row itself cannot be read.
 */
export async function pollOnce({ api, worldId, sweeper }) {
  const row = await api.get(`/combat/${encodeURIComponent(worldId)}`);
  const combat = isPlainObject(row) ? row : null;
  sweeper.setRoster(combatantRows(combat).map((r) => r.c));
  let error = null;
  try {
    await sweeper.tick();
  } catch (err) {
    error = err;
  }
  return { combat, error };
}

function initiativeText(value) {
  if (value === null || value === undefined) return t('sandbox.combat.noInitiative', 'Waiting');
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.trunc(n)) : t('sandbox.combat.noInitiative', 'Waiting');
}

function renderBar(def, record, castId, isGM, busy) {
  const { value, max } = resourceNumbers(def, record.systemData);
  const label = cleanText(def.label, 40) || cleanText(def.key, 24) || '?';
  const text = `${label} ${value}/${max}`;
  const width = barPercent(value, max);
  const color = safeColor(def.color);
  const disabled = busy ? ' disabled' : '';
  const adjust = isGM && castId
    ? `<span class="ldm-combat-adjust">`
      + `<button type="button" class="ldm-combat-btn ldm-combat-btn-small" data-action="combat-res" `
      + `data-cast-id="${esc(castId)}" data-res-key="${esc(def.key)}" data-delta="-1"${disabled} `
      + `aria-label="${esc(`${t('sandbox.combat.decrease', 'Decrease')} ${text}`)}">-</button>`
      + `<button type="button" class="ldm-combat-btn ldm-combat-btn-small" data-action="combat-res" `
      + `data-cast-id="${esc(castId)}" data-res-key="${esc(def.key)}" data-delta="1"${disabled} `
      + `aria-label="${esc(`${t('sandbox.combat.increase', 'Increase')} ${text}`)}">+</button>`
      + `</span>`
    : '';
  return `<div class="ldm-combat-res">`
    + `<div class="ldm-combat-res-text"><span>${esc(text)}</span>${adjust}</div>`
    + `<div class="ldm-combat-bar" role="img" aria-label="${esc(text)}">`
    + `<span class="ldm-combat-bar-fill" style="width:${width}%;background:${color}"></span></div>`
    + `</div>`;
}

function renderRow(row, ctx) {
  const { c, index } = row;
  const castId = typeof c.id === 'string' && ID_RE.test(c.id) ? c.id : '';
  const current = index === ctx.turn;
  const record = castId && hasOwn(ctx.records, castId) ? ctx.records[castId] : undefined;
  const own = !!(record && record.cast && isOwnCast(record.cast, ctx.userId));
  const classes = ['ldm-combat-row'];
  if (current) classes.push('ldm-combat-current');
  if (own) classes.push('ldm-combat-own');
  const tags = [];
  if (current) tags.push(`<span class="ldm-combat-tag">${esc(t('sandbox.combat.turnMarker', 'Current'))}</span>`);
  if (own) tags.push(`<span class="ldm-combat-tag ldm-combat-tag-own">${esc(t('sandbox.combat.you', 'You'))}</span>`);

  let body = '';
  if (!record) {
    body = `<p class="ldm-combat-note">${esc(t('sandbox.combat.noData', 'No data'))}</p>`;
  } else if (record.missingActor) {
    body = `<p class="ldm-combat-note">${esc(t('sandbox.combat.missingActor', 'Actor not found'))}</p>`;
  } else if (ctx.config) {
    body = combatResourceDefs(ctx.config)
      .map((def) => renderBar(def, record, ctx.isGM ? castId : '', ctx.isGM, ctx.busy))
      .join('');
  }

  const name = cleanText(c.name, 60) || '?';
  const aria = current ? ' aria-current="step"' : '';
  return `<li class="${classes.join(' ')}" data-cast-id="${esc(castId)}"${aria}>`
    + `<div class="ldm-combat-head">`
    + `<span class="ldm-combat-name">${esc(name)}</span>`
    + `<span class="ldm-combat-init">${esc(t('sandbox.combat.initiative', 'Initiative'))}: ${esc(initiativeText(c.initiative))}</span>`
    + `</div>`
    + (tags.length ? `<div class="ldm-combat-tags">${tags.join('')}</div>` : '')
    + body
    + `</li>`;
}

/**
 * HTML of the panel body. Every string is escaped; resource colors are validated and widths clamped.
 * `state`: { status, combat, config, records, isGM, userId, busy, notice }
 *   records: { [castId]: { cast, systemData, missingActor } | null }  (null = could not read)
 */
export function renderCombatPanel(state) {
  const s = isPlainObject(state) ? state : {};
  const combat = isPlainObject(s.combat) ? s.combat : null;
  const config = isPlainObject(s.config) ? s.config : null;
  const records = isPlainObject(s.records) ? s.records : Object.create(null);
  const isGM = s.isGM === true;
  const busy = s.busy === true;
  const userId = typeof s.userId === 'string' && s.userId ? s.userId : null;
  const parts = ['<div class="ldm-combat-root">'];

  if (s.status === 'error') {
    parts.push(`<p class="ldm-combat-status ldm-combat-status-error" role="alert">${esc(t('sandbox.combat.error', 'Could not load the combat. Retrying.'))}</p>`);
  }
  if (s.notice === 'failed') {
    parts.push(`<p class="ldm-combat-status ldm-combat-status-error" role="alert">${esc(t('sandbox.combat.updateFailed', 'The change was not saved.'))}</p>`);
  }
  if (busy) {
    parts.push(`<p class="ldm-combat-status" role="status">${esc(t('sandbox.combat.updating', 'Updating...'))}</p>`);
  }

  if (!combat) {
    const text = s.status === 'loading' || !s.status
      ? t('sandbox.combat.loading', 'Loading...')
      : t('sandbox.combat.none', 'No active combat.');
    parts.push(`<p class="ldm-combat-empty">${esc(text)}</p>`);
  } else {
    const rows = combatantRows(combat);
    const turn = Number.isFinite(Number(combat.currentTurn)) ? clamp(Math.trunc(Number(combat.currentTurn)), 0, 99999) : 0;
    const round = Number.isFinite(Number(combat.round)) ? clamp(Math.trunc(Number(combat.round)), 1, 99999) : 1;
    const active = rows.find((r) => r.index === turn);
    const activeName = active ? cleanText(active.c.name, 60) || '?' : '';
    parts.push(`<div class="ldm-combat-header">`
      + `<span class="ldm-combat-round">${esc(t('sandbox.combat.round', 'Round'))} ${round}</span>`
      + (activeName ? `<span class="ldm-combat-turn">${esc(t('sandbox.combat.turn', 'Current turn'))}: ${esc(activeName)}</span>` : '')
      + `</div>`);
    if (rows.length === 0) {
      parts.push(`<p class="ldm-combat-empty">${esc(t('sandbox.combat.noCombatants', 'No combatants yet.'))}</p>`);
    } else {
      const ctx = { turn, records, config, isGM, busy, userId };
      parts.push(`<ol class="ldm-combat-list">${rows.map((row) => renderRow(row, ctx)).join('')}</ol>`);
    }
    if (isGM) {
      const disabled = busy ? ' disabled' : '';
      parts.push(`<div class="ldm-combat-actions">`
        + `<button type="button" class="ldm-combat-btn" data-action="combat-prev"${disabled}>${esc(t('sandbox.combat.previous', 'Previous turn'))}</button>`
        + `<button type="button" class="ldm-combat-btn ldm-combat-btn-primary" data-action="combat-next"${disabled}>${esc(t('sandbox.combat.next', 'Next turn'))}</button>`
        + `<button type="button" class="ldm-combat-btn ldm-combat-btn-danger" data-action="combat-end"${disabled}>${esc(t('sandbox.combat.end', 'End combat'))}</button>`
        + `</div>`);
    }
  }
  parts.push('</div>');
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Window (built on first use: needs window.Loom.BaseWindow at runtime)
// ---------------------------------------------------------------------------

function freshPanel() {
  return {
    status: 'loading',
    combat: null,
    combatId: null,
    config: null,
    records: Object.create(null),
    isGM: false,
    userId: null,
    busy: false,
    notice: '',
  };
}

function loomGlobal() {
  return typeof globalThis !== 'undefined' ? globalThis.window?.Loom : undefined;
}

function isHiddenTab() {
  return typeof document !== 'undefined' && document.hidden === true;
}

/** Builds the panel class on top of a given BaseWindow class (exported for tests). */
export function createCombatPanelClass(Base) {
  return class CombatPanelWindow extends Base {
    static DEFAULT_OPTIONS = { id: WINDOW_ID, title: 'Combat', width: 420, height: 'auto' };

    constructor(props = {}) {
      super({
        ...(isPlainObject(props) ? props : {}),
        id: WINDOW_ID,
        title: t('sandbox.combat.windowTitle', 'Combat'),
      });
      this.panel = freshPanel();
      this.started = false;
      this.closed = false;
      this.configLoadedAt = 0;
      this.poller = createPoller({
        task: () => this.refresh(),
        isHidden: isHiddenTab,
        cooldownFor: rateLimitWaitMs,
      });
      this.onVisibility = () => {
        if (!isHiddenTab()) this.poller.wake();
      };
    }

    bodyTemplate() {
      return renderCombatPanel(this.panel);
    }

    onRender() {
      if (this.started || this.closed) return;
      this.started = true;
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
      getSharedSweeper().setDriven(true);
      this.poller.start();
    }

    onClose() {
      this.closed = true;
      this.poller.stop();
      getSharedSweeper().setDriven(false);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    }

    onAction(action, id, target) {
      if (action === 'combat-next') return this.advance('next');
      if (action === 'combat-prev') return this.advance('previous');
      if (action === 'combat-end') return this.endCombat();
      if (action === 'combat-res') return this.adjustResource(target);
      return undefined;
    }

    rerender() {
      if (!this.closed && this.element) this.rerenderBody();
    }

    setBusy(value) {
      this.panel.busy = value;
      this.rerender();
    }

    worldId() {
      const id = loomGlobal()?.world?.id;
      return typeof id === 'string' && ID_RE.test(id) ? id : '';
    }

    async advance(verb) {
      const api = loomGlobal()?.api;
      const worldId = this.worldId();
      if (!api || !worldId || !this.panel.isGM || this.panel.busy) return;
      this.panel.notice = '';
      this.setBusy(true);
      try {
        await api.post(`/combat/${encodeURIComponent(worldId)}/${verb}`, {});
      } catch {
        this.panel.notice = 'failed';
      } finally {
        this.setBusy(false);
      }
      this.poller.wake();
    }

    async endCombat() {
      if (!this.panel.isGM || this.panel.busy) return;
      // The engine dialog keeps focus inside the app; window.confirm is only a last resort.
      const message = t('sandbox.combat.endConfirm', 'End the combat?');
      const title = t('sandbox.combat.end', 'End combat');
      const showConfirm = loomGlobal()?.showConfirm;
      let ask = false;
      if (typeof showConfirm === 'function') {
        try {
          ask = await showConfirm(title, message);
        } catch {
          ask = false;
        }
      } else if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
        ask = window.confirm(message);
      }
      if (!ask) return;
      const api = loomGlobal()?.api;
      const worldId = this.worldId();
      if (!api || !worldId) return;
      this.panel.notice = '';
      this.setBusy(true);
      try {
        await api.post(`/combat/${encodeURIComponent(worldId)}/end`, {});
      } catch {
        this.panel.notice = 'failed';
      } finally {
        this.setBusy(false);
      }
      this.poller.wake();
    }

    async adjustResource(target) {
      const api = loomGlobal()?.api;
      if (!api || !this.panel.isGM || this.panel.busy || !target || !target.dataset) return;
      const castId = target.dataset.castId || '';
      const key = target.dataset.resKey || '';
      const delta = Number(target.dataset.delta);
      if (!ID_RE.test(castId) || !SLUG_RE.test(key) || (delta !== 1 && delta !== -1)) return;
      const record = hasOwn(this.panel.records, castId) ? this.panel.records[castId] : null;
      if (!record || !record.cast || record.missingActor) return;
      const def = combatResourceDefs(this.panel.config).find((d) => d.key === key);
      if (!def) return;
      const { value, max } = resourceNumbers(def, record.systemData);
      const next = clamp(value + delta, 0, max);
      if (next === value) return;

      const cast = record.cast;
      const linked = cast.isLinked === true && typeof cast.actorId === 'string' && ID_RE.test(cast.actorId);
      const path = linked
        ? `/actors/${encodeURIComponent(cast.actorId)}`
        : `/cast/${encodeURIComponent(castId)}`;
      const patch = { systemData: { res: { [key]: { value: next } } } };
      this.panel.notice = '';
      this.setBusy(true);
      try {
        await api.put(path, patch);
      } catch {
        this.panel.notice = 'failed';
      } finally {
        this.setBusy(false);
      }
      // Re-read this combatant on the next poll, not on its slow turn.
      getSharedSweeper().markDirty(castId);
      this.poller.wake();
    }

    /** One poll: the combat row, then a due resource pass from the shared sweeper. Config is refreshed
     * on open, on a new combat, and every 30 s. Throws on a failed combat read, and on a 429 from the
     * resource reads, so the poller backs off (a 429 waits 30 s or the given Retry-After). */
    async refresh() {
      const loom = loomGlobal();
      const worldId = this.worldId();
      if (!loom?.api || !worldId) {
        this.panel = { ...this.panel, status: 'error' };
        this.rerender();
        throw new Error('no world');
      }
      const sweeper = getSharedSweeper();
      let result;
      try {
        result = await pollOnce({ api: loom.api, worldId, sweeper });
      } catch (err) {
        this.panel = { ...this.panel, status: 'error' };
        this.rerender();
        throw err;
      }
      const { combat } = result;
      const combatId = combat && typeof combat.id === 'string' ? combat.id : null;
      const at = Date.now();
      let config = this.panel.config;
      if (!config || combatId !== this.panel.combatId || at - this.configLoadedAt > CONFIG_REFRESH_MS) {
        config = await defaultLoadConfig({ fresh: true });
        this.configLoadedAt = at;
      }
      const records = Object.create(null);
      for (const row of combatantRows(combat)) {
        const id = typeof row.c.id === 'string' ? row.c.id : '';
        const entry = ID_RE.test(id) ? sweeper.get(id) : undefined;
        if (entry) records[id] = entry.record;
      }
      this.panel = {
        ...this.panel,
        status: result.error ? 'error' : 'ready',
        combat,
        combatId,
        config,
        records,
        isGM: loom.user?.isGM === true,
        userId: typeof loom.user?.id === 'string' ? loom.user.id : null,
      };
      this.rerender();
      if (result.error) throw result.error;
    }
  };
}

let cachedBase = null;
let cachedClass = null;

/** The panel class, built on window.Loom.BaseWindow the first time it exists. Null without an engine. */
export function getCombatPanelClass() {
  const Base = loomGlobal()?.BaseWindow;
  if (typeof Base !== 'function') return null;
  if (cachedClass && cachedBase === Base) return cachedClass;
  cachedBase = Base;
  cachedClass = createCombatPanelClass(Base);
  return cachedClass;
}

/** Opens the panel (or focuses it when open). Returns false without an engine. */
export function openCombatPanel(props = {}) {
  try {
    const Cls = getCombatPanelClass();
    const wm = loomGlobal()?.windowManager;
    if (!Cls || !wm || typeof wm.open !== 'function') return false;
    wm.open(WINDOW_ID, Cls, isPlainObject(props) ? props : {});
    return true;
  } catch {
    return false;
  }
}

/** Registration: builds the window class now if the engine is ready. Returns false otherwise. */
export function registerCombatPanel() {
  try {
    return getCombatPanelClass() !== null;
  } catch {
    return false;
  }
}
