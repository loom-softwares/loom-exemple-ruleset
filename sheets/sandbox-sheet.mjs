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
import {
  loadConfig,
  defaultConfig,
  validateConfig,
  defaultItemData,
  actorValue,
  abilityKindLabel,
  resourceList,
  categoryList,
  attributeList,
  skillList,
} from '../lib/config.mjs';
import { describe as describeDice, buildExtra, rollCheck } from '../lib/dice.mjs';

export const ACTOR_TYPES = Object.freeze(['hero', 'villain', 'beast']);

const ITEM_GROUP_TYPES = Object.freeze(['gear', 'ability', 'spell']);
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
  'sandbox.sheet.resources': 'Resources',
  'sandbox.sheet.decrease': 'Decrease',
  'sandbox.sheet.increase': 'Increase',
  'sandbox.sheet.resCount': '{value} / {max}',
  'sandbox.sheet.resValue': '{label} value',
  'sandbox.sheet.attributes': 'Attributes',
  'sandbox.sheet.rollNamed': 'Roll {label}',
  'sandbox.sheet.min': 'Min',
  'sandbox.sheet.max': 'Max',
  'sandbox.sheet.skills': 'Skills',
  'sandbox.sheet.basedOn': 'Based on {label}',
  'sandbox.sheet.skillsOther': 'No attribute',
  'sandbox.sheet.rank': 'Rank',
  'sandbox.sheet.modifier': 'Modifier',
  'sandbox.sheet.items': 'Items',
  'sandbox.sheet.addItem': 'Add {kind}',
  'sandbox.sheet.noItems': 'Nothing here yet.',
  'sandbox.sheet.uncategorized': 'Uncategorized',
  'sandbox.sheet.kindGear': 'Gear',
  'sandbox.sheet.kindAbility': 'Ability',
  'sandbox.sheet.kindSpell': 'Spell',
  'sandbox.sheet.quantity': 'Quantity',
  'sandbox.sheet.uses': 'Uses',
  'sandbox.sheet.use': 'Use',
  'sandbox.sheet.edit': 'Edit',
  'sandbox.sheet.delete': 'Delete',
  'sandbox.sheet.confirmDelete': 'Delete this item?',
  'sandbox.sheet.costLabel': 'Cost {amount} {res}',
  'sandbox.sheet.unnamed': 'Unnamed',
  'sandbox.sheet.notes': 'Notes',
  'sandbox.sheet.noActor': 'No actor is loaded.',
  'sandbox.sheet.newGear': 'New gear',
  'sandbox.sheet.newAbility': 'New ability',
  'sandbox.sheet.newSpell': 'New spell',
  'sandbox.sheet.created': 'Item created.',
  'sandbox.sheet.deleted': 'Item deleted.',
  'sandbox.sheet.used': '{actor} used {item}.',
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
});

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
    case 'attr':
      return { kind: 'attr', key, value };
    case 'skill':
      return { kind: 'skill', key, value };
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

function groupOfItem(type) {
  if (type === 'ability') return 'ability';
  if (type === 'spell') return 'spell';
  return 'gear';
}

function itemKindLabel(cfg, group) {
  if (group === 'gear') return null;
  return abilityKindLabel(cfg, group);
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
    min: a.min,
    max: a.max,
    name: safeName(`attr.${a.key}`),
  }));

  // Skills grouped by their attribute, in attribute order. Skills whose attribute is
  // empty or no longer exists go to a last group without a base value.
  const skillAll = skillList(c);
  const attrKeys = new Set(attributes.map((a) => a.key));
  const skillRow = (s, attrKey, base) => {
    const rank = actorValue(actorRef, c, 'skill', s.key);
    return {
      key: s.key,
      label: s.label,
      attr: attrKey,
      rank,
      max: s.max,
      modifier: base + rank,
      name: safeName(`skill.${s.key}`),
    };
  };
  const skillGroups = [];
  for (const a of attributes) {
    const rows = skillAll.filter((s) => s.attr === a.key).map((s) => skillRow(s, a.key, a.value));
    if (rows.length) skillGroups.push({ attrKey: a.key, label: a.label, base: a.value, skills: rows });
  }
  const orphan = skillAll.filter((s) => !attrKeys.has(s.attr)).map((s) => skillRow(s, '', 0));
  if (orphan.length) skillGroups.push({ attrKey: '', label: labels['sandbox.sheet.skillsOther'], base: 0, skills: orphan });

  const resources = resourceList(c)
    .map((r) => resourceState(sys, c, r.key))
    .filter(Boolean)
    .map((r) => ({
      ...r,
      pct: r.max > 0 ? clamp((r.value / r.max) * 100, 0, 100) : 0,
      name: safeName(`res.${r.key}`),
    }));

  // Items grouped by type (gear, ability, spell), then by category.
  const list = Array.isArray(items) ? items.filter(isPlainObject) : [];
  const categories = categoryList(c);
  const itemGroups = ITEM_GROUP_TYPES.map((group) => {
    const kind = group === 'gear'
      ? labels['sandbox.sheet.kindGear']
      : itemKindLabel(c, group);
    const byCategory = new Map();
    for (const item of list) {
      if (groupOfItem(item.type) !== group) continue;
      const d = isPlainObject(item.data) ? item.data : {};
      const catKey = typeof d.category === 'string' ? d.category : '';
      const row = itemRow(item, d, group, c, labels);
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
      addLabel: fmt(labels['sandbox.sheet.addItem'], { kind }),
      count,
      categories: ordered,
    };
  });

  const typeKey = hasActor && TYPE_LABEL_KEYS[actor.type] ? TYPE_LABEL_KEYS[actor.type] : 'sandbox.sheet.typeOther';

  return {
    empty: !hasActor,
    actorId: hasActor ? String(actor.id ?? '') : '',
    name: hasActor ? String(actor.name ?? '') : '',
    typeLabel: labels[typeKey],
    avatar: hasActor ? safeImageUrl(actor.avatarUrl) : '',
    systemName: c.name,
    dice: { mode: c.dice.mode, description: describeDice(c) },
    advantage: ADV_ORDER.includes(ui.advantage) ? ui.advantage : 'none',
    isGM: ui.isGM === true,
    editable: ui.editable !== false,
    configChanged: ui.configChanged === true,
    attributes,
    skillGroups,
    resources,
    itemGroups,
    notes: typeof sys.notes === 'string' ? sys.notes : '',
    labels,
  };
}

function itemRow(item, d, group, cfg, labels) {
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
  return {
    id,
    name,
    type: group,
    kindLabel: group === 'gear' ? labels['sandbox.sheet.kindGear'] : itemKindLabel(cfg, group),
    quantity: group === 'gear' ? (toNumber(d.quantity) ?? 1) : null,
    uses,
    canRoll,
    canUse: canRoll || costLabel !== '' || uses !== null,
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
  const portrait = c.avatar
    ? `<img class="ldm-sheet-portrait-img" src="${esc(c.avatar)}" alt="${esc(c.name)}" loading="lazy">`
    : `<div class="ldm-sheet-portrait-empty" aria-label="${L(c, 'sandbox.sheet.noPortrait')}">${L(c, 'sandbox.sheet.portrait')}</div>`;
  return `<header class="ldm-sheet-header">
    <div class="ldm-sheet-portrait">${portrait}</div>
    <div class="ldm-sheet-identity">
      <h2 class="ldm-sheet-name">${esc(c.name)}</h2>
      <p class="ldm-sheet-type">${esc(c.typeLabel)} <span class="ldm-sheet-system">· ${esc(c.systemName)}</span></p>
    </div>
  </header>`;
}

function renderToolbar(c) {
  const advKey = { none: 'sandbox.sheet.advNone', adv: 'sandbox.sheet.advAdv', dis: 'sandbox.sheet.advDis' }[c.advantage];
  const dis = c.editable ? '' : ' disabled';
  const gm = c.isGM
    ? `<button type="button" class="ldm-sheet-btn" data-action="configure">${L(c, 'sandbox.sheet.configure')}</button>`
    : '';
  return `<div class="ldm-sheet-toolbar">
    <button type="button" class="ldm-sheet-btn ldm-sheet-adv ldm-sheet-adv--${esc(c.advantage)}" data-action="toggle-adv">${L(c, 'sandbox.sheet.rollMode')}: ${L(c, advKey)}</button>
    <button type="button" class="ldm-sheet-btn" data-action="open-combat">${L(c, 'sandbox.sheet.combat')}</button>
    <button type="button" class="ldm-sheet-btn" data-action="reload-config">${L(c, 'sandbox.sheet.reloadConfig')}</button>
    ${gm}
    <p class="ldm-sheet-dice"><span class="ldm-sheet-dice-label">${L(c, 'sandbox.sheet.rollMode')}</span> ${esc(c.dice.description)}</p>
  </div>`;
}

function renderResources(c) {
  if (!c.resources.length) return '';
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
  return `<section class="ldm-sheet-section" aria-labelledby="ldm-sheet-h-res">
    <h3 id="ldm-sheet-h-res" class="ldm-sheet-h">${L(c, 'sandbox.sheet.resources')}</h3>
    <div class="ldm-sheet-res-list">${rows}</div>
  </section>`;
}

function renderAttributes(c) {
  if (!c.attributes.length) return '';
  const dis = c.editable ? '' : ' disabled';
  const cards = c.attributes.map((a) => `<div class="ldm-sheet-attr">
      <label class="ldm-sheet-attr-label" for="ldm-sheet-a-${esc(a.name)}">${esc(a.label)}</label>
      <input id="ldm-sheet-a-${esc(a.name)}" type="number" class="ldm-sheet-input" name="${esc(a.name)}" value="${esc(a.value)}" min="${esc(a.min)}" max="${esc(a.max)}" inputmode="numeric" data-field="attr" data-key="${esc(a.key)}"${dis}>
      <span class="ldm-sheet-range">${L(c, 'sandbox.sheet.min')} ${esc(a.min)} · ${L(c, 'sandbox.sheet.max')} ${esc(a.max)}</span>
      <button type="button" class="ldm-sheet-btn" data-action="attr-roll" data-key="${esc(a.key)}" aria-label="${L(c, 'sandbox.sheet.rollNamed', { label: a.label })}">${L(c, 'sandbox.sheet.rollNamed', { label: a.label })}</button>
    </div>`).join('');
  return `<section class="ldm-sheet-section" aria-labelledby="ldm-sheet-h-attr">
    <h3 id="ldm-sheet-h-attr" class="ldm-sheet-h">${L(c, 'sandbox.sheet.attributes')}</h3>
    <div class="ldm-sheet-attr-grid">${cards}</div>
  </section>`;
}

function renderSkills(c) {
  if (!c.skillGroups.length) return '';
  const dis = c.editable ? '' : ' disabled';
  const groups = c.skillGroups.map((g) => {
    const rows = g.skills.map((s) => {
      const mod = s.modifier >= 0 ? `+${s.modifier}` : `${s.modifier}`;
      return `<li class="ldm-sheet-skill">
        <span class="ldm-sheet-skill-label">${esc(s.label)}</span>
        <input type="number" class="ldm-sheet-input ldm-sheet-input--small" name="${esc(s.name)}" value="${esc(s.rank)}" min="0" max="${esc(s.max)}" inputmode="numeric" data-field="skill" data-key="${esc(s.key)}" aria-label="${L(c, 'sandbox.sheet.rank')}: ${esc(s.label)}"${dis}>
        <span class="ldm-sheet-skill-mod" title="${L(c, 'sandbox.sheet.modifier')}">${esc(mod)}</span>
        <button type="button" class="ldm-sheet-btn" data-action="skill-roll" data-key="${esc(s.key)}" aria-label="${L(c, 'sandbox.sheet.rollNamed', { label: s.label })}">${L(c, 'sandbox.sheet.rollNamed', { label: s.label })}</button>
      </li>`;
    }).join('');
    const basedOn = g.attrKey ? L(c, 'sandbox.sheet.basedOn', { label: g.label }) : esc(g.label);
    return `<div class="ldm-sheet-skill-group">
      <h4 class="ldm-sheet-subh">${basedOn}</h4>
      <ul class="ldm-sheet-skill-list">${rows}</ul>
    </div>`;
  }).join('');
  return `<section class="ldm-sheet-section" aria-labelledby="ldm-sheet-h-skill">
    <h3 id="ldm-sheet-h-skill" class="ldm-sheet-h">${L(c, 'sandbox.sheet.skills')}</h3>
    ${groups}
  </section>`;
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
  const use = it.canUse
    ? `<button type="button" class="ldm-sheet-btn" data-action="use-item" data-id="${id}"${dis}>${L(c, 'sandbox.sheet.use')}</button>`
    : '';
  const desc = it.description ? `<p class="ldm-sheet-item-desc">${esc(it.description)}</p>` : '';
  return `<li class="ldm-sheet-item" data-id="${id}">
    <div class="ldm-sheet-item-main">
      <span class="ldm-sheet-item-name">${esc(it.name)}</span>
      ${meta ? `<span class="ldm-sheet-item-meta">${meta}</span>` : ''}
      ${desc}
    </div>
    <div class="ldm-sheet-item-controls">
      ${qty}${uses}${use}
      <button type="button" class="ldm-sheet-btn" data-action="edit-item" data-id="${id}">${L(c, 'sandbox.sheet.edit')}</button>
      <button type="button" class="ldm-sheet-btn ldm-sheet-btn--danger" data-action="delete-item" data-id="${id}"${dis}>${L(c, 'sandbox.sheet.delete')}</button>
    </div>
  </li>`;
}

function renderItems(c) {
  const dis = c.editable ? '' : ' disabled';
  const groups = c.itemGroups.map((g) => {
    const cats = g.categories.map((cat) => `<div class="ldm-sheet-cat">
        <h5 class="ldm-sheet-cat-h">${esc(cat.label)}</h5>
        <ul class="ldm-sheet-item-list">${cat.items.map((it) => renderItemRow(c, it)).join('')}</ul>
      </div>`).join('');
    const empty = g.count === 0 ? `<p class="ldm-sheet-empty">${L(c, 'sandbox.sheet.noItems')}</p>` : '';
    return `<div class="ldm-sheet-item-group" data-type="${esc(g.type)}">
      <div class="ldm-sheet-item-group-head">
        <h4 class="ldm-sheet-subh">${esc(g.kind)}</h4>
        <button type="button" class="ldm-sheet-btn" data-action="add-item" data-type="${esc(g.type)}"${dis}>${esc(g.addLabel)}</button>
      </div>
      ${cats}${empty}
    </div>`;
  }).join('');
  return `<section class="ldm-sheet-section" aria-labelledby="ldm-sheet-h-items">
    <h3 id="ldm-sheet-h-items" class="ldm-sheet-h">${L(c, 'sandbox.sheet.items')}</h3>
    ${groups}
  </section>`;
}

function renderNotes(c) {
  const dis = c.editable ? '' : ' disabled';
  return `<section class="ldm-sheet-section" aria-labelledby="ldm-sheet-h-notes">
    <h3 id="ldm-sheet-h-notes" class="ldm-sheet-h">${L(c, 'sandbox.sheet.notes')}</h3>
    <textarea class="ldm-sheet-notes" name="notes" rows="4" maxlength="${NOTES_MAX}" data-field="notes" aria-label="${L(c, 'sandbox.sheet.notes')}"${dis}>${esc(c.notes)}</textarea>
  </section>`;
}

/** Renders the whole sheet body from a context built by buildSheetContext. Pure. */
export function renderSheet(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : { empty: true, labels: {} };
  if (c.empty) {
    return `<div class="ldm-sheet ldm-sheet--empty"><p class="ldm-sheet-empty">${L(c, 'sandbox.sheet.noActor')}</p></div>`;
  }
  return `<div class="ldm-sheet${c.editable ? '' : ' ldm-sheet--readonly'}">
    ${renderHeader(c)}
    ${renderToolbar(c)}
    ${c.configChanged ? `<p class="ldm-sheet-hint" role="status">${L(c, 'sandbox.sheet.configChanged')}</p>` : ''}
    <div class="ldm-sheet-body">
      ${renderResources(c)}
      ${renderAttributes(c)}
      ${renderSkills(c)}
      ${renderItems(c)}
      ${renderNotes(c)}
    </div>
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
 * Builds the sheet class against window.Loom. Called once, from registerActorSheet().
 * The mixin and base class come from window.Loom at call time (not at import time).
 */
function buildSheetClass(loom) {
  const Base = loom.LoomHandlebarsMixin(loom.LoomActorSheet);

  return class SandboxSheet extends Base {
    // `compile()` below renders the body from the pure renderer, so no PARTS templates.
    static DEFAULT_OPTIONS = { position: { width: 680, height: 800 } };
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

    constructor(props) {
      super({ ...props, classes: [...(props?.classes ?? []), 'ldm-sheet-window'] });
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
      this._ldmWireInput();
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
      if (String(change.kind).startsWith('item-')) {
        const idx = this._ldmItemQueue.findIndex((p) => p.key === key);
        if (idx >= 0) this._ldmItemQueue[idx].change = change;
        else this._ldmItemQueue.push({ key, change });
      } else {
        const built = buildPatch(this._ldmView(), this._ldmCfg ?? defaultConfig(), change);
        if (built) this._ldmPatch = mergePatch(this._ldmPatch, built.systemData);
      }
      clearTimeout(this._ldmTimer);
      this._ldmTimer = null;
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
      try {
        while (!isEmptyPatch(this._ldmPatch) || this._ldmItemQueue.length > 0) {
          const sysPatch = this._ldmPatch;
          this._ldmPatch = {};
          const itemChanges = this._ldmItemQueue.splice(0).map((p) => p.change);
          this._ldmInFlight = isEmptyPatch(sysPatch) ? null : sysPatch;
          try {
            await this._ldmWrite(sysPatch, itemChanges);
          } finally {
            this._ldmInFlight = null;
          }
        }
      } finally {
        this._ldmFlushing = false;
      }
    }

    /**
     * Writes one batch: ONE PUT of the minimal systemData patch (to the actor, or to the
     * unlinked cast, see resolveWriteTarget), then one PUT per changed item.
     */
    async _ldmWrite(sysPatch, itemChanges) {
      const doc = this.document;
      if (!doc || !doc.id) return;
      if (this._ldmCastState === 'refused') {
        toast('sandbox.sheet.errCastRefused');
        await this._reloadDocument();
        return;
      }
      const cfg = this._ldmCfg ?? defaultConfig();
      try {
        if (!isEmptyPatch(sysPatch)) await this._ldmPutSystem(doc, sysPatch);
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
        loomGlobal()?.clog?.error?.(`[SANDBOX-SHEET] write failed: ${err?.message ?? err}`);
        toast('sandbox.sheet.errSave');
        await this._reloadDocument();
        return;
      }
      this.rerenderBody();
    }

    /**
     * Sends ONE minimal patch: `{ systemData: patch }`. The server deep-merges it into the stored
     * base data, so untouched keys (and a stored resource max) are never rewritten. The route is
     * the actor, or the unlinked cast when a cast context is loaded (CLAUDE.md rule 6).
     */
    async _ldmPutSystem(doc, patch) {
      const cast = this._ldmCast;
      const url = cast ? `/cast/${cast.id}` : `${this.apiRoute}/${doc.id}`;
      const res = await loomGlobal().api.put(url, { systemData: patch });
      // The response (actor: effect-applied; cast: raw) is the server's view after the merge.
      const next = isPlainObject(res?.systemData) ? res.systemData : mergePatch(this._ldmSysData(), patch);
      if (cast) cast.systemData = next;
      else doc.systemData = next;
    }

    async _ldmPutItem(doc, item, data) {
      await loomGlobal().api.put(`${this.apiRoute}/${doc.id}/items/${item.id}`, { data });
      item.data = data;
    }

    _ldmContext() {
      const loom = loomGlobal();
      const doc = this.document;
      const actor = doc
        ? { id: doc.id, name: doc.name, type: doc.type, avatarUrl: doc.avatarUrl, systemData: this._ldmView() }
        : null;
      return buildSheetContext(actor, this._ldmItemList(), this._ldmCfg ?? defaultConfig(), {
        isGM: loom?.user?.isGM === true,
        editable: this.isEditable !== false && this._ldmCastState !== 'refused',
        advantage: this._ldmAdvantage,
        configChanged: this._ldmConfigChanged,
        t: localizeKey,
      });
    }

    /** Renders the body into compiledHtml (the mixin injects it on mount and on every re-render). */
    async compile() {
      this.compiledHtml = renderSheet(this._ldmContext());
    }

    async onAction(action, id, target) {
      const ds = target?.dataset ?? {};
      const itemId = ds.id || id || '';
      switch (action) {
        case 'attr-roll': return this._ldmRollAttr(ds.key);
        case 'skill-roll': return this._ldmRollSkill(ds.key);
        case 'toggle-adv': {
          const i = ADV_ORDER.indexOf(this._ldmAdvantage);
          this._ldmAdvantage = ADV_ORDER[(i + 1) % ADV_ORDER.length];
          this.rerenderBody();
          return undefined;
        }
        case 'res-delta': {
          const delta = toNumber(ds.delta);
          if (delta === null || !ds.key) return undefined;
          return this._ldmQueue({ kind: 'res', key: ds.key, delta }, `imm:${++this._ldmSeq}`, false);
        }
        case 'add-item': return this._ldmAddItem(ds.type);
        case 'use-item': return this._ldmUseItem(itemId);
        case 'edit-item': return this._ldmEditItem(itemId);
        case 'delete-item': return this._ldmDeleteItem(itemId);
        case 'configure': return this._ldmOpenEditor();
        case 'open-combat': return this._ldmOpenCombat();
        case 'reload-config': return this._ldmReloadConfig();
        default: return undefined;
      }
    }

    async _ldmReloadConfig() {
      const next = await loadConfig({ fresh: true });
      const sig = JSON.stringify(next);
      this._ldmConfigChanged = this._ldmCfgSig !== '' && sig !== this._ldmCfgSig;
      this._ldmCfg = next;
      this._ldmCfgSig = sig;
      this.rerenderBody();
    }

    async _ldmRollAttr(key) {
      const cfg = this._ldmCfg ?? defaultConfig();
      const def = attributeList(safeCfg(cfg)).find((a) => a.key === key);
      if (!def || !this.document) return;
      const result = await rollCheck(cfg, {
        actorId: this.document.id,
        label: def.label,
        attrValue: actorValue({ systemData: this._ldmView() }, cfg, 'attr', key),
        skillValue: 0,
        bonus: 0,
        advantage: this._ldmAdvantage,
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
      const attrValue = def.attr ? actorValue(view, cfg, 'attr', def.attr) : 0;
      const result = await rollCheck(cfg, {
        actorId: this.document.id,
        label: def.label,
        attrValue,
        skillValue: actorValue(view, cfg, 'skill', key),
        bonus: 0,
        advantage: this._ldmAdvantage,
        mode: 'public',
        extraMeta: { actorName: String(this.document.name ?? '') },
      });
      if (!result.ok) toast('sandbox.sheet.errNoDispatch');
    }

    /**
     * Use an ability or spell: plan the cost and uses (refuse when short), write the new
     * resource and uses, then roll. The damage formula, when valid, is a second roll.
     */
    async _ldmUseItem(itemId) {
      await this._ldmFlush();
      const doc = this.document;
      const cfg = this._ldmCfg ?? defaultConfig();
      const item = this._ldmItemList().find((i) => i && i.id === itemId);
      if (!doc || !item) return;
      const sys = this._ldmView();
      const plan = planUse(item, sys, cfg);
      if (!plan.ok) {
        const d = isPlainObject(item.data) ? item.data : {};
        const res = d.cost && typeof d.cost.res === 'string' ? resourceList(safeCfg(cfg)).find((r) => r.key === d.cost.res) : null;
        toast(PLAN_ERROR_KEYS[plan.error] ?? 'sandbox.sheet.errGeneric', { res: res ? res.label : '' });
        return;
      }

      try {
        if (plan.patch.res) {
          // Only the value goes out: planUse keys come from the config's resource list.
          const res = {};
          for (const [key, entry] of Object.entries(plan.patch.res)) res[key] = { value: entry.value };
          await this._ldmPutSystem(doc, { res });
        }
        if (plan.patch.uses) {
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
      if (roll && roll.enabled === true) {
        const result = await rollCheck(cfg, {
          actorId: doc.id,
          label: itemName,
          attrValue: roll.attr ? actorValue({ systemData: sys }, cfg, 'attr', roll.attr) : 0,
          skillValue: roll.skill ? actorValue({ systemData: sys }, cfg, 'skill', roll.skill) : 0,
          bonus: toNumber(roll.bonus) ?? 0,
          advantage: this._ldmAdvantage,
          mode: 'public',
          extraMeta: { actorName },
        });
        if (!result.ok) toast('sandbox.sheet.errNoDispatch');
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
      this.rerenderBody();
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
