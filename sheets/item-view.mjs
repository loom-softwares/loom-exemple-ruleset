// ══════════════════════════════════════════════════════════════
// Loom Demo System — sheets/item-view.mjs
// ══════════════════════════════════════════════════════════════
//
// Pure part of the item sheet: normalization of the item `data` model, the view
// context, and the HTML renderer. No DOM, no `window`, no SDK import, so this file
// runs in plain Node (tests/item.test.mjs). The thin engine layer lives in
// sheets/item-sheet.mjs.
//
// Every string that reaches HTML goes through esc(). Config text (category, attribute,
// skill and resource labels) and item text (name, description, damage) are treated as
// hostile: a GM account or an imported file can put anything there.

import { esc, deepClone, isPlainObject } from '../lib/helpers.mjs';
import {
  ITEM_LAYOUT_BLOCKS,
  abilityKindLabel,
  attributeList,
  blockLabelKey,
  skillList,
  resourceList,
  categoryList,
  resolveItemLayout,
} from '../lib/config.mjs';
import { buildExtra } from '../lib/dice.mjs';
import { renderBlock, renderGrid, renderTabs } from '../lib/layout-view.mjs';
import { renderEffectsBlock } from '../lib/effects-view.mjs';

/** Item types this sheet handles. Legacy types use the same fields. */
export const ITEM_TYPES = Object.freeze(['gear', 'ability', 'spell', 'weapon', 'armor', 'potion', 'scroll']);

/** Types without a quantity field. */
const NO_QUANTITY = new Set(['ability', 'spell']);
/** Types with a uses counter. */
const USES_TYPES = new Set(['ability', 'spell', 'potion', 'scroll']);

const NAME_MAX = 80;
const IMG_MAX = 500;
const KEY_REF_MAX = 24;
const DESCRIPTION_MAX = 4000;
const DAMAGE_MAX = 200;
const QUANTITY_MAX = 9999;
const USES_MAX = 999;
const BONUS_LIMIT = 99;
const COST_MAX = 999;

// Local URL check for the portrait: a site-relative path or an http(s) URL. Blocks
// javascript:, data:, protocol-relative URLs, quotes, angle brackets and whitespace.
const IMG_URL_RE = /^(\/(?!\/)[^\s"'<>\\]*|https?:\/\/[^\s"'<>\\]+)$/;

/** Fallback labels used when no translation is available. Keys are the short names. */
const LABEL_DEFAULTS = Object.freeze({
  name: 'Name',
  portrait: 'Image URL',
  portraitHelp: 'A path starting with / or an http(s) URL.',
  portraitInvalid: 'That image URL is not allowed. It was not saved.',
  clearPortrait: 'Clear image',
  effectsUnavailable: 'The effects block could not be shown.',
  category: 'Category',
  none: 'None',
  description: 'Description',
  quantity: 'Quantity',
  uses: 'Uses',
  usesValue: 'Current uses',
  usesMax: 'Maximum uses',
  roll: 'Roll',
  rollEnabled: 'Enable roll',
  rollAttr: 'Attribute',
  rollSkill: 'Skill',
  rollBonus: 'Bonus',
  damage: 'Extra damage formula (optional)',
  damageHelp: 'Dice and plain numbers only, for example 1d6+2.',
  damageInvalid: 'Invalid damage formula',
  cost: 'Cost',
  costRes: 'Resource spent',
  costAmount: 'Amount spent',
  removed: '(removed)',
  removedNote: 'Some references point to keys that are no longer in the configuration. Their stored values are kept and marked as removed.',
  readOnly: 'Read only: you cannot edit this item.',
  configChanged: 'The configuration changed since this sheet was opened. Close and reopen the item to refresh the lists.',
  'type.gear': 'Gear',
  'type.ability': 'Ability',
  'type.spell': 'Spell',
  'type.weapon': 'Weapon',
  'type.armor': 'Armor',
  'type.potion': 'Potion',
  'type.scroll': 'Scroll',
});

/**
 * Builds the label table. `t(key, fallback)` is the translator; the default returns the
 * fallback. A translator that throws also falls back. Keys are `sandbox.item.<short>`.
 */
export function itemLabels(t) {
  const tr = typeof t === 'function' ? t : (key, fallback) => fallback;
  const out = {};
  for (const [short, fallback] of Object.entries(LABEL_DEFAULTS)) {
    const key = `sandbox.item.${short}`;
    let text;
    try {
      text = tr(key, fallback);
    } catch {
      text = fallback;
    }
    // A translator that echoes the key back (no translation loaded) gets the English fallback.
    out[short] = typeof text === 'string' && text !== '' && text !== key ? text : fallback;
  }
  out.types = {};
  for (const type of ITEM_TYPES) out.types[type] = out[`type.${type}`];
  return out;
}

/** Text value: strings only, control characters removed, cut to `max` characters. */
function textOf(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max);
}

/** Key-like reference (attribute, skill, resource, category). Unknown keys are kept. */
function refOf(value) {
  return textOf(value, KEY_REF_MAX).trim();
}

/**
 * Integer clamped to [min, max]. Non-numeric, NaN and Infinity give `fallback`; numbers
 * outside the range are clamped (so 1e300 becomes `max`, -5 becomes `min` when min > -5).
 */
function intOf(value, min, max, fallback) {
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
  else return fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** True when the URL may be used as an image source. */
export function safeImageUrl(url) {
  if (typeof url !== 'string') return '';
  return IMG_URL_RE.test(url) && url.length <= IMG_MAX ? url : '';
}

/** Name for the item row: single line, trimmed. */
export function normalizeItemName(value) {
  return textOf(value, NAME_MAX).replace(/[\r\n\t]/g, ' ').trim();
}

/**
 * Normalizes an item `data` object to the sandbox model for `type`.
 *
 * - Missing or non-object fields are filled with defaults.
 * - Numbers are integers clamped to their bounds; NaN, Infinity and wrong types fall back.
 * - Unknown keys are dropped.
 * - Key references (category, roll.attr, roll.skill, cost.res) are kept as stored, even when the
 *   key no longer exists in the configuration. Only a missing category gets the first configured one.
 * - Damage formulas are kept as text (validated when shown and when rolled), so the GM can see
 *   and fix an invalid one.
 *
 * @param {unknown} data
 * @param {object} cfg world configuration (used only to fill a missing category)
 * @param {string} type item type
 * @returns {object} a new object
 */
export function normalizeItemData(data, cfg, type) {
  const src = isPlainObject(data) ? data : {};
  const out = {};

  if (typeof src.category === 'string') out.category = refOf(src.category);
  else out.category = categoryList(cfg)[0]?.key ?? '';

  out.description = textOf(src.description, DESCRIPTION_MAX);

  if (!NO_QUANTITY.has(type)) out.quantity = intOf(src.quantity, 0, QUANTITY_MAX, 1);

  if (USES_TYPES.has(type)) {
    const uses = isPlainObject(src.uses) ? src.uses : {};
    const max = intOf(uses.max, 0, USES_MAX, 0);
    out.uses = { value: intOf(uses.value, 0, max, 0), max };
  }

  const roll = isPlainObject(src.roll) ? src.roll : {};
  out.roll = {
    enabled: roll.enabled === true,
    attr: refOf(roll.attr),
    skill: refOf(roll.skill),
    bonus: intOf(roll.bonus, -BONUS_LIMIT, BONUS_LIMIT, 0),
    damage: textOf(roll.damage, DAMAGE_MAX).trim(),
  };

  const cost = isPlainObject(src.cost) ? src.cost : {};
  out.cost = {
    res: refOf(cost.res),
    amount: intOf(cost.amount, 0, COST_MAX, 0),
  };

  return out;
}

/**
 * Select options for a key reference. The stored value is always present: a key that is not
 * in the list becomes an extra option labelled "(removed) key" and selected, so saving the
 * sheet never silently changes it.
 */
function refField(list, stored, L) {
  const options = [{ value: '', label: L.none, selected: stored === '' }];
  let found = false;
  for (const entry of list) {
    if (!entry || typeof entry.key !== 'string') continue;
    if (entry.key === stored) found = true;
    options.push({ value: entry.key, label: String(entry.label ?? entry.key), selected: entry.key === stored });
  }
  const removed = stored !== '' && !found;
  if (removed) options.push({ value: stored, label: `${L.removed} ${stored}`, selected: true });
  return { value: stored, removed, options };
}

/** English fallbacks for the item block titles (the keys live in sandbox.layout.item.*). */
const BLOCK_FALLBACK = Object.freeze({
  details: 'Details',
  uses: 'Uses',
  roll: 'Roll',
  cost: 'Cost',
  description: 'Description',
  effects: 'Effects',
});

/** Localized titles for ITEM_LAYOUT_BLOCKS; the English fallback is used when no translation exists. */
export function itemBlockTitles(t) {
  const tr = typeof t === 'function' ? t : (key, fallback) => fallback;
  const out = {};
  for (const block of ITEM_LAYOUT_BLOCKS) {
    const key = blockLabelKey(block, 'item');
    let text;
    try {
      text = tr(key, BLOCK_FALLBACK[block]);
    } catch {
      text = BLOCK_FALLBACK[block];
    }
    out[block] = typeof text === 'string' && text !== '' && text !== key ? text : BLOCK_FALLBACK[block];
  }
  return out;
}

/**
 * Builds the view context for one item.
 *
 * @param {object} item item row: { id, type, name, imgUrl, data }
 * @param {object} cfg world configuration (may be null/undefined: lists are then empty)
 * @param {(key: string, fallback: string) => string} [t] translator
 * @param {{ editable?: boolean, configChanged?: boolean, portraitRejected?: boolean,
 *           activeTab?: string, effects?: unknown[], editingId?: string | null }} [opts]
 * @returns {object} context for renderItem
 */
export function buildItemContext(item, cfg, t, opts = {}) {
  const row = isPlainObject(item) ? item : {};
  const o = isPlainObject(opts) ? opts : {};
  const type = typeof row.type === 'string' && row.type !== '' ? row.type : 'gear';
  const data = normalizeItemData(row.data ?? row.systemData, cfg, type);
  const translate = typeof t === 'function' ? t : (key, fallback) => fallback;
  const L = itemLabels(translate);

  const kindLabel = abilityKindLabel(cfg, type);
  const typeLabel = kindLabel !== type ? kindLabel : (L.types[type] ?? type);

  const imgUrl = textOf(row.imgUrl, IMG_MAX);
  const category = refField(categoryList(cfg), data.category, L);
  const attr = refField(attributeList(cfg), data.roll.attr, L);
  const skill = refField(skillList(cfg), data.roll.skill, L);
  const res = refField(resourceList(cfg), data.cost.res, L);

  const damageCheck = data.roll.damage ? buildExtra(data.roll.damage) : { ok: true };
  const damageError = damageCheck.ok ? '' : (damageCheck.error || 'invalid');

  const removedCount = [category, attr, skill, res].filter((r) => r.removed).length;

  // Layout: every item block is always listed (resolveItemLayout appends the missing ones).
  const layout = resolveItemLayout(cfg);
  const tabKeys = layout.tabs.map((tab) => tab.key);
  const activeTab = tabKeys.includes(o.activeTab) ? o.activeTab : (tabKeys[0] ?? '');

  return {
    id: textOf(row.id, 64),
    type,
    typeLabel,
    name: textOf(row.name, NAME_MAX),
    imgUrl,
    portrait: safeImageUrl(imgUrl),
    portraitRejected: o.portraitRejected === true,
    editable: o.editable !== false,
    configChanged: o.configChanged === true,
    showQuantity: !NO_QUANTITY.has(type),
    showUses: USES_TYPES.has(type),
    category,
    quantity: data.quantity,
    uses: data.uses ?? { value: 0, max: 0 },
    description: data.description,
    roll: {
      enabled: data.roll.enabled,
      attr,
      skill,
      bonus: data.roll.bonus,
      damage: data.roll.damage,
      damageError,
    },
    cost: { res, amount: data.cost.amount },
    removedCount,
    layout,
    activeTab,
    tabsLabel: safeTranslate(translate, 'sandbox.layout.tablist', 'Sheet sections'),
    blockTitles: itemBlockTitles(translate),
    effects: Array.isArray(o.effects) ? o.effects : [],
    editingId: typeof o.editingId === 'string' ? o.editingId.slice(0, 64) : null,
    translate,
    labels: L,
    data,
  };
}

/** Translator call that never throws and falls back when the key is not translated. */
function safeTranslate(t, key, fallback) {
  try {
    const out = t(key, fallback);
    return typeof out === 'string' && out !== '' && out !== key ? out : fallback;
  } catch {
    return fallback;
  }
}

function selectHtml(field, ref, dis, label, extraClass = '') {
  const cls = ['ldm-item-input', ref.removed ? 'ldm-item-removed' : '', extraClass].filter(Boolean).join(' ');
  const options = ref.options
    .map((o) => `<option value="${esc(o.value)}"${o.selected ? ' selected' : ''}>${esc(o.label)}</option>`)
    .join('');
  return `<select class="${cls}" data-field="${esc(field)}" aria-label="${esc(label)}"${dis}>${options}</select>`;
}

function numberHtml(field, value, min, max, dis, label) {
  return `<input type="number" class="ldm-item-input" data-field="${esc(field)}" value="${esc(value)}" min="${min}" max="${max}" step="1" inputmode="numeric" aria-label="${esc(label)}"${dis}>`;
}

/** Label wrapping one control. `control` is trusted markup built by this module. */
function fieldLabel(text, control) {
  return `<label class="ldm-item-field"><span class="ldm-item-label">${esc(text)}</span>${control}</label>`;
}

// ── Block bodies. Each returns trusted HTML; every value goes through esc(). ──

function detailsBody(c, L, dis) {
  const initial = String(c.typeLabel || '?').charAt(0).toUpperCase();
  const img = c.portrait
    ? `<img class="ldm-item-img" src="${esc(c.portrait)}" alt="">`
    : `<span class="ldm-item-img ldm-item-img--empty" aria-hidden="true">${esc(initial)}</span>`;
  const clear = c.editable && c.imgUrl
    ? `<button type="button" class="ldm-item-btn" data-action="clear-portrait">${esc(L.clearPortrait)}</button>`
    : '';
  const name = `<input type="text" class="ldm-item-input ldm-item-name" data-field="name" value="${esc(c.name)}" maxlength="${NAME_MAX}" autocomplete="off" aria-label="${esc(L.name)}"${dis}>`;
  const portrait = `<input type="text" class="ldm-item-input" data-field="portrait" value="${esc(c.imgUrl)}" maxlength="${IMG_MAX}" autocomplete="off" aria-describedby="ldm-item-portrait-help"${dis}>`;
  const quantity = c.showQuantity
    ? fieldLabel(L.quantity, numberHtml('quantity', c.quantity, 0, QUANTITY_MAX, dis, L.quantity))
    : '';

  return `<div class="ldm-item-details">
  <div class="ldm-item-head">
    <div class="ldm-item-portrait">${img}</div>
    <div class="ldm-item-head-fields">
      <span class="ldm-item-type">${esc(c.typeLabel)}</span>
      ${fieldLabel(L.name, name)}
    </div>
  </div>
  ${fieldLabel(L.portrait, portrait)}
  <span class="ldm-item-help" id="ldm-item-portrait-help">${esc(L.portraitHelp)}</span>
  ${clear}
  <div class="ldm-item-row">
    ${fieldLabel(L.category, selectHtml('category', c.category, dis, L.category))}
    ${quantity}
  </div>
</div>`;
}

function usesBody(c, L, dis) {
  return `<div class="ldm-item-row">${fieldLabel(L.usesValue, numberHtml('uses.value', c.uses.value, 0, c.uses.max, dis, L.usesValue))}${fieldLabel(L.usesMax, numberHtml('uses.max', c.uses.max, 0, USES_MAX, dis, L.usesMax))}</div>`;
}

function rollBody(c, L, dis) {
  const r = c.roll;
  const describedBy = r.damageError ? 'ldm-item-damage-help ldm-item-damage-error' : 'ldm-item-damage-help';
  const error = r.damageError
    ? `<span class="ldm-item-error" id="ldm-item-damage-error" role="alert">${esc(L.damageInvalid)} (${esc(r.damageError)})</span>`
    : '';
  const damage = `<input type="text" class="ldm-item-input" data-field="roll.damage" value="${esc(r.damage)}" maxlength="${DAMAGE_MAX}" autocomplete="off" aria-describedby="${describedBy}"${r.damageError ? ' aria-invalid="true"' : ''}${dis}>`;
  return `<label class="ldm-item-check"><input type="checkbox" data-field="roll.enabled"${r.enabled ? ' checked' : ''}${dis}> <span>${esc(L.rollEnabled)}</span></label>
  <div class="ldm-item-row">
    ${fieldLabel(L.rollAttr, selectHtml('roll.attr', r.attr, dis, L.rollAttr))}
    ${fieldLabel(L.rollSkill, selectHtml('roll.skill', r.skill, dis, L.rollSkill))}
    ${fieldLabel(L.rollBonus, numberHtml('roll.bonus', r.bonus, -BONUS_LIMIT, BONUS_LIMIT, dis, L.rollBonus))}
  </div>
  ${fieldLabel(L.damage, damage)}
  <span class="ldm-item-help" id="ldm-item-damage-help">${esc(L.damageHelp)}</span>
  ${error}`;
}

function costBody(c, L, dis) {
  return `<div class="ldm-item-row">${fieldLabel(L.costRes, selectHtml('cost.res', c.cost.res, dis, L.costRes))}${fieldLabel(L.costAmount, numberHtml('cost.amount', c.cost.amount, 0, COST_MAX, dis, L.costAmount))}</div>`;
}

function descriptionBody(c, L, dis) {
  return `<label class="ldm-item-field"><span class="ldm-item-label">${esc(L.description)}</span><textarea class="ldm-item-input ldm-item-textarea" data-field="description" rows="4" maxlength="${DESCRIPTION_MAX}"${dis} aria-label="${esc(L.description)}">${esc(c.description)}</textarea></label>`;
}

/** Effects block: always present. A renderer failure shows a note instead of an empty block. */
function effectsBody(c, L, renderEffects) {
  try {
    const out = renderEffects({
      effects: c.effects,
      editable: c.editable,
      ownerKind: 'item',
      editingId: c.editingId,
      t: c.translate,
    });
    if (typeof out === 'string') return out;
  } catch {
    // Fall through to the note below.
  }
  return `<p class="ldm-item-help" role="note">${esc(L.effectsUnavailable)}</p>`;
}

/**
 * Renders the item sheet body as an HTML string: notices, a compact title (the name only),
 * then the tab set built from the item layout. Every block of every tab is in the markup, so
 * hidden tabs keep their fields (the sheet toggles `hidden`). Every value is escaped.
 *
 * @param {object} ctx result of buildItemContext
 * @param {{ renderEffects?: Function }} [options] renderEffects defaults to renderEffectsBlock;
 *   tests inject a stub so they do not depend on the effects block internals.
 * @returns {string}
 */
export function renderItem(ctx, options = {}) {
  const c = ctx && typeof ctx === 'object' ? ctx : buildItemContext({}, null);
  const L = c.labels || itemLabels();
  const dis = c.editable ? '' : ' disabled';
  const opts = isPlainObject(options) ? options : {};
  const renderEffects = typeof opts.renderEffects === 'function' ? opts.renderEffects : renderEffectsBlock;
  const titles = c.blockTitles || itemBlockTitles();

  const bodies = Object.freeze({
    details: () => detailsBody(c, L, dis),
    uses: () => (c.showUses ? usesBody(c, L, dis) : ''),
    roll: () => rollBody(c, L, dis),
    cost: () => costBody(c, L, dis),
    description: () => descriptionBody(c, L, dis),
    effects: () => effectsBody(c, L, renderEffects),
  });

  const tabs = c.layout.tabs;
  const panels = Object.create(null);
  for (const tab of tabs) {
    const blocks = [];
    for (const block of tab.blocks) {
      if (!Object.prototype.hasOwnProperty.call(bodies, block)) continue;
      const body = bodies[block]();
      if (body === '') continue;
      blocks.push(renderBlock({ key: block, title: titles[block] || BLOCK_FALLBACK[block] || block, body }));
    }
    panels[tab.key] = renderGrid(blocks, tab.columns);
  }

  const notices = [];
  if (c.configChanged) notices.push(`<p class="ldm-item-notice" role="status">${esc(L.configChanged)}</p>`);
  if (!c.editable) notices.push(`<p class="ldm-item-notice" role="note">${esc(L.readOnly)}</p>`);
  if (c.portraitRejected) notices.push(`<p class="ldm-item-error" role="alert">${esc(L.portraitInvalid)}</p>`);
  if (c.removedCount > 0) notices.push(`<p class="ldm-item-notice" role="note">${esc(L.removedNote)}</p>`);

  const title = c.name ? `<div class="ldm-item-title">${esc(c.name)}</div>` : '';
  const tabsHtml = renderTabs({
    idPrefix: 'ldm-item',
    tabs,
    activeKey: c.activeTab,
    labelOf: (tab) => tab.label,
    panels,
    ariaLabel: c.tabsLabel,
  });

  return `<div class="ldm-item-sheet" data-item-id="${esc(c.id)}" data-item-type="${esc(c.type)}">${notices.join('\n')}${title}${tabsHtml}</div>`;
}

/**
 * Returns a copy of `data` with `value` written at a dotted path ("roll.attr").
 * Paths come from the sheet's own fixed field names, never from user input.
 */
export function applyField(data, path, value) {
  const out = isPlainObject(data) ? deepClone(data) : {};
  const keys = String(path).split('.');
  let node = out;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (!isPlainObject(node[keys[i]])) node[keys[i]] = {};
    node = node[keys[i]];
  }
  node[keys[keys.length - 1]] = value;
  return out;
}
