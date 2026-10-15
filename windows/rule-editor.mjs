// GM rule editor of the sandbox system. Edits the world config (lib/config.mjs) in a window.
//
// File layout:
//   1. imports and translation helpers (no engine access at import time)
//   2. pure draft helpers: row operations, draft <-> config conversion, errors, dirty check
//   3. pure renderers: renderPreview(cfg) and renderEditor(state) (escaped HTML strings)
//   4. RuleEditorWindow (thin engine layer), openRuleEditor, registerRuleEditorMenu
//
// Import-time rule: nothing here touches window/document, and the window base class is read
// from globalThis.Loom. In plain Node (tests) the fallback base class is used and the pure
// functions run unchanged. In the browser window.Loom.BaseWindow is always present.

import { esc, slug, deepClone, isPlainObject } from '../lib/helpers.mjs';
import {
  CONFIG_MODULE,
  LIMITS,
  LAYOUT_BLOCKS,
  ITEM_LAYOUT_BLOCKS,
  LAYOUT_LIMITS,
  LAYOUT_SKILL_GROUPINGS,
  PRESETS,
  blockLabelKey,
  defaultConfig,
  resolveLayout,
  resolveItemLayout,
  validateConfig,
  migrateConfig,
  parseConfig,
  serializeConfig,
  loadConfig,
  saveConfig,
  onConfigSaved,
} from '../lib/config.mjs';
import { buildCheck, describe as describeDice } from '../lib/dice.mjs';
import { renderTabs, attachTabs, clampColumns } from '../lib/layout-view.mjs';

export const EDITOR_WINDOW_ID = 'loom-demo-rule-editor';
const MENU_KEY = 'ruleEditor';
const SAVE_DEBOUNCE_MS = 300;
const DEFAULT_ACCENT = '#7c5cff';
const DEFAULT_COLOR = '#888888';
/** Lists edited as rows. Their order is the order shown to the GM. */
export const LIST_NAMES = Object.freeze(['attributes', 'skills', 'resources', 'itemCategories', 'abilityKinds']);
/** Layout tab lists inside `draft.layout`: actor sheet tabs and item sheet tabs. */
export const LAYOUT_TAB_LISTS = Object.freeze(['tabs', 'itemTabs']);
/** Editor sections in navigation order. Each key is a panel of the section tabs. */
export const SECTION_KEYS = Object.freeze([
  'dice', 'attributes', 'skills', 'saves', 'attacks', 'magic', 'resources', 'categories', 'kinds', 'layout', 'card', 'combat', 'io',
]);
const SAMPLE_FACES = [6, 5, 2, 1, 4, 3];

/** English names of the layout blocks, used only when the language file has no entry. */
const BLOCK_FALLBACK = Object.freeze({
  saves: 'Saving throws',
  attacks: 'Attacks',
  magic: 'Magic',
  resources: 'Resources',
  attributes: 'Attributes',
  skills: 'Skills',
  'items:gear': 'Gear',
  'items:ability': 'Abilities',
  'items:spell': 'Spells',
  'items:other': 'Other items',
  notes: 'Notes',
  effects: 'Effects',
  details: 'Details',
  uses: 'Uses',
  roll: 'Roll',
  cost: 'Cost',
  description: 'Description',
});

/** Layout scopes: tab list inside `draft.layout`, block scope, allowed blocks and resolver. */
const LAYOUT_SCOPES = Object.freeze({
  actor: Object.freeze({
    list: 'tabs', scope: 'actor', blocks: LAYOUT_BLOCKS, resolve: resolveLayout,
    titleKey: 'sandbox.editor.layoutActorTitle', titleFallback: 'Actor sheet',
  }),
  item: Object.freeze({
    list: 'itemTabs', scope: 'item', blocks: ITEM_LAYOUT_BLOCKS, resolve: resolveItemLayout,
    titleKey: 'sandbox.editor.layoutItemTitle', titleFallback: 'Item sheet',
  }),
});

// ---------------------------------------------------------------------------
// Translation. Every visible string goes through here. The English fallback lives in code;
// the same keys exist in i18n/editor.*.json (a test enforces that).
// ---------------------------------------------------------------------------

function translate(key, fallback) {
  try {
    const text = globalThis.Loom?.i18n?.localize?.(key);
    return typeof text === 'string' && text && text !== key ? text : fallback;
  } catch {
    return fallback;
  }
}

/** Escaped, localized text, ready to place in HTML. */
function T(key, fallback) {
  return esc(translate(key, fallback));
}

/** Escaped text with `{name}` placeholders replaced by escaped values. Unknown braces are kept. */
function TV(key, fallback, vars) {
  let text = esc(translate(key, fallback));
  for (const [name, value] of Object.entries(vars)) {
    text = text.split(`{${name}}`).join(esc(value));
  }
  return text;
}

// ---------------------------------------------------------------------------
// Pure row helpers. They return new arrays; row objects keep their identity so the
// editor can track which rows are new or editable (WeakSets in the state).
// ---------------------------------------------------------------------------

/** Swaps row `index` with its neighbour (`dir` -1 = up, 1 = down). Out of range: unchanged copy. */
export function moveRow(list, index, dir) {
  const out = Array.isArray(list) ? list.slice() : [];
  const target = dir === -1 ? index - 1 : dir === 1 ? index + 1 : index;
  const valid = Number.isInteger(index) && index >= 0 && index < out.length;
  if (!valid || target < 0 || target >= out.length || target === index) return out;
  [out[index], out[target]] = [out[target], out[index]];
  return out;
}

/** Returns a copy of the list without row `index`. Out of range: unchanged copy. */
export function removeRow(list, index) {
  const out = Array.isArray(list) ? list.slice() : [];
  if (Number.isInteger(index) && index >= 0 && index < out.length) out.splice(index, 1);
  return out;
}

/** Returns a copy of the list with a deep copy of `template` appended. Stops at `max` rows. */
export function addRow(list, template, max = Infinity) {
  const out = Array.isArray(list) ? list.slice() : [];
  if (out.length >= max) return out;
  out.push(deepClone(template));
  return out;
}

/** Sets one field of row `index` in place (identity kept) and returns a copy of the list. */
export function updateRow(list, index, field, value) {
  const out = Array.isArray(list) ? list.slice() : [];
  if (Number.isInteger(index) && index >= 0 && index < out.length && isPlainObject(out[index])) {
    out[index][field] = value;
  }
  return out;
}

/** Default values of a new row for a list. `draft` supplies the attribute a new skill points at. */
export function newRowTemplate(listName, draft) {
  switch (listName) {
    case 'attributes':
      return { key: '', label: '', min: 0, max: 10, default: 0, useD20Modifier: false, group: '' };
    case 'skills': {
      const first = Array.isArray(draft?.attributes) && draft.attributes[0] ? draft.attributes[0].key : '';
      return { key: '', label: '', attr: first, max: 10, default: 0, group: '' };
    }
    case 'resources':
      return { key: '', label: '', max: 10, color: DEFAULT_COLOR, showInCombat: false };
    case 'itemCategories':
    case 'abilityKinds':
      return { key: '', label: '' };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Pure layout helpers. A tab list is `layout.tabs` or `layout.itemTabs`. Every helper returns a
// new list and never mutates its input. Tab moves, adds and removes keep the identity of the tab
// objects; a block edit returns a new object for the one tab it changes (the editor carries the
// new-tab flags over, see RuleEditorWindow.setLayoutTabs). Invalid indexes and refused operations
// return an unchanged copy.
// ---------------------------------------------------------------------------

const NEW_TAB_KEY_STEM = 'tab';
const NEW_TAB_LABEL = 'Tab';
const TAB_KEY_RE = /^[a-z][a-z0-9_]{0,23}$/;

function isIndexIn(index, length) {
  return Number.isInteger(index) && index >= 0 && index < length;
}

function tabListCopy(layoutTabs) {
  return Array.isArray(layoutTabs) ? layoutTabs.slice() : [];
}

function blocksOf(tab) {
  return Array.isArray(tab?.blocks) ? tab.blocks : [];
}

/** Layout tab list name ('tabs' or 'itemTabs') from a dataset value, or null for anything else. */
export function layoutListName(value) {
  return LAYOUT_TAB_LISTS.includes(value) ? value : null;
}

/** Blocks that no tab of the list lists, in the order of `allBlocks`. These are the blocks the
 * add-block choice offers. */
export function unplacedBlocks(layoutTabs, allBlocks) {
  if (!Array.isArray(allBlocks)) return [];
  const placed = new Set();
  if (Array.isArray(layoutTabs)) {
    for (const tab of layoutTabs) for (const block of blocksOf(tab)) placed.add(block);
  }
  return allBlocks.filter((block) => typeof block === 'string' && !placed.has(block));
}

/** Free key for a tab built from `label`: a slug that matches the config grammar, unique in the
 * list. `ignoreIndex` skips one tab (the tab being renamed). */
export function tabKeyFor(layoutTabs, label, ignoreIndex = -1) {
  const taken = new Set();
  if (Array.isArray(layoutTabs)) {
    layoutTabs.forEach((tab, index) => {
      if (index !== ignoreIndex && isPlainObject(tab) && typeof tab.key === 'string') taken.add(tab.key);
    });
  }
  let base = slug(typeof label === 'string' ? label : '');
  if (!TAB_KEY_RE.test(base)) base = NEW_TAB_KEY_STEM;
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) {
    candidate = `${base.slice(0, 20).replace(/_+$/, '')}_${n}`;
  }
  return candidate;
}

/** Copy of the list where tab `tabIndex` is replaced by a new object with the given blocks. */
function withTabBlocks(out, tabIndex, blocks) {
  out[tabIndex] = { ...out[tabIndex], blocks };
  return out;
}

/** Moves block `blockIndex` of tab `tabIndex` up (dir -1) or down (dir 1) inside that tab. */
export function moveBlock(layoutTabs, tabIndex, blockIndex, dir) {
  const out = tabListCopy(layoutTabs);
  if (!isIndexIn(tabIndex, out.length) || !isPlainObject(out[tabIndex])) return out;
  const blocks = blocksOf(out[tabIndex]).slice();
  const target = dir === -1 ? blockIndex - 1 : dir === 1 ? blockIndex + 1 : blockIndex;
  if (!isIndexIn(blockIndex, blocks.length) || !isIndexIn(target, blocks.length) || target === blockIndex) return out;
  [blocks[blockIndex], blocks[target]] = [blocks[target], blocks[blockIndex]];
  return withTabBlocks(out, tabIndex, blocks);
}

/** Appends `block` to tab `tabIndex`. Refused when the block is already on any tab of the list,
 * when the block name is not text, or when the tab already holds the maximum number of blocks. */
export function addBlock(layoutTabs, tabIndex, block) {
  const out = tabListCopy(layoutTabs);
  if (!isIndexIn(tabIndex, out.length) || !isPlainObject(out[tabIndex])) return out;
  if (typeof block !== 'string' || block === '') return out;
  if (unplacedBlocks(out, [block]).length === 0) return out;
  const blocks = blocksOf(out[tabIndex]);
  if (blocks.length >= LAYOUT_LIMITS.maxBlocksPerTab) return out;
  return withTabBlocks(out, tabIndex, [...blocks, block]);
}

/** Removes block `blockIndex` from tab `tabIndex`. The block is then unplaced, and it shows in the
 * first tab until another tab takes it. */
export function removeBlock(layoutTabs, tabIndex, blockIndex) {
  const out = tabListCopy(layoutTabs);
  if (!isIndexIn(tabIndex, out.length) || !isPlainObject(out[tabIndex])) return out;
  const blocks = blocksOf(out[tabIndex]).slice();
  if (!isIndexIn(blockIndex, blocks.length)) return out;
  blocks.splice(blockIndex, 1);
  return withTabBlocks(out, tabIndex, blocks);
}

/** Appends an empty tab with two columns and a key built from `label`. Refused at the tab maximum. */
export function addTab(layoutTabs, label) {
  const out = tabListCopy(layoutTabs);
  if (out.length >= LAYOUT_LIMITS.maxTabs) return out;
  const text = typeof label === 'string'
    ? label.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, LAYOUT_LIMITS.label).trim()
    : '';
  const shown = text || NEW_TAB_LABEL;
  out.push({
    key: tabKeyFor(out, shown),
    label: shown,
    columns: LAYOUT_LIMITS.defaultColumns,
    blocks: [],
  });
  return out;
}

/** Removes tab `tabIndex`. The last remaining tab cannot be removed (a sheet always has one tab). */
export function removeTab(layoutTabs, tabIndex) {
  const out = tabListCopy(layoutTabs);
  if (out.length <= 1 || !isIndexIn(tabIndex, out.length)) return out;
  out.splice(tabIndex, 1);
  return out;
}

/** Moves tab `tabIndex` one place (dir -1 up, 1 down). Out-of-range moves are ignored. */
export function moveTab(layoutTabs, tabIndex, dir) {
  return moveRow(layoutTabs, tabIndex, dir);
}

// ---------------------------------------------------------------------------
// Draft <-> config. The draft keeps abilityKinds as a row list (editable, ordered); the engine
// config keeps it as an object. Everything else is the same shape as the config.
// ---------------------------------------------------------------------------

/** Editor draft from a stored config (sanitized first). */
export function draftFromConfig(cfg) {
  const clean = migrateConfig(cfg);
  const draft = deepClone(clean);
  draft.abilityKinds = Object.keys(clean.abilityKinds).map((key) => ({ key, label: clean.abilityKinds[key] }));
  return draft;
}

/** Engine config from the editor draft. Duplicate kind keys keep the first row. */
export function configFromDraft(draft) {
  const out = deepClone(draft ?? {});
  const kinds = {};
  if (Array.isArray(draft?.abilityKinds)) {
    for (const row of draft.abilityKinds) {
      if (!isPlainObject(row) || typeof row.key !== 'string') continue;
      if (!Object.prototype.hasOwnProperty.call(kinds, row.key)) kinds[row.key] = row.label;
    }
  }
  out.abilityKinds = kinds;
  return out;
}

function sourceSelect(draft, collection, index, sources = [], nestedPath = '') {
  const selected = new Set((sources ?? []).map((s) => `${s.kind}:${s.key}:${s.value ?? (s.kind === 'skill' ? 'rank' : 'configured')}`));
  const options = [['', T('sandbox.editor.sourceNone', 'No source')]];
  const valid = new Set();
  for (const row of draft.attributes ?? []) {
    for (const [value, label] of [['configured', T('sandbox.editor.attributeValue', 'attribute or modifier')], ['score', T('sandbox.editor.attributeScore', 'full value')], ['modifier', T('sandbox.editor.attributeModifier', 'd20 modifier')]]) {
      const key = `attr:${row.key}:${value}`; valid.add(key); options.push([key, `${esc(row.label)} (${label})`]);
    }
  }
  for (const row of draft.skills ?? []) { const key = `skill:${row.key}:rank`; valid.add(key); options.push([key, `${esc(row.label)} (${T('sandbox.editor.skillRank', 'skill rank')})`]); }
  const opts = options.map(([value, label]) => `<option value="${esc(value)}"${selected.has(value) ? ' selected' : ''}>${label}</option>`).join('');
  const hint = T('sandbox.editor.sourceHint', 'Select the attributes and skills that contribute. A skill never adds its linked attribute automatically.');
  return field(T('sandbox.editor.rollSources', 'Roll sources'), `<select class="ldm-editor-input" title="${esc(hint)}" data-field="sources" data-nested-list="${collection}" data-source-list="${collection}"${nestedPath ? ` data-nested-path="${nestedPath}"` : ''} data-index="${index}">${opts}</select>`);
}

function mechanicSection(draft, name) {
  const root = draft[name] ?? {};
  const saves = name === 'saves';
  const attacks = name === 'attacks';
  const prop = saves ? 'entries' : attacks ? 'profiles' : 'levels';
  const rows = Array.isArray(root[prop]) ? root[prop] : [];
  const attrs = (index) => ` data-nested-list="${name}.${prop}" data-index="${index}"`;
  const remove = (index) => `<button type="button" class="ldm-editor-btn ldm-editor-danger" data-action="ed-nested-remove" data-collection="${name}.${prop}" data-index="${index}">${T('sandbox.editor.remove', 'Remove')}</button>`;
  const content = rows.map((row, i) => {
    const fields = textField('label', T('sandbox.editor.fieldLabel', 'Name'), row.label ?? '', LIMITS.label, attrs(i));
    if (saves) return `<li class="ldm-editor-row"><div class="ldm-editor-row-body ldm-editor-grid">${fields}${numberField('bonus', T('sandbox.editor.bonus', 'Bonus'), row.bonus ?? 0, -99, 99, attrs(i))}${numberField('target', T('sandbox.editor.target', 'Default difficulty'), row.target ?? '', 0, 999, `${attrs(i)} data-nullable-number="true"`)}${sourceSelect(draft, `${name}.${prop}`, i, row.sources)}${checkField('showOnSheet', T('sandbox.editor.showOnSheet', 'Show on character sheet'), row.showOnSheet !== false, attrs(i))}</div>${remove(i)}</li>`;
    if (attacks) return `<li class="ldm-editor-row"><div class="ldm-editor-row-body ldm-editor-grid">${fields}${selectField('mode', T('sandbox.editor.attackDice', 'Attack dice'), [['system', T('sandbox.editor.followSystem', 'Follow system')], ['d20', 'D20'], ['pool', T('sandbox.editor.dicePool', 'Dice pool')]], row.mode ?? 'system', attrs(i))}${numberField('faces', T('sandbox.editor.dieFaces', 'Attack die faces'), row.faces ?? 10, 2, 100, attrs(i))}${numberField('successMin', T('sandbox.editor.attackPoolSuccessOn', 'Attack pool success on'), row.successMin ?? 5, 2, 100, attrs(i))}${numberField('bonus', T('sandbox.editor.bonus', 'Attack bonus'), row.bonus ?? 0, -99, 99, attrs(i))}${numberField('target', T('sandbox.editor.target', 'Default defense'), row.target ?? null, 0, 999, `${attrs(i)} data-nullable-number="true"`)}${sourceSelect(draft, `${name}.${prop}`, i, row.sources)}${selectField('method', T('sandbox.editor.damageMethod', 'Damage method'), [['none', T('sandbox.editor.damageNone', 'No damage')], ['fixed', T('sandbox.editor.damageFixed', 'Fixed value')], ['dice', T('sandbox.editor.damageDice', 'Separate dice roll')], ['successes', T('sandbox.editor.damageSuccesses', 'Attack successes')], ['margin', T('sandbox.editor.damageMargin', 'Margin over defense')], ['pool', T('sandbox.editor.damagePool', 'Separate damage pool')]], row.damage?.method ?? 'none', ` data-nested-list="${name}.${prop}" data-index="${i}" data-nested-path="damage"`)}${numberField('base', T('sandbox.editor.damageBase', 'Base damage'), row.damage?.base ?? 0, -99, 999, ` data-nested-list="${name}.${prop}" data-index="${i}" data-nested-path="damage"`)}${sourceSelect(draft, `${name}.${prop}`, i, row.damage?.sources, 'damage')}${numberField('count', T('sandbox.editor.damageDiceCount', 'Damage dice'), row.damage?.count ?? 1, 1, 100, ` data-nested-list="${name}.${prop}" data-index="${i}" data-nested-path="damage"`)}${numberField('faces', T('sandbox.editor.damageDieFaces', 'Damage die faces'), row.damage?.faces ?? 6, 2, 100, ` data-nested-list="${name}.${prop}" data-index="${i}" data-nested-path="damage"`)}${numberField('successMin', T('sandbox.editor.successMin', 'Pool success on'), row.damage?.successMin ?? 5, 2, 100, ` data-nested-list="${name}.${prop}" data-index="${i}" data-nested-path="damage"`)}${checkField('critPairs', T('sandbox.editor.critPairs', 'Critical pairs add two successes'), row.damage?.critPairs === true, ` data-nested-list="${name}.${prop}" data-index="${i}" data-nested-path="damage"`)}${numberField('critFace', T('sandbox.editor.critFace', 'Critical face'), row.damage?.critFace ?? 10, 2, 100, ` data-nested-list="${name}.${prop}" data-index="${i}" data-nested-path="damage"`)}</div>${remove(i)}</li>`;
    return `<li class="ldm-editor-row"><div class="ldm-editor-row-body ldm-editor-grid">${fields}${numberField('rank', T('sandbox.editor.level', 'Level'), row.rank ?? 0, 0, 20, attrs(i))}${numberField('capacityDefault', T('sandbox.editor.capacity', 'Default slots'), row.capacityDefault ?? 0, 0, 99, attrs(i))}${checkField('free', T('sandbox.editor.freeLevel', 'Free level'), row.free === true, attrs(i))}</div>${remove(i)}</li>`;
  }).join('');
  let body = checkField(`${name}.enabled`, T('sandbox.editor.moduleEnabled', 'Enable this section'), root.enabled !== false);
  if (saves) body += `<ol class="ldm-editor-rows">${content}</ol><button type="button" class="ldm-editor-btn ldm-editor-add" data-action="ed-nested-add" data-collection="saves.entries">${T('sandbox.editor.addSave', 'Add saving throw')}</button>`;
  if (attacks) body += `<ol class="ldm-editor-rows">${content}</ol><button type="button" class="ldm-editor-btn ldm-editor-add" data-action="ed-nested-add" data-collection="attacks.profiles">${T('sandbox.editor.addAttack', 'Add attack')}</button>`;
  if (name === 'magic') {
    const checkRows = (root.checkProfiles ?? []).map((row, i) => `<li class="ldm-editor-row"><div class="ldm-editor-row-body ldm-editor-grid">${textField('label', T('sandbox.editor.fieldLabel', 'Name'), row.label ?? '', LIMITS.label, ` data-nested-list="magic.checkProfiles" data-index="${i}"`)}${selectField('mode', T('sandbox.editor.attackDice', 'Dice mode'), [['system', T('sandbox.editor.followSystem', 'Follow system')], ['d20', 'D20'], ['pool', T('sandbox.editor.dicePool', 'Dice pool')]], row.mode ?? 'system', ` data-nested-list="magic.checkProfiles" data-index="${i}"`)}${numberField('bonus', T('sandbox.editor.bonus', 'Bonus'), row.bonus ?? 0, -99, 99, ` data-nested-list="magic.checkProfiles" data-index="${i}"`)}${numberField('target', T('sandbox.editor.target', 'Difficulty / defense'), row.target ?? null, 0, 999, ` data-nested-list="magic.checkProfiles" data-index="${i}" data-nullable-number="true"`)}${sourceSelect(draft, 'magic.checkProfiles', i, row.sources)}</div><button type="button" class="ldm-editor-btn ldm-editor-danger" data-action="ed-nested-remove" data-collection="magic.checkProfiles" data-index="${i}">${T('sandbox.editor.remove', 'Remove')}</button></li>`).join('');
    body += `${selectField('magic.defaultMethod', T('sandbox.editor.defaultCastingMethod', 'Default casting method'), [['free', T('sandbox.editor.methodFree', 'Free')], ['resource', T('sandbox.editor.methodResource', 'Resource points')], ['spontaneous', T('sandbox.editor.methodSpontaneous', 'Spontaneous slots')], ['prepared', T('sandbox.editor.methodPrepared', 'Prepared / Vancian')], ['uses', T('sandbox.editor.methodUses', 'Uses per spell')], ['check', T('sandbox.editor.methodCheck', 'Casting check')]], root.defaultMethod ?? 'resource')}${selectField('magic.recovery', T('sandbox.editor.recovery', 'Recovery'), [['manual', T('sandbox.editor.recoveryManual', 'Manual')], ['shortRest', T('sandbox.editor.recoveryShort', 'Short rest')], ['longRest', T('sandbox.editor.recoveryLong', 'Long rest')]], root.recovery ?? 'manual')}<fieldset class="ldm-editor-subsection"><legend>${T('sandbox.editor.enabledMethods', 'Methods available to spells')}</legend>${[['free','methodFree','Free'],['resource','methodResource','Resource points'],['spontaneous','methodSpontaneous','Spontaneous slots'],['prepared','methodPrepared','Prepared / Vancian'],['uses','methodUses','Uses per spell'],['check','methodCheck','Casting check']].map(([method,key,fallback])=>`<label class="ldm-editor-check"><input type="checkbox" data-field="magic.methods" data-method="${method}"${(root.methods ?? []).includes(method) ? ' checked' : ''}><span>${T(`sandbox.editor.${key}`,fallback)}</span></label>`).join('')}</fieldset><ol class="ldm-editor-rows">${content}</ol><button type="button" class="ldm-editor-btn ldm-editor-add" data-action="ed-nested-add" data-collection="magic.levels">${T('sandbox.editor.addLevel', 'Add spell level')}</button><h4 class="ldm-editor-h4">${T('sandbox.editor.castingProfiles', 'Casting check profiles')}</h4><ol class="ldm-editor-rows">${checkRows}</ol><button type="button" class="ldm-editor-btn ldm-editor-add" data-action="ed-nested-add" data-collection="magic.checkProfiles">${T('sandbox.editor.addCastingProfile', 'Add casting check')}</button>`;
  }
  const title = saves ? T('sandbox.editor.sectionSaves', 'Saving throws') : attacks ? T('sandbox.editor.sectionAttacks', 'Attacks and damage') : T('sandbox.editor.sectionMagic', 'Magic');
  const hint = saves ? T('sandbox.editor.savesHint', 'Choose attributes and skills for each save; character adjustments are stored separately.') : attacks ? T('sandbox.editor.attacksHint', 'Configure attack sources and damage behavior. Result-based damage is calculated from the actual chat roll.') : T('sandbox.editor.magicHint', 'Choose how spells consume resources and how recovery works.');
  return section(name, title, hint, body);
}

/** Errors that stop saving: every validateConfig message plus editor-only checks. */
export function draftErrors(draft) {
  const errors = [];
  const seen = new Set();
  if (Array.isArray(draft?.abilityKinds)) {
    for (const row of draft.abilityKinds) {
      const key = row?.key;
      if (typeof key !== 'string' || key === '') continue;
      if (seen.has(key)) errors.push(translate('sandbox.editor.duplicateKind', 'Item kind keys must be unique.'));
      seen.add(key);
    }
  }
  return [...errors, ...validateConfig(configFromDraft(draft)).errors];
}

/** Stable text of a config, used to compare the draft with the last saved state. */
export function baselineOf(cfg) {
  return JSON.stringify(configFromDraft(draftFromConfig(cfg)));
}

/** True when the draft differs from the last saved (or loaded) config. */
export function isDirty(state) {
  if (typeof state?.baseline !== 'string') return true;
  return JSON.stringify(configFromDraft(state.draft)) !== state.baseline;
}

/** Sets a dotted path (for example `dice.d20.sides`) in place. Paths come from this file only. */
export function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(cur[part])) cur[part] = {};
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

/** Full editor state for a config. Rows are not editable by key until added or loaded as a draft. */
export function createEditorState(cfg, { readOnly = false } = {}) {
  const source = cfg ?? defaultConfig();
  return {
    loading: false,
    readOnly,
    saving: false,
    stale: false,
    draft: draftFromConfig(source),
    baseline: baselineOf(source),
    pending: null,
    preset: 'd20Classic',
    section: 'dice',
    notice: null,
    importText: '',
    importErrors: [],
    exportText: '',
    keyEditable: new WeakSet(),
    autoKey: new WeakSet(),
  };
}

/** Marks every row and layout tab of a draft as having an editable key (presets, imports, reset). */
export function markKeysEditable(state) {
  for (const list of LIST_NAMES) {
    for (const row of state.draft[list] ?? []) state.keyEditable.add(row);
  }
  for (const name of LAYOUT_TAB_LISTS) {
    for (const tab of state.draft.layout?.[name] ?? []) state.keyEditable.add(tab);
  }
}

// ---------------------------------------------------------------------------
// Pure renderers
// ---------------------------------------------------------------------------

function colorOf(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : DEFAULT_COLOR;
}

function attrString(map) {
  let out = '';
  for (const [name, value] of Object.entries(map)) {
    if (value === undefined || value === null || value === false) continue;
    out += value === true ? ` ${name}` : ` ${name}="${esc(value)}"`;
  }
  return out;
}

function rowAttrs(list, index) {
  return ` data-list="${esc(list)}" data-index="${index}"`;
}

function field(labelHtml, control, hint = '') {
  return `<label class="ldm-editor-field"><span class="ldm-editor-label">${labelHtml}</span>${control}${hint ? `<span class="ldm-editor-hint">${hint}</span>` : ''}</label>`;
}

function textField(prop, labelHtml, value, maxlength, extra = '') {
  const attrs = attrString({ type: 'text', class: 'ldm-editor-input', 'data-field': prop, value, maxlength, autocomplete: 'off' });
  return field(labelHtml, `<input${attrs}${extra}>`);
}

function numberField(prop, labelHtml, value, min, max, extra = '') {
  const attrs = attrString({
    type: 'number',
    class: 'ldm-editor-input',
    'data-field': prop,
    value: value === undefined || value === null ? '' : String(value),
    min,
    max,
    step: 1,
  });
  return field(labelHtml, `<input${attrs}${extra}>`);
}

function checkField(prop, labelHtml, checked, extra = '') {
  const attrs = attrString({ type: 'checkbox', 'data-field': prop, checked: checked === true });
  return `<label class="ldm-editor-check"><input${attrs}${extra}><span>${labelHtml}</span></label>`;
}

function selectField(prop, labelHtml, options, selected, extra = '') {
  const opts = options
    .map(([value, text]) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${text}</option>`)
    .join('');
  return field(labelHtml, `<select class="ldm-editor-input" data-field="${esc(prop)}"${extra}>${opts}</select>`);
}

function colorField(prop, labelHtml, value, extra = '') {
  const attrs = attrString({ type: 'color', class: 'ldm-editor-color', 'data-field': prop, value: colorOf(value) });
  return field(labelHtml, `<input${attrs}${extra}>`);
}

function section(id, titleHtml, hintHtml, body) {
  return `<section class="ldm-editor-section" aria-labelledby="ldm-editor-h-${id}">
  <h3 class="ldm-editor-h3" id="ldm-editor-h-${id}">${titleHtml}</h3>
  ${hintHtml ? `<p class="ldm-editor-hint">${hintHtml}</p>` : ''}
  ${body}
</section>`;
}

function rowTools(listName, index, count) {
  const at = rowAttrs(listName, index);
  return `<div class="ldm-editor-row-tools">
    <button type="button" class="ldm-editor-btn" data-action="ed-move" data-dir="-1"${at}${index === 0 ? ' disabled' : ''}>${T('sandbox.editor.up', 'Up')}</button>
    <button type="button" class="ldm-editor-btn" data-action="ed-move" data-dir="1"${at}${index >= count - 1 ? ' disabled' : ''}>${T('sandbox.editor.down', 'Down')}</button>
    <button type="button" class="ldm-editor-btn ldm-editor-danger" data-action="ed-remove"${at}>${T('sandbox.editor.remove', 'Remove')}</button>
  </div>`;
}

function keyField(listName, index, row, state) {
  const summary = `<summary>${T('sandbox.editor.internalId', 'Internal identifier (advanced)')}</summary>`;
  if (!state.keyEditable?.has(row)) {
    return `<details class="ldm-editor-key-details">${summary}<div class="ldm-editor-field"><span class="ldm-editor-label">${T('sandbox.editor.fieldKey', 'Key')}</span><code class="ldm-editor-key">${esc(row.key)}</code><span class="ldm-editor-hint">${T('sandbox.editor.keyFixed', 'Key is fixed once saved; actors store values under it.')}</span></div></details>`;
  }
  const hint = state.autoKey?.has(row) ? T('sandbox.editor.keyHint', 'Created from the label; you can change it until you save.') : '';
  const attrs = attrString({
    type: 'text',
    class: 'ldm-editor-input',
    'data-field': 'key',
    value: row.key,
    maxlength: 24,
    spellcheck: 'false',
    autocomplete: 'off',
  });
  return `<details class="ldm-editor-key-details">${summary}${field(T('sandbox.editor.fieldKey', 'Key'), `<input${attrs}${rowAttrs(listName, index)}>`, hint)}</details>`;
}

/** Optional group text of an attribute or skill row (empty means no group). */
function groupField(listName, index, row) {
  const placeholder = ` placeholder="${T('sandbox.editor.groupPlaceholder', 'optional')}"`;
  return textField('group', T('sandbox.editor.group', 'Group'), row.group ?? '', LIMITS.group, `${rowAttrs(listName, index)}${placeholder}`);
}

function listSection(id, titleKey, titleFallback, hintKey, hintFallback, listName, rows, state, renderFields, addKey, addFallback) {
  const max = LIMITS[listName];
  const full = rows.length >= max;
  const body = rows.length === 0
    ? `<p class="ldm-editor-empty">${T('sandbox.editor.empty', 'Nothing here yet. Add the first one.')}</p>`
    : `<ol class="ldm-editor-rows">${rows
      .map((row, index) => `<li class="ldm-editor-row">
        <div class="ldm-editor-row-body">${renderFields(row, index)}</div>
        ${rowTools(listName, index, rows.length)}
      </li>`)
      .join('')}</ol>`;
  const add = `<div class="ldm-editor-actions">
    <button type="button" class="ldm-editor-btn ldm-editor-add" data-action="ed-add" data-list="${esc(listName)}"${full ? ' disabled' : ''}>${T(addKey, addFallback)}</button>
    ${full ? `<span class="ldm-editor-hint">${TV('sandbox.editor.limitReached', 'Limit reached ({max}).', { max })}</span>` : ''}
  </div>`;
  return section(id, T(titleKey, titleFallback), T(hintKey, hintFallback), body + add);
}

function attributeOptions(draft, selected) {
  const attrs = Array.isArray(draft.attributes) ? draft.attributes : [];
  const options = [['', T('sandbox.editor.noAttribute', 'None')]];
  for (const a of attrs) options.push([String(a.key ?? ''), esc(a.label || a.key || '')]);
  if (selected && !attrs.some((a) => a.key === selected)) options.push([selected, esc(selected)]);
  return options;
}

function diceSection(draft, cfg) {
  const mode = draft.dice?.mode === 'pool' ? 'pool' : 'd20';
  const d20 = draft.dice?.d20 ?? {};
  const pool = draft.dice?.pool ?? {};
  const modeSelect = selectField(
    'dice.mode',
    T('sandbox.editor.diceMode', 'Dice system'),
    [['d20', T('sandbox.editor.singleDie', 'One die + bonuses')], ['pool', T('sandbox.editor.dicePool', 'Dice pool')]],
    mode,
  );
  const fields = mode === 'pool'
    ? numberField('dice.pool.faces', T('sandbox.editor.faces', 'Die faces'), pool.faces, 2, 100)
      + numberField('dice.pool.successMin', T('sandbox.editor.successMin', 'Success on'), pool.successMin, 2, 100)
      + numberField('dice.pool.maxDice', T('sandbox.editor.maxDice', 'Maximum dice'), pool.maxDice, 1, 50)
      + checkField('dice.pool.glitchOnOnes', T('sandbox.editor.glitchOnOnes', 'Glitch when most dice show 1'), pool.glitchOnOnes === true)
    : numberField('dice.d20.sides', T('sandbox.editor.sides', 'Die sides'), d20.sides, 2, 100)
      + numberField('dice.d20.critMin', T('sandbox.editor.critMin', 'Critical on'), d20.critMin, 2, 100)
      + numberField('dice.d20.fumbleMax', T('sandbox.editor.fumbleMax', 'Fumble on'), d20.fumbleMax, 1, 100)
      + textField('dice.d20.targetLabel', T('sandbox.editor.targetLabel', 'Target label'), d20.targetLabel ?? '', LIMITS.targetLabel);
  const faces = mode === 'pool' ? pool.faces : d20.sides;
  const choices = `<div class="ldm-editor-dice-choices" role="group" aria-label="${T('sandbox.editor.chooseDie', 'Choose your die')}">${[4, 6, 8, 10, 12, 20, 100].map((n) => `<button type="button" class="ldm-editor-btn ldm-editor-btn--die" data-action="ed-die" data-faces="${n}" aria-pressed="${Number(faces) === n}"><span class="ldm-die-symbol">🎲</span><span class="ldm-die-label">D${n}</span></button>`).join('')}</div>`;
  const explanation = mode === 'pool'
    ? T('sandbox.editor.poolHelp', 'Attribute + skill + bonus determines how many dice to roll. Each die at or above the success threshold counts as one success. Advantage adds a die; disadvantage removes one.')
    : T('sandbox.editor.singleHelp', 'Roll one die and add the attribute, skill and bonus. Meet or beat the target to succeed. Advantage rolls two dice and keeps the higher; disadvantage keeps the lower.');
  const body = `${modeSelect}${choices}<p class="ldm-editor-hint">${explanation}</p><p class="ldm-editor-summary" aria-live="polite">${esc(describeDice(cfg))}</p><div class="ldm-editor-grid">${fields}</div>${renderPreview(cfg)}`;
  return section('dice', T('sandbox.editor.sectionDice', 'Dice'), '', body);
}

function cardSection(draft, cfg) {
  const card = draft.card ?? {};
  const body = `<div class="ldm-editor-grid">
    ${selectField('card.style', T('sandbox.editor.cardStyle', 'Style'), [
      ['detailed', T('sandbox.editor.styleDetailed', 'Detailed')],
      ['compact', T('sandbox.editor.styleCompact', 'Compact')],
    ], card.style === 'compact' ? 'compact' : 'detailed')}
    ${colorField('card.accent', T('sandbox.editor.accent', 'Accent color'), card.accent)}
    ${checkField('card.showFormula', T('sandbox.editor.showFormula', 'Show formula'), card.showFormula === true)}
    ${checkField('card.showDice', T('sandbox.editor.showDice', 'Show dice'), card.showDice === true)}
    ${textField('card.header', T('sandbox.editor.header', 'Header'), card.header ?? '', LIMITS.headerMax)}
    ${textField('card.successLabel', T('sandbox.editor.successLabel', 'Success word'), card.successLabel ?? '', LIMITS.cardLabel)}
    ${textField('card.critLabel', T('sandbox.editor.critLabel', 'Critical label'), card.critLabel ?? '', LIMITS.cardLabel)}
    ${textField('card.fumbleLabel', T('sandbox.editor.fumbleLabel', 'Fumble label'), card.fumbleLabel ?? '', LIMITS.cardLabel)}
  </div>
  <p class="ldm-editor-hint">${T('sandbox.editor.headerHint', 'Tokens: {actor}, {label}, {result}.')}</p>
  <div class="ldm-editor-preview-wrap">
    <h4 class="ldm-editor-h4">${T('sandbox.editor.previewTitle', 'Preview (sample roll)')}</h4>
    ${renderPreview(cfg)}
  </div>`;
  return section('card', T('sandbox.editor.sectionCard', 'Chat card'), '', body);
}

function combatSection(draft, cfg) {
  const init = draft.combat?.initiative ?? {};
  const body = `<div class="ldm-editor-grid">
    ${selectField('combat.initiative.mode', T('sandbox.editor.initMode', 'Initiative'), [
      ['roll', T('sandbox.editor.initRoll', 'Roll (check)')],
      ['attribute', T('sandbox.editor.initAttribute', 'Attribute value')],
      ['fixed', T('sandbox.editor.initFixed', 'Fixed bonus')],
    ], init.mode ?? 'attribute')}
    ${selectField('combat.initiative.attr', T('sandbox.editor.initAttr', 'Attribute used'), attributeOptions(draft, init.attr ?? ''), init.attr ?? '')}
    ${numberField('combat.initiative.bonus', T('sandbox.editor.initBonus', 'Bonus'), init.bonus ?? 0, -LIMITS.bonusBound, LIMITS.bonusBound)}
  </div>
  <p class="ldm-editor-summary" aria-live="polite">${describeInitiative(cfg)}</p>
  <h4 class="ldm-editor-h4">${T('sandbox.editor.trackerResources', 'Resources in the combat tracker')}</h4>
  <p class="ldm-editor-hint">${T('sandbox.editor.trackerHelp', 'Choose which resources appear beside combatants. Create or rename resources in Resources. Initiative uses the dice selected in Dice; the core orders higher totals first.')}</p>
  <div class="ldm-editor-grid">${(draft.resources ?? []).map((row, index) => checkField('showInCombat', esc(row.label || row.key), row.showInCombat === true, rowAttrs('resources', index))).join('')}</div>`;
  return section('combat', T('sandbox.editor.sectionCombat', 'Combat'), '', body);
}

/** Localized one-line summary of the initiative rule (already escaped). */
function describeInitiative(cfg) {
  const init = cfg.combat.initiative;
  const attr = cfg.attributes.find((a) => a.key === init.attr)?.label || '-';
  const vars = { attr, bonus: init.bonus };
  if (init.mode === 'roll') {
    return TV('sandbox.editor.initSummaryRoll', 'Initiative: check roll plus {attr} and bonus {bonus}.', vars);
  }
  if (init.mode === 'fixed') {
    return TV('sandbox.editor.initSummaryFixed', 'Initiative: fixed bonus {bonus}.', vars);
  }
  return TV('sandbox.editor.initSummaryAttr', 'Initiative: {attr} value plus bonus {bonus}.', vars);
}

/** Raw (unescaped) localized name of a layout block in a scope. Escape it before it reaches HTML. */
function blockName(block, scope) {
  return translate(blockLabelKey(block, scope), BLOCK_FALLBACK[block] ?? String(block ?? ''));
}

function tabAttrs(listName, index) {
  return ` data-tab-list="${esc(listName)}" data-index="${index}"`;
}

/** Key of a layout tab: read-only once saved, editable (auto-slugged from the label) when new. */
function tabKeyField(listName, index, tab, s) {
  if (!s.keyEditable?.has(tab)) {
    return `<div class="ldm-editor-field"><span class="ldm-editor-label">${T('sandbox.editor.fieldKey', 'Key')}</span><code class="ldm-editor-key">${esc(tab.key)}</code><span class="ldm-editor-hint">${T('sandbox.editor.tabKeyFixed', 'Key is fixed once saved.')}</span></div>`;
  }
  const hint = s.autoKey?.has(tab) ? T('sandbox.editor.keyHint', 'Created from the label; you can change it until you save.') : '';
  const attrs = attrString({
    type: 'text',
    class: 'ldm-editor-input',
    'data-field': 'key',
    value: tab.key,
    maxlength: 24,
    spellcheck: 'false',
    autocomplete: 'off',
  });
  return field(T('sandbox.editor.fieldKey', 'Key'), `<input${attrs}${tabAttrs(listName, index)}>`, hint);
}

/** One tab of a layout list: fields, move and remove tools, its blocks as chips, and the add-block choice. */
function tabRow(meta, tabs, tab, index, s) {
  const at = tabAttrs(meta.list, index);
  const blocks = Array.isArray(tab.blocks) ? tab.blocks : [];
  const columnOptions = [1, 2, 3, 4].map((n) => [String(n), String(n)]);
  const fields = `<div class="ldm-editor-grid">${tabKeyField(meta.list, index, tab, s)}`
    + textField('label', T('sandbox.editor.fieldLabel', 'Label'), tab.label ?? '', LIMITS.label, at)
    + selectField('columns', T('sandbox.editor.columns', 'Columns'), columnOptions, String(clampColumns(tab.columns)), at)
    + '</div>';
  const last = tabs.length - 1;
  const tools = `<div class="ldm-editor-row-tools">
    <button type="button" class="ldm-editor-btn" data-action="ed-tab-move" data-dir="-1"${at}${index === 0 ? ' disabled' : ''}>${T('sandbox.editor.up', 'Up')}</button>
    <button type="button" class="ldm-editor-btn" data-action="ed-tab-move" data-dir="1"${at}${index >= last ? ' disabled' : ''}>${T('sandbox.editor.down', 'Down')}</button>
    <button type="button" class="ldm-editor-btn ldm-editor-danger" data-action="ed-tab-remove"${at}${tabs.length <= 1 ? ' disabled' : ''}>${T('sandbox.editor.remove', 'Remove')}</button>
  </div>`;

  const chips = blocks.map((block, bi) => {
    const name = blockName(block, meta.scope);
    const blockAt = `${at} data-block="${bi}" data-layout-block="${esc(block)}"`;
    return `<li class="ldm-editor-chip">
      <span class="ldm-editor-chip-name">${esc(name)}</span>
      ${meta.scope === 'actor' ? `<select class="ldm-editor-input" data-field="blockSpan"${blockAt} aria-label="${T('sandbox.editor.blockWidth', 'Block width')}"><option value="auto"${tab.blockSpans?.[block] !== 'full' ? ' selected' : ''}>${T('sandbox.editor.widthAuto', 'Automatic')}</option><option value="full"${tab.blockSpans?.[block] === 'full' ? ' selected' : ''}>${T('sandbox.editor.widthFull', 'Full width')}</option></select>` : ''}
      <span class="ldm-editor-chip-tools">
        <button type="button" class="ldm-editor-btn" data-action="ed-block-move" data-dir="-1"${blockAt}${bi === 0 ? ' disabled' : ''} aria-label="${TV('sandbox.editor.blockUp', 'Move {name} up', { name })}">${T('sandbox.editor.up', 'Up')}</button>
        <button type="button" class="ldm-editor-btn" data-action="ed-block-move" data-dir="1"${blockAt}${bi >= blocks.length - 1 ? ' disabled' : ''} aria-label="${TV('sandbox.editor.blockDown', 'Move {name} down', { name })}">${T('sandbox.editor.down', 'Down')}</button>
        <button type="button" class="ldm-editor-btn ldm-editor-danger" data-action="ed-block-remove"${blockAt} aria-label="${TV('sandbox.editor.blockRemove', 'Remove {name}', { name })}">${T('sandbox.editor.remove', 'Remove')}</button>
      </span>
    </li>`;
  }).join('');
  const chipBlock = blocks.length
    ? `<ul class="ldm-editor-chips" aria-label="${T('sandbox.editor.blocksOnTab', 'Blocks on this tab')}">${chips}</ul>`
    : `<p class="ldm-editor-hint">${T('sandbox.editor.tabEmpty', 'No blocks on this tab yet.')}</p>`;

  const free = unplacedBlocks(tabs, meta.blocks);
  const none = free.length === 0 || blocks.length >= LAYOUT_LIMITS.maxBlocksPerTab;
  const options = free
    .map((block) => `<option value="${esc(block)}">${esc(blockName(block, meta.scope))}</option>`)
    .join('');
  const addRow = `<div class="ldm-editor-actions">
    <select class="ldm-editor-input" data-block-select aria-label="${T('sandbox.editor.blockPick', 'Block to add')}"${none ? ' disabled' : ''}>
      <option value="">${none ? T('sandbox.editor.noBlocksLeft', 'No blocks left to add.') : T('sandbox.editor.blockPickNone', 'Choose a block...')}</option>${none ? '' : options}
    </select>
    <button type="button" class="ldm-editor-btn" data-action="ed-block-add"${at}${none ? ' disabled' : ''}>${T('sandbox.editor.blockAdd', 'Add block')}</button>
  </div>`;

  return `<li class="ldm-editor-row">
    <div class="ldm-editor-row-body">
      ${fields}
      <div class="ldm-editor-blocks"><span class="ldm-editor-label">${T('sandbox.editor.blocks', 'Blocks')}</span>${chipBlock}${addRow}</div>
    </div>
    ${tools}
  </li>`;
}

/**
 * Schematic preview of a resolved tab list: tab names, column count and one box per block.
 * Boxes only (no real sheet). Every label is escaped; `aria-hidden` because the lists above
 * carry the same information.
 */
export function renderLayoutPreview(tabs, scope = 'actor') {
  const list = Array.isArray(tabs) ? tabs : [];
  if (list.length === 0) return '';
  const body = list.map((tab) => {
    const blocks = Array.isArray(tab.blocks) ? tab.blocks : [];
    const cols = clampColumns(tab.columns);
    const boxes = blocks.length
      ? blocks.map((block) => `<span class="ldm-editor-lp-box">${esc(blockName(block, scope))}</span>`).join('')
      : `<span class="ldm-editor-lp-box is-empty">${T('sandbox.editor.tabEmpty', 'No blocks on this tab yet.')}</span>`;
    return `<div class="ldm-editor-lp-tab">
      <div class="ldm-editor-lp-bar"><span class="ldm-editor-lp-chip">${esc(tab.label)}</span><span class="ldm-editor-hint">${TV('sandbox.editor.previewColumns', '{count} columns', { count: cols })}</span></div>
      <div class="ldm-editor-lp-grid" style="--ldm-editor-cols:${cols}">${boxes}</div>
    </div>`;
  }).join('');
  return `<div class="ldm-editor-layout-preview" aria-hidden="true">${body}</div>`;
}

/** One sheet of the layout section (actor or item): its tabs, the unplaced-block notice and the preview. */
function layoutPart(kind, draft, cfg, s) {
  const meta = LAYOUT_SCOPES[kind];
  const tabs = Array.isArray(draft.layout?.[meta.list]) ? draft.layout[meta.list] : [];
  const full = tabs.length >= LAYOUT_LIMITS.maxTabs;
  const rows = tabs.map((tab, index) => tabRow(meta, tabs, tab, index, s)).join('');
  const resolved = meta.resolve(cfg).tabs;
  const missing = unplacedBlocks(cfg.layout?.[meta.list] ?? [], meta.blocks);
  const notice = missing.length
    ? `<p class="ldm-editor-notice is-info" role="status">${TV('sandbox.editor.unplacedNotice', 'Not on any tab: {blocks}. They appear in the first tab, "{tab}".', {
      blocks: missing.map((block) => blockName(block, meta.scope)).join(', '),
      tab: resolved[0]?.label ?? '',
    })}</p>`
    : '';
  const add = `<div class="ldm-editor-actions">
    <button type="button" class="ldm-editor-btn ldm-editor-add" data-action="ed-tab-add" data-tab-list="${esc(meta.list)}"${full ? ' disabled' : ''}>${T('sandbox.editor.addTab', 'Add tab')}</button>
    ${full ? `<span class="ldm-editor-hint">${TV('sandbox.editor.limitReached', 'Limit reached ({max}).', { max: LAYOUT_LIMITS.maxTabs })}</span>` : ''}
  </div>`;
  return `<div class="ldm-editor-subsection" data-ldm-layout="${esc(meta.scope)}">
    <h4 class="ldm-editor-h4" id="ldm-editor-layout-${esc(meta.scope)}">${T(meta.titleKey, meta.titleFallback)}</h4>
    <ol class="ldm-editor-rows">${rows}</ol>
    ${add}
    ${notice}
    <p class="ldm-editor-hint">${T('sandbox.editor.effectsAlways', 'Effects is always shown on the sheet, even when no tab lists it. You can move it to any tab.')}</p>
    <h5 class="ldm-editor-h4">${T('sandbox.editor.sheetPreview', 'Sheet preview')}</h5>
    ${renderLayoutPreview(resolved, meta.scope)}
  </div>`;
}

/** Layout section: density and skill grouping, then the actor and item sheet tab lists. */
function layoutSection(draft, cfg, s) {
  const layout = draft.layout ?? {};
  const density = layout.density === 'compact' ? 'compact' : 'comfortable';
  const grouping = LAYOUT_SKILL_GROUPINGS.includes(layout.skillGrouping) ? layout.skillGrouping : 'attribute';
  const global = `<div class="ldm-editor-grid">
    ${selectField('layout.density', T('sandbox.editor.density', 'Density'), [
      ['comfortable', T('sandbox.editor.densityComfortable', 'Comfortable')],
      ['compact', T('sandbox.editor.densityCompact', 'Compact')],
    ], density)}
    ${selectField('layout.skillGrouping', T('sandbox.editor.skillGrouping', 'Group skills by'), [
      ['attribute', T('sandbox.editor.groupByAttribute', 'Attribute')],
      ['group', T('sandbox.editor.groupByGroup', 'Group field')],
      ['none', T('sandbox.editor.groupNone', 'No grouping')],
    ], grouping)}
  </div>`;
  const body = `${global}${layoutPart('actor', draft, cfg, s)}${layoutPart('item', draft, cfg, s)}`;
  return section('layout', T('sandbox.editor.sectionLayout', 'Layout'), T('sandbox.editor.layoutHint', 'Choose the tabs of each sheet and the blocks each tab shows. A block that no tab lists appears in the first tab.'), body);
}

/** Section tab titles: [language key, English fallback]. Raw text is escaped by renderTabs. */
const SECTION_TITLES = Object.freeze({
  dice: ['sandbox.editor.sectionDice', 'Dice'],
  attributes: ['sandbox.editor.sectionAttributes', 'Attributes'],
  skills: ['sandbox.editor.sectionSkills', 'Skills'],
  saves: ['sandbox.editor.sectionSaves', 'Saving throws'],
  attacks: ['sandbox.editor.sectionAttacks', 'Attacks'],
  magic: ['sandbox.editor.sectionMagic', 'Magic'],
  resources: ['sandbox.editor.sectionResources', 'Resources'],
  categories: ['sandbox.editor.sectionCategories', 'Item categories'],
  kinds: ['sandbox.editor.sectionKinds', 'Item kinds'],
  layout: ['sandbox.editor.sectionLayout', 'Layout'],
  card: ['sandbox.editor.sectionCard', 'Chat card'],
  combat: ['sandbox.editor.sectionCombat', 'Combat'],
  io: ['sandbox.editor.sectionIO', 'Import and export'],
});

function ioSection(state) {
  const errors = state.importErrors?.length
    ? `<div class="ldm-editor-errors" aria-live="polite"><p>${T('sandbox.editor.importErrors', 'Import refused:')}</p><ul>${state.importErrors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`
    : '';
  const body = `
    <label class="ldm-editor-field"><span class="ldm-editor-label">${T('sandbox.editor.import', 'Import')}</span>
      <textarea class="ldm-editor-textarea" data-state="importText" spellcheck="false" aria-describedby="ldm-editor-import-hint">${esc(state.importText ?? '')}</textarea>
    </label>
    <p class="ldm-editor-hint" id="ldm-editor-import-hint">${T('sandbox.editor.importHint', 'Paste JSON, then import. Nothing changes until you import.')}</p>
    <div class="ldm-editor-actions">
      <button type="button" class="ldm-editor-btn" data-action="ed-import">${T('sandbox.editor.importAction', 'Import JSON')}</button>
      <button type="button" class="ldm-editor-btn" data-action="ed-export">${T('sandbox.editor.exportAction', 'Export JSON')}</button>
    </div>
    ${errors}
    <label class="ldm-editor-field"><span class="ldm-editor-label">${T('sandbox.editor.export', 'Export')}</span>
      <textarea class="ldm-editor-textarea" readonly spellcheck="false">${esc(state.exportText ?? '')}</textarea>
    </label>
    <p class="ldm-editor-hint">${T('sandbox.editor.exportHint', 'Copy this JSON to keep a backup or share a system.')}</p>`;
  return section('io', T('sandbox.editor.sectionIO', 'Import and export'), '', body);
}

function presetName(key) {
  if (key === 'd6Pool') return T('sandbox.editor.presetD6Pool', 'Dice pool (d6)');
  return T('sandbox.editor.presetD20Classic', 'Classic d20');
}

function pendingBar(state) {
  if (!state.pending) return '';
  const message = state.pending.kind === 'reset'
    ? T('sandbox.editor.confirmReset', 'Reset the draft to the default rules? Unsaved changes will be lost.')
    : TV('sandbox.editor.confirmPreset', 'Replace the current draft with the "{name}" preset? Unsaved changes will be lost.', {
      name: translatePresetName(state.pending.name),
    });
  return `<div class="ldm-editor-confirm" role="alert">
    <p>${message}</p>
    <div class="ldm-editor-actions">
      <button type="button" class="ldm-editor-btn ldm-editor-danger" data-action="ed-confirm">${T('sandbox.editor.confirmReplace', 'Replace')}</button>
      <button type="button" class="ldm-editor-btn" data-action="ed-cancel-pending">${T('sandbox.editor.keep', 'Keep current')}</button>
    </div>
  </div>`;
}

function translatePresetName(key) {
  return key === 'd6Pool' ? translate('sandbox.editor.presetD6Pool', 'Dice pool (d6)') : translate('sandbox.editor.presetD20Classic', 'Classic d20');
}

/**
 * Sample roll of a config, drawn as an escaped HTML card. Deterministic: it shows the
 * configured header, formula, dice and result words, not a real roll.
 */
export function renderPreview(cfg) {
  const c = validateConfig(cfg).config;
  const accent = /^#[0-9a-f]{6}$/i.test(c.card.accent) ? c.card.accent : DEFAULT_ACCENT;
  const compact = c.card.style === 'compact';
  const sampleActor = translate('sandbox.editor.previewActor', 'Sample hero');
  const sampleLabel = translate('sandbox.editor.previewLabel', 'Melee');
  const check = buildCheck(c, { attrValue: 3, skillValue: 2 });
  let dice;
  let resultText;
  let tag = '';
  if (c.dice.mode === 'pool') {
    const pool = c.dice.pool;
    const n = Math.max(1, Math.min(pool.maxDice, 5));
    dice = Array.from({ length: n }, (_, i) => ((SAMPLE_FACES[i % SAMPLE_FACES.length] - 1) % pool.faces) + 1);
    const successes = dice.filter((v) => v >= pool.successMin).length;
    const ones = dice.filter((v) => v === 1).length;
    resultText = `${successes} ${c.card.successLabel}`;
    if (pool.glitchOnOnes && ones * 2 > n) tag = c.card.fumbleLabel;
  } else {
    const natural = Math.min(c.dice.d20.critMin, c.dice.d20.sides);
    dice = [natural];
    resultText = String(natural + 5);
    if (natural >= c.dice.d20.critMin) tag = c.card.critLabel;
  }
  const values = { actor: sampleActor, label: sampleLabel, result: resultText };
  const header = esc(c.card.header).replace(/\{(actor|label|result)\}/g, (_, token) => esc(values[token]));
  const diceHtml = c.card.showDice
    ? `<ul class="ldm-editor-preview-dice">${dice.map((v) => `<li>${esc(v)}</li>`).join('')}</ul>`
    : '';
  return `<div class="ldm-editor-preview${compact ? ' is-compact' : ''}" style="--ldm-editor-accent: ${esc(accent)}">
    <div class="ldm-editor-preview-head">${header}</div>
    ${c.card.showFormula ? `<code class="ldm-editor-preview-formula">${esc(check.formula)}</code>` : ''}
    ${diceHtml}
    <div class="ldm-editor-preview-result">${esc(resultText)}${tag ? ` <span class="ldm-editor-tag">${esc(tag)}</span>` : ''}</div>
  </div>`;
}

function wrap(inner) {
  return `<div class="ldm-editor-root">${inner}</div>`;
}

/**
 * Full editor body as an escaped HTML string. Pure: depends only on `state`.
 * Save is disabled while any validation error exists.
 */
export function renderEditor(state) {
  const s = state ?? {};
  if (s.loading) return wrap(`<p class="ldm-editor-empty">${T('sandbox.editor.loading', 'Loading the rules...')}</p>`);
  if (s.readOnly) return wrap(`<p class="ldm-editor-notice">${T('sandbox.editor.readOnly', 'Only the GM can edit the rules of this system.')}</p>`);

  const draft = s.draft ?? draftFromConfig(defaultConfig());
  const errors = draftErrors(draft);
  const cfg = validateConfig(configFromDraft(draft)).config;
  const dirty = isDirty(s);
  const saveDisabled = errors.length > 0 || s.saving === true;

  const presets = Object.keys(PRESETS).map((key) => [key, presetName(key)]);
  const presetSelect = `<label class="ldm-editor-field"><span class="ldm-editor-label">${T('sandbox.editor.presetLabel', 'Preset')}</span><select class="ldm-editor-input" data-state="preset">${presets
    .map(([key, text]) => `<option value="${esc(key)}"${key === s.preset ? ' selected' : ''}>${text}</option>`)
    .join('')}</select></label>`;

  const top = `<div class="ldm-editor-top">
    <p class="ldm-editor-guide">${T('sandbox.editor.guide', 'Start with the dice. Add the attributes and skills your players use, then arrange their sheet. Save to apply these rules to this world.')}</p>
    ${textField('name', T('sandbox.editor.name', 'System name'), draft.name ?? '', LIMITS.name)}
    <details><summary>${T('sandbox.editor.startingPoint', 'Use a ready-made starting point')}</summary><div class="ldm-editor-actions">
      ${presetSelect}
      <button type="button" class="ldm-editor-btn" data-action="ed-preset-ask">${T('sandbox.editor.presetLoad', 'Load preset')}</button>
      <button type="button" class="ldm-editor-btn ldm-editor-danger" data-action="ed-reset-ask">${T('sandbox.editor.reset', 'Reset to defaults')}</button>
    </div></details>
  </div>`;

  const notice = s.notice?.text
    ? `<p class="ldm-editor-notice is-${esc(s.notice.kind ?? 'info')}" role="status">${esc(s.notice.text)}</p>`
    : '';
  const stale = s.stale
    ? `<div class="ldm-editor-notice is-warn" role="status"><span>${T('sandbox.editor.staleHint', 'The configuration changed elsewhere.')}</span> <button type="button" class="ldm-editor-btn" data-action="ed-reload">${T('sandbox.editor.reload', 'Reload')}</button></div>`
    : '';
  const errorBox = errors.length
    ? `<div class="ldm-editor-errors" aria-live="polite"><p>${T('sandbox.editor.errorsTitle', 'Fix these before saving:')}</p><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`
    : '';

  const attributesDisplay = selectField('attributeDisplay', T('sandbox.editor.attributeDisplay', 'Attribute values'), [
    ['number', T('sandbox.editor.displayNumbers', 'Numbers')],
    ['dots', T('sandbox.editor.displayDots', 'Dots')],
  ], draft.attributeDisplay === 'dots' ? 'dots' : 'number');
  const attributes = `${attributesDisplay}<p class="ldm-editor-hint">${T('sandbox.editor.attributeDisplayHint', 'Max sets the highest score: that many dots in dot mode or the maximum number. Negative ranges and maximums above 20 stay numeric.')}</p>${listSection(
    'attributes', 'sandbox.editor.sectionAttributes', 'Attributes',
    'sandbox.editor.attributesHint', 'Actors store one value per attribute. Removing one hides it; stored values are kept.',
    'attributes', draft.attributes ?? [], s,
    (row, i) => keyField('attributes', i, row, s)
      + textField('label', T('sandbox.editor.fieldLabel', 'Label'), row.label ?? '', LIMITS.label, rowAttrs('attributes', i))
      + numberField('min', T('sandbox.editor.min', 'Min'), row.min, -LIMITS.attrBound, LIMITS.attrBound, rowAttrs('attributes', i))
      + numberField('max', T('sandbox.editor.max', 'Max'), row.max, -LIMITS.attrBound, LIMITS.attrBound, rowAttrs('attributes', i))
      + numberField('default', T('sandbox.editor.default', 'Default'), row.default, -LIMITS.attrBound, LIMITS.attrBound, rowAttrs('attributes', i))
      + checkField('useD20Modifier', T('sandbox.editor.useD20Modifier', 'Convert score to a d20 modifier'), row.useD20Modifier === true, rowAttrs('attributes', i))
      + `<span class="ldm-editor-hint">${T('sandbox.editor.useD20ModifierHint', 'Uses floor((score − 10) ÷ 2) in rolls, linked skills and powers.')}</span>`
      + groupField('attributes', i, row),
    'sandbox.editor.addAttribute', 'Add attribute',
  )}`;

  const skills = listSection(
    'skills', 'sandbox.editor.sectionSkills', 'Skills',
    'sandbox.editor.skillsHint', 'Each skill is tied to an attribute.',
    'skills', draft.skills ?? [], s,
    (row, i) => keyField('skills', i, row, s)
      + textField('label', T('sandbox.editor.fieldLabel', 'Label'), row.label ?? '', LIMITS.label, rowAttrs('skills', i))
      + selectField('attr', T('sandbox.editor.attribute', 'Attribute'), attributeOptions(draft, row.attr ?? ''), row.attr ?? '', rowAttrs('skills', i))
      + numberField('max', T('sandbox.editor.max', 'Max'), row.max, 0, LIMITS.skillMax, rowAttrs('skills', i))
      + numberField('default', T('sandbox.editor.default', 'Default'), row.default, 0, LIMITS.skillMax, rowAttrs('skills', i))
      + groupField('skills', i, row),
    'sandbox.editor.addSkill', 'Add skill',
  );

  const resources = listSection(
    'resources', 'sandbox.editor.sectionResources', 'Resources',
    'sandbox.editor.resourcesHint', 'Resources such as health or mana. Actors have a current value and a maximum.',
    'resources', draft.resources ?? [], s,
    (row, i) => keyField('resources', i, row, s)
      + textField('label', T('sandbox.editor.fieldLabel', 'Label'), row.label ?? '', LIMITS.label, rowAttrs('resources', i))
      + numberField('max', T('sandbox.editor.max', 'Max'), row.max, 1, LIMITS.resourceMax, rowAttrs('resources', i))
      + colorField('color', T('sandbox.editor.color', 'Color'), row.color, rowAttrs('resources', i))
      + checkField('showInCombat', T('sandbox.editor.showInCombat', 'Show in combat'), row.showInCombat === true, rowAttrs('resources', i)),
    'sandbox.editor.addResource', 'Add resource',
  );

  const categories = listSection(
    'categories', 'sandbox.editor.sectionCategories', 'Item categories',
    'sandbox.editor.categoriesHint', 'Groups for gear and other items.',
    'itemCategories', draft.itemCategories ?? [], s,
    (row, i) => keyField('itemCategories', i, row, s)
      + textField('label', T('sandbox.editor.fieldLabel', 'Label'), row.label ?? '', LIMITS.label, rowAttrs('itemCategories', i)),
    'sandbox.editor.addCategory', 'Add category',
  );

  const kinds = listSection(
    'kinds', 'sandbox.editor.sectionKinds', 'Item kinds',
    'sandbox.editor.kindsHint', 'Kinds of abilities and spells that appear on the actor sheet.',
    'abilityKinds', draft.abilityKinds ?? [], s,
    (row, i) => keyField('abilityKinds', i, row, s)
      + textField('label', T('sandbox.editor.fieldLabel', 'Label'), row.label ?? '', LIMITS.label, rowAttrs('abilityKinds', i)),
    'sandbox.editor.addKind', 'Add item kind',
  );

  const footer = `<div class="ldm-editor-footer">
    <span class="ldm-editor-status" role="status"><span class="ldm-status-dot"></span><span class="ldm-status-text">${dirty ? T('sandbox.editor.unsaved', 'Unsaved changes') : T('sandbox.editor.saved', 'All changes saved')}</span></span>
    <div class="ldm-editor-actions">
      <button type="button" class="ldm-editor-btn ldm-editor-btn--nav" data-action="ed-step" data-dir="-1"${SECTION_KEYS.indexOf(s.section) <= 0 ? ' disabled' : ''}>← ${T('sandbox.editor.previousStep', 'Previous')}</button>
      <button type="button" class="ldm-editor-btn ldm-editor-btn--nav" data-action="ed-step" data-dir="1"${SECTION_KEYS.indexOf(s.section) === SECTION_KEYS.length - 1 ? ' disabled' : ''}>${T('sandbox.editor.nextStep', 'Next')} →</button>
      <button type="button" class="ldm-editor-btn ldm-editor-btn--close" data-action="ed-cancel">${T('sandbox.editor.close', 'Close')}</button>
      <button type="button" class="ldm-editor-btn ldm-editor-primary" data-action="ed-save"${saveDisabled ? ' disabled' : ''}>${s.saving ? `⏳ ${T('sandbox.editor.saving', 'Saving...')}` : `💾 ${T('sandbox.editor.save', 'Save')}`}</button>
    </div>
  </div>`;

  // Section navigation: the shared tabs standard. Every panel is rendered (hidden ones carry the
  // `hidden` attribute), so inputs keep their values and focus can be restored across re-renders.
  const panels = {
    dice: diceSection(draft, cfg),
    attributes,
    skills,
    saves: mechanicSection(draft, 'saves'),
    attacks: mechanicSection(draft, 'attacks'),
    magic: mechanicSection(draft, 'magic'),
    resources,
    categories,
    kinds,
    layout: layoutSection(draft, cfg, s),
    card: cardSection(draft, cfg),
    combat: combatSection(draft, cfg),
    io: ioSection(s),
  };
  const nav = renderTabs({
    idPrefix: 'ldm-editor',
    tabs: SECTION_KEYS.map((key) => ({ key, label: translate(SECTION_TITLES[key][0], SECTION_TITLES[key][1]), columns: 1, blocks: [] })),
    activeKey: s.section,
    panels,
    ariaLabel: translate('sandbox.editor.sections', 'Editor sections'),
  });

  return wrap(`
    <header class="ldm-editor-header">${top}</header>
    ${stale}${notice}${pendingBar(s)}${errorBox}
    ${nav}
    ${footer}`);
}

// ---------------------------------------------------------------------------
// Engine layer (window and menu). Everything below reads globalThis.Loom at run time.
// ---------------------------------------------------------------------------

const EngineBase = globalThis.Loom?.BaseWindow ?? class {};

function loomOrNull() {
  return globalThis.Loom ?? null;
}

function readValue(el) {
  if (el.type === 'checkbox') return el.checked === true;
  if (el.type === 'number') {
    if (el.value === '') return el.dataset?.nullableNumber === 'true' ? null : '';
    const n = Number(el.value);
    return Number.isFinite(n) ? n : el.value;
  }
  return el.value;
}

function isEditorField(el) {
  return el && el.dataset && (el.dataset.field !== undefined || el.dataset.state !== undefined);
}

function captureFocus(root) {
  if (typeof document === 'undefined') return null;
  const el = document.activeElement;
  if (!el || !root.contains(el) || !el.dataset) return null;
  const keys = ['action', 'field', 'state', 'list', 'tabList', 'nestedList', 'sourceList', 'nestedPath', 'collection', 'index', 'block', 'dir'];
  const marks = {};
  for (const k of keys) if (el.dataset[k] !== undefined) marks[k] = el.dataset[k];
  if (Object.keys(marks).length === 0) return null;
  let caret = null;
  try {
    if (typeof el.selectionStart === 'number') caret = [el.selectionStart, el.selectionEnd];
  } catch {
    caret = null;
  }
  return { marks, caret };
}

function restoreFocus(root, saved) {
  if (!saved || typeof document === 'undefined') return;
  const selector = Object.entries(saved.marks)
    .map(([k, v]) => `[data-${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}="${String(v).replace(/"/g, '\\"')}"]`)
    .join('');
  const el = root.querySelector(selector);
  if (!el) return;
  el.focus();
  if (saved.caret) {
    try {
      el.setSelectionRange(saved.caret[0], saved.caret[1]);
    } catch {
      // Input types such as number have no selection API.
    }
  }
}

/** Rule editor window (GM only; other users see a read-only notice). */
export class RuleEditorWindow extends EngineBase {
  constructor(props = {}) {
    super({
      id: EDITOR_WINDOW_ID,
      title: translate('sandbox.editor.title', 'Rule editor'),
      icon: '<i class="fa-solid fa-sliders"></i>',
      width: 980,
      height: 700,
      resizable: true,
      showFooter: false,
    });
    void props;
    this.closeOnSave = false;
    const loom = loomOrNull();
    const readOnly = loom?.user?.isGM !== true;
    this.editorState = createEditorState(defaultConfig(), { readOnly });
    this.editorState.loading = !readOnly;
    this.saveTimer = null;
    this.unsubscribeSaved = null;
    this.bound = false;
    this.isRefreshing = false;
    if (!readOnly) {
      this.unsubscribeSaved = onConfigSaved((cfg) => this.onExternalSave(cfg));
      void this.load();
    }
  }

  bodyTemplate() {
    return renderEditor(this.editorState);
  }

  onRender() {
    if (!this.element) return;
    if (!this.bound) {
      this.bound = true;
      this.element.addEventListener('input', (e) => this.onFieldEvent(e, false));
      this.element.addEventListener('change', (e) => this.onFieldEvent(e, true));
      // Section tabs: one delegated click and keydown listener on the window root (shared standard).
      attachTabs(this.element, {
        getTabs: () => SECTION_KEYS.map((key) => ({ key })),
        getActive: () => this.editorState.section,
        setActive: (key) => {
          this.editorState.section = key;
        },
        rerender: () => this.refresh(),
      });
    }
    this.placeFixedFooter();
  }

  placeFixedFooter() {
    if (!this.element) return;
    const body = this.element.querySelector('.loom-window-body');
    const footer = body?.querySelector('.ldm-editor-footer');
    if (!footer) return;
    const previous = this.element.querySelector(':scope > .ldm-editor-footer');
    if (previous && previous !== footer) previous.remove();
    if (footer.parentElement !== this.element) {
      const resizeHandle = this.element.querySelector(':scope > .loom-window-resize-handle');
      this.element.insertBefore(footer, resizeHandle ?? null);
    }
  }

  /** Re-reads the saved config (fresh from the server) and replaces the draft. */
  async load() {
    const cfg = await loadConfig({ fresh: true });
    this.editorState.draft = draftFromConfig(cfg);
    this.editorState.baseline = baselineOf(cfg);
    this.editorState.loading = false;
    this.editorState.stale = false;
    this.editorState.keyEditable = new WeakSet();
    this.editorState.autoKey = new WeakSet();
    this.refresh();
  }

  onExternalSave(cfg) {
    if (this.editorState.saving || !this.element) return;
    if (!isDirty(this.editorState)) {
      this.editorState.draft = draftFromConfig(cfg);
      this.editorState.baseline = baselineOf(cfg);
      this.editorState.stale = false;
      this.refresh();
      return;
    }
    this.editorState.stale = true;
    this.refresh();
  }

  /** Re-renders the body and keeps focus and caret on the same field. */
  refresh() {
    if (!this.element || this.isRefreshing) return;
    clearTimeout(this.saveTimer);
    this.isRefreshing = true;
    try {
      const saved = captureFocus(this.element);
      this.rerenderBody();
      restoreFocus(this.element, saved);
    } finally {
      this.isRefreshing = false;
    }
  }

  scheduleRefresh() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.refresh(), SAVE_DEBOUNCE_MS);
  }

  /** Text and select edits. Text inputs re-render after a pause; committed changes re-render now. */
  onFieldEvent(e, committed) {
    // Replacing the body can synchronously fire blur/change on its focused input.
    // Ignore those synthetic lifecycle events so they cannot start a nested render
    // while BaseWindow is still assigning body.innerHTML.
    if (this.isRefreshing) return;
    const el = e.target.closest?.('input, select, textarea, [data-field], [data-state]') ?? e.target;
    if (!isEditorField(el)) return;
    this.applyField(el);
    if (el.dataset.state !== undefined) return;
    if (committed || el.tagName === 'SELECT') this.refresh();
    else this.scheduleRefresh();
  }

  applyField(el) {
    if (this.editorState.readOnly || this.editorState.saving) return;
    const value = readValue(el);
    if (el.dataset.state !== undefined) {
      this.editorState[el.dataset.state] = String(value);
      return;
    }
    const draft = this.editorState.draft;
    if (el.dataset.field === 'magic.methods' && el.dataset.method) {
      const methods = Array.isArray(draft.magic?.methods) ? draft.magic.methods : [];
      draft.magic.methods = el.checked ? [...new Set([...methods, el.dataset.method])] : methods.filter((method) => method !== el.dataset.method);
      if (!draft.magic.methods.includes(draft.magic.defaultMethod)) draft.magic.defaultMethod = draft.magic.methods[0] ?? 'free';
      return;
    }
    const nested = el.dataset.nestedList ?? el.dataset.sourceList;
    if (nested !== undefined) {
      const [sectionName, listName] = String(nested).split('.');
      const row = draft?.[sectionName]?.[listName]?.[Number(el.dataset.index)];
      if (!isPlainObject(row)) return;
      if (el.dataset.sourceList || el.dataset.field === 'sources') {
        const rawOptions = el.multiple ? [...el.selectedOptions] : (el.value ? [{ value: el.value }] : []);
        const sources = rawOptions.map((option) => {
          const [kind, key, sourceVal] = option.value.split(':');
          const sourceValue = sourceVal || (kind === 'skill' ? 'rank' : 'configured');
          const exists = kind === 'attr' ? draft.attributes?.some((r) => r.key === key) : draft.skills?.some((r) => r.key === key);
          return kind && key ? { kind, key, value: sourceValue, ...(!exists ? { removed: true } : {}) } : null;
        }).filter(Boolean).slice(0, 12);
        if (el.dataset.nestedPath) {
          row[el.dataset.nestedPath] ??= {};
          row[el.dataset.nestedPath].sources = sources;
        } else row.sources = sources;
        return;
      }
      const path = `${el.dataset.nestedPath ? `${el.dataset.nestedPath}.` : ''}${el.dataset.field}`.split('.');
      let node = row;
      for (const part of path.slice(0, -1)) { node[part] ??= {}; node = node[part]; }
      node[path[path.length - 1]] = value;
      return;
    }
    if (el.dataset.tabList !== undefined) {
      this.applyTabField(el, value);
      return;
    }
    if (el.dataset.list !== undefined) {
      const list = el.dataset.list;
      const index = Number(el.dataset.index);
      const row = (draft[list] ?? [])[index];
      if (!row) return;
      const prop = el.dataset.field;
      row[prop] = value;
      if (prop === 'key') this.editorState.autoKey.delete(row);
      if (prop === 'label' && this.editorState.autoKey.has(row)) {
        row.key = slug(String(value));
        const keyEl = this.element.querySelector(`[data-list="${list}"][data-index="${index}"][data-field="key"]`);
        if (keyEl) keyEl.value = row.key;
      }
      return;
    }
    if (el.dataset.field === 'dice.d20.sides') {
      const previous = Number(draft.dice.d20.sides);
      if (Number(draft.dice.d20.critMin) === previous || Number(draft.dice.d20.critMin) > Number(value)) draft.dice.d20.critMin = value;
      draft.dice.d20.fumbleMax = Math.min(Number(draft.dice.d20.fumbleMax), Math.max(1, Number(value) - 1));
    }
    if (el.dataset.field === 'dice.pool.faces') draft.dice.pool.successMin = Math.min(Number(draft.dice.pool.successMin), Number(value));
    setPath(draft, el.dataset.field, value);
  }

  /** Layout tab list named by a dataset value, with its tab array from the draft (or null). */
  layoutTabsFor(datasetValue) {
    const name = layoutListName(datasetValue);
    if (!name) return null;
    const tabs = this.editorState.draft.layout?.[name];
    return Array.isArray(tabs) ? { name, tabs } : null;
  }

  /**
   * Stores a new tab list for `name`. Block edits return a new object for the tab they change, so
   * the new-tab flags of the old object (editable key, auto-slug) move to the object at the same index.
   */
  setLayoutTabs(name, next) {
    const layout = this.editorState.draft.layout;
    const before = Array.isArray(layout[name]) ? layout[name] : [];
    next.forEach((tab, index) => {
      const old = before[index];
      if (!old || old === tab) return;
      if (this.editorState.keyEditable.has(old)) this.editorState.keyEditable.add(tab);
      if (this.editorState.autoKey.has(old)) this.editorState.autoKey.add(tab);
    });
    layout[name] = next;
  }

  /** Field edits of a layout tab: label (auto-slugs a new tab's key), key and columns. */
  applyTabField(el, value) {
    const hit = this.layoutTabsFor(el.dataset.tabList);
    const index = Number(el.dataset.index);
    const tab = hit ? hit.tabs[index] : undefined;
    if (!hit || !isPlainObject(tab)) return;
    const prop = el.dataset.field;
    if (prop === 'blockSpan' && hit.name === 'tabs') {
      const block = el.dataset.layoutBlock;
      if (!block || !tab.blocks.includes(block)) return;
      tab.blockSpans ??= {};
      if (value === 'full') tab.blockSpans[block] = 'full';
      else delete tab.blockSpans[block];
      return;
    }
    if (prop === 'columns') {
      tab.columns = Number(value);
    } else if (prop === 'key') {
      tab.key = String(value);
      this.editorState.autoKey.delete(tab);
    } else if (prop === 'label') {
      tab.label = String(value);
      if (this.editorState.autoKey.has(tab)) {
        tab.key = tabKeyFor(hit.tabs, String(value), index);
        const keyEl = this.element?.querySelector(`[data-tab-list="${hit.name}"][data-index="${index}"][data-field="key"]`);
        if (keyEl) keyEl.value = tab.key;
      }
    }
  }

  onAction(action, id, target) {
    if (this.editorState.readOnly || this.editorState.saving) return;
    const list = target?.dataset?.list;
    const index = Number(target?.dataset?.index);
    const draft = this.editorState.draft;
    switch (action) {
      case 'ed-step': {
        const index = Math.max(0, SECTION_KEYS.indexOf(this.editorState.section));
        this.editorState.section = SECTION_KEYS[Math.max(0, Math.min(SECTION_KEYS.length - 1, index + Number(target.dataset.dir)))];
        return this.refresh();
      }
      case 'ed-die': {
        const faces = Number(target.dataset.faces);
        if (![4, 6, 8, 10, 12, 20, 100].includes(faces)) return;
        this.applyField({ type: 'number', value: String(faces), dataset: { field: draft.dice.mode === 'pool' ? 'dice.pool.faces' : 'dice.d20.sides' } });
        return this.refresh();
      }
      case 'ed-tab-add': {
        const hit = this.layoutTabsFor(target?.dataset?.tabList);
        if (!hit) return undefined;
        const next = addTab(hit.tabs, translate('sandbox.editor.newTabLabel', 'New tab'));
        if (next.length === hit.tabs.length) return undefined;
        const added = next[next.length - 1];
        this.editorState.keyEditable.add(added);
        this.editorState.autoKey.add(added);
        draft.layout[hit.name] = next;
        return this.refresh();
      }
      case 'ed-tab-move': {
        const hit = this.layoutTabsFor(target?.dataset?.tabList);
        if (!hit) return undefined;
        draft.layout[hit.name] = moveTab(hit.tabs, index, Number(target.dataset.dir));
        return this.refresh();
      }
      case 'ed-tab-remove': {
        const hit = this.layoutTabsFor(target?.dataset?.tabList);
        if (!hit) return undefined;
        draft.layout[hit.name] = removeTab(hit.tabs, index);
        return this.refresh();
      }
      case 'ed-block-move': {
        const hit = this.layoutTabsFor(target?.dataset?.tabList);
        if (!hit) return undefined;
        this.setLayoutTabs(hit.name, moveBlock(hit.tabs, index, Number(target.dataset.block), Number(target.dataset.dir)));
        return this.refresh();
      }
      case 'ed-block-remove': {
        const hit = this.layoutTabsFor(target?.dataset?.tabList);
        if (!hit) return undefined;
        this.setLayoutTabs(hit.name, removeBlock(hit.tabs, index, Number(target.dataset.block)));
        return this.refresh();
      }
      case 'ed-block-add': {
        const hit = this.layoutTabsFor(target?.dataset?.tabList);
        if (!hit) return undefined;
        const picker = target.parentElement?.querySelector('[data-block-select]');
        const block = picker ? String(picker.value) : '';
        const allowed = LAYOUT_SCOPES[hit.name === 'itemTabs' ? 'item' : 'actor'].blocks;
        if (!allowed.includes(block)) return undefined;
        this.setLayoutTabs(hit.name, addBlock(hit.tabs, index, block));
        return this.refresh();
      }
      case 'ed-move':
        draft[list] = moveRow(draft[list], index, Number(target.dataset.dir));
        return this.refresh();
      case 'ed-remove':
        draft[list] = removeRow(draft[list], index);
        return this.refresh();
      case 'ed-add': {
        const template = newRowTemplate(list, draft);
        if (!template) return undefined;
        const next = addRow(draft[list], template, LIMITS[list]);
        const added = next[next.length - 1];
        if (added) {
          this.editorState.keyEditable.add(added);
          this.editorState.autoKey.add(added);
        }
        draft[list] = next;
        return this.refresh();
      }
      case 'ed-nested-add': {
        const [sectionName, listName] = String(target?.dataset?.collection ?? '').split('.');
        const list = draft?.[sectionName]?.[listName];
        if (!Array.isArray(list)) return;
        const templates = {
          'saves.entries': { key: `save${list.length + 1}`, label: 'New save', sources: [], bonus: 0, target: 0, showOnSheet: true },
          'attacks.profiles': { key: `attack${list.length + 1}`, label: 'New attack', sources: [], bonus: 0, mode: 'system', faces: 10, successMin: 5, damage: { method: 'none', base: 0, sources: [], count: 1, faces: 6, successMin: 5, critPairs: false, critFace: 10 } },
          'magic.levels': { key: `level${list.length}`, label: `Level ${list.length}`, rank: list.length, capacityDefault: 0, free: list.length === 0 },
          'magic.checkProfiles': { key: `cast${list.length + 1}`, label: 'Casting check', sources: [], bonus: 0, target: 0, mode: 'system' },
        };
        const max = sectionName === 'magic' ? 21 : 24;
        if (templates[`${sectionName}.${listName}`] && list.length < max) list.push(templates[`${sectionName}.${listName}`]);
        return this.refresh();
      }
      case 'ed-nested-remove': {
        const [sectionName, listName] = String(target?.dataset?.collection ?? '').split('.');
        const list = draft?.[sectionName]?.[listName];
        const rowIndex = Number(target?.dataset?.index);
        if (Array.isArray(list) && Number.isInteger(rowIndex) && rowIndex >= 0) list.splice(rowIndex, 1);
        return this.refresh();
      }
      case 'ed-preset-ask':
        this.editorState.pending = { kind: 'preset', name: PRESETS[this.editorState.preset] ? this.editorState.preset : 'd20Classic' };
        return this.refresh();
      case 'ed-reset-ask':
        this.editorState.pending = { kind: 'reset' };
        return this.refresh();
      case 'ed-confirm':
        return this.applyPending();
      case 'ed-cancel-pending':
        this.editorState.pending = null;
        return this.refresh();
      case 'ed-import':
        return this.importText();
      case 'ed-export':
        this.editorState.exportText = serializeConfig(configFromDraft(draft));
        return this.refresh();
      case 'ed-save':
        return this.save();
      case 'ed-cancel':
        return this.requestClose();
      case 'ed-reload':
        return this.reloadFromServer();
      default:
        return undefined;
    }
  }

  applyPending() {
    const pending = this.editorState.pending;
    this.editorState.pending = null;
    if (!pending) return this.refresh();
    const cfg = pending.kind === 'reset' ? defaultConfig() : PRESETS[pending.name]();
    this.editorState.draft = draftFromConfig(cfg);
    markKeysEditable(this.editorState);
    this.editorState.notice = {
      kind: 'info',
      text: translate(pending.kind === 'reset' ? 'sandbox.editor.resetDone' : 'sandbox.editor.presetLoaded',
        pending.kind === 'reset' ? 'Defaults loaded. Review it, then save.' : 'Preset loaded. Review it, then save.'),
    };
    return this.refresh();
  }

  importText() {
    const parsed = parseConfig(this.editorState.importText);
    if (!parsed.ok) {
      this.editorState.importErrors = parsed.errors;
      return this.refresh();
    }
    this.editorState.draft = draftFromConfig(parsed.config);
    markKeysEditable(this.editorState);
    this.editorState.importErrors = [];
    this.editorState.notice = { kind: 'info', text: translate('sandbox.editor.imported', 'Imported. Review it, then save.') };
    return this.refresh();
  }

  async reloadFromServer() {
    if (isDirty(this.editorState) && !(await this.confirmDiscard())) return undefined;
    this.editorState.loading = true;
    this.refresh();
    return this.load();
  }

  async save() {
    if (this.editorState.readOnly) return undefined;
    const errors = draftErrors(this.editorState.draft);
    if (errors.length > 0) {
      this.editorState.notice = { kind: 'error', text: translate('sandbox.editor.fixErrors', 'Fix the errors before saving.') };
      return this.refresh();
    }
    this.editorState.saving = true;
    this.refresh();
    let result;
    try {
      result = await saveConfig(configFromDraft(this.editorState.draft));
    } finally {
      this.editorState.saving = false;
    }
    if (result.ok) {
      this.editorState.baseline = JSON.stringify(configFromDraft(this.editorState.draft));
      this.editorState.keyEditable = new WeakSet();
      this.editorState.autoKey = new WeakSet();
      this.editorState.stale = false;
      this.editorState.notice = { kind: 'ok', text: translate('sandbox.editor.savedNotice', 'Rules saved.') };
    } else {
      const reason = result.errors.join(' ');
      this.editorState.notice = {
        kind: 'error',
        text: TV('sandbox.editor.saveFailed', 'Could not save: {reason}', { reason }),
      };
    }
    return this.refresh();
  }

  async confirmDiscard() {
    const message = translate('sandbox.editor.discardMessage', 'Discard the unsaved changes?');
    const title = translate('sandbox.editor.discardTitle', 'Unsaved changes');
    const confirm = loomOrNull()?.showConfirm;
    if (typeof confirm === 'function') return (await confirm(title, message)) === true;
    return typeof globalThis.confirm === 'function' ? globalThis.confirm(message) === true : false;
  }

  async requestClose() {
    if (await this._onBeforeClose()) loomOrNull()?.windowManager?.close(EDITOR_WINDOW_ID);
  }

  /** Unsaved-changes guard used by the header close button and Close. */
  async _onBeforeClose() {
    if (this.editorState.readOnly || !isDirty(this.editorState)) return true;
    return this.confirmDiscard();
  }

  onClose() {
    clearTimeout(this.saveTimer);
    this.unsubscribeSaved?.();
    this.unsubscribeSaved = null;
  }
}

/** Opens the rule editor window. Non-GM users get the read-only notice inside the same window. */
export function openRuleEditor() {
  const wm = loomOrNull()?.windowManager;
  if (!wm || typeof wm.open !== 'function') return Promise.resolve(false);
  return wm.open(EDITOR_WINDOW_ID, RuleEditorWindow, {}).then(() => true, (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[loom-demo-system] Could not open rule editor:', error);
    try {
      loomOrNull()?.showToast?.(`Não foi possível abrir o editor do sistema: ${message}`, 'error');
    } catch { /* Keep the original window error visible in the console. */ }
    return false;
  });
}

/**
 * Adds the editor to the system settings menu. Returns false when the engine settings API is
 * missing. Nothing registers itself at import time; main.mjs calls this.
 */
export function registerRuleEditorMenu() {
  try {
    const settings = loomOrNull()?.settings;
    if (typeof settings?.registerMenu !== 'function') return false;
    const label = translate('sandbox.editor.menuName', 'Edit game rules');
    const hint = translate('sandbox.editor.menuHint', 'Edit the dice, attributes, skills, resources, items, chat card and combat rules of this system (GM only).');
    settings.registerMenu(CONFIG_MODULE, MENU_KEY, {
      name: label,
      label,
      hint,
      icon: 'fa-solid fa-sliders',
      restricted: true,
      type: RuleEditorWindow,
    });
    return true;
  } catch {
    return false;
  }
}
