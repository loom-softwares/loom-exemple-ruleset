// World configuration of the sandbox system: defaults, presets, validation, migration,
// JSON import/export, and the world setting that stores it.
//
// Only registerConfigSetting, loadConfig and saveConfig touch the engine, and they reach it
// through globalThis.Loom with every access guarded, so this module imports cleanly in plain
// Node (tests) and never reads window/document.

import { clamp, deepClone, isPlainObject, slug } from './helpers.mjs';
import { sanitizeSources } from './check-sources.mjs';

// Store the rules in the active system namespace. The Loom core configuration panel now
// hides config:false backing settings and renders registered system menus in this category.
export const CONFIG_MODULE = 'loom-demo-system';
export const LEGACY_CONFIG_MODULES = Object.freeze(['Loom Demo System - Editor', 'Loom Demo System']);
export const CONFIG_KEY = 'ruleConfig';
export const CONFIG_VERSION = 2;

/** Blocks an actor-sheet tab can show, in canonical order. */
export const LAYOUT_BLOCKS = Object.freeze([
  'resources',
  'attributes',
  'skills',
  'saves',
  'attacks',
  'magic',
  'items:gear',
  'items:ability',
  'items:spell',
  'items:other',
  'notes',
  'effects',
]);
export const OPTIONAL_LAYOUT_BLOCKS = Object.freeze(['saves', 'attacks', 'magic']);

/** Blocks an item-sheet tab can show, in canonical order. */
export const ITEM_LAYOUT_BLOCKS = Object.freeze(['details', 'uses', 'roll', 'cost', 'description', 'effects']);

export const LAYOUT_LIMITS = Object.freeze({
  maxTabs: 8,
  maxBlocksPerTab: 12,
  minColumns: 1,
  maxColumns: 4,
  defaultColumns: 2,
  label: 40,
});

export const DOT_STYLES = Object.freeze(['round', 'square', 'diamond']);
export const LAYOUT_DENSITIES = Object.freeze(['comfortable', 'compact']);
export const LAYOUT_SKILL_GROUPINGS = Object.freeze(['attribute', 'group', 'none']);

export const LIMITS = Object.freeze({
  name: 60,
  label: 40,
  attributes: 12,
  skills: 40,
  resources: 8,
  itemCategories: 24,
  abilityKinds: 8,
  attrBound: 999,
  skillMax: 100,
  resourceMax: 999,
  bonusBound: 99,
  diceSides: 100,
  maxDice: 50,
  targetLabel: 12,
  cardLabel: 24,
  headerMax: 80,
  headerScan: 1000,
  importChars: 200000,
  group: 40,
});

const KEY_RE = /^[a-z][a-z0-9_]{0,23}$/;
const HEX_RE = /^#[0-9a-f]{6}$/i;
const HEADER_TOKENS = new Set(['actor', 'label', 'result']);
const DEFAULT_ACCENT = '#7c5cff';
const DEFAULT_COLOR = '#888888';
const SCAN_CAP = 200;
const ERROR_CAP = 100;

// ---------------------------------------------------------------------------
// Default config and presets
// ---------------------------------------------------------------------------

/** A small, generic preset. Returns a fresh object on every call. */
export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    name: 'My System',
    attributeDisplay: 'number',
    skillDisplay: 'number',
    dotStyle: 'round',
    dotGroup: 5,
    dice: {
      mode: 'd20',
      d20: { sides: 20, critMin: 20, fumbleMax: 1, targetLabel: 'DC' },
      pool: { faces: 6, successMin: 5, maxDice: 20, glitchOnOnes: false },
    },
    attributes: [
      { key: 'might', label: 'Might', min: 0, max: 10, default: 2, useD20Modifier: false, group: '' },
      { key: 'grace', label: 'Grace', min: 0, max: 10, default: 2, useD20Modifier: false, group: '' },
      { key: 'wits', label: 'Wits', min: 0, max: 10, default: 2, useD20Modifier: false, group: '' },
    ],
    skills: [
      { key: 'melee', label: 'Melee', attr: 'might', max: 10, default: 0, group: '' },
      { key: 'ranged', label: 'Ranged', attr: 'grace', max: 10, default: 0, group: '' },
      { key: 'stealth', label: 'Stealth', attr: 'grace', max: 10, default: 0, group: '' },
      { key: 'lore', label: 'Lore', attr: 'wits', max: 10, default: 0, group: '' },
    ],
    saves: { enabled: false, entries: [] },
    attacks: { enabled: true, profiles: [{ key: 'basic', label: 'Basic attack', sources: [], bonus: 0, mode: 'system', faces: 10, successMin: 5, target: null, damage: { method: 'none', base: 0, sources: [], faces: 6, count: 1, successMin: 5, critPairs: false, critFace: 10 } }] },
    magic: { enabled: true, defaultMethod: 'resource', methods: ['free', 'resource', 'spontaneous', 'prepared', 'uses', 'check'], levels: [], checkProfiles: [], recovery: 'manual' },
    resources: [
      { key: 'hp', label: 'Health', max: 20, color: '#a33a2f', showInCombat: true },
      { key: 'mp', label: 'Mana', max: 10, color: '#3f7f8a', showInCombat: true },
    ],
    itemCategories: [
      { key: 'weapon', label: 'Weapon' },
      { key: 'armor', label: 'Armor' },
      { key: 'consumable', label: 'Consumable' },
      { key: 'misc', label: 'Misc' },
    ],
    abilityKinds: { ability: 'Ability', spell: 'Spell' },
    card: {
      style: 'detailed',
      showFormula: true,
      showDice: true,
      accent: DEFAULT_ACCENT,
      header: '{actor}: {label}',
      successLabel: 'successes',
      critLabel: 'Critical',
      fumbleLabel: 'Fumble',
    },
    combat: { initiative: { mode: 'attribute', attr: 'grace', bonus: 0 } },
    layout: defaultLayout(),
  };
}

function d20Classic() {
  return {
    version: CONFIG_VERSION,
    name: 'Classic d20',
    attributeDisplay: 'number',
    skillDisplay: 'number',
    dotStyle: 'round',
    dotGroup: 5,
    dice: {
      mode: 'd20',
      d20: { sides: 20, critMin: 20, fumbleMax: 1, targetLabel: 'DC' },
      pool: { faces: 6, successMin: 5, maxDice: 20, glitchOnOnes: false },
    },
    attributes: [
      { key: 'strength', label: 'Strength', min: 1, max: 20, default: 10, useD20Modifier: true, group: '' },
      { key: 'agility', label: 'Agility', min: 1, max: 20, default: 10, useD20Modifier: true, group: '' },
      { key: 'intellect', label: 'Intellect', min: 1, max: 20, default: 10, useD20Modifier: true, group: '' },
    ],
    skills: [
      { key: 'athletics', label: 'Athletics', attr: 'strength', max: 10, default: 0, group: '' },
      { key: 'acrobatics', label: 'Acrobatics', attr: 'agility', max: 10, default: 0, group: '' },
      { key: 'arcana', label: 'Arcana', attr: 'intellect', max: 10, default: 0, group: '' },
      { key: 'perception', label: 'Perception', attr: 'intellect', max: 10, default: 0, group: '' },
    ],
    saves: { enabled: false, entries: [] },
    attacks: { enabled: false, profiles: [] },
    magic: { enabled: false, defaultMethod: 'resource', methods: ['free', 'resource', 'spontaneous', 'prepared', 'uses', 'check'], levels: [], recovery: 'manual', checkProfiles: [] },
    resources: [
      { key: 'hp', label: 'Hit Points', max: 30, color: '#b03a2e', showInCombat: true },
    ],
    itemCategories: [
      { key: 'weapon', label: 'Weapon' },
      { key: 'armor', label: 'Armor' },
      { key: 'gear', label: 'Gear' },
    ],
    abilityKinds: { ability: 'Feature', spell: 'Spell' },
    card: {
      style: 'detailed',
      showFormula: true,
      showDice: true,
      accent: '#4a90d9',
      header: '{actor} rolls {label}',
      successLabel: 'successes',
      critLabel: 'Critical',
      fumbleLabel: 'Fumble',
    },
    combat: { initiative: { mode: 'attribute', attr: 'agility', bonus: 0 } },
    layout: defaultLayout(),
  };
}

function d6Pool() {
  return {
    version: CONFIG_VERSION,
    name: 'Dice Pool d6',
    attributeDisplay: 'number',
    skillDisplay: 'number',
    dotStyle: 'round',
    dotGroup: 5,
    dice: {
      mode: 'pool',
      d20: { sides: 20, critMin: 20, fumbleMax: 1, targetLabel: 'DC' },
      pool: { faces: 6, successMin: 5, maxDice: 12, glitchOnOnes: true },
    },
    attributes: [
      { key: 'body', label: 'Body', min: 1, max: 6, default: 2, useD20Modifier: false, group: '' },
      { key: 'mind', label: 'Mind', min: 1, max: 6, default: 2, useD20Modifier: false, group: '' },
      { key: 'spirit', label: 'Spirit', min: 1, max: 6, default: 2, useD20Modifier: false, group: '' },
    ],
    skills: [
      { key: 'brawl', label: 'Brawl', attr: 'body', max: 6, default: 0, group: '' },
      { key: 'focus', label: 'Focus', attr: 'mind', max: 6, default: 0, group: '' },
      { key: 'insight', label: 'Insight', attr: 'spirit', max: 6, default: 0, group: '' },
    ],
    saves: { enabled: false, entries: [] },
    attacks: { enabled: false, profiles: [] },
    magic: { enabled: false, defaultMethod: 'resource', methods: ['free', 'resource', 'spontaneous', 'prepared', 'uses', 'check'], levels: [], recovery: 'manual', checkProfiles: [] },
    resources: [
      { key: 'vigor', label: 'Vigor', max: 8, color: '#27ae60', showInCombat: true },
      { key: 'grit', label: 'Grit', max: 4, color: '#d4ac0d', showInCombat: false },
    ],
    itemCategories: [
      { key: 'tool', label: 'Tool' },
      { key: 'weapon', label: 'Weapon' },
      { key: 'supply', label: 'Supply' },
    ],
    abilityKinds: { trick: 'Trick', technique: 'Technique' },
    card: {
      style: 'compact',
      showFormula: true,
      showDice: true,
      accent: '#e67e22',
      header: '{actor}: {label}',
      successLabel: 'successes',
      critLabel: 'Exceptional',
      fumbleLabel: 'Glitch',
    },
    combat: { initiative: { mode: 'roll', attr: '', bonus: 0 } },
    layout: defaultLayout(),
  };
}

/** Named presets. Each factory returns a fresh, valid v1 config. */
export const PRESETS = Object.freeze({
  d20Classic,
  d6Pool,
});

// ---------------------------------------------------------------------------
// Field helpers used by validation
// ---------------------------------------------------------------------------

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  return obj;
}

function cleanText(text) {
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}

function numberOf(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

function section(parent, name, path, errors) {
  const value = parent[name];
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object; defaults used`);
    return {};
  }
  return value;
}

function enumOf(value, allowed, fallback, path, errors) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string' && allowed.includes(value)) return value;
  errors.push(`${path} must be one of ${allowed.join(', ')}; using ${fallback}`);
  return fallback;
}

function intOf(value, min, max, fallback, path, errors) {
  const safeFallback = clamp(fallback, min, max);
  if (value === undefined || value === null) return safeFallback;
  const n = numberOf(value);
  if (!Number.isFinite(n)) {
    errors.push(`${path} must be a number; using ${safeFallback}`);
    return safeFallback;
  }
  const rounded = Math.round(n);
  const result = clamp(rounded, min, max);
  if (result !== rounded) errors.push(`${path} is outside ${min}..${max}; using ${result}`);
  return result;
}

function boolOf(value, fallback, path, errors) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  errors.push(`${path} must be true or false; using ${fallback}`);
  return fallback;
}

function hexOf(value, fallback, path, errors) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string' && HEX_RE.test(value)) return value.toLowerCase();
  errors.push(`${path} must be a #rrggbb colour; using ${fallback}`);
  return fallback;
}

function labelOf(value, fallback, max, path, errors) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') {
    errors.push(`${path} must be text; using "${fallback}"`);
    return fallback;
  }
  const text = cleanText(value);
  if (!text) {
    errors.push(`${path} is empty; using "${fallback}"`);
    return fallback;
  }
  if (text.length <= max) return text;
  errors.push(`${path} is longer than ${max} characters; cut`);
  return text.slice(0, max).trim();
}

function keyOf(value, path, errors) {
  if (typeof value === 'string' && KEY_RE.test(value)) return value;
  const fixed = typeof value === 'string' ? slug(value) : '';
  if (fixed) {
    errors.push(`${path} key "${value.slice(0, 40)}" changed to "${fixed}"`);
    return fixed;
  }
  errors.push(`${path} has no usable key; dropped`);
  return null;
}

/** Reads at most SCAN_CAP entries of a list, keeping only plain objects up to `max`. */
function entries(list, path, max, errors) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) {
    errors.push(`${path} must be a list; ignored`);
    return [];
  }
  if (list.length > SCAN_CAP) errors.push(`${path}: only the first ${SCAN_CAP} entries are read`);
  const out = [];
  const scan = Math.min(list.length, SCAN_CAP);
  for (let i = 0; i < scan; i++) {
    const item = list[i];
    if (!isPlainObject(item)) {
      errors.push(`${path}[${i}] must be an object; dropped`);
      continue;
    }
    if (out.length === max) {
      errors.push(`${path} allows at most ${max} entries; the rest are dropped`);
      break;
    }
    out.push({ index: i, item });
  }
  return out;
}

/** Shared list logic: keyed entries, duplicates dropped, each built by `build`. */
function keyedList(list, path, max, errors, build) {
  const out = [];
  const seen = new Set();
  for (const { index, item } of entries(list, path, max, errors)) {
    const itemPath = `${path}[${index}]`;
    const key = keyOf(item.key, itemPath, errors);
    if (key === null) continue;
    if (seen.has(key)) {
      errors.push(`${itemPath}: duplicate key "${key}" dropped`);
      continue;
    }
    seen.add(key);
    out.push(build(item, key, itemPath));
  }
  return out;
}

function headerOf(value, errors) {
  const fallback = '{actor}: {label}';
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') {
    errors.push('card.header must be text; using the default');
    return fallback;
  }
  if (value.length > LIMITS.headerScan) {
    errors.push(`card.header is longer than ${LIMITS.headerScan} characters; the rest is ignored`);
  }
  let text = cleanText(value.slice(0, LIMITS.headerScan)).replace(/\{([^{}]*)\}/g, (match, name) => {
    if (HEADER_TOKENS.has(name)) return match;
    errors.push('card.header: unknown token removed');
    return '';
  });
  text = text.replace(/ {2,}/g, ' ').trim();
  if (text.length > LIMITS.headerMax) {
    errors.push(`card.header is longer than ${LIMITS.headerMax} characters; cut`);
    text = text.slice(0, LIMITS.headerMax).trim();
  }
  if (!text) {
    errors.push('card.header is empty; using the default');
    return fallback;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Sanitizer: every branch returns a valid value and reports what it changed
// ---------------------------------------------------------------------------

function sanitizeDice(input, errors) {
  const dice = section(input, 'dice', 'dice', errors);
  const mode = enumOf(dice.mode, ['d20', 'pool'], 'd20', 'dice.mode', errors);

  const d20In = section(dice, 'd20', 'dice.d20', errors);
  const sides = intOf(d20In.sides, 2, LIMITS.diceSides, 20, 'dice.d20.sides', errors);

  const poolIn = section(dice, 'pool', 'dice.pool', errors);
  const faces = intOf(poolIn.faces, 2, LIMITS.diceSides, 6, 'dice.pool.faces', errors);

  return {
    mode,
    d20: {
      sides,
      critMin: intOf(d20In.critMin, 1, sides, sides, 'dice.d20.critMin', errors),
      fumbleMax: intOf(d20In.fumbleMax, 0, sides, 1, 'dice.d20.fumbleMax', errors),
      targetLabel: labelOf(d20In.targetLabel, 'DC', LIMITS.targetLabel, 'dice.d20.targetLabel', errors),
    },
    pool: {
      faces,
      successMin: intOf(poolIn.successMin, 2, faces, Math.min(5, faces), 'dice.pool.successMin', errors),
      maxDice: intOf(poolIn.maxDice, 1, LIMITS.maxDice, 20, 'dice.pool.maxDice', errors),
      glitchOnOnes: boolOf(poolIn.glitchOnOnes, false, 'dice.pool.glitchOnOnes', errors),
    },
  };
}

function sanitizeAttributes(list, errors) {
  return keyedList(list, 'attributes', LIMITS.attributes, errors, (item, key, path) => {
    let min = intOf(item.min, -LIMITS.attrBound, LIMITS.attrBound, 0, `${path}.min`, errors);
    let max = intOf(item.max, -LIMITS.attrBound, LIMITS.attrBound, 10, `${path}.max`, errors);
    if (min > max) {
      errors.push(`${path}: min is above max; swapped`);
      [min, max] = [max, min];
    }
  return {
      key,
      label: labelOf(item.label, key, LIMITS.label, `${path}.label`, errors),
      min,
      max,
      useD20Modifier: boolOf(item.useD20Modifier, false, `${path}.useD20Modifier`, errors),
      group: optionalTextOf(item.group, LIMITS.group, `${path}.group`, errors),
      default: intOf(item.default, min, max, 0, `${path}.default`, errors),
    };
  });
}

function sanitizeSkills(list, attrKeys, errors) {
  return keyedList(list, 'skills', LIMITS.skills, errors, (item, key, path) => {
    let attr = '';
    if (item.attr !== undefined && item.attr !== null && item.attr !== '') {
      if (typeof item.attr === 'string' && attrKeys.has(item.attr)) attr = item.attr;
      else errors.push(`${path}.attr does not name an attribute; cleared`);
    }
    const max = intOf(item.max, 0, LIMITS.skillMax, 10, `${path}.max`, errors);
    return {
      key,
      label: labelOf(item.label, key, LIMITS.label, `${path}.label`, errors),
      attr,
      max,
      group: optionalTextOf(item.group, LIMITS.group, `${path}.group`, errors),
      default: intOf(item.default, 0, max, 0, `${path}.default`, errors),
    };
  });
}

function sanitizeResources(list, errors) {
  return keyedList(list, 'resources', LIMITS.resources, errors, (item, key, path) => ({
    key,
    label: labelOf(item.label, key, LIMITS.label, `${path}.label`, errors),
    max: intOf(item.max, 1, LIMITS.resourceMax, 10, `${path}.max`, errors),
    color: hexOf(item.color, DEFAULT_COLOR, `${path}.color`, errors),
    showInCombat: boolOf(item.showInCombat, true, `${path}.showInCombat`, errors),
  }));
}

function sanitizeCategories(list, errors) {
  return keyedList(list, 'itemCategories', LIMITS.itemCategories, errors, (item, key, path) => ({
    key,
    label: labelOf(item.label, key, LIMITS.label, `${path}.label`, errors),
  }));
}

function sanitizeAbilityKinds(value, errors) {
  const fallback = { ability: 'Ability', spell: 'Spell' };
  if (value === undefined || value === null) return fallback;
  if (!isPlainObject(value)) {
    errors.push('abilityKinds must be an object; defaults used');
    return fallback;
  }
  const out = {};
  let count = 0;
  for (const [rawKey, rawLabel] of Object.entries(value).slice(0, SCAN_CAP)) {
    if (count === LIMITS.abilityKinds) {
      errors.push(`abilityKinds allows at most ${LIMITS.abilityKinds} entries; the rest are dropped`);
      break;
    }
    const key = keyOf(rawKey, 'abilityKinds', errors);
    if (key === null) continue;
    if (hasOwn(out, key)) {
      errors.push(`abilityKinds: duplicate key "${key}" dropped`);
      continue;
    }
    setOwn(out, key, labelOf(rawLabel, key, LIMITS.label, `abilityKinds.${key}`, errors));
    count++;
  }
  if (count === 0) {
    errors.push('abilityKinds needs at least one entry; defaults used');
    return fallback;
  }
  return out;
}

function sanitizeCard(card, errors) {
  return {
    style: enumOf(card.style, ['detailed', 'compact'], 'detailed', 'card.style', errors),
    showFormula: boolOf(card.showFormula, true, 'card.showFormula', errors),
    showDice: boolOf(card.showDice, true, 'card.showDice', errors),
    accent: hexOf(card.accent, DEFAULT_ACCENT, 'card.accent', errors),
    header: headerOf(card.header, errors),
    successLabel: labelOf(card.successLabel, 'successes', LIMITS.cardLabel, 'card.successLabel', errors),
    critLabel: labelOf(card.critLabel, 'Critical', LIMITS.cardLabel, 'card.critLabel', errors),
    fumbleLabel: labelOf(card.fumbleLabel, 'Fumble', LIMITS.cardLabel, 'card.fumbleLabel', errors),
  };
}

function sanitizeCombat(combat, attrKeys, errors) {
  const init = section(combat, 'initiative', 'combat.initiative', errors);
  let mode = enumOf(init.mode, ['roll', 'attribute', 'fixed'], 'roll', 'combat.initiative.mode', errors);
  let attr = '';
  if (init.attr !== undefined && init.attr !== null && init.attr !== '') {
    if (typeof init.attr === 'string' && attrKeys.has(init.attr)) attr = init.attr;
    else errors.push('combat.initiative.attr does not name an attribute; cleared');
  }
  if (mode === 'attribute' && !attr) {
    errors.push("combat.initiative: mode 'attribute' needs an attribute; using 'roll'");
    mode = 'roll';
  }
  return {
    initiative: {
      mode,
      attr,
      bonus: intOf(init.bonus, -LIMITS.bonusBound, LIMITS.bonusBound, 0, 'combat.initiative.bonus', errors),
    },
  };
}

function sanitizeCheckList(raw, name, cfg, max, errors) {
  return keyedList(raw, name, max, errors, (item, key, path) => ({
    key,
    label: labelOf(item.label, key, LIMITS.label, `${path}.label`, errors),
    group: optionalTextOf(item.group, LIMITS.group, `${path}.group`, errors),
    sources: sanitizeSources(item.sources, cfg),
    bonus: intOf(item.bonus, -LIMITS.bonusBound, LIMITS.bonusBound, 0, `${path}.bonus`, errors),
    showOnSheet: boolOf(item.showOnSheet, true, `${path}.showOnSheet`, errors),
    mode: enumOf(item.mode, ['system', 'd20', 'pool'], 'system', `${path}.mode`, errors),
    target: item.target === undefined || item.target === null ? null : intOf(item.target, 0, LIMITS.attrBound, 0, `${path}.target`, errors),
  }));
}

function sanitizeAttacks(raw, cfg, errors) {
  const input = section({ attacks: raw }, 'attacks', 'attacks', errors);
  const profiles = keyedList(input.profiles, 'attacks.profiles', 24, errors, (item, key, path) => {
    const damage = section(item, 'damage', `${path}.damage`, errors);
    return {
      key,
      label: labelOf(item.label, key, LIMITS.label, `${path}.label`, errors),
      sources: sanitizeSources(item.sources, cfg),
      bonus: intOf(item.bonus, -LIMITS.bonusBound, LIMITS.bonusBound, 0, `${path}.bonus`, errors),
      mode: enumOf(item.mode, ['system', 'd20', 'pool'], 'system', `${path}.mode`, errors),
      faces: intOf(item.faces, 2, LIMITS.diceSides, cfg.dice.pool.faces, `${path}.faces`, errors),
      successMin: intOf(item.successMin, 2, 100, cfg.dice.pool.successMin, `${path}.successMin`, errors),
      target: item.target === undefined || item.target === null ? null : intOf(item.target, 0, LIMITS.attrBound, 0, `${path}.target`, errors),
      damage: {
        method: enumOf(damage.method, ['none', 'fixed', 'dice', 'successes', 'margin', 'pool'], 'none', `${path}.damage.method`, errors),
        base: intOf(damage.base, 0, LIMITS.attrBound, 0, `${path}.damage.base`, errors),
        sources: sanitizeSources(damage.sources, cfg),
        count: intOf(damage.count, 1, 100, 1, `${path}.damage.count`, errors),
        faces: intOf(damage.faces, 2, 100, 6, `${path}.damage.faces`, errors),
        successMin: intOf(damage.successMin, 2, 100, 5, `${path}.damage.successMin`, errors),
        critPairs: boolOf(damage.critPairs, false, `${path}.damage.critPairs`, errors),
        critFace: intOf(damage.critFace, 2, 100, 10, `${path}.damage.critFace`, errors),
      },
    };
  });
  return { enabled: boolOf(input.enabled, true, 'attacks.enabled', errors), profiles };
}

function sanitizeMagic(raw, cfg, errors) {
  const input = section({ magic: raw }, 'magic', 'magic', errors);
  const methods = Array.isArray(input.methods)
    ? [...new Set(input.methods.filter((v) => ['free', 'resource', 'spontaneous', 'prepared', 'uses', 'check'].includes(v)))].slice(0, 6)
    : ['free', 'resource', 'spontaneous', 'prepared', 'uses', 'check'];
  const allowed = ['free', 'resource', 'spontaneous', 'prepared', 'uses', 'check'];
  const defaultMethod = enumOf(input.defaultMethod, allowed, 'resource', 'magic.defaultMethod', errors);
  const levels = keyedList(input.levels, 'magic.levels', 21, errors, (item, key, path) => ({
    key,
    label: labelOf(item.label, key, LIMITS.label, `${path}.label`, errors),
    rank: intOf(item.rank, 0, 20, 0, `${path}.rank`, errors),
    capacityDefault: intOf(item.capacityDefault, 0, 99, 0, `${path}.capacityDefault`, errors),
    free: boolOf(item.free, false, `${path}.free`, errors),
  }));
  return {
    enabled: boolOf(input.enabled, true, 'magic.enabled', errors),
    defaultMethod: methods.includes(defaultMethod) ? defaultMethod : (methods[0] ?? 'free'),
    methods,
    levels,
    recovery: enumOf(input.recovery, ['manual', 'shortRest', 'longRest'], 'manual', 'magic.recovery', errors),
    checkProfiles: sanitizeCheckList(input.checkProfiles, 'magic.checkProfiles', cfg, 24, errors),
  };
}

function sanitizeSaves(raw, cfg, errors) {
  const input = section({ saves: raw }, 'saves', 'saves', errors);
  return {
    enabled: boolOf(input.enabled, false, 'saves.enabled', errors),
    entries: sanitizeCheckList(input.entries, 'saves.entries', cfg, 24, errors),
  };
}

// ---------------------------------------------------------------------------
// Layout: actor tabs and item tabs (both sanitized with the same rules)
// ---------------------------------------------------------------------------

/** Default actor tabs. Fresh objects on every call. */
function defaultTabs() {
  return [
    { key: 'main', label: 'Main', columns: 1, blocks: ['resources', 'attributes', 'skills', 'saves'], blockSpans: {} },
    { key: 'attacks', label: 'Attacks', columns: 1, blocks: ['attacks'], blockSpans: {} },
    { key: 'magic', label: 'Magic', columns: 1, blocks: ['magic'], blockSpans: {} },
    { key: 'powers', label: 'Powers', columns: 1, blocks: ['items:ability', 'items:spell'], blockSpans: {} },
    { key: 'gear', label: 'Gear', columns: 1, blocks: ['items:gear', 'items:other', 'notes'], blockSpans: {} },
    { key: 'effects', label: 'Effects', columns: 1, blocks: ['effects'], blockSpans: {} },
  ];
}

/** Default item tabs. Fresh objects on every call. */
function defaultItemTabs() {
  return [
    { key: 'details', label: 'Details', columns: 2, blocks: ['details', 'uses'], blockSpans: {} },
    { key: 'rules', label: 'Rules', columns: 2, blocks: ['roll', 'cost'], blockSpans: {} },
    { key: 'effects', label: 'Effects', columns: 1, blocks: ['effects'], blockSpans: {} },
    { key: 'text', label: 'Description', columns: 1, blocks: ['description'], blockSpans: {} },
  ];
}

/** Default layout: actor tabs, item tabs, density and skill grouping. Fresh on every call. */
export function defaultLayout() {
  return {
    density: 'comfortable',
    skillGrouping: 'attribute',
    tabs: defaultTabs(),
    itemTabs: defaultItemTabs(),
  };
}

/** Short text for an error about a value of any type. Never throws. */
function briefOf(value) {
  return typeof value === 'string' ? value.slice(0, 40) : typeof value;
}

/** Optional text that may be empty: trimmed, control characters removed, cut to `max`. */
function optionalTextOf(value, max, path, errors) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    errors.push(`${path} must be text; cleared`);
    return '';
  }
  const text = cleanText(value);
  if (text.length <= max) return text;
  errors.push(`${path} is longer than ${max} characters; cut`);
  return text.slice(0, max).trim();
}

/** Blocks of one tab: known names only, and each name at most once across the whole list (`placed`). */
function sanitizeBlocks(raw, path, allowed, placed, errors) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.push(`${path}.blocks must be a list; ignored`);
    return [];
  }
  if (raw.length > SCAN_CAP) errors.push(`${path}.blocks: only the first ${SCAN_CAP} entries are read`);
  const out = [];
  const scan = Math.min(raw.length, SCAN_CAP);
  for (let i = 0; i < scan; i++) {
    const block = raw[i];
    if (typeof block !== 'string' || !allowed.includes(block)) {
      errors.push(`${path}.blocks[${i}]: unknown block "${briefOf(block)}" dropped`);
      continue;
    }
    if (out.length === LAYOUT_LIMITS.maxBlocksPerTab) {
      errors.push(`${path}.blocks allows at most ${LAYOUT_LIMITS.maxBlocksPerTab} entries; the rest are dropped`);
      break;
    }
    if (placed.has(block)) {
      errors.push(`${path}.blocks[${i}]: "${block}" already appears in another place; dropped`);
      continue;
    }
    placed.add(block);
    out.push(block);
  }
  return out;
}

/** A tab list: slug keys, unique, at most maxTabs; an empty or invalid list gives the fallback tabs. */
function sanitizeTabList(raw, path, allowed, fallbackTabs, errors) {
  if (raw === undefined || raw === null) return fallbackTabs();
  if (!Array.isArray(raw)) {
    errors.push(`${path} must be a list; default tabs used`);
    return fallbackTabs();
  }
  const seenKeys = new Set();
  const placed = new Set();
  const tabs = [];
  for (const { index, item } of entries(raw, path, LAYOUT_LIMITS.maxTabs, errors)) {
    const tabPath = `${path}[${index}]`;
    const key = keyOf(item.key, tabPath, errors);
    if (key === null) continue;
    if (seenKeys.has(key)) {
      errors.push(`${tabPath}: duplicate key "${key}" dropped`);
      continue;
    }
    seenKeys.add(key);
    tabs.push({
      key,
      label: labelOf(item.label, key, LAYOUT_LIMITS.label, `${tabPath}.label`, errors),
      columns: intOf(
        item.columns,
        LAYOUT_LIMITS.minColumns,
        LAYOUT_LIMITS.maxColumns,
        LAYOUT_LIMITS.defaultColumns,
        `${tabPath}.columns`,
        errors,
      ),
      blocks: [],
      blockSpans: {},
    });
    const tab = tabs[tabs.length - 1];
    tab.blocks = sanitizeBlocks(item.blocks, tabPath, allowed, placed, errors);
    tab.blockSpans = sanitizeBlockSpans(item.blockSpans, tabPath, new Set(tab.blocks), errors);
  }
  if (tabs.length === 0) {
    errors.push(`${path} has no valid tab; default tabs used`);
    return fallbackTabs();
  }
  return tabs;
}

/** Optional full-row blocks in the tab's grid. Missing/invalid entries simply mean auto width. */
function sanitizeBlockSpans(raw, path, tabPlaced, errors) {
  if (!isPlainObject(raw)) return {};
  const spans = {};
  for (const [key, value] of Object.entries(raw).slice(0, LAYOUT_LIMITS.maxBlocksPerTab)) {
    if (!tabPlaced.has(key)) continue;
    if (value === 'full' || value === 'auto') spans[key] = value;
  }
  return spans;
}

/** Layout section. Missing values use the defaults silently; invalid ones are reported and defaulted. */
function sanitizeLayout(raw, errors) {
  if (raw === undefined || raw === null) return defaultLayout();
  if (!isPlainObject(raw)) {
    errors.push('layout must be an object; default layout used');
    return defaultLayout();
  }
  return {
    density: enumOf(raw.density, LAYOUT_DENSITIES, 'comfortable', 'layout.density', errors),
    skillGrouping: enumOf(raw.skillGrouping, LAYOUT_SKILL_GROUPINGS, 'attribute', 'layout.skillGrouping', errors),
    tabs: sanitizeTabList(raw.tabs, 'layout.tabs', LAYOUT_BLOCKS, defaultTabs, errors),
    itemTabs: sanitizeTabList(raw.itemTabs, 'layout.itemTabs', ITEM_LAYOUT_BLOCKS, defaultItemTabs, errors),
  };
}

/** Builds a fresh, valid config from any input. Only known keys survive. */
function sanitize(input, errors) {
  const dice = sanitizeDice(input, errors);
  const attributes = sanitizeAttributes(input.attributes, errors);
  const attrKeys = new Set(attributes.map((a) => a.key));
  const skills = sanitizeSkills(input.skills, attrKeys, errors);
  const resources = sanitizeResources(input.resources, errors);
  const sourceCfg = { attributes, skills, dice };
  const saves = sanitizeSaves(input.saves, sourceCfg, errors);
  const attacks = sanitizeAttacks(input.attacks, sourceCfg, errors);
  const magic = sanitizeMagic(input.magic, sourceCfg, errors);
  const itemCategories = sanitizeCategories(input.itemCategories, errors);
  const abilityKinds = sanitizeAbilityKinds(input.abilityKinds, errors);
  const card = sanitizeCard(section(input, 'card', 'card', errors), errors);
  const combat = sanitizeCombat(section(input, 'combat', 'combat', errors), attrKeys, errors);
  const layout = sanitizeLayout(input.layout, errors);
  return {
    version: CONFIG_VERSION,
    name: labelOf(input.name, 'My System', LIMITS.name, 'name', errors),
    attributeDisplay: enumOf(input.attributeDisplay, ['number', 'dots'], 'number', 'attributeDisplay', errors),
    skillDisplay: enumOf(input.skillDisplay, ['number', 'dots'], 'number', 'skillDisplay', errors),
    dotStyle: enumOf(input.dotStyle, DOT_STYLES, 'round', 'dotStyle', errors),
    dotGroup: intOf(input.dotGroup, 0, 10, 5, 'dotGroup', errors),
    dice,
    attributes,
    skills,
    resources,
    saves,
    attacks,
    magic,
    itemCategories,
    abilityKinds,
    card,
    combat,
    layout,
  };
}

/** Deterministic migration: old combat items retain their existing roll/damage fields. */
function upgrade(raw) {
  // Sanitizers below read into fresh output objects and never mutate input. A deep clone here
  // would walk attacker-controlled sparse arrays before the bounded list scanners can reject them.
  const source = Object.create(null);
  for (const key of Object.keys(raw)) source[key] = raw[key];
  if (Number(source.version) < 2) {
    source.saves ??= { enabled: false, entries: [] };
    source.attacks ??= { enabled: true, profiles: [{ key: 'basic', label: 'Basic attack', sources: [], bonus: 0, mode: 'system', faces: 10, successMin: 5, target: null, damage: { method: 'none', base: 0, sources: [], count: 1, faces: 6, successMin: 5, critPairs: false, critFace: 10 } }] };
    source.magic ??= { enabled: true, defaultMethod: 'resource', methods: ['free', 'resource', 'spontaneous', 'prepared', 'uses', 'check'], levels: [], recovery: 'manual', checkProfiles: [] };
    source.version = 2;
  }
  return source;
}

function capErrors(errors) {
  if (errors.length <= ERROR_CAP) return errors;
  return [...errors.slice(0, ERROR_CAP), `...and ${errors.length - ERROR_CAP} more`];
}

// ---------------------------------------------------------------------------
// Public pure API
// ---------------------------------------------------------------------------

/**
 * Validates and sanitizes any input. `config` is always a valid v2 config; `errors` lists every
 * value that was changed, dropped or defaulted. Never throws.
 */
export function validateConfig(input) {
  try {
    if (!isPlainObject(input)) {
      return { ok: false, config: defaultConfig(), errors: ['Configuration must be an object.'] };
    }
    const errors = [];
    const config = sanitize(upgrade(input), errors);
    return { ok: errors.length === 0, config, errors: capErrors(errors) };
  } catch {
    return { ok: false, config: defaultConfig(), errors: ['Configuration could not be read.'] };
  }
}

/** Upgrades any raw value to a valid v2 config. Missing or unknown versions are accepted and
 * known keys are kept. Never throws. */
export function migrateConfig(raw) {
  try {
    if (!isPlainObject(raw)) return defaultConfig();
    return sanitize(upgrade(raw), []);
  } catch {
    return defaultConfig();
  }
}

/** Parses JSON text (for example an import) into a valid config. Never throws. */
export function parseConfig(text) {
  try {
    if (typeof text !== 'string') {
      return { ok: false, config: defaultConfig(), errors: ['Import text must be a string.'] };
    }
    if (text.length > LIMITS.importChars) {
      return { ok: false, config: defaultConfig(), errors: [`Import text is larger than ${LIMITS.importChars} characters.`] };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, config: defaultConfig(), errors: ['The text is not valid JSON.'] };
    }
    if (!isPlainObject(parsed)) {
      return { ok: false, config: defaultConfig(), errors: ['Configuration must be a JSON object.'] };
    }
    return validateConfig(parsed);
  } catch {
    return { ok: false, config: defaultConfig(), errors: ['Configuration could not be read.'] };
  }
}

/** Pretty JSON of the sanitized config, ready to export or store. */
export function serializeConfig(cfg) {
  return JSON.stringify(validateConfig(cfg).config, null, 2);
}

/** Attribute list of a config (empty when absent). */
export function attributeList(cfg) {
  return Array.isArray(cfg?.attributes) ? cfg.attributes : [];
}

/** Skill list of a config (empty when absent). */
export function skillList(cfg) {
  return Array.isArray(cfg?.skills) ? cfg.skills : [];
}

/** Resource list of a config (empty when absent). */
export function resourceList(cfg) {
  return Array.isArray(cfg?.resources) ? cfg.resources : [];
}

/** Item category list of a config (empty when absent). */
export function categoryList(cfg) {
  return Array.isArray(cfg?.itemCategories) ? cfg.itemCategories : [];
}

/** Label of an ability kind; falls back to the kind itself. */
export function abilityKindLabel(cfg, kind) {
  if (typeof kind !== 'string') return '';
  const kinds = cfg?.abilityKinds;
  if (isPlainObject(kinds) && hasOwn(kinds, kind) && typeof kinds[kind] === 'string') return kinds[kind];
  return kind;
}

/**
 * Default systemData for a new actor: every attribute, skill and resource at its default
 * (resources full). `type` is reserved: every actor type shares one shape today.
 */
export function defaultActorData(cfg, type) {
  void type;
  const c = validateConfig(cfg).config;
  const attrs = {};
  for (const a of c.attributes) setOwn(attrs, a.key, a.default);
  const skills = {};
  for (const s of c.skills) setOwn(skills, s.key, s.default);
  const res = {};
  for (const r of c.resources) setOwn(res, r.key, { value: r.max, max: null });
  const saves = {};
  for (const save of c.saves.entries) setOwn(saves, save.key, 0);
  const slots = {};
  for (const level of c.magic.levels) setOwn(slots, level.key, { value: level.capacityDefault, max: level.capacityDefault });
  return { attrs, skills, res, saves, magic: { slots, prepared: {}, uses: {} }, notes: '' };
}

/**
 * Default `data` for a new item. Abilities and spells get no quantity; every other type
 * starts with quantity 1. `roll` and `cost` are always present, disabled by default.
 */
export function defaultItemData(cfg, type) {
  const c = validateConfig(cfg).config;
  const data = {
    category: c.itemCategories[0] ? c.itemCategories[0].key : '',
    description: '',
    roll: { enabled: false, attr: '', skill: '', bonus: 0, damage: '' },
    cost: { res: '', amount: 0 },
    casting: { method: 'inherit', levelKey: '', resourceKey: '', cost: 0, usesMax: 0, checkProfileKey: '' },
    attack: { profileKey: '', bonus: 0, damageBonus: 0 },
  };
  if (type === 'spell') data.casting.resourceKey = c.resources.find((r) => /mana|mp/i.test(`${r.key} ${r.label}`))?.key ?? '';
  if (type !== 'ability' && type !== 'spell') data.quantity = 1;
  return data;
}

/**
 * Value of an attribute or skill for an actor, clamped to the config bounds.
 * `actor` may be an actor (with `systemData`) or the systemData itself. Missing values resolve
 * to the config default; unknown keys resolve to 0. Never throws.
 * @param {'attr'|'skill'} kind
 */
export function actorValue(actor, cfg, kind, key) {
  try {
    const c = validateConfig(cfg).config;
    const data = actor?.systemData ?? actor ?? {};
    if (kind === 'attr') {
      const def = c.attributes.find((a) => a.key === key);
      if (!def) return 0;
      const bucket = isPlainObject(data.attrs) ? data.attrs : {};
      const n = hasOwn(bucket, key) ? numberOf(bucket[key]) : NaN;
      return Number.isFinite(n) ? clamp(Math.round(n), def.min, def.max) : def.default;
    }
    if (kind === 'skill') {
      const def = c.skills.find((s) => s.key === key);
      if (!def) return 0;
      const bucket = isPlainObject(data.skills) ? data.skills : {};
      const n = hasOwn(bucket, key) ? numberOf(bucket[key]) : NaN;
      return Number.isFinite(n) ? clamp(Math.round(n), 0, def.max) : def.default;
    }
    return 0;
  } catch {
    return 0;
  }
}

/** Converts a configured attribute score into its roll modifier, or returns it unchanged. */
export function attributeRollValue(cfg, key, score) {
  try {
    const def = validateConfig(cfg).config.attributes.find((a) => a.key === key);
    const value = numberOf(score);
    if (!def || !Number.isFinite(value)) return 0;
    return def.useD20Modifier ? Math.floor((value - 10) / 2) : Math.round(value);
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Layout helpers (pure): what the sheets render
// ---------------------------------------------------------------------------

function copyTabs(tabs) {
  return tabs.map((tab) => ({ key: tab.key, label: tab.label, columns: tab.columns, blocks: [...tab.blocks], blockSpans: { ...(tab.blockSpans ?? {}) } }));
}

/** Appends every allowed block that no tab lists to the first tab, in canonical order. */
function appendMissing(tabs, allowed) {
  const placed = new Set(tabs.flatMap((tab) => tab.blocks));
  const missing = allowed.filter((block) => !placed.has(block));
  if (missing.length > 0 && tabs.length > 0) tabs[0].blocks.push(...missing);
  return tabs;
}

function fallbackLayout() {
  const d = defaultLayout();
  return { density: d.density, skillGrouping: d.skillGrouping, tabs: appendMissing(d.tabs, LAYOUT_BLOCKS) };
}

function fallbackItemLayout() {
  return { tabs: appendMissing(defaultLayout().itemTabs, ITEM_LAYOUT_BLOCKS) };
}

/**
 * Actor layout that always shows every actor block: a block that no tab lists is appended to the
 * first tab, in canonical order. Never throws.
 */
export function resolveLayout(cfg) {
  try {
    const clean = validateConfig(cfg).config;
    const { layout } = clean;
    const allowed = LAYOUT_BLOCKS.filter((block) => !OPTIONAL_LAYOUT_BLOCKS.includes(block)
      || (block === 'saves' ? clean.saves.enabled && clean.saves.entries.some((row) => row.showOnSheet)
        : block === 'attacks' ? clean.attacks.enabled && clean.attacks.profiles.length > 0
          : clean.magic.enabled));
    const tabs = appendMissing(copyTabs(layout.tabs), LAYOUT_BLOCKS.filter((block) => !OPTIONAL_LAYOUT_BLOCKS.includes(block)));
    for (const tab of tabs) {
      tab.blocks = tab.blocks.filter((block) => allowed.includes(block));
      for (const block of Object.keys(tab.blockSpans)) if (!tab.blocks.includes(block)) delete tab.blockSpans[block];
    }
    if (tabs.length === 0) return fallbackLayout();
    return { density: layout.density, skillGrouping: layout.skillGrouping, tabs };
  } catch {
    return fallbackLayout();
  }
}

/**
 * Item layout that always shows every item block: a block that no item tab lists is appended to
 * the first item tab, in canonical order. Never throws.
 */
export function resolveItemLayout(cfg) {
  try {
    const { layout } = validateConfig(cfg).config;
    const tabs = appendMissing(copyTabs(layout.itemTabs), ITEM_LAYOUT_BLOCKS);
    if (tabs.length === 0) return fallbackItemLayout();
    return { tabs };
  } catch {
    return fallbackItemLayout();
  }
}

/** Group of an item: its trimmed `group` text, or '' when absent. Never throws. */
function groupKeyOf(item) {
  try {
    const group = item?.group;
    return typeof group === 'string' ? group.trim() : '';
  } catch {
    return '';
  }
}

/** Buckets items by `keyFn`, keeping the order of first appearance of each key. */
function bucket(items, keyFn) {
  const order = [];
  const byKey = new Map();
  for (const item of items) {
    const key = keyFn(item);
    let entry = byKey.get(key);
    if (!entry) {
      entry = { key, items: [] };
      byKey.set(key, entry);
      order.push(entry);
    }
    entry.items.push(item);
  }
  return order;
}

/** Items grouped by their `group` text, in order of first appearance. Items without a group go in ''. */
export function groupedList(list) {
  try {
    if (!Array.isArray(list)) return [];
    return bucket(list, groupKeyOf).map((entry) => ({ group: entry.key, items: entry.items }));
  } catch {
    return [];
  }
}

/**
 * Sections for the skills block, following `layout.skillGrouping`:
 * - 'attribute': one section per skill attribute (title = attribute label); no attribute gives ''.
 * - 'group': one section per skill `group` ('' has no title).
 * - 'none': exactly one section, untitled.
 * Sections keep the order of first appearance among the skills.
 */
export function skillSections(cfg) {
  try {
    const { skills, attributes, layout } = validateConfig(cfg).config;
    if (layout.skillGrouping === 'none') return [{ key: 'all', title: '', skills: [...skills] }];
    if (layout.skillGrouping === 'group') {
      return bucket(skills, (skill) => skill.group).map((entry) => ({
        key: entry.key,
        title: entry.key,
        skills: entry.items,
      }));
    }
    const labels = new Map(attributes.map((attr) => [attr.key, attr.label]));
    return bucket(skills, (skill) => skill.attr).map((entry) => ({
      key: entry.key,
      title: entry.key ? (labels.get(entry.key) ?? entry.key) : '',
      skills: entry.items,
    }));
  } catch {
    return [];
  }
}

/**
 * i18n key of a layout block's name. `effects` exists in both lists: the default scope is the actor
 * sheet (`sandbox.layout.block.<name>`); pass scope 'item' for the item sheet (`sandbox.layout.item.<name>`).
 * Returns '' for an unknown block.
 */
export function blockLabelKey(block, scope = 'actor') {
  if (typeof block !== 'string') return '';
  if (scope === 'item' && ITEM_LAYOUT_BLOCKS.includes(block)) return `sandbox.layout.item.${block}`;
  if (LAYOUT_BLOCKS.includes(block)) return `sandbox.layout.block.${block.replace(':', '_')}`;
  if (ITEM_LAYOUT_BLOCKS.includes(block)) return `sandbox.layout.item.${block}`;
  return '';
}
// ---------------------------------------------------------------------------
// Engine boundary (guarded: the module imports and runs without an engine)
// ---------------------------------------------------------------------------

const listeners = new Set();
/** Last config this module loaded or saved; read synchronously by getConfigSync(). */
let lastKnownConfig = null;

function engine() {
  return typeof globalThis !== 'undefined' ? globalThis.Loom : undefined;
}

function translate(loom, key, fallback) {
  try {
    const text = loom?.i18n?.localize?.(key);
    return typeof text === 'string' && text && text !== key ? text : fallback;
  } catch {
    return fallback;
  }
}

function messageOf(error) {
  try {
    return typeof error?.message === 'string' && error.message ? error.message : 'Save failed.';
  } catch {
    return 'Save failed.';
  }
}

/** Turns a stored value (JSON text or an object) into a valid config, or null when nothing is stored. */
function fromStoredValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return parseConfig(value).config;
  if (isPlainObject(value)) return migrateConfig(value);
  return defaultConfig();
}

/** GET /api/module-settings/:worldId/:module, the same route the engine uses to preload settings. */
async function fetchStoredValue(loom, module = CONFIG_MODULE) {
  const worldId = loom?.world?.id;
  const get = loom?.api?.get;
  if (!worldId || typeof get !== 'function') return { ok: false };
  const res = await get(`/module-settings/${encodeURIComponent(worldId)}/${encodeURIComponent(module)}`);
  if (res && typeof res === 'object' && res.error) return { ok: false };
  const data = res && isPlainObject(res.data) ? res.data : {};
  return { ok: true, value: hasOwn(data, CONFIG_KEY) ? data[CONFIG_KEY] : undefined };
}

/** Stores a config as the last known one and returns it. */
function remember(cfg) {
  lastKnownConfig = deepClone(cfg);
  return cfg;
}

/**
 * Loads the world config. With `fresh` (default) it reads the saved value from the server,
 * otherwise the engine's cached copy. Waits for the saved world settings first. Never throws:
 * falls back to the cache, then to defaultConfig().
 */
export async function loadConfig({ fresh = true } = {}) {
  try {
    const loom = engine();
    if (!loom) return defaultConfig();
    try {
      await loom.settings?.whenReady?.(CONFIG_MODULE);
    } catch {
      // Carry on with whatever the cache holds.
    }
    if (fresh) {
      try {
        const fetched = await fetchStoredValue(loom);
        if (fetched.ok && fetched.value !== undefined) return remember(fromStoredValue(fetched.value) ?? defaultConfig());
        if (fetched.ok) {
          // One-time migration: preserve worlds that saved the JSON in the old visible
          // system setting, then persist it under the editor-only settings namespace.
          for (const legacyModule of LEGACY_CONFIG_MODULES) {
            const legacy = await fetchStoredValue(loom, legacyModule);
            if (legacy.ok && legacy.value !== undefined) {
              const migrated = fromStoredValue(legacy.value) ?? defaultConfig();
              try {
                await loom.settings?.set?.(CONFIG_MODULE, CONFIG_KEY, serializeConfig(migrated));
              } catch {
                // The legacy value is still usable this session even if persisting the
                // copy fails; never replace a user's rules with defaults in that case.
              }
              return remember(migrated);
            }
          }
          return remember(defaultConfig());
        }
      } catch {
        // Network or server error: use the cached copy below.
      }
    }
    const current = fromStoredValue(loom.settings?.get?.(CONFIG_MODULE, CONFIG_KEY));
    if (current) return remember(current);
    for (const legacyModule of LEGACY_CONFIG_MODULES) {
      const legacy = fromStoredValue(loom.settings?.get?.(legacyModule, CONFIG_KEY));
      if (legacy) return remember(legacy);
    }
    return remember(defaultConfig());
  } catch {
    return defaultConfig();
  }
}

/**
 * Validates, then stores the config as JSON text in the world setting. Refuses when there are
 * validation errors (nothing is written) or when the local user is known not to be a GM.
 * Calls every onConfigSaved listener after a successful write.
 * @returns {Promise<{ok:boolean, errors:string[]}>}
 */
export async function saveConfig(cfg) {
  try {
    const checked = validateConfig(cfg);
    if (!checked.ok) return { ok: false, errors: checked.errors };
    const loom = engine();
    if (!loom?.settings?.set) return { ok: false, errors: ['The engine settings API is not available.'] };
    if (loom.user?.isGM === false) {
      return { ok: false, errors: ['Only a GM can change the system configuration.'] };
    }
    await loom.settings.set(CONFIG_MODULE, CONFIG_KEY, serializeConfig(checked.config));
    lastKnownConfig = deepClone(checked.config);
    for (const listener of [...listeners]) {
      try {
        listener(deepClone(checked.config));
      } catch {
        // A broken listener must not block the others.
      }
    }
    return { ok: true, errors: [] };
  } catch (error) {
    return { ok: false, errors: [messageOf(error)] };
  }
}

/** Subscribes to successful saves. Returns the unsubscribe function. */
export function onConfigSaved(callback) {
  if (typeof callback !== 'function') return () => {};
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/**
 * Synchronous read for render paths that cannot await (default actor data, chat cards). Returns the
 * last config this module loaded or saved, else the engine's cached copy, else defaultConfig().
 * It never fetches: call loadConfig() to refresh.
 */
/** Forgets the last loaded or saved config (tests and engine reloads). */
export function clearConfigCache() {
  lastKnownConfig = null;
}

export function getConfigSync() {
  if (lastKnownConfig) return deepClone(lastKnownConfig);
  try {
    const cached = fromStoredValue(engine()?.settings?.get?.(CONFIG_MODULE, CONFIG_KEY));
    if (cached) return cached;
  } catch {
    // No engine or unreadable cache: fall through to the default.
  }
  return defaultConfig();
}

/**
 * Registers the world setting that holds the config (JSON text, GM-writable). Returns false when
 * the engine is not present.
 */
export function registerConfigSetting() {
  try {
    const loom = engine();
    if (!loom?.settings?.register) return false;
    loom.settings.register(CONFIG_MODULE, CONFIG_KEY, {
      name: translate(loom, 'sandbox.config.settingName', 'System configuration'),
      hint: translate(loom, 'sandbox.config.settingHint', 'JSON of the rules, edited from the system editor.'),
      scope: 'world',
      config: false,
      type: String,
      default: serializeConfig(defaultConfig()),
    });
    return true;
  } catch {
    return false;
  }
}
