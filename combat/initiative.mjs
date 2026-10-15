// Initiative for the `combatInitiative` hook.
//
// Engine facts this module relies on (verified in E:\modules\LoomVTT):
// - The hook is called with ctx `{ castIds, initiatives, health, rolls, pending }` by the GM
//   "Start combat (DEX)" button, only for the selected tokens (client/screens/game-hud/sidebar.ts:6089-6112).
// - The UI awaits `ctx.pending` before it POSTs dex-initiative (sidebar.ts:6111). A rejected promise
//   there aborts the whole start, so every error is caught here.
// - A total in `ctx.initiatives[castId]` is used as given, clamped to -20..100 by the server
//   (server/applications/api/combat.ts:152-164). The formula in the request is ignored for these tokens.
// - The hook is registered with LoomHooks.on, the same way other rulesets do it.
//   This module reads `window.LoomHooks` directly so it can be imported in plain Node for tests.
//
// Pure functions here run in plain Node. Nothing touches `window` at import time.

import { buildCheck } from '../lib/dice.mjs';
import { actorValue, attributeRollValue, loadConfig as defaultLoadConfig } from '../lib/config.mjs';
import { clamp, isPlainObject } from '../lib/helpers.mjs';
import { cleanText, readCombatantRecord, t } from './labels.mjs';

export const INITIATIVE_MIN = -20;
export const INITIATIVE_MAX = 100;
const MAX_TOKENS = 50;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MODES = ['roll', 'attribute', 'fixed'];

/** Maps a random number in [0, 1) to a die face 1..faces. Any other value is clamped into range. */
function dieValue(rng, faces) {
  const r = Number(rng());
  const safe = Number.isFinite(r) ? Math.min(Math.max(r, 0), 0.9999999999) : 0;
  return 1 + Math.floor(safe * faces);
}

function finalize(n) {
  const whole = Number.isFinite(n) ? Math.trunc(n) : 0;
  return clamp(whole, INITIATIVE_MIN, INITIATIVE_MAX);
}

function initiativeSettings(cfg) {
  const init = isPlainObject(cfg?.combat?.initiative) ? cfg.combat.initiative : {};
  const mode = MODES.includes(init.mode) ? init.mode : 'roll';
  const attr = typeof init.attr === 'string' ? init.attr : '';
  const bonusRaw = Number(init.bonus);
  const bonus = Number.isFinite(bonusRaw) ? clamp(Math.trunc(bonusRaw), -99, 99) : 0;
  return { mode, attr, bonus };
}

/**
 * Initiative total for one combatant. Integer, always inside -20..100.
 *   roll      d20 mode: 1d{sides} + attribute + bonus.
 *             pool mode: number of successes of a pool sized by attribute + bonus (min 1 die).
 *   attribute attribute value + bonus (no roll).
 *   fixed     bonus only.
 * An empty `attr` counts as 0. The dice shape comes from buildCheck (lib/dice.mjs), so the pool
 * size and the d20 modifier follow the same rules as every other check.
 *
 * @param {object} cfg validated or migrated config
 * @param {object} actorSystemData the combatant's systemData (or an object with `systemData`)
 * @param {() => number} [rng] random source in [0, 1); injectable for tests
 */
export function computeInitiative(cfg, actorSystemData, rng = Math.random) {
  try {
    const { mode, attr, bonus } = initiativeSettings(cfg);
    const attrValue = attr ? attributeRollValue(cfg, attr, actorValue(actorSystemData, cfg, 'attr', attr)) : 0;
    if (mode === 'fixed') return finalize(bonus);
    if (mode === 'attribute') return finalize(attrValue + bonus);

    const built = buildCheck(cfg, { attrValue, bonus });
    const pool = /^(\d+)d(\d+)cs>=(\d+)$/.exec(built.formula);
    if (pool) {
      const count = Number(pool[1]);
      const faces = Number(pool[2]);
      const successMin = Number(pool[3]);
      let successes = 0;
      for (let i = 0; i < count; i += 1) {
        if (dieValue(rng, faces) >= successMin) successes += 1;
      }
      return finalize(successes);
    }
    const d20 = /^1d(\d+)([+-]\d+)$/.exec(built.formula);
    if (d20) {
      const sides = Number(d20[1]);
      const modifier = Number(d20[2]);
      return finalize(dieValue(rng, sides) + modifier);
    }
    return finalize(attrValue + bonus);
  } catch {
    return 0;
  }
}

/** Chat line with the rolled totals, highest first. Plain text: the chat renderer escapes it. */
export function formatInitiativeSummary(results) {
  const heading = t('sandbox.combat.initiativeSummary', 'Initiative');
  const lines = [...results]
    .sort((a, b) => b.total - a.total)
    .map((r) => `${cleanText(r.name, 40) || '?'} ${r.total}`);
  return cleanText(`${heading}: ${lines.join(' \u00b7 ')}`, 1000);
}

function postSummary(results) {
  try {
    const chat = globalThis.window?.Loom?.ChatMessage;
    if (!chat || typeof chat.create !== 'function' || results.length === 0) return;
    const speaker = { alias: t('sandbox.combat.speaker', 'Combat') };
    const flags = { 'loom-demo-system': { combatInitiative: true } };
    Promise.resolve(chat.create({ content: formatInitiativeSummary(results), speaker, flags })).catch(() => {});
  } catch {
    // The summary is a convenience: the totals are already set.
  }
}

async function rollForTokens(castIds, out, load, rng, apiOverride) {
  const results = [];
  try {
    const cfg = await load({ fresh: true });
    const api = apiOverride ?? globalThis.window?.Loom?.api;
    for (const castId of castIds) {
      try {
        const record = await readCombatantRecord(castId, api);
        if (!record) continue;
        const total = computeInitiative(cfg, record.systemData, rng);
        out[castId] = total;
        results.push({ name: record.cast.name, total });
      } catch {
        // This token keeps no total: the server then waits for its d20 instead of failing the start.
      }
    }
  } catch {
    // Config unreadable: nothing is set, and the server falls back to the deferred d20 flow.
  }
  postSummary(results);
}

/**
 * Installs the `combatInitiative` handler. Returns false when there is no engine hook bus.
 * The handler only pushes into `ctx.pending`; it never throws.
 */
export function registerCombatInitiative(options = {}) {
  try {
    const hooks = globalThis.window?.Loom?.LoomHooks ?? globalThis.window?.LoomHooks;
    if (!hooks || typeof hooks.on !== 'function') return false;
    const load = typeof options.loadConfig === 'function' ? options.loadConfig : defaultLoadConfig;
    const rng = typeof options.rng === 'function' ? options.rng : Math.random;
    hooks.on('combatInitiative', (ctx) => {
      try {
        if (!ctx || !Array.isArray(ctx.pending) || !isPlainObject(ctx.initiatives)) return;
        const castIds = (Array.isArray(ctx.castIds) ? ctx.castIds : [])
          .filter((id) => typeof id === 'string' && ID_RE.test(id))
          .slice(0, MAX_TOKENS);
        ctx.pending.push(rollForTokens(castIds, ctx.initiatives, load, rng, options.api));
      } catch {
        // Leave the totals empty: the server handles those combatants.
      }
    });
    return true;
  } catch {
    return false;
  }
}
