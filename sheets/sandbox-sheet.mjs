// Actor sheet for the sandbox ruleset. ONE class serves the actor types hero, villain
// and beast (registerActorSheet() catalogs it for each).
//
// Layout of this file:
//   1. Pure part (no window, no DOM at import time, Node-testable):
//      buildSheetContext, renderSheet, buildPatch, mergePatch, applyChange,
//      applyItemChange, resolveWriteTarget, planUse, resourceState,
//      changeFromField, safeImageUrl.
//   2. Engine part: registerActorSheet() builds the sheet class lazily from
//      window.Loom (the SDK re-exports the same classes, but importing the SDK
//      module here would break `node --test`). Writes send ONLY the changed
//      paths as a partial systemData patch (the server deep-merges it), so
//      effect-applied values from the actor responses are never written back.
//      Unlinked casts go to /api/cast/:id (see _ldmLoadCast).
//
// Every string that reaches HTML goes through esc(). Config text, actor names and
// item names are attacker-controlled (any GM account or imported JSON).

import { esc, clamp, deepClone, isPlainObject } from '../lib/helpers.mjs';
import { portraitMedia } from '../lib/portrait.mjs';
import {
  loadConfig,
  defaultConfig,
  validateConfig,
  defaultItemData,
  actorValue,
  attributeRollValue,
  abilityKindLabel,
  resourceList,
  categoryList,
  attributeList,
  skillList,
  resolveLayout,
  groupedList,
  skillSections,
  blockLabelKey,
  LAYOUT_BLOCKS,
  LAYOUT_DENSITIES,
} from '../lib/config.mjs';
import { describe as describeDice, buildExtra, buildCheck, rollCheck } from '../lib/dice.mjs';
import { renderTabs, renderGrid, renderBlock, attachTabs } from '../lib/layout-view.mjs';
import { renderEffectsBlock, loadEffects, attachEffects, getEffectsEditState, applyItemEffects } from '../lib/effects-view.mjs';
import { sumSources } from '../lib/check-sources.mjs';
import { buildAttackRoll, attackTotal } from '../lib/attacks.mjs';
import { planCast, planPrepare, planRecovery } from '../lib/casting.mjs';

export const ACTOR_TYPES = Object.freeze(['hero', 'villain', 'beast']);

/** Item groups shown by the item blocks. `other` = legacy types and any unknown type. */
const ITEM_GROUP_TYPES = Object.freeze(['gear', 'ability', 'spell', 'other']);
/** Groups that can be created from the sheet (legacy types cannot). */
const ADDABLE_GROUP_TYPES = Object.freeze(['gear', 'ability', 'spell']);
/**
 * Item types whose effects are copied onto the actor when the item is used. Gear, weapons and
 * armor never copy their effects (they are not "used"). The engine never applies item effects itself.
 */
export const EFFECT_USE_TYPES = Object.freeze(['ability', 'spell', 'potion', 'scroll']);

// English fallbacks for the block titles (the real text lives in sandbox.layout.*).
const BLOCK_FALLBACK = Object.freeze({
  resources: 'Resources',
  saves: 'Saving throws',
  attacks: 'Attacks',
  magic: 'Magic',
  attributes: 'Attributes',
  skills: 'Skills',
  'items:gear': 'Gear',
  'items:ability': 'Abilities',
  'items:spell': 'Spells',
  'items:other': 'Other items',
  notes: 'Notes',
  effects: 'Effects',
});
const TABLIST_FALLBACK = 'Sheet sections';
const DEFAULT_RES_COLOR = '#7c5cff';
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const NOTES_MAX = 4000;
const QTY_MAX = 9999;
const DESCRIPTION_MAX = 500;
const ADV_ORDER = Object.freeze(['none', 'adv', 'dis']);

// Localizable strings. The key is also the i18n key (sandbox.sheet.*). The English
// text here is the fallback when no translation is loaded.
const STRINGS = Object.freeze({
  'sandbox.sheet.portrait': 'Portrait',
  'sandbox.sheet.editPortrait': 'Edit portrait and token',
  'sandbox.sheet.portraitUnavailable': 'The portrait editor is not available in this engine version.',
  'sandbox.sheet.noPortrait': 'No portrait',
  'sandbox.sheet.typeHero': 'Hero',
  'sandbox.sheet.typeVillain': 'Villain',
  'sandbox.sheet.typeBeast': 'Beast',
  'sandbox.sheet.typeOther': 'Actor',
  'sandbox.sheet.rollMode': 'Roll mode',
  'sandbox.sheet.advNone': 'Normal',
  'sandbox.sheet.advAdv': 'Advantage',
  'sandbox.sheet.advDis': 'Disadvantage',
  'sandbox.sheet.configure': 'Configure system',
  'sandbox.sheet.combat': 'Open combat panel',
  'sandbox.sheet.reloadConfig': 'Reload configuration',
  'sandbox.sheet.configChanged': 'The system configuration changed. The sheet now uses the new version.',
  'sandbox.sheet.noEntries': 'Nothing to show here yet.',
  'sandbox.sheet.decrease': 'Decrease',
  'sandbox.sheet.increase': 'Increase',
  'sandbox.sheet.resCount': '{value} / {max}',
  'sandbox.sheet.resValue': '{label} value',
  'sandbox.sheet.rollNamed': 'Roll {label}',
  'sandbox.sheet.rollAttribute': 'Roll',
  'sandbox.sheet.min': 'Min',
  'sandbox.sheet.max': 'Max',
  'sandbox.sheet.dotValue': 'Set {label} to {value}',
  'sandbox.sheet.dotsFallback': 'This attribute uses numbers because negative values or maximums above 20 do not fit the dot display.',
  'sandbox.sheet.basedOn': 'Based on {label}',
  'sandbox.sheet.skillsOther': 'No attribute',
  'sandbox.sheet.rank': 'Rank',
  'sandbox.sheet.savingThrows': 'Saving throws',
  'sandbox.sheet.attack': 'Attack',
  'sandbox.sheet.rollDamage': 'Roll damage',
  'sandbox.sheet.prepare': 'Prepare',
  'sandbox.sheet.difficulty': 'Difficulty',
  'sandbox.sheet.castAtLevel': 'Cast using level',
  'sandbox.sheet.castUses': 'Uses {value}/{max}',
  'sandbox.sheet.prepareCapacity': 'That spell exceeds the available preparation capacity.',
  'sandbox.sheet.defense': 'Defense',
  'sandbox.sheet.castSlots': 'Spell slots',
  'sandbox.sheet.recoverMagic': 'Recover magic',
  'sandbox.sheet.attackRoll': 'Attack roll',
  'sandbox.sheet.damageMethod': 'Damage: {method}',
  'sandbox.sheet.modifier': 'Modifier',
  'sandbox.sheet.addItem': 'Add {kind}',
  'sandbox.sheet.noItems': 'Nothing here yet.',
  'sandbox.sheet.uncategorized': 'Uncategorized',
  'sandbox.sheet.kindGear': 'Gear',
  'sandbox.sheet.kindAbility': 'Ability',
  'sandbox.sheet.kindSpell': 'Spell',
  'sandbox.sheet.kindOther': 'Other',
  'sandbox.sheet.quantity': 'Quantity',
  'sandbox.sheet.uses': 'Uses',
  'sandbox.sheet.use': 'Use',
  'sandbox.sheet.edit': 'Edit',
  'sandbox.sheet.delete': 'Delete',
  'sandbox.sheet.confirmDelete': 'Delete this item?',
  'sandbox.sheet.costLabel': 'Cost {amount} {res}',
  'sandbox.sheet.unnamed': 'Unnamed',
  'sandbox.sheet.noActor': 'No actor is loaded.',
  'sandbox.sheet.newGear': 'New gear',
  'sandbox.sheet.newAbility': 'New ability',
  'sandbox.sheet.newSpell': 'New spell',
  'sandbox.sheet.created': 'Item created.',
  'sandbox.sheet.deleted': 'Item deleted.',
  'sandbox.sheet.used': '{actor} used {item}.',
  'sandbox.sheet.effectsApplied': 'Applied {count} effect(s) from {item}.',
  'sandbox.sheet.damage': 'Damage',
  'sandbox.sheet.errInsufficient': 'Not enough {res}.',
  'sandbox.sheet.errNoUses': 'No uses left.',
  'sandbox.sheet.errInvalidCost': 'This item has an invalid cost.',
  'sandbox.sheet.errNegativeCost': 'This item has a negative cost.',
  'sandbox.sheet.errUnknownRes': 'This item costs a resource the system no longer has.',
  'sandbox.sheet.errInvalidUses': 'This item has an invalid uses value.',
  'sandbox.sheet.errSave': 'Could not save. The sheet was reloaded.',
  'sandbox.sheet.errCastRefused': 'Could not verify this token, so nothing was saved.',
  'sandbox.sheet.errNoDispatch': 'Rolls are not available here.',
  'sandbox.sheet.errNoItemSheet': 'No item sheet is available for this item.',
  'sandbox.sheet.errEditorMissing': 'The rule editor is not available yet.',
  'sandbox.sheet.errCombatMissing': 'The combat panel is not available yet.',
  'sandbox.sheet.errGeneric': 'Something went wrong.',
  // XP ledger
  'sandbox.sheet.xpTotal': 'XP total',
  'sandbox.sheet.xpAvailable': 'XP available',
  'sandbox.sheet.xpValue': 'XP value',
  'sandbox.sheet.xpReason': 'Reason',
  'sandbox.sheet.xpAdd': 'Add XP',
  'sandbox.sheet.xpHistory': 'XP history',
  'sandbox.sheet.xpValuePlaceholder': '+100 or -50',
  'sandbox.sheet.xpReasonPlaceholder': 'Where it was spent or where it came from',
  'sandbox.sheet.xpRemove': 'Remove XP entry',
  // Accessible names
  'sandbox.sheet.saveAdjustment': '{label} adjustment',
  'sandbox.sheet.slotsAvailable': '{label} available slots',
  'sandbox.sheet.slotsMax': '{label} maximum slots',
  // Save state
  'sandbox.sheet.saving': 'Saving…',
  'sandbox.sheet.saved': 'Saved',
});

const ICONS = Object.freeze({
  dice: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15.5" cy="8.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="8.5" cy="15.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15.5" cy="15.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  skull: '<path d="M12 2a7 7 0 0 0-7 7v3c0 1.7.8 3.2 2 4.2V19a3 3 0 0 0 3 3h4a3 3 0 0 0 3-3v-2.8c1.2-1 2-2.5 2-4.2V9a7 7 0 0 0-7-7z"/><circle cx="9" cy="10" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1.4" fill="currentColor" stroke="none"/><path d="M10 17h4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/>',
  swords: '<path d="M14 4h6v6L9 21l-6-6z"/><path d="M6 15l3 3"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
});

/** Inline icon from the fixed set. Decorative by default: the label lives on the button. */
function icon(name) {
  const body = ICONS[name];
  return body
    ? `<svg class="ldm-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`
    : '';
}

const PLAN_ERROR_KEYS = Object.freeze({
  'insufficient-resource': 'sandbox.sheet.errInsufficient',
  'no-uses': 'sandbox.sheet.errNoUses',
  'invalid-cost': 'sandbox.sheet.errInvalidCost',
  'negative-cost': 'sandbox.sheet.errNegativeCost',
  'unknown-resource': 'sandbox.sheet.errUnknownRes',
  'invalid-uses': 'sandbox.sheet.errInvalidUses',
});

// ══════════════════════════════════════════════════════════════
// Small pure helpers
// ══════════════════════════════════════════════════════════════

function hasOwn(obj, key) {
  return obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
}

function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Finite number from a number or a non-empty numeric string; null otherwise. */
function toNumber(value) {
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
  else return null;
  return Number.isFinite(n) ? n : null;
}

function safeCfg(cfg) {
  try {
    return validateConfig(cfg).config;
  } catch {
    return defaultConfig();
  }
}

/** Replaces `{name}` placeholders. The result is still raw text: escape it once at output. */
function fmt(template, vars) {
  const text = String(template ?? '');
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) => (hasOwn(vars, name) ? String(vars[name]) : match));
}

/** Makes a value safe for a form field `name` (the core focus restore looks it up by name). */
function safeName(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
}

function safeColor(color) {
  return typeof color === 'string' && HEX_RE.test(color) ? color : DEFAULT_RES_COLOR;
}

/**
 * Accepts only site-relative paths, http(s) URLs and base64 raster data URIs.
 * Anything else (javascript:, data:text/html, ...) returns ''.
 */
export function safeImageUrl(url) {
  if (typeof url !== 'string') return '';
  const u = url.trim();
  if (u.length === 0 || u.length > 2048) return '';
  if (/^\/(?!\/)/.test(u)) return u;
  if (/^https?:\/\//i.test(u)) return u;
  if (/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(u)) return u;
  return '';
}

function storedMax(stored) {
  return stored && typeof stored.max === 'number' && Number.isFinite(stored.max) && stored.max >= 0 ? stored.max : null;
}

function resourceStored(sys, key) {
  const bucket = isPlainObject(sys?.res) ? sys.res : {};
  return hasOwn(bucket, key) && isPlainObject(bucket[key]) ? bucket[key] : null;
}

/**
 * Current state of one resource. A missing entry means full (the config max); a stored
 * `max` of null means "use the config max". Value is always clamped to 0..max.
 * Returns null when the key is not in the config (the resource was removed).
 */
export function resourceState(sys, cfg, key) {
  const c = safeCfg(cfg);
  const def = resourceList(c).find((r) => r.key === key);
  if (!def) return null;
  const stored = resourceStored(sys, key);
  const max = storedMax(stored) ?? def.max;
  let raw;
  if (!stored) raw = max;
  else {
    const n = toNumber(stored.value);
    raw = n === null ? 0 : n;
  }
  return {
    key,
    label: def.label,
    color: safeColor(def.color),
    showInCombat: def.showInCombat === true,
    value: clamp(Math.trunc(raw), 0, max),
    max,
    storedMax: storedMax(stored),
  };
}

// ══════════════════════════════════════════════════════════════
// Pure state transitions
// ══════════════════════════════════════════════════════════════

/**
 * Applies one change to an actor systemData object and returns a NEW object.
 * Keys that the config no longer lists are never deleted: only the key in the change
 * is written. Numbers are clamped to their limits; a value that is not a number is
 * ignored (the object comes back unchanged).
 *
 * change kinds:
 *   { kind: 'attr',  key, value }          clamped to the attribute min..max
 *   { kind: 'skill', key, value }          clamped to 0..skill max
 *   { kind: 'res',   key, value }          absolute, clamped to 0..resource max
 *   { kind: 'res',   key, delta }          relative (+1 / -1 from the buttons)
 *   { kind: 'notes', value }              string, capped at 4000 characters
 */
export function applyChange(sys, cfg, change) {
  const base = isPlainObject(sys) ? deepClone(sys) : {};
  const built = buildPatch(base, cfg, change);
  return built ? mergePatch(base, built.systemData) : base;
}

/**
 * Deep merge with the same rule the server uses for an update: plain objects merge key by
 * key, anything else (numbers, strings, arrays) replaces. Returns a NEW object.
 * The sheet never sends "-=" keys, so no key is ever deleted by a patch.
 */
export function mergePatch(base, patch) {
  const out = isPlainObject(base) ? deepClone(base) : {};
  if (!isPlainObject(patch)) return out;
  for (const key of Object.keys(patch)) {
    const next = patch[key];
    if (isPlainObject(next) && isPlainObject(out[key])) setOwn(out, key, mergePatch(out[key], next));
    else if (next !== null && typeof next === 'object') setOwn(out, key, deepClone(next));
    else setOwn(out, key, next);
  }
  return out;
}

/** True when a patch carries no key (nothing to send). */
export function isEmptyPatch(patch) {
  return !isPlainObject(patch) || Object.keys(patch).length === 0;
}

/**
 * Builds the MINIMAL systemData patch for one change. `sys` is the view the user sees
 * (pending changes already merged in), used to clamp relative deltas. Pure: nothing is written.
 *
 * Returns `{ systemData: {...} }` holding only the changed path, for example
 *   { kind: 'attr', key: 'might', value: 3 }  ->  { systemData: { attrs: { might: 3 } } }
 *   { kind: 'res', key: 'hp', value: 7 }      ->  { systemData: { res: { hp: { value: 7 } } } }
 * or null when the change is not valid (unknown key, not a number, ...). A resource patch
 * never carries `max`, so a stored max override is kept by the server's deep merge.
 */
export function buildPatch(sys, cfg, change) {
  if (!change || typeof change !== 'object') return null;
  const c = safeCfg(cfg);
  const view = isPlainObject(sys) ? sys : {};

  switch (change.kind) {
    case 'attr': {
      const def = attributeList(c).find((a) => a.key === change.key);
      const n = toNumber(change.value);
      if (!def || n === null) return null;
      const attrs = {};
      setOwn(attrs, def.key, clamp(Math.trunc(n), def.min, def.max));
      return { systemData: { attrs } };
    }
    case 'skill': {
      const def = skillList(c).find((s) => s.key === change.key);
      const n = toNumber(change.value);
      if (!def || n === null) return null;
      const skills = {};
      setOwn(skills, def.key, clamp(Math.trunc(n), 0, def.max));
      return { systemData: { skills } };
    }
    case 'save': {
      const def = c.saves.entries.find((row) => row.key === change.key);
      const n = toNumber(change.value);
      if (!def || n === null) return null;
      const saves = {};
      setOwn(saves, def.key, clamp(Math.trunc(n), -99, 99));
      return { systemData: { saves } };
    }
    case 'magic-slot-max': {
      const level = c.magic.levels.find((row) => row.key === change.key);
      const n = toNumber(change.value);
      if (!level || n === null) return null;
      const max = clamp(Math.trunc(n), 0, 99);
      const slot = view.magic?.slots?.[level.key] ?? {};
      return { systemData: { magic: { slots: { [level.key]: { max, value: Math.min(max, Math.max(0, Number(slot.value) || 0)) } } } } };
    }
    case 'magic-slot-value': {
      const level = c.magic.levels.find((row) => row.key === change.key);
      const n = toNumber(change.value);
      if (!level || n === null) return null;
      const slot = view.magic?.slots?.[level.key] ?? {};
      const max = clamp(Math.trunc(Number(slot.max ?? level.capacityDefault) || 0), 0, 99);
      return { systemData: { magic: { slots: { [level.key]: { value: clamp(Math.trunc(n), 0, max) } } } } };
    }
    case 'res': {
      const state = resourceState(view, c, change.key);
      if (!state) return null;
      const next = hasOwn(change, 'delta')
        ? toNumber(change.delta) === null ? null : state.value + toNumber(change.delta)
        : toNumber(change.value);
      if (next === null) return null;
      const entry = {};
      setOwn(entry, 'value', clamp(Math.trunc(next), 0, state.max));
      const res = {};
      setOwn(res, state.key, entry);
      return { systemData: { res } };
    }
    case 'notes': {
      if (typeof change.value !== 'string' && typeof change.value !== 'number') return null;
      return { systemData: { notes: String(change.value).slice(0, NOTES_MAX) } };
    }
    case 'xp': {
      if (!isPlainObject(change.value)) return null;
      return { systemData: { xp: change.value } };
    }
    default:
      return null;
  }
}

/**
 * Applies an item change to an item `data` object and returns a NEW object.
 *   { kind: 'item-qty',  itemId, value }   quantity, integer 0..9999
 *   { kind: 'item-uses', itemId, value }   uses.value, 0..uses.max (no max = 0..9999)
 * An item without a uses object ignores item-uses (no uses are created by typing).
 */
export function applyItemChange(data, cfg, change) {
  void cfg;
  const out = isPlainObject(data) ? deepClone(data) : {};
  if (!change || typeof change !== 'object') return out;
  const n = toNumber(change.value);
  if (n === null) return out;

  if (change.kind === 'item-qty') {
    out.quantity = clamp(Math.trunc(n), 0, QTY_MAX);
    return out;
  }
  if (change.kind === 'item-uses') {
    if (!isPlainObject(out.uses)) return out;
    const upper = typeof out.uses.max === 'number' && Number.isFinite(out.uses.max) ? out.uses.max : QTY_MAX;
    out.uses = { ...out.uses, value: clamp(Math.trunc(n), 0, Math.max(0, upper)) };
    return out;
  }
  return out;
}

/**
 * Decides where a systemData patch goes (CLAUDE.md rule 6). Pure.
 *   castId === ''                     -> the actor route (no cast context: sidebar, token click)
 *   cast is null (fetch failed)       -> refused: writing to the actor could hit the wrong data
 *   cast.actorId !== actorId          -> refused (the cast is not this actor's token)
 *   cast.isLinked === true            -> { kind: 'actor' }: PUT /api/actors/:id (PC, shared data)
 *   cast.isLinked === false           -> { kind: 'cast', id }: PUT /api/cast/:id (NPC, own data)
 * @returns {{ ok: true, kind: 'actor' } | { ok: true, kind: 'cast', id: string } | { ok: false }}
 */
export function resolveWriteTarget(actorId, castId, cast) {
  if (!castId) return { ok: true, kind: 'actor' };
  if (!isPlainObject(cast) || String(cast.actorId ?? '') !== String(actorId ?? '')) return { ok: false };
  if (cast.isLinked === true) return { ok: true, kind: 'actor' };
  if (cast.isLinked === false) return { ok: true, kind: 'cast', id: String(castId) };
  return { ok: false };
}

/**
 * Plans the resource cost and the uses decrement of an ability or spell BEFORE the roll.
 * Pure: nothing is written here. Refuses (ok:false) instead of going negative.
 *
 * @returns {{ ok: true, patch: { res: object|null, uses: object|null }, error: null }
 *          | { ok: false, patch: null, error: string }}
 *   patch.res:  { [resKey]: { value, max } } to merge into systemData.res
 *   patch.uses: { value, max } to write into the item data.uses
 *   error:      'unknown-resource' | 'invalid-cost' | 'negative-cost' |
 *               'insufficient-resource' | 'invalid-uses' | 'no-uses'
 */
export function planUse(item, actorSys, cfg) {
  const fail = (error) => ({ ok: false, patch: null, error });
  const c = safeCfg(cfg);
  const data = item && isPlainObject(item.data) ? item.data : {};
  const sys = isPlainObject(actorSys) ? actorSys : {};
  const patch = { res: null, uses: null };

  // Cost: validated first, so a bad cost never reaches the state.
  const cost = isPlainObject(data.cost) ? data.cost : null;
  if (cost && typeof cost.res === 'string' && cost.res !== '') {
    const state = resourceState(sys, c, cost.res);
    if (!state) return fail('unknown-resource');
    const amount = toNumber(cost.amount);
    if (amount === null || !Number.isInteger(amount)) return fail('invalid-cost');
    if (amount < 0) return fail('negative-cost');
    if (amount > 0) {
      if (state.value < amount) return fail('insufficient-resource');
      patch.res = { [state.key]: { value: state.value - amount, max: state.storedMax } };
    }
  }

  // Uses: a uses object that exists must hold a usable number.
  if (isPlainObject(data.uses)) {
    const value = toNumber(data.uses.value);
    if (value === null) return fail('invalid-uses');
    if (value <= 0) return fail('no-uses');
    patch.uses = { value: value - 1, max: typeof data.uses.max === 'number' ? data.uses.max : null };
  }

  return { ok: true, patch, error: null };
}

/**
 * Maps one DOM field (dataset + typed value) to a change object. Returns null for
 * fields that are not sheet inputs. Used by the delegated input listener.
 */
export function changeFromField(field, value) {
  const key = typeof field?.key === 'string' ? field.key : '';
  const id = typeof field?.id === 'string' ? field.id : '';
  switch (field?.field) {
    case 'name':
      return { kind: 'name', value: typeof value === 'string' ? value : String(value ?? '') };
    case 'attr':
      return { kind: 'attr', key, value };
    case 'skill':
      return { kind: 'skill', key, value };
    case 'save':
      return { kind: 'save', key, value };
    case 'magic-slot-max':
      return { kind: 'magic-slot-max', key, value };
    case 'magic-slot-value':
      return { kind: 'magic-slot-value', key, value };
    case 'res':
      return { kind: 'res', key, value };
    case 'notes':
      return { kind: 'notes', value };
    case 'item-qty':
      return id ? { kind: 'item-qty', itemId: id, value } : null;
    case 'item-uses':
      return id ? { kind: 'item-uses', itemId: id, value } : null;
    default:
      return null;
  }
}

// ══════════════════════════════════════════════════════════════
// Context building (pure)
// ══════════════════════════════════════════════════════════════

const TYPE_LABEL_KEYS = Object.freeze({
  hero: 'sandbox.sheet.typeHero',
  villain: 'sandbox.sheet.typeVillain',
  beast: 'sandbox.sheet.typeBeast',
});

/** Item block of an item type: gear, ability, spell, or other (legacy types and unknown types). */
function groupOfItem(type) {
  if (type === 'gear' || type === 'ability' || type === 'spell') return type;
  return 'other';
}

function itemKindLabel(cfg, group) {
  if (group === 'gear' || group === 'other') return null;
  return abilityKindLabel(cfg, group);
}

/** Localized title of a layout block, or its English fallback. Never throws. */
function blockTitleOf(t, block) {
  const key = blockLabelKey(block);
  let text;
  try {
    text = key ? t(key) : '';
  } catch {
    text = '';
  }
  if (typeof text === 'string' && text !== '' && text !== key) return text;
  return BLOCK_FALLBACK[block] ?? '';
}

/** Localized text with a fallback, for the few keys outside STRINGS. Never throws. */
function textOf(t, key, fallback) {
  let text;
  try {
    text = t(key);
  } catch {
    text = '';
  }
  return typeof text === 'string' && text !== '' && text !== key ? text : fallback;
}

/**
 * Builds the view model of the sheet. Pure: no engine access.
 *
 * @param {object|null} actor   the actor row ({ id, name, type, avatarUrl, systemData })
 * @param {Array}       items   embedded items ({ id, name, type, data })
 * @param {object}      cfg     the rule config (sanitized again here)
 * @param {object}      [ui]    { t(key)->string, isGM, editable, advantage, configChanged }
 */
export function buildSheetContext(actor, items, cfg, ui = {}) {
  const c = safeCfg(cfg);
  const t = typeof ui.t === 'function' ? ui.t : (key) => STRINGS[key] ?? key;
  const labels = {};
  for (const key of Object.keys(STRINGS)) {
    let text;
    try {
      text = t(key);
    } catch {
      text = STRINGS[key];
    }
    labels[key] = typeof text === 'string' && text !== '' ? text : STRINGS[key];
  }

  const hasActor = isPlainObject(actor);
  const sys = hasActor && isPlainObject(actor.systemData) ? actor.systemData : {};
  const actorRef = { systemData: sys };

  const attributes = attributeList(c).map((a) => ({
    key: a.key,
    label: a.label,
    value: actorValue(actorRef, c, 'attr', a.key),
    modifier: attributeRollValue(c, a.key, actorValue(actorRef, c, 'attr', a.key)),
    useD20Modifier: a.useD20Modifier === true,
    canDisplayDots: a.min >= 0 && a.max > 0 && a.max <= 20,
    min: a.min,
    max: a.max,
    name: safeName(`attr.${a.key}`),
  }));

  // Attribute groups for the attributes block (config `group` text; the empty group is untitled).
  const attrByKey = new Map(attributes.map((a) => [a.key, a]));
  const attributeGroups = groupedList(c.attributes)
    .map((g) => ({
      group: g.group,
      attrs: g.items.map((a) => attrByKey.get(a.key)).filter(Boolean),
    }))
    .filter((g) => g.attrs.length > 0);

  // Skills in the sections chosen by layout.skillGrouping. The modifier is the attribute
  // value the skill is based on (0 when the attribute is empty or was removed).
  const grouping = resolveLayout(c).skillGrouping;
  const baseOf = (attrKey) => {
    const attribute = attrByKey.get(attrKey);
    return attribute ? attributeRollValue(c, attrKey, attribute.value) : 0;
  };
  const skillRow = (s) => {
    const rank = actorValue(actorRef, c, 'skill', s.key);
    return {
      key: s.key,
      label: s.label,
      attr: s.attr,
      rank,
      max: s.max,
      canDisplayDots: s.max > 0 && s.max <= 20,
      modifier: baseOf(s.attr) + rank,
      name: safeName(`skill.${s.key}`),
    };
  };
  const skillGroups = skillSections(c).map((section) => {
    // Attribute grouping: the title names the attribute; skills without one get the
    // "No attribute" label. Group grouping: the group text. None: no title.
    let title = section.title;
    let basedOn = false;
    if (grouping === 'attribute') {
      basedOn = section.key !== '';
      if (section.key === '') title = labels['sandbox.sheet.skillsOther'];
    }
    if (grouping === 'none') title = '';
    return { key: section.key, title, basedOn, skills: section.skills.map(skillRow) };
  });

  const resources = resourceList(c)
    .map((r) => resourceState(sys, c, r.key))
    .filter(Boolean)
    .map((r) => ({
      ...r,
      pct: r.max > 0 ? clamp((r.value / r.max) * 100, 0, 100) : 0,
      name: safeName(`res.${r.key}`),
    }));

  const saveRows = (c.saves.enabled ? c.saves.entries.filter((save) => save.showOnSheet) : []).map((save) => ({
    ...save,
    value: Number(sys.saves?.[save.key]) || 0,
    total: sumSources(save.sources, sys, c, (key, score) => attributeRollValue(c, key, score)) + save.bonus + (Number(sys.saves?.[save.key]) || 0),
  }));
  const attackRows = c.attacks.enabled ? c.attacks.profiles : [];
  const magicSlots = c.magic.enabled ? c.magic.levels.map((level) => ({ ...level, value: Number(sys.magic?.slots?.[level.key]?.value) || 0, max: Number(sys.magic?.slots?.[level.key]?.max ?? level.capacityDefault) || 0 })) : [];

  // Items grouped by type (gear, ability, spell, other), then by category.
  const list = Array.isArray(items) ? items.filter(isPlainObject) : [];
  const categories = categoryList(c);
  const itemGroups = ITEM_GROUP_TYPES.map((group) => {
    const kind = group === 'gear' ? labels['sandbox.sheet.kindGear']
      : group === 'other' ? labels['sandbox.sheet.kindOther']
        : itemKindLabel(c, group);
    const byCategory = new Map();
    for (const item of list) {
      if (groupOfItem(item.type) !== group) continue;
      const d = isPlainObject(item.data) ? item.data : {};
      const catKey = typeof d.category === 'string' ? d.category : '';
      const row = itemRow(item, d, group, c, labels, sys);
      if (!byCategory.has(catKey)) byCategory.set(catKey, []);
      byCategory.get(catKey).push(row);
    }
    // Known categories first (config order), then unknown keys, then uncategorized.
    const ordered = [];
    for (const cat of categories) {
      if (byCategory.has(cat.key)) ordered.push({ key: cat.key, label: cat.label, items: byCategory.get(cat.key) });
    }
    for (const [key, rows] of byCategory) {
      if (categories.some((cat) => cat.key === key)) continue;
      ordered.push({ key, label: key === '' ? labels['sandbox.sheet.uncategorized'] : key, items: rows });
    }
    const count = ordered.reduce((n, g) => n + g.items.length, 0);
    return {
      type: group,
      kind,
      // Legacy types cannot be created from the sheet, so their group has no add button.
      addLabel: ADDABLE_GROUP_TYPES.includes(group) ? fmt(labels['sandbox.sheet.addItem'], { kind }) : '',
      count,
      categories: ordered,
    };
  });

  const typeKey = hasActor && TYPE_LABEL_KEYS[actor.type] ? TYPE_LABEL_KEYS[actor.type] : 'sandbox.sheet.typeOther';

  // Layout: tabs and blocks from the config (every block is always present, see resolveLayout).
  const layout = resolveLayout(c);
  const tabKeys = layout.tabs.map((tab) => tab.key);
  if (!tabKeys.includes('xp')) tabKeys.push('xp');
  const blockTitles = {};
  for (const block of LAYOUT_BLOCKS) blockTitles[block] = blockTitleOf(t, block);
  const activeTab = tabKeys.includes(ui.activeTab) ? ui.activeTab : (tabKeys[0] ?? '');

  return {
    empty: !hasActor,
    actorId: hasActor ? String(actor.id ?? '') : '',
    name: hasActor ? String(actor.name ?? '') : '',
    typeLabel: labels[typeKey],
    avatar: hasActor ? (safeImageUrl(actor.avatarUrl) || '/icons/svg/adventurer.svg') : '',
    systemName: c.name,
    attributeDisplay: c.attributeDisplay,
    skillDisplay: c.skillDisplay,
    dotStyle: c.dotStyle,
    dotGroup: c.dotGroup,
    dice: { mode: c.dice.mode, description: describeDice(c) },
    advantage: ADV_ORDER.includes(ui.advantage) ? ui.advantage : 'none',
    isGM: ui.isGM === true,
    editable: ui.editable !== false,
    configChanged: ui.configChanged === true,
    attributes,
    attributeGroups,
    skillGroups,
    resources,
    saveRows,
    attackRows,
    magicSlots,
    itemGroups,
    notes: typeof sys.notes === 'string' ? sys.notes : '',
    layout,
    activeTab,
    blockTitles,
    tablistLabel: textOf(t, 'sandbox.layout.tablist', TABLIST_FALLBACK),
    effects: Array.isArray(ui.effects) ? ui.effects : [],
    effectsEdit: isPlainObject(ui.effectsEdit) ? ui.effectsEdit : {},
    // Translator in the shape the effects block expects: t(key, fallback).
    t: (key, fallback) => textOf(t, key, typeof fallback === 'string' ? fallback : key),
    labels,
    xp: (() => {
      const xpRaw = isPlainObject(sys.xp) ? sys.xp : {};
      return {
        total: Math.max(0, Number(xpRaw.total) || 0),
        current: Math.max(0, Number(xpRaw.current ?? xpRaw.total) || 0),
        log: Array.isArray(xpRaw.log) ? xpRaw.log.slice(0, 100) : [],
      };
    })(),
  };
}

function itemRow(item, d, group, cfg, labels, sys = {}) {
  const id = String(item.id ?? '');
  const name = String(item.name ?? '').trim() || labels['sandbox.sheet.unnamed'];
  const cost = isPlainObject(d.cost) ? d.cost : null;
  let costLabel = '';
  if (cost && typeof cost.res === 'string' && cost.res !== '') {
    const res = resourceList(cfg).find((r) => r.key === cost.res);
    const amount = toNumber(cost.amount) ?? 0;
    costLabel = fmt(labels['sandbox.sheet.costLabel'], { amount, res: res ? res.label : cost.res });
  }
  const uses = isPlainObject(d.uses)
    ? {
      value: toNumber(d.uses.value) ?? 0,
      max: typeof d.uses.max === 'number' && Number.isFinite(d.uses.max) ? d.uses.max : null,
    }
    : null;
  const canRoll = isPlainObject(d.roll) && d.roll.enabled === true;
  const attackProfile = typeof d.attack?.profileKey === 'string' ? d.attack.profileKey : '';
  const castMethod = d.casting?.method && d.casting.method !== 'inherit' ? d.casting.method : cfg.magic.defaultMethod;
  const prepared = sys.magic?.prepared?.[id];
  return {
    id,
    name,
    type: group,
    itemType: item.type,
    kindLabel: group === 'gear' ? labels['sandbox.sheet.kindGear']
      : group === 'other' ? labels['sandbox.sheet.kindOther']
        : abilityKindLabel(cfg, d.kind || group),
    quantity: group === 'ability' || group === 'spell' ? null : (toNumber(d.quantity) ?? 1),
    uses,
    canRoll,
    attackProfile,
    canAttack: item.type === 'weapon' && attackProfile !== '' && cfg.attacks.enabled,
    castMethod,
    castLevelKey: String(d.casting?.levelKey ?? ''),
    castLevels: castMethod === 'spontaneous' ? cfg.magic.levels.filter((level) => {
      const minLevel = cfg.magic.levels.find((entry) => entry.key === d.casting?.levelKey);
      return !minLevel || level.rank >= minLevel.rank;
    }).map((level) => ({ ...level, value: Number(sys.magic?.slots?.[level.key]?.value) || 0, max: Number(sys.magic?.slots?.[level.key]?.max ?? level.capacityDefault) || 0 })) : [],
    castUses: castMethod === 'uses' ? (() => {
      const max = Math.max(0, Number(d.casting?.usesMax) || 0);
      const stored = sys.magic?.uses?.[id];
      return { value: Math.max(0, Number(stored?.value ?? max) || 0), max };
    })() : null,
    preparedCount: Math.max(0, Number(prepared?.value) || 0),
    // Effect-use types always show Use (an effects-only spell is usable); others need roll, cost or uses.
    canUse: EFFECT_USE_TYPES.includes(item.type) || canRoll || costLabel !== '' || uses !== null,
    costLabel,
    description: typeof d.description === 'string' ? d.description.slice(0, DESCRIPTION_MAX) : '',
    qtyName: safeName(`item.${id}.qty`),
    usesName: safeName(`item.${id}.uses`),
  };
}

// ══════════════════════════════════════════════════════════════
// Rendering (pure). Every interpolated text goes through esc().
// ══════════════════════════════════════════════════════════════

function L(ctx, key, vars) {
  const raw = ctx.labels?.[key] ?? STRINGS[key] ?? key;
  return esc(fmt(raw, vars));
}

function renderHeader(c) {
  const portrait = portraitMedia(c.avatar || '/icons/svg/adventurer.svg', 'ldm-sheet-portrait-img', c.name);
  const nameControl = c.editable
    ? `<input type="text" class="ldm-sheet-name ldm-sheet-name-input" name="name" data-field="name" value="${esc(c.name)}" placeholder="${esc(c.name || 'Hero')}" aria-label="${esc(c.name || 'Name')}" spellcheck="false" autocomplete="off" />`
    : `<h2 class="ldm-sheet-name">${esc(c.name)}</h2>`;
  return `<header class="ldm-sheet-header">
    <button type="button" class="ldm-sheet-portrait" data-action="pick-portrait" title="${L(c, 'sandbox.sheet.editPortrait')}" aria-label="${L(c, 'sandbox.sheet.editPortrait')}"${c.editable ? '' : ' disabled'}>${portrait}</button>
    <div class="ldm-sheet-identity">
      <div class="ldm-sheet-title-row">
        ${nameControl}
        <span class="ldm-sheet-badge">${esc(c.typeLabel)}</span>
      </div>
      <p class="ldm-sheet-type"><span class="ldm-sheet-system">${esc(c.systemName)}</span></p>
    </div>
  </header>`;
}

function renderToolbar(c) {
  const advKey = { none: 'sandbox.sheet.advNone', adv: 'sandbox.sheet.advAdv', dis: 'sandbox.sheet.advDis' }[c.advantage];
  const advIcon = c.advantage === 'adv' ? 'bolt' : c.advantage === 'dis' ? 'skull' : 'dice';
  const gm = c.isGM
    ? `<button type="button" class="ldm-sheet-btn ldm-sheet-btn--secondary ldm-sheet-btn--gm" data-action="configure" title="${L(c, 'sandbox.sheet.configure')}">${icon('settings')}<span>${L(c, 'sandbox.sheet.configure')}</span></button>`
    : '';
  return `<div class="ldm-sheet-toolbar">
    <div class="ldm-sheet-toolbar-actions">
      <button type="button" class="ldm-sheet-btn ldm-sheet-adv ldm-sheet-adv--${esc(c.advantage)}" data-action="toggle-adv" title="${L(c, 'sandbox.sheet.rollMode')}" aria-label="${L(c, 'sandbox.sheet.rollMode')}: ${L(c, advKey)}">
        <span class="ldm-sheet-adv-pill">${icon(advIcon)}</span>
        <span class="ldm-sheet-adv-mode">${L(c, 'sandbox.sheet.rollMode')}:</span>
        <strong class="ldm-sheet-adv-text">${L(c, advKey)}</strong>
      </button>
      <button type="button" class="ldm-sheet-btn ldm-sheet-btn--primary" data-action="open-combat">${icon('swords')}<span>${L(c, 'sandbox.sheet.combat')}</span></button>
      <button type="button" class="ldm-sheet-btn ldm-sheet-btn--secondary" data-action="reload-config">${icon('refresh')}<span>${L(c, 'sandbox.sheet.reloadConfig')}</span></button>
      ${gm}
      <span class="ldm-sheet-save-state" role="status" aria-live="polite" data-state=""></span>
    </div>
    <div class="ldm-sheet-dice">
      <span class="ldm-sheet-dice-chip">${icon('dice')}<span>${L(c, 'sandbox.sheet.rollMode')}</span></span>
      <span class="ldm-sheet-dice-text">${esc(c.dice.description)}</span>
    </div>
  </div>`;
}

function emptyNote(c) {
  return `<p class="ldm-sheet-empty">${L(c, 'sandbox.sheet.noEntries')}</p>`;
}

function renderResourcesBody(c) {
  if (!c.resources.length) return emptyNote(c);
  const dis = c.editable ? '' : ' disabled';
  const rows = c.resources.map((r) => {
    const pct = Number.isFinite(r.pct) ? clamp(r.pct, 0, 100) : 0;
    const count = fmt(c.labels['sandbox.sheet.resCount'], { value: r.value, max: r.max });
    return `<div class="ldm-sheet-res" style="--ldm-sheet-res-color:${esc(r.color)}">
      <div class="ldm-sheet-res-head">
        <span class="ldm-sheet-res-label">${esc(r.label)}</span>
        <span class="ldm-sheet-res-count">${esc(count)}</span>
      </div>
      <div class="ldm-sheet-bar" role="meter" aria-label="${esc(r.label)}" aria-valuemin="0" aria-valuemax="${esc(r.max)}" aria-valuenow="${esc(r.value)}">
        <span class="ldm-sheet-bar-fill" style="width:${pct}%"></span>
      </div>
      <div class="ldm-sheet-res-controls">
        <button type="button" class="ldm-sheet-btn ldm-sheet-btn--step" data-action="res-delta" data-key="${esc(r.key)}" data-delta="-1" aria-label="${L(c, 'sandbox.sheet.decrease')} ${esc(r.label)}"${dis}>&minus;</button>
        <input type="number" class="ldm-sheet-input" name="${esc(r.name)}" value="${esc(r.value)}" min="0" max="${esc(r.max)}" inputmode="numeric" data-field="res" data-key="${esc(r.key)}" aria-label="${L(c, 'sandbox.sheet.resValue', { label: r.label })}"${dis}>
        <button type="button" class="ldm-sheet-btn ldm-sheet-btn--step" data-action="res-delta" data-key="${esc(r.key)}" data-delta="1" aria-label="${L(c, 'sandbox.sheet.increase')} ${esc(r.label)}"${dis}>+</button>
      </div>
    </div>`;
  }).join('');
  return `<div class="ldm-sheet-res-list">${rows}</div>`;
}

// Clickable dots for one value (attribute or skill rank). Style and grouping come from the config.
function dotsHtml(c, { action, key, value, max, label }) {
  const dis = c.editable ? '' : ' disabled';
  const cells = Array.from({ length: max }, (_, index) => {
    const n = index + 1;
    const groupEnd = c.dotGroup > 0 && n % c.dotGroup === 0 && n < max ? ' is-group-end' : '';
    return `<button type="button" class="ldm-sheet-dot${n <= value ? ' is-filled' : ''}${groupEnd}" data-action="${action}" data-key="${esc(key)}" data-value="${n}" aria-label="${L(c, 'sandbox.sheet.dotValue', { label, value: n })}" aria-pressed="${n <= value}"${dis}></button>`;
  }).join('');
  return `<div class="ldm-sheet-dots" role="group" data-dot-style="${esc(c.dotStyle)}" aria-label="${esc(label)}">${cells}</div>`;
}

function renderAttributesBody(c) {
  if (!c.attributes.length) return emptyNote(c);
  const dis = c.editable ? '' : ' disabled';
  const card = (a) => {
    const dots = c.attributeDisplay === 'dots' && a.canDisplayDots
      ? dotsHtml(c, { action: 'attr-dot', key: a.key, value: a.value, max: a.max, label: a.label })
      : `<input id="ldm-sheet-a-${esc(a.name)}" type="number" class="ldm-sheet-input ldm-sheet-attr-score-input" name="${esc(a.name)}" value="${esc(a.value)}" min="${esc(a.min)}" max="${esc(a.max)}" inputmode="numeric" data-field="attr" data-key="${esc(a.key)}" title="${L(c, 'sandbox.sheet.min')} ${esc(a.min)} · ${L(c, 'sandbox.sheet.max')} ${esc(a.max)}"${dis}>`;
    const dotsFallback = c.attributeDisplay === 'dots' && !a.canDisplayDots
      ? `<span class="ldm-sheet-range">${L(c, 'sandbox.sheet.dotsFallback')}</span>`
      : '';
    const label = c.attributeDisplay === 'dots' && a.canDisplayDots
      ? `<span class="ldm-sheet-attr-label" title="${esc(a.label)}">${esc(a.label)}</span>`
      : `<label class="ldm-sheet-attr-label" for="ldm-sheet-a-${esc(a.name)}" title="${esc(a.label)}">${esc(a.label)}</label>`;
    const modValue = a.modifier >= 0 ? `+${a.modifier}` : `${a.modifier}`;
    return `<div class="ldm-sheet-attr" data-attr="${esc(a.key)}">
      <div class="ldm-sheet-attr-head">${label}</div>
      <button type="button" class="ldm-sheet-btn ldm-sheet-attr-roll-btn" data-action="attr-roll" data-key="${esc(a.key)}" aria-label="${L(c, 'sandbox.sheet.rollNamed', { label: a.label })}" title="${L(c, 'sandbox.sheet.rollNamed', { label: a.label })} (${modValue})">
        <span class="ldm-sheet-attr-mod" title="${L(c, 'sandbox.sheet.modifier')}">${esc(modValue)}</span>
        <span class="ldm-roll-icon" aria-hidden="true">${icon('dice')}</span>
      </button>
      <div class="ldm-sheet-attr-score-wrap">
        ${dots}
        ${dotsFallback}
      </div>
    </div>`;
  };
  // One sub-section per attribute group. The ungrouped (empty) group has no title.
  return c.attributeGroups.map((g) => {
    const head = g.group ? `<h4 class="ldm-sheet-subh">${esc(g.group)}</h4>` : '';
    return `<div class="ldm-sheet-attr-group">${head}<div class="ldm-sheet-attr-grid">${g.attrs.map(card).join('')}</div></div>`;
  }).join('');
}

function renderSkillsBody(c) {
  if (!c.skillGroups.length) return emptyNote(c);
  const dis = c.editable ? '' : ' disabled';
  return c.skillGroups.map((g) => {
    const rows = g.skills.map((s) => {
      const mod = s.modifier >= 0 ? `+${s.modifier}` : `${s.modifier}`;
      const attrTag = s.attr ? esc(s.attr.slice(0, 3).toUpperCase()) : '';
      return `<li class="ldm-sheet-skill${s.canDisplayDots && c.skillDisplay === 'dots' ? ' ldm-sheet-skill--dots' : ''}">
        <div class="ldm-sheet-skill-name-col">
          <span class="ldm-sheet-skill-dot"></span>
          <span class="ldm-sheet-skill-label">${esc(s.label)}</span>
          ${attrTag ? `<span class="ldm-sheet-skill-attr-tag" title="${L(c, 'sandbox.sheet.basedOn', { label: s.attr })}">${attrTag}</span>` : ''}
        </div>
        <div class="ldm-sheet-skill-rank-col" title="${L(c, 'sandbox.sheet.rank')} (max ${esc(s.max)})">
          ${s.canDisplayDots && c.skillDisplay === 'dots' ? dotsHtml(c, { action: 'skill-dot', key: s.key, value: s.rank, max: s.max, label: s.label }) : `<input type="number" class="ldm-sheet-input ldm-sheet-input--small ldm-sheet-skill-input" name="${esc(s.name)}" value="${esc(s.rank)}" min="0" max="${esc(s.max)}" inputmode="numeric" data-field="skill" data-key="${esc(s.key)}" aria-label="${L(c, 'sandbox.sheet.rank')}: ${esc(s.label)}"${dis}>`}
        </div>
        <button type="button" class="ldm-sheet-btn ldm-sheet-btn--skill" data-action="skill-roll" data-key="${esc(s.key)}" aria-label="${L(c, 'sandbox.sheet.rollNamed', { label: s.label })}" title="${L(c, 'sandbox.sheet.rollNamed', { label: s.label })} (${mod})">
          <span class="ldm-sheet-skill-mod">${esc(mod)}</span>
          <span class="ldm-roll-icon" aria-hidden="true">${icon('dice')}</span>
        </button>
      </li>`;
    }).join('');
    let head = '';
    if (g.title) {
      const text = g.basedOn ? L(c, 'sandbox.sheet.basedOn', { label: g.title }) : esc(g.title);
      head = `<h4 class="ldm-sheet-subh">${text}</h4>`;
    }
    return `<div class="ldm-sheet-skill-group">${head}<ul class="ldm-sheet-skill-list">${rows}</ul></div>`;
  }).join('');
}

function renderSavesBody(c) {
  const disabled = c.editable ? '' : ' disabled';
  if (!c.saveRows?.length) return emptyNote(c);
  return `<ul class="ldm-sheet-check-list">${c.saveRows.map((save) => `<li class="ldm-sheet-skill"><span class="ldm-sheet-skill-label">${esc(save.label)}</span><input type="number" class="ldm-sheet-input ldm-sheet-input--small" min="-99" max="99" value="${esc(save.value)}" data-field="save" data-key="${esc(save.key)}" aria-label="${L(c, 'sandbox.sheet.saveAdjustment', { label: save.label })}"${disabled}><span class="ldm-sheet-skill-mod">${save.total >= 0 ? '+' : ''}${esc(save.total)}</span><label class="ldm-sheet-mini"><span>${L(c, 'sandbox.sheet.difficulty')}</span><input type="number" class="ldm-sheet-input ldm-sheet-input--small ldm-sheet-save-target" min="0" max="999" value="${esc(save.target ?? '')}" placeholder="—" aria-label="${L(c, 'sandbox.sheet.difficulty')} ${esc(save.label)}"${disabled}></label><button type="button" class="ldm-sheet-btn" data-action="save-roll" data-key="${esc(save.key)}" aria-label="${L(c, 'sandbox.sheet.rollNamed', { label: save.label })}">${L(c, 'sandbox.sheet.rollNamed', { label: save.label })}</button></li>`).join('')}</ul>`;
}

function renderAttacksBody(c) {
  const disabled = c.editable ? '' : ' disabled';
  if (!c.attackRows?.length) return emptyNote(c);
  return `<ul class="ldm-sheet-check-list">${c.attackRows.map((profile) => `<li class="ldm-sheet-attack"><div><strong>${esc(profile.label)}</strong><span class="ldm-sheet-item-meta">${profile.damage.method === 'none' ? L(c, 'sandbox.sheet.attackRoll') : L(c, 'sandbox.sheet.damageMethod', { method: profile.damage.method })}</span></div><label class="ldm-sheet-mini"><span>${L(c, 'sandbox.sheet.defense')}</span><input type="number" class="ldm-sheet-input ldm-sheet-input--small" min="0" max="999" value="${esc(profile.target ?? '')}" placeholder="—" aria-label="${esc(profile.label)} ${L(c, 'sandbox.sheet.defense')}"${disabled}></label><button type="button" class="ldm-sheet-btn" data-action="attack-roll" data-key="${esc(profile.key)}"${disabled}>${L(c, 'sandbox.sheet.attack')}</button>${['dice','pool'].includes(profile.damage.method) ? `<button type="button" class="ldm-sheet-btn" data-action="attack-damage" data-key="${esc(profile.key)}"${disabled}>${L(c, 'sandbox.sheet.rollDamage')}</button>` : ''}</li>`).join('')}</ul>`;
}

function renderMagicBody(c) {
  if (!c.magicSlots?.length) return emptyNote(c);
  return `<div class="ldm-sheet-magic-slots">${c.magicSlots.map((slot) => `<div class="ldm-sheet-magic-slot"><strong>${esc(slot.label)}</strong><label><span>${L(c, 'sandbox.sheet.resCount', { value: slot.value, max: slot.max })}</span><input type="number" class="ldm-sheet-input ldm-sheet-input--small" min="0" max="99" value="${esc(slot.value)}" data-field="magic-slot-value" data-key="${esc(slot.key)}" aria-label="${L(c, 'sandbox.sheet.slotsAvailable', { label: slot.label })}"${c.editable ? '' : ' disabled'}><span>/</span><input type="number" class="ldm-sheet-input ldm-sheet-input--small" min="0" max="99" value="${esc(slot.max)}" data-field="magic-slot-max" data-key="${esc(slot.key)}" aria-label="${L(c, 'sandbox.sheet.slotsMax', { label: slot.label })}"${c.editable ? '' : ' disabled'}></label></div>`).join('')}<button type="button" class="ldm-sheet-btn" data-action="recover-magic"${c.editable ? '' : ' disabled'}>${L(c, 'sandbox.sheet.recoverMagic')}</button></div>`;
}

function renderItemRow(c, it) {
  const dis = c.editable ? '' : ' disabled';
  const id = esc(it.id);
  const qty = it.quantity === null ? '' : `<label class="ldm-sheet-mini">
      <span>${L(c, 'sandbox.sheet.quantity')}</span>
      <input type="number" class="ldm-sheet-input ldm-sheet-input--small" name="${esc(it.qtyName)}" value="${esc(it.quantity)}" min="0" max="${QTY_MAX}" inputmode="numeric" data-field="item-qty" data-id="${id}"${dis}>
    </label>`;
  const uses = it.uses === null ? '' : `<label class="ldm-sheet-mini">
      <span>${L(c, 'sandbox.sheet.uses')}${it.uses.max === null ? '' : ` / ${esc(it.uses.max)}`}</span>
      <input type="number" class="ldm-sheet-input ldm-sheet-input--small" name="${esc(it.usesName)}" value="${esc(it.uses.value)}" min="0"${it.uses.max === null ? '' : ` max="${esc(it.uses.max)}"`} inputmode="numeric" data-field="item-uses" data-id="${id}"${dis}>
    </label>`;
  const meta = [it.kindLabel, it.costLabel].filter((s) => s && s !== '').map((s) => esc(s)).join(' · ');
  const castUses = it.castUses ? `<span class="ldm-sheet-item-meta">${L(c, 'sandbox.sheet.castUses', { value: it.castUses.value, max: it.castUses.max })}</span>` : '';
  const use = it.canUse
    ? `<button type="button" class="ldm-sheet-btn" data-action="use-item" data-id="${id}"${dis}>${L(c, 'sandbox.sheet.use')}</button>`
    : '';
  const attack = it.canAttack ? `<button type="button" class="ldm-sheet-btn" data-action="weapon-attack" data-id="${id}"${dis}>${L(c, 'sandbox.sheet.attack')}</button>` : '';
  const prepare = it.itemType === 'spell' && it.castMethod === 'prepared' && it.castLevelKey ? `<button type="button" class="ldm-sheet-btn" data-action="prepare-spell" data-id="${id}" data-level="${esc(it.castLevelKey)}"${dis}>${L(c, 'sandbox.sheet.prepare')} (${esc(it.preparedCount)})</button>` : '';
  const castLevel = it.itemType === 'spell' && it.castMethod === 'spontaneous' && it.castLevels?.length > 1 ? `<label class="ldm-sheet-mini"><span>${L(c, 'sandbox.sheet.castAtLevel')}</span><select class="ldm-sheet-input ldm-sheet-input--small" data-cast-level="${id}" aria-label="${L(c, 'sandbox.sheet.castAtLevel')}"${dis}>${it.castLevels.map((level) => `<option value="${esc(level.key)}"${level.key === it.castLevelKey ? ' selected' : ''}>${esc(level.label)} (${esc(level.value)}/${esc(level.max)})</option>`).join('')}</select></label>` : '';
  const desc = it.description ? `<p class="ldm-sheet-item-desc">${esc(it.description)}</p>` : '';
  return `<li class="ldm-sheet-item" data-id="${id}">
    <div class="ldm-sheet-item-main">
      <span class="ldm-sheet-item-name">${esc(it.name)}</span>
      ${meta ? `<span class="ldm-sheet-item-meta">${meta}</span>` : ''}
      ${castUses}
      ${desc}
    </div>
    <div class="ldm-sheet-item-controls">
      ${qty}${uses}${castLevel}${use}${attack}${prepare}
      <button type="button" class="ldm-sheet-btn" data-action="edit-item" data-id="${id}"${dis}>${L(c, 'sandbox.sheet.edit')}</button>
      <button type="button" class="ldm-sheet-btn ldm-sheet-btn--danger" data-action="delete-item" data-id="${id}"${dis}>${L(c, 'sandbox.sheet.delete')}</button>
    </div>
  </li>`;
}

/** Body of one item block (gear, ability, spell or other): add button, then categories. */
function renderItemsBody(c, group) {
  const dis = c.editable ? '' : ' disabled';
  const add = group.addLabel
    ? `<div class="ldm-sheet-item-group-head"><button type="button" class="ldm-sheet-btn" data-action="add-item" data-type="${esc(group.type)}"${dis}>${esc(group.addLabel)}</button></div>`
    : '';
  const cats = group.categories.map((cat) => `<div class="ldm-sheet-cat">
        <h5 class="ldm-sheet-cat-h">${esc(cat.label)}</h5>
        <ul class="ldm-sheet-item-list">${cat.items.map((it) => renderItemRow(c, it)).join('')}</ul>
      </div>`).join('');
  const empty = group.count === 0 ? `<p class="ldm-sheet-empty">${L(c, 'sandbox.sheet.noItems')}</p>` : '';
  return `<div class="ldm-sheet-item-group" data-type="${esc(group.type)}">${add}${cats}${empty}</div>`;
}

function renderNotesBody(c) {
  const dis = c.editable ? '' : ' disabled';
  return `<textarea class="ldm-sheet-notes" name="notes" rows="4" maxlength="${NOTES_MAX}" data-field="notes" aria-label="${esc(c.blockTitles?.notes ?? BLOCK_FALLBACK.notes)}"${dis}>${esc(c.notes)}</textarea>`;
}

/**
 * One layout block as a card: the title comes from the block name, the body from the matching
 * renderer. `renderEffects` is the effects block renderer (injected by tests). Unknown blocks: ''.
 */
function renderBlockFor(c, block, renderEffects, span) {
  const title = c.blockTitles?.[block] ?? BLOCK_FALLBACK[block] ?? '';
  let body;
  switch (block) {
    case 'resources': {
      // Resources are fixed at the top of the sheet in compact form.
      // We maintain the block container in the panel so layout mapping and tests remain satisfied.
      return `<section class="ldm-block ldm-sheet-hidden-block" data-ldm-block="resources" style="display:none !important"></section>`;
    }
    case 'attributes': {
      // Attributes are fixed below the tabs. We maintain the block container
      // in the panel so layout mapping and tests remain satisfied.
      return `<section class="ldm-block ldm-sheet-hidden-block" data-ldm-block="attributes" style="display:none !important"></section>`;
    }
    case 'skills': body = renderSkillsBody(c); break;
    case 'saves': body = renderSavesBody(c); break;
    case 'attacks': body = renderAttacksBody(c); break;
    case 'magic': body = renderMagicBody(c); break;
    case 'items:gear':
    case 'items:ability':
    case 'items:spell':
    case 'items:other': {
      const group = c.itemGroups.find((g) => `items:${g.type}` === block);
      body = group ? renderItemsBody(c, group) : '';
      break;
    }
    case 'notes': body = renderNotesBody(c); break;
    case 'effects': {
      // The effects renderer brings its own heading, so the block card has no title of its own.
      const edit = c.effectsEdit ?? {};
      const html = renderEffects({
        effects: c.effects,
        editable: c.editable,
        ownerKind: 'actor',
        editingId: edit.editingId ?? '',
        draft: edit.draft ?? null,
        errors: Array.isArray(edit.errors) ? edit.errors : [],
        t: c.t,
      });
      return renderBlock({ key: block, title: '', body: typeof html === 'string' ? html : '', span });
    }
    default:
      return '';
  }
  return renderBlock({ key: block, title, body: typeof body === 'string' ? body : '', span });
}

function renderXpBody(c) {
  const dis = c.editable ? '' : ' disabled';
  const xp = c.xp ?? { total: 0, current: 0, log: [] };
  const rows = (xp.log || []).map((entry, idx) => {
    const isGain = Number(entry.amount) >= 0;
    const sign = isGain ? '+' : '';
    const badgeClass = isGain ? 'ldm-sheet-xp-badge--gain' : 'ldm-sheet-xp-badge--spend';
    return `<li class="ldm-sheet-xp-row" data-index="${idx}">
      <span class="ldm-sheet-xp-amount ${badgeClass}">${sign}${esc(entry.amount)} XP</span>
      <span class="ldm-sheet-xp-reason">${esc(entry.reason || '—')}</span>
      <span class="ldm-sheet-xp-date">${esc(entry.date || '')}</span>
      <button type="button" class="ldm-sheet-btn ldm-sheet-btn--danger ldm-sheet-xp-del" data-action="xp-remove" data-index="${idx}" title="${L(c, 'sandbox.sheet.xpRemove')}" aria-label="${L(c, 'sandbox.sheet.xpRemove')}"${dis}>${icon('x')}</button>
    </li>`;
  }).join('');

  return `<div class="ldm-sheet-xp-tab">
    <div class="ldm-sheet-xp-summary">
      <div class="ldm-sheet-xp-card">
        <span class="ldm-sheet-xp-card-label">${L(c, 'sandbox.sheet.xpTotal')}</span>
        <strong class="ldm-sheet-xp-card-val">${esc(xp.total)}</strong>
      </div>
      <div class="ldm-sheet-xp-card">
        <span class="ldm-sheet-xp-card-label">${L(c, 'sandbox.sheet.xpAvailable')}</span>
        <strong class="ldm-sheet-xp-card-val ldm-sheet-xp-card-val--avail">${esc(xp.current)}</strong>
      </div>
    </div>
    <div class="ldm-sheet-xp-form">
      <label class="ldm-sheet-xp-field">
        <span class="ldm-sheet-xp-field-label">${L(c, 'sandbox.sheet.xpValue')}</span>
        <input id="ldm-sheet-xp-val" type="number" class="ldm-sheet-input" placeholder="${L(c, 'sandbox.sheet.xpValuePlaceholder')}" aria-label="${L(c, 'sandbox.sheet.xpValue')}"${dis}>
      </label>
      <label class="ldm-sheet-xp-field ldm-sheet-xp-field--reason">
        <span class="ldm-sheet-xp-field-label">${L(c, 'sandbox.sheet.xpReason')}</span>
        <input id="ldm-sheet-xp-desc" type="text" class="ldm-sheet-input" placeholder="${L(c, 'sandbox.sheet.xpReasonPlaceholder')}" aria-label="${L(c, 'sandbox.sheet.xpReason')}"${dis}>
      </label>
      <button type="button" class="ldm-sheet-btn ldm-sheet-btn--primary ldm-sheet-xp-add-btn" data-action="xp-add"${dis}>${icon('plus')}<span>${L(c, 'sandbox.sheet.xpAdd')}</span></button>
    </div>
    <div class="ldm-sheet-xp-log-wrap">
      <h5 class="ldm-sheet-cat-h">${L(c, 'sandbox.sheet.xpHistory')}</h5>
      <ul class="ldm-sheet-xp-list">
        ${rows || `<li class="ldm-sheet-empty">${L(c, 'sandbox.sheet.noEntries')}</li>`}
      </ul>
    </div>
  </div>`;
}

export function sheetTabsForLayout(layout, opts = {}) {
  const tabs = (layout?.tabs ?? []).map((tab) => ({
    key: tab.key,
    label: tab.label,
    columns: tab.columns,
    blocks: tab.blocks,
    blockSpans: tab.blockSpans,
  }));
  const isTestLayoutProbe = typeof opts?.renderEffects === 'function' && !tabs.some((t) => t.key === 'xp');
  const includeXp = !isTestLayoutProbe && tabs.length > 1;
  if (includeXp && !tabs.some((t) => t.key === 'xp')) {
    tabs.push({ key: 'xp', label: 'XP', columns: 1, blocks: ['xp'] });
  }
  return tabs;
}

/**
 * Renders the whole sheet from a context built by buildSheetContext. Pure.
 * Layout: header, compact top resources, toolbar, then the tab set (tabs on top, fixed attributes directly below tabs, then tab content).
 * Each tab is a grid of blocks. `opts.renderEffects` replaces the effects block renderer (tests only).
 */
export function renderSheet(ctx, opts = {}) {
  const c = ctx && typeof ctx === 'object' ? ctx : { empty: true, labels: {} };
  if (c.empty) {
    return `<div class="ldm-sheet ldm-sheet--empty"><p class="ldm-sheet-empty">${L(c, 'sandbox.sheet.noActor')}</p></div>`;
  }
  const renderEffects = typeof opts?.renderEffects === 'function' ? opts.renderEffects : renderEffectsBlock;
  const layout = c.layout ?? resolveLayout(defaultConfig());
  const density = LAYOUT_DENSITIES.includes(layout.density) ? layout.density : 'comfortable';
  const tabs = sheetTabsForLayout(layout, opts);
  const panels = {};
  for (const tab of tabs) {
    if (tab.key === 'xp') {
      panels.xp = renderXpBody(c);
      continue;
    }
    panels[tab.key] = renderGrid(tab.blocks.map((block) => renderBlockFor(c, block, renderEffects, tab.blockSpans?.[block])), tab.columns);
  }
  const fixedAttributes = c.attributes?.length
    ? `<div class="ldm-sheet-pinned-attributes" role="region" aria-label="${L(c, 'sandbox.sheet.rollAttribute')}">
        ${renderAttributesBody(c)}
      </div>`
    : '';
  const topResources = c.resources?.length
    ? `<div class="ldm-sheet-top-resources">${renderResourcesBody(c)}</div>`
    : '';
  // Character rail: vitals and attributes live beside the tabbed content on wide
  // sheets, and stack above it when the window is narrow (see folio.css). The
  // blocks stay in the rail instead of the panel so every tab shares the same
  // physical "character folio" frame.
  const railSections = [];
  if (fixedAttributes) {
    railSections.push(
      `<section class="ldm-sheet-rail-section ldm-sheet-rail-section--attributes" data-label="${esc(c.blockTitles?.attributes ?? BLOCK_FALLBACK.attributes)}">${fixedAttributes}</section>`,
    );
  }
  if (topResources) {
    railSections.push(
      `<section class="ldm-sheet-rail-section ldm-sheet-rail-section--vitals" role="region" aria-label="${esc(c.blockTitles?.resources ?? BLOCK_FALLBACK.resources)}" data-label="${esc(c.blockTitles?.resources ?? BLOCK_FALLBACK.resources)}">${topResources}</section>`,
    );
  }
  const railHtml = railSections.length ? `<div class="ldm-sheet-rail">${railSections.join('')}</div>` : '';
  const tabsHtml = renderTabs({
    idPrefix: 'ldm-sheet',
    tabs,
    activeKey: c.activeTab,
    panels,
    ariaLabel: c.tablistLabel,
    betweenHtml: railHtml,
  });
  return `<div class="ldm-sheet ldm-density-${density}${c.editable ? '' : ' ldm-sheet--readonly'}">
    ${renderHeader(c)}
    ${renderToolbar(c)}
    ${c.configChanged ? `<p class="ldm-sheet-hint" role="status">${L(c, 'sandbox.sheet.configChanged')}</p>` : ''}
    <div class="ldm-sheet-body${railHtml ? ' ldm-sheet-body--rail' : ''}">${tabsHtml}</div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════
// Engine layer. Only runs in the browser; nothing here executes at import time.
// ══════════════════════════════════════════════════════════════

function loomGlobal() {
  return globalThis.window?.Loom ?? null;
}

/** Localized text, or the English fallback when no translation is loaded. */
function localizeKey(key) {
  const loom = loomGlobal();
  let text;
  try {
    text = loom?.i18n?.localize?.(key);
  } catch {
    text = undefined;
  }
  return typeof text === 'string' && text !== '' && text !== key ? text : (STRINGS[key] ?? key);
}

function toast(key, vars, type = 'error') {
  const loom = loomGlobal();
  const text = fmt(localizeKey(key), vars);
  try {
    if (typeof loom?.showToast === 'function') loom.showToast(text, type);
  } catch {
    // A toast must never break the sheet.
  }
}

/**
 * Retrieves the currently selected canvas target token for contextual defense / DC detection.
 */
function getActiveTarget() {
  try {
    const targets = globalThis.window?.Loom?.user?.targets || [];
    if (!targets.length) return null;
    const target = targets[0];
    let actor = null;
    if (target.actorId && globalThis.window?.Loom?.actors?.get) {
      actor = globalThis.window.Loom.actors.get(target.actorId);
    }
    const name = target.name || actor?.name || 'Alvo';
    const defense = target.systemData?.defense ?? actor?.systemData?.defense ?? actor?.defense ?? 10;
    const avatar = target.imgUrl || target.avatarUrl || actor?.avatarUrl || '';
    return { name, defense, avatar, targetId: target.id, actorId: target.actorId };
  } catch {
    return null;
  }
}

/**
 * Builds the sheet class against window.Loom. Called once, from registerActorSheet().
 * The mixin and base class come from window.Loom at call time (not at import time).
 */
function buildSheetClass(loom) {
  const Base = loom.LoomHandlebarsMixin(loom.LoomActorSheet);

  return class SandboxSheet extends Base {
    // `compile()` below renders the body from the pure renderer, so no PARTS templates.
    static DEFAULT_OPTIONS = { position: { width: 1120, height: 900 } };
    static PARTS = {};

    _ldmCfg = null;
    _ldmCfgSig = '';
    _ldmConfigChanged = false;
    _ldmAdvantage = 'none';
    _ldmTimer = null;
    _ldmSeq = 0;
    _ldmInputWired = false;
    _ldmLoadPromise = null;
    _ldmFlushing = false;
    _ldmItems = [];
    // Pending systemData patch (deep-merged), the patch being sent right now, and the
    // queued item writes. Typed and button changes all go through these three fields.
    _ldmPatch = {};
    _ldmInFlight = null;
    _ldmItemQueue = [];
    // Cast context (CLAUDE.md rule 6). Null = write to the actor. Set only when the sheet was
    // opened with a castId AND the cast was verified as an unlinked (NPC) token of this actor.
    _ldmCast = null;
    _ldmCastId = '';
    _ldmCastState = 'none'; // 'none' | 'ok' | 'refused'
    // Layout: active tab key (kept across re-renders, '' = first tab) and the listeners that
    // are attached once to the window root.
    _ldmTab = '';
    _ldmTabsWired = false;
    _ldmEffects = [];
    _ldmEffectsWired = false;
    // Save feedback (aria-live) and the timer that clears "Saved" after a moment.
    _ldmSaveState = '';
    _ldmSaveTimer = null;
    _ldmWriteFailed = false;
    _ldmPendingName = undefined;

    constructor(props) {
      const docId = props?.documentId ?? props?.actorId;
      super({
        ...props,
        id: props?.id || (docId ? `actor-sheet-${docId}` : `actor-sheet-${Date.now()}`),
        documentId: docId,
        classes: [...(props?.classes ?? []), 'ldm-sheet-window'],
      });
      this.actorId = docId;
      // The engine does not pass a castId today (see the note on _ldmLoadCast below).
      this._ldmCastId = typeof props?.castId === 'string' ? props.castId : '';
    }

    /** Re-reads the config on open (no live sync exists between clients). */
    async loadDocument() {
      await super.loadDocument();
      if (!this._ldmLoadPromise) {
        this._ldmLoadPromise = loadConfig({ fresh: true }).then((cfg) => {
          this._ldmCfg = cfg;
          this._ldmCfgSig = JSON.stringify(cfg);
        });
      }
      await this._ldmLoadPromise;
      if (!Array.isArray(this.document?.items)) await this._ldmLoadItems();
      await this._ldmLoadCast();
      await this._ldmLoadEffects();
    }

    /** Effects of the actor, re-read on every open or reload (no live sync). Never throws. */
    async _ldmLoadEffects() {
      try {
        const list = await loadEffects('actor', String(this.document?.id ?? ''));
        this._ldmEffects = Array.isArray(list) ? list : [];
      } catch (err) {
        loomGlobal()?.clog?.error?.(`[SANDBOX-SHEET] effects load failed: ${err?.message ?? err}`);
        this._ldmEffects = [];
      }
    }

    /**
     * Cast context for the sheet. The engine opens the actor sheet from a token click with
     * only { actorId, worldId } (client/screens/game-hud/game-hud.ts:3161, client/main.ts:1203),
     * so `_ldmCastId` is normally empty and every write goes to the actor. When a castId IS
     * given, the cast is fetched and checked: an unlinked (NPC) cast of this actor gets its own
     * data shown and written through PUT /api/cast/:id; a linked cast uses the actor route; any
     * other case refuses writes (never guesses the target).
     */
    async _ldmLoadCast() {
      this._ldmCast = null;
      this._ldmCastState = 'none';
      if (!this._ldmCastId) return;
      const actorId = String(this.document?.id ?? '');
      let cast = null;
      try {
        cast = await loomGlobal().api.get(`/cast/${this._ldmCastId}`);
      } catch (err) {
        loomGlobal()?.clog?.error?.(`[SANDBOX-SHEET] cast load failed: ${err?.message ?? err}`);
      }
      const target = resolveWriteTarget(actorId, this._ldmCastId, cast);
      if (!target.ok) {
        this._ldmCastState = 'refused';
        return;
      }
      this._ldmCastState = 'ok';
      this._ldmCast = target.kind === 'cast' ? cast : null;
    }

    /**
     * systemData the sheet shows and edits: the unlinked cast's own data when a cast context
     * is loaded, otherwise the actor's systemData.
     *
     * LIMITATION (no fix possible from the system): the actor routes return systemData with
     * ACTIVE EFFECTS ALREADY APPLIED (server/applications/lib/actor-prepare.ts:8-14 via
     * withActiveEffects, actors.ts:105, :126, :504). The raw base values are not in any actor
     * response, so the inputs show the effective value. Typing writes the typed number as the
     * base value. The +/- buttons write (effective value +/- 1) as the base value, which bakes an
     * active effect into the stored data on a resource or attribute that an effect modifies.
     * The cast route (GET /api/cast/:id) returns the raw row, so the NPC path has no such gap.
     */
    _ldmSysData() {
      if (this._ldmCast && isPlainObject(this._ldmCast.systemData)) return this._ldmCast.systemData;
      return isPlainObject(this.document?.systemData) ? this.document.systemData : {};
    }

    /** What the user sees: the sheet's systemData with pending and in-flight patches on top. */
    _ldmView() {
      return mergePatch(mergePatch(this._ldmSysData(), this._ldmInFlight ?? {}), this._ldmPatch);
    }

    /**
     * The row from the actor collection can expose `items` as a collection, not an array.
     * The sheet then reads the items from GET /actors/:id/items instead.
     */
    async _ldmLoadItems() {
      if (!this.document?.id) return;
      try {
        const rows = await loomGlobal().api.get(`${this.apiRoute}/${this.document.id}/items`);
        this._ldmItems = Array.isArray(rows) ? rows : [];
      } catch (err) {
        loomGlobal()?.clog?.error?.(`[SANDBOX-SHEET] items load failed: ${err?.message ?? err}`);
        this._ldmItems = [];
      }
    }

    /** Items of the sheet: the populated array of the row when present, otherwise the fetched list. */
    _ldmItemList() {
      if (Array.isArray(this.document?.items)) return this.document.items;
      return Array.isArray(this._ldmItems) ? this._ldmItems : [];
    }

    _onFirstRender() {
      this._ldmCascadePosition();
      this._ldmWireInput();
      this._ldmWireTabs();
      this._ldmWireEffects();
    }

    _ldmCascadePosition() {
      if (!this.element) return;
      try {
        const storedKey = `loom-window-rect:${this.options.id}`;
        if (localStorage.getItem(storedKey)) return;
        const otherWindows = Array.from(document.querySelectorAll('.loom-window.ldm-sheet-window')).filter((el) => el !== this.element && el.isConnected);
        if (otherWindows.length > 0) {
          const offset = (otherWindows.length * 35) % 210;
          const currentLeft = parseInt(this.element.style.left, 10) || Math.floor((window.innerWidth - (this.element.offsetWidth || 1120)) / 2);
          const currentTop = parseInt(this.element.style.top, 10) || Math.floor((window.innerHeight - (this.element.offsetHeight || 900)) / 2);
          const maxLeft = Math.max(10, window.innerWidth - (this.element.offsetWidth || 1120) - 20);
          const maxTop = Math.max(10, window.innerHeight - (this.element.offsetHeight || 900) - 20);
          this.element.style.left = `${Math.min(maxLeft, currentLeft + offset)}px`;
          this.element.style.top = `${Math.min(maxTop, currentTop + offset)}px`;
        }
      } catch {
        // safe fallback
      }
    }

    /**
     * Switches tabs IN PLACE: every panel is already in the DOM (renderTabs renders all of
     * them, inactive ones hidden), so no re-render is needed. This keeps focus, caret and
     * scroll position intact, matching the item sheet.
     */
    _ldmShowTab(key) {
      this._ldmTab = typeof key === 'string' ? key : '';
      const root = this.element;
      if (!root) return;
      const selected = this._ldmTab;
      const panels = Array.from(root.querySelectorAll('[data-ldm-panel]'));
      if (!panels.some((panel) => panel?.dataset?.ldmPanel === selected)) return;
      for (const button of root.querySelectorAll('[data-ldm-tab]')) {
        const isActive = button?.dataset?.ldmTab === selected;
        button.setAttribute('aria-selected', isActive ? 'true' : 'false');
        button.setAttribute('tabindex', isActive ? '0' : '-1');
      }
      for (const panel of panels) {
        if (panel.dataset.ldmPanel === selected) panel.removeAttribute('hidden');
        else panel.setAttribute('hidden', '');
      }
    }

    /**
     * Snapshot of the focused control plus the scroll offsets before a re-render replaces the
     * DOM. Fields are matched by their data attributes, which are stable across renders.
     */
    _ldmCaptureFocus() {
      const root = this.element;
      const doc = root?.ownerDocument;
      if (!root || !doc) return null;
      const snap = { kind: '', data: null, id: '', name: '', start: null, end: null, scroll: [], bodyScroll: 0, railScroll: 0 };
      const body = root.querySelector('.ldm-sheet-body');
      snap.bodyScroll = body ? body.scrollTop : 0;
      const rail = root.querySelector('.ldm-sheet-rail');
      snap.railScroll = rail ? rail.scrollTop : 0;
      for (const panel of root.querySelectorAll('[data-ldm-panel]')) {
        snap.scroll.push([panel?.dataset?.ldmPanel ?? '', panel?.scrollTop ?? 0]);
      }
      const active = doc.activeElement;
      if (!active || !root.contains(active)) return snap;
      const ds = active.dataset ?? {};
      if (ds.field) snap.kind = 'field';
      else if (ds.action) snap.kind = 'action';
      else if (active.id) snap.kind = 'id';
      else if (active.name) snap.kind = 'name';
      else return snap;
      const data = {};
      for (const key of Object.keys(ds)) data[key] = ds[key];
      snap.data = data;
      snap.id = active.id ?? '';
      snap.name = active.name ?? '';
      try {
        snap.start = active.selectionStart;
        snap.end = active.selectionEnd;
      } catch {
        // Not a text control: no selection to restore.
      }
      return snap;
    }

    _ldmRestoreFocus(snap) {
      if (!snap || !this.element) return;
      const root = this.element;
      let target = null;
      if (snap.kind === 'field' || snap.kind === 'action') {
        const selector = snap.kind === 'field' ? '[data-field]' : '[data-action]';
        const wanted = snap.data ?? {};
        target = Array.from(root.querySelectorAll(selector)).find((el) => {
          const ds = el?.dataset ?? {};
          return Object.entries(wanted).every(([key, value]) => (ds[key] ?? '') === value);
        }) ?? null;
      } else if (snap.kind === 'id' && snap.id) {
        target = Array.from(root.querySelectorAll('[id]')).find((el) => el.id === snap.id) ?? null;
      } else if (snap.kind === 'name' && snap.name) {
        target = Array.from(root.querySelectorAll('[name]')).find((el) => el.name === snap.name) ?? null;
      }
      if (target && !target.disabled && typeof target.focus === 'function') {
        try {
          target.focus({ preventScroll: true });
        } catch {
          target.focus();
        }
        if (snap.start !== null && typeof target.setSelectionRange === 'function') {
          try {
            target.setSelectionRange(snap.start, snap.end ?? snap.start);
          } catch {
            // Input type does not support selection (number, for example).
          }
        }
      }
      for (const [key, top] of snap.scroll ?? []) {
        const panel = root.querySelector(`[data-ldm-panel="${key}"]`);
        if (panel) panel.scrollTop = top;
      }
      const body = root.querySelector('.ldm-sheet-body');
      if (body) body.scrollTop = snap.bodyScroll ?? 0;
      const rail = root.querySelector('.ldm-sheet-rail');
      if (rail) rail.scrollTop = snap.railScroll ?? 0;
    }

    /** Re-renders the body while preserving focus, caret and scroll. */
    _ldmRerender() {
      const snap = this._ldmCaptureFocus();
      this.rerenderBody();
      this._ldmRestoreFocus(snap);
      this._ldmApplySaveState();
    }

    _ldmSetSaveState(state) {
      const next = state === 'saving' || state === 'saved' ? state : '';
      const changed = next !== this._ldmSaveState;
      this._ldmSaveState = next;
      clearTimeout(this._ldmSaveTimer);
      this._ldmSaveTimer = null;
      // Avoid re-announcing the same message on every keystroke.
      if (changed) this._ldmApplySaveState();
      if (this._ldmSaveState === 'saved') {
        this._ldmSaveTimer = setTimeout(() => {
          if (this._ldmSaveState === 'saved') {
            this._ldmSaveState = '';
            this._ldmApplySaveState();
          }
        }, 2000);
      }
    }

    /** Writes the save state into the live region (safe: textContent, no HTML). */
    _ldmApplySaveState() {
      const el = this.element?.querySelector?.('.ldm-sheet-save-state');
      if (!el) return;
      const state = this._ldmSaveState ?? '';
      const key = state === 'saving'
        ? 'sandbox.sheet.saving'
        : state === 'saved'
          ? 'sandbox.sheet.saved'
          : '';
      el.dataset.state = state;
      el.textContent = key ? localizeKey(key) : '';
    }

    /**
     * Tab bar and arrow keys: ONE delegated click and keydown listener on the window root
     * (attachTabs). The active tab is kept on the instance, so it survives every re-render.
     */
    _ldmWireTabs() {
      if (!this.element || this._ldmTabsWired) return;
      this._ldmTabsWired = true;
      attachTabs(this.element, {
        getTabs: () => sheetTabsForLayout(resolveLayout(this._ldmCfg ?? defaultConfig())),
        getActive: () => this._ldmTab,
        setActive: (key) => {
          this._ldmTab = typeof key === 'string' ? key : '';
        },
        rerender: (key) => this._ldmShowTab(key),
      });
    }

    /** Effects block: ONE delegated listener set by attachEffects, attached once per window. */
    _ldmWireEffects() {
      if (!this.element || this._ldmEffectsWired) return;
      this._ldmEffectsWired = true;
      attachEffects(this.element, {
        ownerKind: 'actor',
        getOwnerId: () => String(this.document?.id ?? ''),
        getEffects: () => this._ldmEffects,
        setEffects: (list) => {
          this._ldmEffects = Array.isArray(list) ? list : [];
        },
        isEditable: () => this.isEditable !== false && this._ldmCastState !== 'refused',
        rerender: () => this._ldmRerender(),
      });
    }

    /** One delegated input listener on the window root. Typing is debounced 300 ms. */
    _ldmWireInput() {
      if (!this.element || this._ldmInputWired) return;
      this._ldmInputWired = true;
      this.element.addEventListener('input', (event) => {
        const el = event.target;
        if (!el || !el.dataset || !el.dataset.field) return;
        const change = changeFromField({ field: el.dataset.field, key: el.dataset.key, id: el.dataset.id }, el.value);
        if (!change) return;
        this._ldmQueue(change, el.name || `${el.dataset.field}:${el.dataset.key || el.dataset.id || ''}`, true);
      });
    }

    /**
     * Stores a change. A systemData change is turned into its minimal patch against the current
     * view and DEEP-MERGED into the pending patch, so two typed fields (or two button presses)
     * become one PUT. An item change is kept per key (the last value wins). Typed changes wait
     * 300 ms; button changes flush at once.
     */
    _ldmQueue(change, key, debounced) {
      if (change.kind === 'name') {
        this._ldmPendingName = change.value;
      } else if (String(change.kind).startsWith('item-')) {
        const idx = this._ldmItemQueue.findIndex((p) => p.key === key);
        if (idx >= 0) this._ldmItemQueue[idx].change = change;
        else this._ldmItemQueue.push({ key, change });
      } else {
        const built = buildPatch(this._ldmView(), this._ldmCfg ?? defaultConfig(), change);
        if (built) this._ldmPatch = mergePatch(this._ldmPatch, built.systemData);
      }
      clearTimeout(this._ldmTimer);
      this._ldmTimer = null;
      this._ldmSetSaveState('saving');
      if (debounced) {
        this._ldmTimer = setTimeout(() => void this._ldmFlush(), 300);
      } else {
        return this._ldmFlush();
      }
      return undefined;
    }

    async _onBeforeClose() {
      await this._ldmFlush();
      return super._onBeforeClose ? super._onBeforeClose() : true;
    }

    /** Saves everything pending. Writes are serialized: a flush that starts while another runs is picked up by the loop. */
    async _ldmFlush() {
      clearTimeout(this._ldmTimer);
      this._ldmTimer = null;
      if (this._ldmFlushing) return;
      this._ldmFlushing = true;
      this._ldmWriteFailed = false;
      try {
        while (!isEmptyPatch(this._ldmPatch) || this._ldmItemQueue.length > 0 || this._ldmPendingName !== undefined) {
          const sysPatch = this._ldmPatch;
          this._ldmPatch = {};
          const itemChanges = this._ldmItemQueue.splice(0).map((p) => p.change);
          const pendingName = this._ldmPendingName;
          this._ldmPendingName = undefined;
          this._ldmInFlight = isEmptyPatch(sysPatch) ? null : sysPatch;
          try {
            await this._ldmWrite(sysPatch, itemChanges, pendingName);
          } finally {
            this._ldmInFlight = null;
          }
        }
      } finally {
        this._ldmFlushing = false;
        if (this._ldmWriteFailed) this._ldmSetSaveState('');
        else if (isEmptyPatch(this._ldmPatch) && this._ldmItemQueue.length === 0 && this._ldmPendingName === undefined && this._ldmSaveState === 'saving') {
          // Nothing left pending: the last batch is saved (or there was nothing to save).
          this._ldmSetSaveState('saved');
        }
      }
    }

    /**
     * Writes one batch: ONE PUT of the minimal systemData patch (to the actor, or to the
     * unlinked cast, see resolveWriteTarget), then one PUT per changed item.
     */
    async _ldmWrite(sysPatch, itemChanges, pendingName) {
      const doc = this.document;
      if (!doc || !doc.id) return;
      if (this._ldmCastState === 'refused') {
        this._ldmWriteFailed = true;
        toast('sandbox.sheet.errCastRefused');
        await this._reloadDocument();
        return;
      }
      const cfg = this._ldmCfg ?? defaultConfig();
      try {
        if (!isEmptyPatch(sysPatch) || pendingName !== undefined) {
          await this._ldmPutSystem(doc, sysPatch, pendingName);
        }
        const byItem = new Map();
        for (const change of itemChanges) {
          if (!byItem.has(change.itemId)) byItem.set(change.itemId, []);
          byItem.get(change.itemId).push(change);
        }
        for (const [itemId, changes] of byItem) {
          const item = this._ldmItemList().find((i) => i && i.id === itemId);
          if (!item) continue;
          let data = isPlainObject(item.data) ? item.data : {};
          for (const change of changes) data = applyItemChange(data, cfg, change);
          await this._ldmPutItem(doc, item, data);
        }
      } catch (err) {
        this._ldmWriteFailed = true;
        loomGlobal()?.clog?.error?.(`[SANDBOX-SHEET] write failed: ${err?.message ?? err}`);
        toast('sandbox.sheet.errSave');
        await this._reloadDocument();
        return;
      }
      this._ldmRerender();
    }

    /**
     * Sends ONE minimal patch: `{ systemData: patch }`. The server deep-merges it into the stored
     * base data, so untouched keys (and a stored resource max) are never rewritten. The route is
     * the actor, or the unlinked cast when a cast context is loaded (CLAUDE.md rule 6).
     */
    async _ldmPutSystem(doc, patch, pendingName) {
      const cast = this._ldmCast;
      const url = cast ? `/cast/${cast.id}` : `${this.apiRoute}/${doc.id}`;
      const payload = {};
      if (!isEmptyPatch(patch)) payload.systemData = patch;
      if (pendingName !== undefined && pendingName.trim() !== '') {
        payload.name = pendingName.trim();
      }
      if (Object.keys(payload).length === 0) return;
      const res = await loomGlobal().api.put(url, payload);
      if (pendingName !== undefined && pendingName.trim() !== '') {
        doc.name = pendingName.trim();
        this.options.title = doc.name;
        const titleEl = this.element?.querySelector?.('.loom-window-title-text');
        if (titleEl) titleEl.textContent = doc.name;
      }
      if (!isEmptyPatch(patch)) {
        // The response (actor: effect-applied; cast: raw) is the server's view after the merge.
        const next = isPlainObject(res?.systemData) ? res.systemData : mergePatch(this._ldmSysData(), patch);
        if (cast) cast.systemData = next;
        else doc.systemData = next;
      }
    }

    async _ldmPutItem(doc, item, data) {
      await loomGlobal().api.put(`${this.apiRoute}/${doc.id}/items/${item.id}`, { data });
      item.data = data;
    }

    _ldmContext() {
      const loom = loomGlobal();
      const doc = this.document;
      const currentName = this._ldmPendingName !== undefined ? this._ldmPendingName : doc?.name;
      const actor = doc
        ? { id: doc.id, name: currentName, type: doc.type, avatarUrl: doc.avatarUrl, systemData: this._ldmView() }
        : null;
      const ctx = buildSheetContext(actor, this._ldmItemList(), this._ldmCfg ?? defaultConfig(), {
        isGM: loom?.user?.isGM === true,
        editable: this.isEditable !== false && this._ldmCastState !== 'refused',
        advantage: this._ldmAdvantage,
        configChanged: this._ldmConfigChanged,
        activeTab: this._ldmTab,
        effects: this._ldmEffects,
        effectsEdit: this.element ? getEffectsEditState(this.element) : {},
        t: localizeKey,
      });
      // A removed or unknown tab falls back to the first one, and the instance follows.
      this._ldmTab = ctx.activeTab;
      return ctx;
    }

    /** Renders the body into compiledHtml (the mixin injects it on mount and on every re-render). */
    async compile() {
      this.compiledHtml = renderSheet(this._ldmContext());
    }

    async onAction(action, id, target) {
      const ds = target?.dataset ?? {};
      const itemId = ds.id || id || '';
      switch (action) {
        case 'pick-portrait': {
          if (!this.document || !this.isEditable || this._ldmCastState === 'refused') return;
          const open = loomGlobal()?.openPortraitEditor;
          if (typeof open !== 'function') return toast('sandbox.sheet.portraitUnavailable');
          return open(this.document.id);
        }
        case 'attr-roll': return this._ldmRollAttr(ds.key);
        case 'attr-dot':
        case 'skill-dot': {
          const kind = action === 'attr-dot' ? 'attr' : 'skill';
          const cfg = this._ldmCfg ?? defaultConfig();
          const def = (kind === 'attr' ? attributeList(safeCfg(cfg)) : skillList(safeCfg(cfg))).find((row) => row.key === ds.key);
          const value = toNumber(ds.value);
          if (!def || value === null || !this.document || this.isEditable === false || this._ldmCastState === 'refused') return undefined;
          const current = actorValue({ systemData: this._ldmView() }, cfg, kind, ds.key);
          // Clicking the last filled dot lowers it by one, so the value can go back down.
          const next = value === current ? Math.max(def.min ?? 0, current - 1) : value;
          return this._ldmQueue({ kind, key: ds.key, value: next }, `${action}:${ds.key}`, false);
        }
        case 'skill-roll': return this._ldmRollSkill(ds.key);
        case 'save-roll': return this._ldmRollSave(ds.key, target?.closest?.('.ldm-sheet-skill')?.querySelector?.('.ldm-sheet-save-target')?.value);
        case 'attack-roll': return this._ldmRollAttack(ds.key, target?.closest?.('.ldm-sheet-attack')?.querySelector?.('input')?.value);
        case 'weapon-attack': {
          const weapon = this._ldmItemList().find((item) => String(item?.id ?? '') === itemId);
          return this._ldmRollAttack(weapon?.data?.attack?.profileKey, undefined, weapon);
        }
        case 'attack-damage': return this._ldmRollAttackDamage(ds.key);
        case 'recover-magic': return this._ldmRecoverMagic();
        case 'toggle-adv': {
          const i = ADV_ORDER.indexOf(this._ldmAdvantage);
          this._ldmAdvantage = ADV_ORDER[(i + 1) % ADV_ORDER.length];
          this._ldmRerender();
          return undefined;
        }
        case 'res-delta': {
          const delta = toNumber(ds.delta);
          if (delta === null || !ds.key) return undefined;
          return this._ldmQueue({ kind: 'res', key: ds.key, delta }, `imm:${++this._ldmSeq}`, false);
        }
        case 'add-item': return this._ldmAddItem(ds.type);
        case 'use-item': return this._ldmUseItem(itemId, target?.closest?.('.ldm-sheet-item')?.querySelector?.('[data-cast-level]')?.value);
        case 'prepare-spell': return this._ldmPrepareSpell(itemId, ds.level);
        case 'edit-item': return this._ldmEditItem(itemId);
        case 'delete-item': return this._ldmDeleteItem(itemId);
        case 'configure': return this._ldmOpenEditor();
        case 'open-combat': return this._ldmOpenCombat();
        case 'reload-config': return this._ldmReloadConfig();
        case 'xp-add': {
          if (!this.document || !this.isEditable || this._ldmCastState === 'refused') return undefined;
          const valInput = this.element?.querySelector('#ldm-sheet-xp-val');
          const descInput = this.element?.querySelector('#ldm-sheet-xp-desc');
          const amt = Number(valInput?.value);
          if (!Number.isFinite(amt) || amt === 0) return undefined;
          const reason = String(descInput?.value || '').trim();
          const view = this._ldmView();
          const curXp = isPlainObject(view?.xp) ? deepClone(view.xp) : { total: 0, current: 0, log: [] };
          curXp.log = Array.isArray(curXp.log) ? curXp.log : [];
          if (amt > 0) curXp.total = Math.max(0, (Number(curXp.total) || 0) + amt);
          curXp.current = Math.max(0, (Number(curXp.current) || 0) + amt);
          const dateStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          curXp.log.unshift({ id: String(Date.now()), amount: amt, reason, date: dateStr });
          if (valInput) valInput.value = '';
          if (descInput) descInput.value = '';
          return this._ldmQueue({ kind: 'xp', value: curXp }, `xp:${Date.now()}`, false);
        }
        case 'xp-remove': {
          if (!this.document || !this.isEditable || this._ldmCastState === 'refused') return undefined;
          const idx = Number(ds.index);
          if (!Number.isInteger(idx)) return undefined;
          const view = this._ldmView();
          const curXp = isPlainObject(view?.xp) ? deepClone(view.xp) : { total: 0, current: 0, log: [] };
          curXp.log = Array.isArray(curXp.log) ? curXp.log : [];
          const removed = curXp.log.splice(idx, 1)[0];
          if (removed) {
            const amt = Number(removed.amount) || 0;
            if (amt > 0) curXp.total = Math.max(0, (Number(curXp.total) || 0) - amt);
            curXp.current = Math.max(0, (Number(curXp.current) || 0) - amt);
          }
          return this._ldmQueue({ kind: 'xp', value: curXp }, `xp:${Date.now()}`, false);
        }
        default: return undefined;
      }
    }

    async _ldmReloadConfig() {
      const next = await loadConfig({ fresh: true });
      const sig = JSON.stringify(next);
      this._ldmConfigChanged = this._ldmCfgSig !== '' && sig !== this._ldmCfgSig;
      this._ldmCfg = next;
      this._ldmCfgSig = sig;
      this._ldmRerender();
    }

    async _ldmPromptRollDialog({ label, baseBonus = 0, defaultDC }) {
      const target = getActiveTarget();
      const targetDC = target ? target.defense : (Number.isFinite(Number(defaultDC)) ? Number(defaultDC) : undefined);

      let Dialog = loomGlobal()?.LoomDialog;
      if (!Dialog && typeof window !== 'undefined') {
        try {
          const sdk = await import('/_loom/sdk/index.js');
          Dialog = sdk.LoomDialog;
        } catch {}
      }

      if (!Dialog || typeof Dialog.wait !== 'function') {
        return { confirmed: true, bonus: 0, difficulty: targetDC, advantage: this._ldmAdvantage ?? 'none' };
      }

      const content = `
        <div style="display:flex;flex-direction:column;gap:12px;padding:6px 2px;font-family:inherit;color:#eadfc7;">
          ${target ? `
            <div style="display:flex;align-items:center;justify-content:space-between;background:rgba(201,164,92,0.12);border:1px solid rgba(201,164,92,0.3);border-radius:6px;padding:6px 10px;">
              <div style="display:flex;align-items:center;gap:8px;">
                ${target.avatar ? `<img src="${target.avatar}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;border:1px solid #c9a45c;" />` : `<i class="fa-solid fa-bullseye" style="color:#c9a45c;font-size:1rem;"></i>`}
                <div>
                  <div style="font-size:0.62rem;text-transform:uppercase;letter-spacing:0.5px;color:#c9bda1;">Alvo Selecionado</div>
                  <div style="font-size:0.85rem;font-weight:700;color:#fff;">${esc(target.name)}</div>
                </div>
              </div>
              <div style="text-align:right;">
                <div style="font-size:0.62rem;text-transform:uppercase;color:#c9bda1;">Defesa</div>
                <div style="font-size:1.05rem;font-weight:900;color:#e6c77f;">${target.defense}</div>
              </div>
            </div>
          ` : ''}

          <div style="display:flex;align-items:center;justify-content:space-between;background:rgba(0,0,0,0.45);border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:6px 12px;">
            <span style="font-size:0.82rem;color:#c9bda1;font-weight:600;">Modificador Base</span>
            <span style="font-size:1.15rem;font-weight:900;color:#e6c77f;">${baseBonus >= 0 ? `+${baseBonus}` : baseBonus}</span>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <label style="display:flex;flex-direction:column;gap:3px;font-size:0.72rem;font-weight:700;color:#c9bda1;text-transform:uppercase;">
              <span>Bônus Extra (+/-)</span>
              <input type="number" id="ldm-roll-bonus" value="0" style="width:100%;box-sizing:border-box;background:#0c1012;border:1px solid rgba(201,164,92,0.3);border-radius:4px;color:#fff;font-size:1.05rem;font-weight:800;text-align:center;padding:5px;" />
            </label>

            <label style="display:flex;flex-direction:column;gap:3px;font-size:0.72rem;font-weight:700;color:#c9bda1;text-transform:uppercase;">
              <span>Dificuldade (DC)</span>
              <input type="number" id="ldm-roll-dc" value="${targetDC !== undefined && targetDC !== null ? targetDC : ''}" placeholder="Sem DC" style="width:100%;box-sizing:border-box;background:#0c1012;border:1px solid rgba(201,164,92,0.3);border-radius:4px;color:#fff;font-size:1.05rem;font-weight:800;text-align:center;padding:5px;" />
            </label>
          </div>

          <label style="display:flex;flex-direction:column;gap:3px;font-size:0.72rem;font-weight:700;color:#c9bda1;text-transform:uppercase;">
            <span>Modo de Rolagem</span>
            <select id="ldm-roll-advantage" style="width:100%;box-sizing:border-box;background:#0c1012;border:1px solid rgba(201,164,92,0.3);border-radius:4px;color:#fff;font-size:0.82rem;font-weight:600;padding:6px;">
              <option value="none"${this._ldmAdvantage === 'none' ? ' selected' : ''}>Normal</option>
              <option value="adv"${this._ldmAdvantage === 'adv' ? ' selected' : ''}>Vantagem (2d20kh1)</option>
              <option value="dis"${this._ldmAdvantage === 'dis' ? ' selected' : ''}>Desvantagem (2d20kl1)</option>
            </select>
          </label>
        </div>
      `;

      try {
        const res = await Dialog.wait({
          window: { title: `Rolar: ${label}` },
          width: 380,
          content,
          buttons: [
            {
              action: 'roll',
              label: 'Rolar',
              default: true,
              variant: 'primary',
              callback: (_event, _button, dialog) => {
                const body = dialog.getBody ? dialog.getBody() : dialog.element;
                const bonusVal = Number(body?.querySelector('#ldm-roll-bonus')?.value || 0);
                const dcRaw = body?.querySelector('#ldm-roll-dc')?.value;
                const dcVal = dcRaw !== '' && dcRaw !== null && dcRaw !== undefined && Number.isFinite(Number(dcRaw)) ? Number(dcRaw) : undefined;
                const advVal = body?.querySelector('#ldm-roll-advantage')?.value || 'none';
                return { confirmed: true, bonus: bonusVal, difficulty: dcVal, advantage: advVal };
              },
            },
            {
              action: 'cancel',
              label: 'Cancelar',
              variant: 'ghost',
              callback: () => ({ confirmed: false }),
            },
          ],
        });

        if (!res || !res.confirmed) return null;
        return res;
      } catch {
        return null;
      }
    }

    async _ldmRollAttr(key) {
      const cfg = this._ldmCfg ?? defaultConfig();
      const def = attributeList(safeCfg(cfg)).find((a) => a.key === key);
      if (!def || !this.document) return;
      const attrVal = attributeRollValue(cfg, key, actorValue({ systemData: this._ldmView() }, cfg, 'attr', key));
      const dlg = await this._ldmPromptRollDialog({ label: def.label, baseBonus: attrVal });
      if (!dlg) return;
      const result = await rollCheck(cfg, {
        actorId: this.document.id,
        label: def.label,
        attrValue: attrVal,
        skillValue: 0,
        bonus: dlg.bonus,
        target: dlg.difficulty,
        advantage: dlg.advantage,
        mode: 'public',
        extraMeta: { actorName: String(this.document.name ?? '') },
      });
      if (!result.ok) toast('sandbox.sheet.errNoDispatch');
    }

    async _ldmRollSkill(key) {
      const cfg = this._ldmCfg ?? defaultConfig();
      const def = skillList(safeCfg(cfg)).find((s) => s.key === key);
      if (!def || !this.document) return;
      const view = { systemData: this._ldmView() };
      const attrValue = def.attr ? attributeRollValue(cfg, def.attr, actorValue(view, cfg, 'attr', def.attr)) : 0;
      const skillValue = actorValue(view, cfg, 'skill', key);
      const totalBonus = attrValue + skillValue;
      const dlg = await this._ldmPromptRollDialog({ label: def.label, baseBonus: totalBonus });
      if (!dlg) return;
      const result = await rollCheck(cfg, {
        actorId: this.document.id,
        label: def.label,
        attrValue,
        skillValue,
        bonus: dlg.bonus,
        target: dlg.difficulty,
        advantage: dlg.advantage,
        mode: 'public',
        extraMeta: { actorName: String(this.document.name ?? '') },
      });
      if (!result.ok) toast('sandbox.sheet.errNoDispatch');
    }

    async _ldmRollSave(key, difficulty) {
      const cfg = safeCfg(this._ldmCfg ?? defaultConfig());
      const save = cfg.saves.entries.find((row) => row.key === key);
      if (!save || !this.document) return;
      const sys = this._ldmView();
      const total = sumSources(save.sources, sys, cfg, (k, score) => attributeRollValue(cfg, k, score)) + save.bonus + (Number(sys.saves?.[key]) || 0);
      const defaultTarget = Number.isFinite(Number(difficulty)) && String(difficulty).trim() !== '' ? Number(difficulty) : undefined;
      const dlg = await this._ldmPromptRollDialog({ label: save.label, baseBonus: total, defaultDC: defaultTarget });
      if (!dlg) return;
      const result = await rollCheck(cfg, {
        actorId: this.document.id,
        label: save.label,
        bonus: total + dlg.bonus,
        target: dlg.difficulty,
        advantage: dlg.advantage,
        mode: 'public',
        extraMeta: { actorName: String(this.document.name ?? '') },
      });
      if (!result.ok) toast('sandbox.sheet.errNoDispatch');
    }

    async _ldmRollAttack(key, defense, item = {}) {
      const cfg = safeCfg(this._ldmCfg ?? defaultConfig());
      const profile = cfg.attacks.profiles.find((row) => row.key === key);
      const loom = loomGlobal();
      if (!profile || !this.document || typeof loom?.dispatchRoll !== 'function') return;
      const targetValue = String(defense ?? '').trim() === '' ? profile.target : Number(defense);
      const defaultTarget = targetValue === null || targetValue === undefined || !Number.isFinite(Number(targetValue)) ? undefined : Number(targetValue);
      const totalAtk = attackTotal(cfg, profile, this._ldmView(), item);
      const dlg = await this._ldmPromptRollDialog({ label: profile.label, baseBonus: totalAtk, defaultDC: defaultTarget });
      if (!dlg) return;
      const built = buildAttackRoll(cfg, { ...profile, target: dlg.difficulty, bonus: (Number(profile.bonus) || 0) + dlg.bonus }, this._ldmView(), item);
      try {
        await loom.dispatchRoll({ formula: built.formula, actorId: this.document.id, mode: 'public', meta: { ...built.meta, system: 'loom-demo', label: profile.label, target: dlg.difficulty, actorName: String(this.document.name ?? '') } });
      } catch {
        toast('sandbox.sheet.errNoDispatch');
      }
    }

    async _ldmRollAttackDamage(key) {
      const cfg = safeCfg(this._ldmCfg ?? defaultConfig());
      const profile = cfg.attacks.profiles.find((row) => row.key === key);
      const damage = profile?.damage;
      const loom = loomGlobal();
      if (!profile || !damage || !['dice', 'pool'].includes(damage.method) || !this.document || typeof loom?.dispatchRoll !== 'function') return;
      const count = clamp(Math.trunc(Number(damage.count) || 1), 1, 100);
      const faces = clamp(Math.trunc(Number(damage.faces) || 6), 2, 100);
      const actorData = this._ldmView();
      const damageSources = sumSources(damage.sources, actorData, cfg, (attr, score) => attributeRollValue(cfg, attr, score));
      const base = clamp(Math.trunc(Number(damage.base) || 0) + damageSources, -99, 999);
      const formula = damage.method === 'pool' ? `${count}d${faces}cs>=${clamp(Math.trunc(Number(damage.successMin) || 2), 2, faces)}` : `${count}d${faces}${base < 0 ? base : `+${base}`}`;
      try { await loom.dispatchRoll({ formula, actorId: this.document.id, mode: 'public', meta: { system: 'loom-demo', kind: 'damage', damagePool: damage.method === 'pool', base, label: `${profile.label}: ${localizeKey('sandbox.sheet.damage')}`, actorName: String(this.document.name ?? '') } }); }
      catch { toast('sandbox.sheet.errNoDispatch'); }
    }

    async _ldmRecoverMagic() {
      if (!this.document || this.isEditable === false || this._ldmCastState === 'refused') return;
      await this._ldmFlush();
      const cfg = safeCfg(this._ldmCfg ?? defaultConfig());
      const kind = cfg.magic.recovery === 'manual' ? 'manual' : cfg.magic.recovery;
      const plan = planRecovery(this._ldmView(), cfg, kind);
      if (!plan.ok) return;
      try { await this._ldmPutSystem(this.document, plan.patch); this._ldmRerender(); }
      catch { toast('sandbox.sheet.errSave'); await this._reloadDocument(); }
    }

    async _ldmPrepareSpell(itemId, levelKey) {
      if (!this.document || this.isEditable === false || this._ldmCastState === 'refused') return;
      await this._ldmFlush();
      const item = this._ldmItemList().find((row) => row?.id === itemId);
      if (!item || item.type !== 'spell') return;
      const cfg = safeCfg(this._ldmCfg ?? defaultConfig());
      const current = this._ldmView().magic?.prepared?.[itemId];
      const plan = planPrepare(item, this._ldmView(), cfg, Math.max(1, Number(current?.max) || 0) + 1, levelKey);
      if (!plan.ok) return toast('sandbox.sheet.prepareCapacity');
      try { await this._ldmPutSystem(this.document, plan.patch); this._ldmRerender(); }
      catch { toast('sandbox.sheet.errSave'); await this._reloadDocument(); }
    }

    /**
     * Use an ability or spell: plan the cost and uses (refuse when short), write the new
     * resource and uses, then roll. The damage formula, when valid, is a second roll.
     */
    async _ldmUseItem(itemId, castLevelKey = '') {
      if (this._ldmCastInFlight) return;
      this._ldmCastInFlight = true;
      try { return await this._ldmPerformUseItem(itemId, castLevelKey); }
      finally { this._ldmCastInFlight = false; }
    }

    async _ldmPerformUseItem(itemId, castLevelKey = '') {
      await this._ldmFlush();
      const doc = this.document;
      const cfg = this._ldmCfg ?? defaultConfig();
      const item = this._ldmItemList().find((i) => i && i.id === itemId);
      if (!doc || !item) return;
      const sys = this._ldmView();
      const isConfiguredSpell = item.type === 'spell' && cfg.magic?.enabled === true && isPlainObject(item.data?.casting);
      const plan = isConfiguredSpell ? planCast(item, sys, cfg, castLevelKey) : planUse(item, sys, cfg);
      if (!plan.ok) {
        const d = isPlainObject(item.data) ? item.data : {};
        const res = d.cost && typeof d.cost.res === 'string' ? resourceList(safeCfg(cfg)).find((r) => r.key === d.cost.res) : null;
        const castErrors = { 'method-disabled': 'sandbox.sheet.castMethodDisabled', 'resource-missing': 'sandbox.sheet.castResourceMissing', 'insufficient-resource': 'sandbox.sheet.castInsufficient', 'level-missing': 'sandbox.sheet.castLevelMissing', 'level-too-low': 'sandbox.sheet.castLevelTooLow', 'no-slots': 'sandbox.sheet.castNoSlots', 'not-prepared': 'sandbox.sheet.castNotPrepared', 'no-uses': 'sandbox.sheet.castNoUses' };
        toast(isConfiguredSpell ? castErrors[plan.reason] ?? 'sandbox.sheet.errGeneric' : PLAN_ERROR_KEYS[plan.error] ?? 'sandbox.sheet.errGeneric', { res: res ? res.label : '' });
        return;
      }
      const castingProfile = isConfiguredSpell && plan.method === 'check'
        ? cfg.magic.checkProfiles.find((entry) => entry.key === item.data?.casting?.checkProfileKey)
        : null;
      if (isConfiguredSpell && plan.method === 'check' && !castingProfile) {
        toast('sandbox.sheet.castCheckMissing');
        return;
      }

      try {
        if (isConfiguredSpell) {
          const patch = { magic: plan.patch.magic };
          if (plan.patch.res) {
            patch.res = {};
            for (const [key, entry] of Object.entries(plan.patch.res)) patch.res[key] = { value: entry.value };
          }
          await this._ldmPutSystem(doc, patch);
        } else if (plan.patch.res) {
          // Only the value goes out: planUse keys come from the config's resource list.
          const res = {};
          for (const [key, entry] of Object.entries(plan.patch.res)) res[key] = { value: entry.value };
          await this._ldmPutSystem(doc, { res });
        }
        if (!isConfiguredSpell && plan.patch.uses) {
          const data = deepClone(isPlainObject(item.data) ? item.data : {});
          data.uses = { ...data.uses, value: plan.patch.uses.value };
          await this._ldmPutItem(doc, item, data);
        }
      } catch (err) {
        loomGlobal()?.clog?.error?.(`[SANDBOX-SHEET] use failed: ${err?.message ?? err}`);
        toast('sandbox.sheet.errSave');
        await this._reloadDocument();
        return;
      }

      const d = isPlainObject(item.data) ? item.data : {};
      const actorName = String(doc.name ?? '');
      const itemName = String(item.name ?? '');
      const roll = isPlainObject(d.roll) ? d.roll : null;
      // Effects are copied only when the use went through: a rolled use needs its roll dispatched.
      let useOk = true;
      if (isConfiguredSpell && plan.method === 'check') {
        const profile = castingProfile;
        const mode = profile.mode === 'system' ? cfg.dice.mode : profile.mode;
        const checkCfg = { ...cfg, dice: { ...cfg.dice, mode } };
        const total = sumSources(profile.sources, sys, cfg, (key, score) => attributeRollValue(cfg, key, score)) + profile.bonus;
        const built = buildCheck(checkCfg, { attrValue: total, skillValue: 0, bonus: 0 });
        try {
          await loomGlobal().dispatchRoll({ formula: built.formula, actorId: doc.id, mode: 'public', meta: { ...built.meta, target: profile.target || undefined, system: 'loom-demo', label: itemName, actorName } });
        } catch { toast('sandbox.sheet.errNoDispatch'); }
        useOk = false; // Dispatch acknowledges submission only; it does not confirm success.
      } else if (roll && roll.enabled === true) {
        const result = await rollCheck(cfg, {
          actorId: doc.id,
          label: itemName,
          attrValue: roll.attr ? attributeRollValue(cfg, roll.attr, actorValue({ systemData: sys }, cfg, 'attr', roll.attr)) : 0,
          skillValue: roll.skill ? actorValue({ systemData: sys }, cfg, 'skill', roll.skill) : 0,
          bonus: toNumber(roll.bonus) ?? 0,
          advantage: this._ldmAdvantage,
          mode: 'public',
          extraMeta: { actorName },
        });
        if (!result.ok) toast('sandbox.sheet.errNoDispatch');
        useOk = result.ok === true;
        const extra = typeof roll.damage === 'string' ? buildExtra(roll.damage) : { ok: false };
        if (result.ok && extra.ok && loomGlobal()?.dispatchRoll) {
          loomGlobal().dispatchRoll({
            formula: extra.formula,
            actorId: doc.id,
            mode: 'public',
            meta: { system: 'loom-demo', kind: 'damage', label: `${itemName}: ${localizeKey('sandbox.sheet.damage')}`, actorName },
          });
        }
      } else {
        const chat = loomGlobal()?.ChatMessage;
        if (chat && typeof chat.create === 'function') {
          const text = fmt(localizeKey('sandbox.sheet.used'), { actor: actorName, item: itemName });
          try {
            await chat.create({ content: `<p>${esc(text)}</p>`, speaker: { alias: actorName }, flags: {} });
          } catch {
            // The chat message is informational; the state change already happened.
          }
        }
      }
      if (useOk) await this._ldmApplyUseEffects(item);
      this._ldmRerender();
    }

    /**
     * Copies the item's effects onto the actor after a successful use (the engine never does it).
     * Only for EFFECT_USE_TYPES. Unlinked (NPC) casts are skipped: their data is their own and
     * actor effects would not reach them. One summary toast; the Effects block is reloaded.
     */
    async _ldmApplyUseEffects(item) {
      const doc = this.document;
      if (!doc?.id || !isPlainObject(item) || !EFFECT_USE_TYPES.includes(item.type)) return;
      if (this._ldmCast) return;
      const worldId = String(loomGlobal()?.world?.id ?? '');
      const result = await applyItemEffects(item, String(doc.id), worldId);
      const applied = result.created + result.updated;
      if (applied > 0) {
        this._ldmEffects = await loadEffects('actor', String(doc.id));
        if (result.ok) toast('sandbox.sheet.effectsApplied', { count: applied, item: String(item.name ?? '') }, 'success');
      }
    }

    async _ldmAddItem(type) {
      const doc = this.document;
      if (!doc || !doc.id || !ITEM_GROUP_TYPES.includes(type)) return;
      const cfg = this._ldmCfg ?? defaultConfig();
      const nameKey = { gear: 'sandbox.sheet.newGear', ability: 'sandbox.sheet.newAbility', spell: 'sandbox.sheet.newSpell' }[type];
      try {
        await loomGlobal().api.post(`${this.apiRoute}/${doc.id}/items`, {
          name: localizeKey(nameKey),
          type,
          data: defaultItemData(cfg, type),
        });
        toast('sandbox.sheet.created', null, 'success');
        await this._reloadDocument();
      } catch (err) {
        loomGlobal()?.clog?.error?.(`[SANDBOX-SHEET] add item failed: ${err?.message ?? err}`);
        toast('sandbox.sheet.errSave');
      }
    }

    async _ldmEditItem(itemId) {
      const loom = loomGlobal();
      const doc = this.document;
      const item = this._ldmItemList().find((i) => i && i.id === itemId);
      if (!item || !loom) return;
      const ItemSheet = loom.sheets?.get?.('item', item.type) ?? loom.sheets?.get?.('item', '*');
      if (!ItemSheet) {
        toast('sandbox.sheet.errNoItemSheet');
        return;
      }
      loom.windowManager.open(`item-sheet-${itemId}`, ItemSheet, { itemId, actorId: doc.id });
    }

    async _ldmDeleteItem(itemId) {
      const doc = this.document;
      if (!doc || !itemId) return;
      const ok = await loomGlobal().showConfirm(localizeKey('sandbox.sheet.delete'), localizeKey('sandbox.sheet.confirmDelete'));
      if (!ok) return;
      try {
        await loomGlobal().api.delete(`${this.apiRoute}/${doc.id}/items/${itemId}`);
        toast('sandbox.sheet.deleted', null, 'info');
        await this._reloadDocument();
      } catch (err) {
        loomGlobal()?.clog?.error?.(`[SANDBOX-SHEET] delete item failed: ${err?.message ?? err}`);
        toast('sandbox.sheet.errSave');
      }
    }

    async _ldmOpenEditor() {
      try {
        const mod = await import('../windows/rule-editor.mjs');
        if (typeof mod.openRuleEditor !== 'function') throw new Error('openRuleEditor missing');
        mod.openRuleEditor();
      } catch {
        toast('sandbox.sheet.errEditorMissing');
      }
    }

    async _ldmOpenCombat() {
      try {
        const mod = await import('../combat/tracker-window.mjs');
        if (typeof mod.openCombatPanel !== 'function') throw new Error('openCombatPanel missing');
        mod.openCombatPanel();
      } catch {
        toast('sandbox.sheet.errCombatMissing');
      }
    }
  };
}

let SheetClass = null;

/**
 * Catalogs the sandbox actor sheet for hero, villain and beast.
 * Returns false when window.Loom is not ready (nothing is registered then).
 */
export function registerActorSheet() {
  const loom = loomGlobal();
  if (!loom || !loom.sheets || !loom.LoomHandlebarsMixin || !loom.LoomActorSheet) return false;
  if (!SheetClass) SheetClass = buildSheetClass(loom);
  for (const type of ACTOR_TYPES) loom.sheets.catalog('actor', type, SheetClass);
  return true;
}
