// ══════════════════════════════════════════════════════════════
// Effects block for the sandbox actor and item sheets.
//
// Pure rendering and normalisation live at the top (plain Node, no DOM). The thin engine layer
// (window.Loom.effects, toasts, the delegated listener) is at the bottom.
//
// ENGINE RESEARCH (verified in E:\modules\LoomVTT, read-only):
// (1) Schema and routes. A buff row is { id, worldId, actorId, itemId, name, icon, origin,
//     duration (-1 = permanent), disabled, changes: [{ key, mode, value, priority? }], createdAt, updatedAt }.
//     Reads: GET /api/buffs/actor/:actorId and GET /api/buffs/item/:itemId (any signed-in session).
//     Writes: POST /api/buffs (201, returns the row; needs name, actorId or itemId, and worldId or itemId),
//     PUT /api/buffs/:id (partial update of name, icon, origin, duration, disabled, changes; 404 when unknown),
//     DELETE /api/buffs/:id (returns { success: true }). Writes return 403
//     { error: 'Access denied: you do not own this actor' } unless the caller is the GM or owns the resolved
//     actor. A buff with no resolvable actor is GM-only (server/applications/api/buffs.ts:27-33, 78-80,
//     108-110, 135-137). client/core/effects-api.ts:29-40 exposes these as window.Loom.effects.
//     client/core/api.ts:82-86 throws ApiError(status, message) on failure, and get() returns the parsed body.
// (2) Changes. The engine's modes are add, multiply, override, upgrade (applies only when greater) and
//     downgrade (applies only when less), applied server-side (server/applications/lib/effects.ts:5, 48-66).
//     They are derived into the actor's systemData by prepareActor (actor-prepare.ts:4-8), which selects
//     buffs by actorId and disabled = false only (effects.ts:72-77). Buffs that have only an itemId are
//     NEVER applied to the owning actor: not when the item is equipped, not when it is used. Numeric modes
//     coerce with Number(), so a non-numeric string is a silent no-op there.
//     CONSEQUENCE: the item block's hint says so (sandbox.effects.itemHint). It must not claim otherwise.
//     THIS SYSTEM copies them: applyItemEffects() (below) makes one actor effect per enabled item effect
//     (origin "item:<itemId>") when the item is used. It is a system-side copy; the engine stays untouched.
// (2b) Key paths. withActiveEffects() applies each change to a copy of the ACTOR'S systemData (actor-prepare.ts:6-7,
//     effects.ts:26-27), split on "." (effects.ts:45) and read with getPath from that root (effects.ts:46).
//     So "attrs.might" is systemData.attrs.might and "res.hp.value" is systemData.res.hp.value. A key
//     without the system prefix (e.g. "might") writes a NEW top-level key that no sheet shows.
//     A missing or non-number base counts as 0 for add/multiply/upgrade/downgrade (effects.ts:51-63), and a
//     resource max is null until the GM sets one, so "res.hp.max" with mode add gives the bonus alone.
//     Use "override" (Set to) for a max.
// (3) Live sync. buff.created/updated/deleted are emitted as Signal events but are NOT relayed to
//     WebSocket clients (no Signal.listen('buff.*') in server/index.ts; docs/en/api/buffs.md:54).
//     Every change is therefore followed by a reload of the list (reload() in attachEffects).
// Duration: combat round wrap decrements every enabled buff in the world and deletes it at 0
// (server/applications/api/combat.ts:20-34). Nothing else expires a buff.
//
// Limits enforced here (not in the engine): name 1-60, origin <= 80, icon <= 512 chars,
// duration -1..9999, at most 20 changes per effect, change values <= 80 characters when text.
// ══════════════════════════════════════════════════════════════

import { esc } from './helpers.mjs';

/** The engine's real change modes (server/applications/lib/effects.ts). */
export const EFFECT_MODES = Object.freeze(['add', 'multiply', 'override', 'upgrade', 'downgrade']);

const NUMERIC_MODES = Object.freeze(['add', 'multiply', 'upgrade', 'downgrade']);
const LIMITS = Object.freeze({ name: 60, origin: 80, icon: 512, value: 80, changes: 20, duration: 9999, summary: 160 });
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]{0,63}$/;
const FORBIDDEN_SEGMENTS = Object.freeze(['__proto__', 'constructor', 'prototype']);
const NUMBER_TEXT = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
const DURATION_TEXT = /^\s*-?\d{1,6}\s*$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const OWNER_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const NEW_ID = '__new__';

// Explicit key maps (not template strings) so every key is a literal the i18n check can see.
const MODE_LABEL_KEY = Object.freeze({
  add: "sandbox.effects.mode.add",
  multiply: "sandbox.effects.mode.multiply",
  override: "sandbox.effects.mode.override",
  upgrade: "sandbox.effects.mode.upgrade",
  downgrade: "sandbox.effects.mode.downgrade",
});
const CHANGE_TEMPLATE_KEY = Object.freeze({
  add: "sandbox.effects.change.add",
  multiply: "sandbox.effects.change.multiply",
  override: "sandbox.effects.change.override",
  upgrade: "sandbox.effects.change.upgrade",
  downgrade: "sandbox.effects.change.downgrade",
});

const ACTIONS = new Set(['add', 'edit', 'save', 'cancel', 'toggle', 'delete', 'add-change', 'remove-change']);
const MUTATING_ACTIONS = new Set(['add', 'edit', 'save', 'toggle', 'delete', 'add-change', 'remove-change']);

// English fallbacks. Every visible string goes through t(key, fallback); these are used when the
// engine has no translation (t is missing or returns the key itself).
const FALLBACK = Object.freeze({
  'sandbox.effects.title': 'Effects',
  'sandbox.effects.add': 'Add effect',
  'sandbox.effects.empty': 'No effects yet.',
  'sandbox.effects.actorHint': "Active effects change this actor's derived values. Durations count down when a new combat round starts.",
  'sandbox.effects.itemHint': 'Effects on an item are copied onto the character when the item is used (abilities, spells, potions and scrolls). Each use adds or refreshes a copy named after the item. Nothing applies the item effects by itself.',
  'sandbox.effects.newTitle': 'New effect',
  'sandbox.effects.editTitle': 'Edit effect',
  'sandbox.effects.edit': 'Edit',
  'sandbox.effects.delete': 'Delete',
  'sandbox.effects.enable': 'Enable',
  'sandbox.effects.disable': 'Disable',
  'sandbox.effects.save': 'Save',
  'sandbox.effects.cancel': 'Cancel',
  'sandbox.effects.name': 'Name',
  'sandbox.effects.origin': 'Origin',
  'sandbox.effects.icon': 'Icon (a /path or an http(s) address)',
  'sandbox.effects.duration': 'Duration (rounds, -1 = permanent)',
  'sandbox.effects.enabled': 'Enabled',
  'sandbox.effects.changes': 'Changes',
  'sandbox.effects.addChange': 'Add change',
  'sandbox.effects.removeChange': 'Remove',
  'sandbox.effects.changeKey': 'Key',
  'sandbox.effects.changeMode': 'Mode',
  'sandbox.effects.changeValue': 'Value',
  'sandbox.effects.unnamed': '(unnamed)',
  'sandbox.effects.noChanges': 'No changes',
  'sandbox.effects.permanent': 'Permanent',
  'sandbox.effects.durationOne': '1 round',
  'sandbox.effects.durationMany': '{count} rounds',
  'sandbox.effects.stateOn': 'Active',
  'sandbox.effects.stateOff': 'Off',
  'sandbox.effects.tooManyChanges': 'An effect can have at most 20 changes.',
  'sandbox.effects.readOnly': 'You cannot change effects on this sheet.',
  'sandbox.effects.keyHint': 'Key path in the character data. Examples: attrs.might, skills.melee, res.hp.value. For a max, use Set to (res.hp.max). Other paths are stored but this system does not show them.',
  'sandbox.effects.applyFailed': 'Could not apply the item effects: {message}',
  'sandbox.effects.noOwner': 'This sheet has no owner to attach the effect to.',
  'sandbox.effects.forbidden': "You cannot change this effect. Only the GM or the actor's owner can.",
  'sandbox.effects.saveFailed': 'Could not save the effect: {message}',
  'sandbox.effects.deleteFailed': 'Could not delete the effect: {message}',
  'sandbox.effects.toggleFailed': 'Could not change the effect: {message}',
  'sandbox.effects.loadFailed': 'Could not load the effects: {message}',
  'sandbox.effects.mode.add': 'Add',
  'sandbox.effects.mode.multiply': 'Multiply',
  'sandbox.effects.mode.override': 'Set to',
  'sandbox.effects.mode.upgrade': 'At least',
  'sandbox.effects.mode.downgrade': 'At most',
  'sandbox.effects.change.add': '{key} {value}',
  'sandbox.effects.change.multiply': '{key} x{value}',
  'sandbox.effects.change.override': '{key} = {value}',
  'sandbox.effects.change.upgrade': '{key} at least {value}',
  'sandbox.effects.change.downgrade': '{key} at most {value}',
});

/** Returns a translator that falls back to the given English text. Never throws. */
function translator(t) {
  return (key, fallback) => {
    const english = fallback ?? FALLBACK[key] ?? key;
    try {
      if (typeof t === 'function') {
        const text = t(key, english);
        if (typeof text === 'string' && text !== '' && text !== key) return text;
      }
    } catch {
      // A broken translator must not break the block: fall through to the English text.
    }
    return english;
  };
}

/** Replaces {name} tokens in one pass with raw values. The caller escapes the result once. */
function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Removes control characters and surrounding whitespace. */
function cleanText(value) {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
}

/** Text as shown in an input: strings as they are, finite numbers and booleans as text, anything else empty. */
function textOf(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return '';
}

/**
 * True for an icon the view may put in an <img src>: empty, a relative path that starts with a
 * single "/", or an http(s) address. Anything else (javascript:, data:, protocol-relative) is refused.
 * Length is checked separately by normalizeEffect.
 */
export function isSafeIcon(value) {
  if (value === '' || value === undefined || value === null) return true;
  if (typeof value !== 'string') return false;
  if (/[\u0000-\u0020\u007f"'<>\\]/.test(value)) return false;
  if (value.startsWith('/')) return !value.startsWith('//');
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' || url.protocol === 'http:';
}

function readText(value, max, label, errors, required = false) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') {
    errors.push(`${label} must be text`);
    return '';
  }
  const text = cleanText(value);
  if (required && text === '') errors.push(`${label} is required`);
  else if (text.length > max) errors.push(`${label} must be at most ${max} characters`);
  return text;
}

function readDuration(value, errors) {
  let n = value;
  if (n === undefined || n === null || n === '') return -1;
  if (typeof n === 'string' && DURATION_TEXT.test(n)) n = Number(n.trim());
  if (!Number.isInteger(n) || n < -1 || n > LIMITS.duration) {
    errors.push(`duration must be a whole number from -1 (permanent) to ${LIMITS.duration}`);
    return -1;
  }
  return n;
}

function readFlag(value, errors) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  errors.push('disabled must be true or false');
  return false;
}

function readChange(raw, index, errors) {
  const at = `change ${index + 1}`;
  if (!isObject(raw)) {
    errors.push(`${at} must be an object`);
    return null;
  }
  const before = errors.length;

  const key = typeof raw.key === 'string' ? cleanText(raw.key) : '';
  const keyOk =
    KEY_PATTERN.test(key) &&
    key.split('.').every((seg) => seg !== '' && !FORBIDDEN_SEGMENTS.includes(seg));
  if (!keyOk) {
    errors.push(`${at}: key must be a dotted path such as "attrs.might" or "res.hp.value" (letters, digits, _ and ., no empty or reserved segments)`);
  }

  const mode = raw.mode;
  if (!EFFECT_MODES.includes(mode)) {
    errors.push(`${at}: mode must be one of ${EFFECT_MODES.join(', ')}`);
  }

  let value;
  if (typeof raw.value === 'number') {
    if (!Number.isFinite(raw.value)) errors.push(`${at}: value must be a finite number`);
    value = raw.value;
  } else if (typeof raw.value === 'string') {
    const text = cleanText(raw.value);
    const modeName = typeof mode === 'string' ? mode : 'unknown';
    if (NUMBER_TEXT.test(text) && Number.isFinite(Number(text))) {
      value = Number(text);
    } else if (NUMERIC_MODES.includes(mode)) {
      errors.push(`${at}: value must be a number for mode "${modeName}"`);
    } else if (text.length > LIMITS.value) {
      errors.push(`${at}: value must be at most ${LIMITS.value} characters`);
    } else {
      value = text;
    }
  } else {
    errors.push(`${at}: value must be a number or text`);
  }

  if (errors.length > before) return null;
  return { key, mode, value };
}

function readChanges(value, errors) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    errors.push('changes must be a list');
    return [];
  }
  if (value.length > LIMITS.changes) {
    errors.push(`an effect can have at most ${LIMITS.changes} changes`);
    return [];
  }
  const out = [];
  for (let i = 0; i < value.length; i += 1) {
    const change = readChange(value[i], i, errors);
    if (change) out.push(change);
  }
  return out;
}

function failure(errors) {
  return { ok: false, effect: null, errors };
}

/**
 * Validates and sanitises a user-edited effect. Returns { ok, effect, errors }; `effect` is set only
 * when ok. Unknown fields are dropped. Never throws: hostile getters or odd types become errors.
 * Error messages are English (like validateConfig), not localised.
 */
export function normalizeEffect(input) {
  try {
    if (!isObject(input)) return failure(['effect must be an object']);
    const errors = [];
    const name = readText(input.name, LIMITS.name, 'name', errors, true);
    const origin = readText(input.origin, LIMITS.origin, 'origin', errors);
    const icon = readText(input.icon, LIMITS.icon, 'icon', errors);
    if (icon !== '' && !isSafeIcon(icon)) {
      errors.push('icon must be empty, a path starting with "/" or an http(s) address');
    }
    const duration = readDuration(input.duration, errors);
    const disabled = readFlag(input.disabled, errors);
    const changes = readChanges(input.changes, errors);
    if (errors.length > 0) return failure(errors);
    return { ok: true, effect: { name, origin, icon, duration, disabled, changes }, errors: [] };
  } catch {
    return failure(['effect could not be read']);
  }
}

function durationText(duration, tr) {
  if (!Number.isInteger(duration) || duration < 0) return tr('sandbox.effects.permanent');
  if (duration === 1) return tr('sandbox.effects.durationOne');
  return fill(tr('sandbox.effects.durationMany'), { count: duration });
}

function describeChange(change, tr) {
  if (!isObject(change) || typeof change.key !== 'string' || change.key === '') return '';
  const key = cleanText(change.key).slice(0, 64);
  const mode = EFFECT_MODES.includes(change.mode) ? change.mode : null;
  let value = '';
  if (typeof change.value === 'number' && Number.isFinite(change.value)) value = String(change.value);
  else if (typeof change.value === 'string') value = cleanText(change.value).slice(0, LIMITS.value);
  if (mode === 'add' && typeof change.value === 'number' && change.value >= 0) value = `+${value}`;
  if (!mode) return `${key} ${value}`.trim();
  return fill(tr(CHANGE_TEMPLATE_KEY[mode]), { key, value });
}

/**
 * One short line describing the changes of an effect, escaped for HTML.
 * Example (raw): "Might +2, Speed x1.5". Never throws.
 */
export function effectSummary(effect, t) {
  const tr = translator(t);
  try {
    const list = isObject(effect) && Array.isArray(effect.changes) ? effect.changes.slice(0, LIMITS.changes) : [];
    const parts = list.map((change) => describeChange(change, tr)).filter((part) => part !== '');
    if (parts.length === 0) return esc(tr('sandbox.effects.noChanges'));
    let text = parts.join(', ');
    if (text.length > LIMITS.summary) text = `${text.slice(0, LIMITS.summary - 1)}…`;
    return esc(text);
  } catch {
    return esc(tr('sandbox.effects.noChanges'));
  }
}

/** A new, empty draft for the create form. Duration is text because it comes from an input. */
export function blankDraft() {
  return { name: '', origin: '', icon: '', duration: '-1', disabled: false, changes: [] };
}

/** Copies a stored effect into an editable draft (all values as text, as the inputs need them). */
export function draftFromEffect(effect) {
  const source = isObject(effect) ? effect : {};
  const changes = Array.isArray(source.changes)
    ? source.changes.filter(isObject).map((c) => ({ key: textOf(c.key), mode: textOf(c.mode), value: textOf(c.value) }))
    : [];
  return {
    name: textOf(source.name),
    origin: textOf(source.origin),
    icon: textOf(source.icon),
    duration: textOf(source.duration ?? -1),
    disabled: source.disabled === true,
    changes,
  };
}

function renderChangeRow(change, index, id, tr) {
  const options = EFFECT_MODES.map((mode) => {
    const selected = change.mode === mode ? ' selected' : '';
    return `<option value="${esc(mode)}"${selected}>${esc(tr(MODE_LABEL_KEY[mode]))}</option>`;
  }).join('');
  const i = String(index);
  return `<div class="ldm-fx-change">
    <label class="ldm-fx-field"><span>${esc(tr('sandbox.effects.changeKey'))}</span><input type="text" value="${esc(change.key)}" placeholder="attrs.might" autocomplete="off" spellcheck="false" data-ldm-fx-field="change-key" data-ldm-fx-index="${esc(i)}"></label>
    <label class="ldm-fx-field"><span>${esc(tr('sandbox.effects.changeMode'))}</span><select data-ldm-fx-field="change-mode" data-ldm-fx-index="${esc(i)}">${options}</select></label>
    <label class="ldm-fx-field"><span>${esc(tr('sandbox.effects.changeValue'))}</span><input type="text" value="${esc(change.value)}" autocomplete="off" data-ldm-fx-field="change-value" data-ldm-fx-index="${esc(i)}"></label>
    <button type="button" class="ldm-fx-btn ldm-fx-btn--danger" data-ldm-fx-action="remove-change" data-ldm-fx-id="${esc(id)}" data-ldm-fx-index="${esc(i)}">${esc(tr('sandbox.effects.removeChange'))}</button>
  </div>`;
}

function renderForm(id, draft, errors, tr) {
  const changes = Array.isArray(draft.changes) ? draft.changes.filter(isObject) : [];
  const title = id === NEW_ID ? tr('sandbox.effects.newTitle') : tr('sandbox.effects.editTitle');
  const errorList = errors.length
    ? `<ul class="ldm-fx-errors" role="alert">${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`
    : '';
  const enabled = draft.disabled === true ? '' : ' checked';
  const full = changes.length >= LIMITS.changes ? ' disabled' : '';
  return `<li class="ldm-fx-row ldm-fx-row--editing" data-ldm-fx-id="${esc(id)}">
    <div class="ldm-fx-form">
      <h4 class="ldm-fx-form-title">${esc(title)}</h4>
      ${errorList}
      <div class="ldm-fx-grid">
        <label class="ldm-fx-field"><span>${esc(tr('sandbox.effects.name'))}</span><input type="text" maxlength="${LIMITS.name}" value="${esc(textOf(draft.name))}" autocomplete="off" data-ldm-fx-field="name"></label>
        <label class="ldm-fx-field"><span>${esc(tr('sandbox.effects.origin'))}</span><input type="text" maxlength="${LIMITS.origin}" value="${esc(textOf(draft.origin))}" autocomplete="off" data-ldm-fx-field="origin"></label>
        <label class="ldm-fx-field"><span>${esc(tr('sandbox.effects.icon'))}</span><input type="text" maxlength="${LIMITS.icon}" value="${esc(textOf(draft.icon))}" autocomplete="off" spellcheck="false" data-ldm-fx-field="icon"></label>
        <label class="ldm-fx-field"><span>${esc(tr('sandbox.effects.duration'))}</span><input type="number" step="1" min="-1" max="${LIMITS.duration}" value="${esc(textOf(draft.duration))}" data-ldm-fx-field="duration"></label>
      </div>
      <label class="ldm-fx-check"><input type="checkbox" data-ldm-fx-field="disabled"${enabled}> <span>${esc(tr('sandbox.effects.enabled'))}</span></label>
      <fieldset class="ldm-fx-changes">
        <legend>${esc(tr('sandbox.effects.changes'))}</legend>
        <p class="ldm-fx-hint">${esc(tr('sandbox.effects.keyHint'))}</p>
        ${changes.map((c, i) => renderChangeRow(c, i, id, tr)).join('')}
        <button type="button" class="ldm-fx-btn" data-ldm-fx-action="add-change" data-ldm-fx-id="${esc(id)}"${full}>${esc(tr('sandbox.effects.addChange'))}</button>
      </fieldset>
      <div class="ldm-fx-form-actions">
        <button type="button" class="ldm-fx-btn ldm-fx-btn--primary" data-ldm-fx-action="save" data-ldm-fx-id="${esc(id)}">${esc(tr('sandbox.effects.save'))}</button>
        <button type="button" class="ldm-fx-btn" data-ldm-fx-action="cancel" data-ldm-fx-id="${esc(id)}">${esc(tr('sandbox.effects.cancel'))}</button>
      </div>
    </div>
  </li>`;
}

function actionButton(action, id, label, extraClass = '') {
  return `<button type="button" class="ldm-fx-btn${extraClass}" data-ldm-fx-action="${action}" data-ldm-fx-id="${esc(id)}">${esc(label)}</button>`;
}

function renderRow(effect, editable, t) {
  const tr = translator(t);
  const id = typeof effect.id === 'string' ? effect.id : '';
  const name = textOf(effect.name) || tr('sandbox.effects.unnamed');
  const origin = textOf(effect.origin);
  const on = effect.disabled !== true;
  const icon = typeof effect.icon === 'string' && effect.icon !== '' && isSafeIcon(effect.icon)
    ? `<img class="ldm-fx-icon" src="${esc(effect.icon)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : '<span class="ldm-fx-icon ldm-fx-icon--empty" aria-hidden="true"></span>';
  const badge = on ? tr('sandbox.effects.stateOn') : tr('sandbox.effects.stateOff');
  const actions = editable
    ? `<div class="ldm-fx-actions">${actionButton('edit', id, tr('sandbox.effects.edit'))}${actionButton('toggle', id, on ? tr('sandbox.effects.disable') : tr('sandbox.effects.enable'))}${actionButton('delete', id, tr('sandbox.effects.delete'), ' ldm-fx-btn--danger')}</div>`
    : '';
  return `<li class="ldm-fx-row${on ? '' : ' ldm-fx-row--off'}" data-ldm-fx-id="${esc(id)}">
    ${icon}
    <div class="ldm-fx-main">
      <div class="ldm-fx-name">${esc(name)}</div>
      ${origin ? `<div class="ldm-fx-origin">${esc(origin)}</div>` : ''}
      <div class="ldm-fx-summary">${effectSummary(effect, t)}</div>
    </div>
    <div class="ldm-fx-meta">
      <span class="ldm-fx-badge ldm-fx-badge--${on ? 'on' : 'off'}">${esc(badge)}</span>
      <span class="ldm-fx-duration">${esc(durationText(effect.duration, tr))}</span>
    </div>
    ${actions}
  </li>`;
}

/**
 * Renders the Effects block as an escaped HTML string.
 * Options: effects (list), editable (bool), ownerKind ('actor' | 'item'), editingId (id, or '__new__'
 * for the create form), draft (optional, the typed values of the open form), errors (optional list of
 * messages shown in the form), t(key, fallback). Edit controls only appear when editable is true.
 */
export function renderEffectsBlock(options = {}) {
  const o = isObject(options) ? options : {};
  const tr = translator(o.t);
  const owner = o.ownerKind === 'item' ? 'item' : 'actor';
  const editable = o.editable === true;
  const effects = Array.isArray(o.effects) ? o.effects.filter(isObject) : [];
  const editing = editable && typeof o.editingId === 'string' && o.editingId !== '' ? o.editingId : null;
  const errors = Array.isArray(o.errors) ? o.errors.filter((e) => typeof e === 'string') : [];
  const hintKey = owner === 'item' ? 'sandbox.effects.itemHint' : 'sandbox.effects.actorHint';

  const items = [];
  if (editing === NEW_ID) {
    const draft = isObject(o.draft) ? o.draft : blankDraft();
    items.push(renderForm(NEW_ID, draft, errors, tr));
  }
  for (const effect of effects) {
    const id = typeof effect.id === 'string' ? effect.id : '';
    if (editing && editing !== NEW_ID && id === editing) {
      const draft = isObject(o.draft) ? o.draft : draftFromEffect(effect);
      items.push(renderForm(id, draft, errors, tr));
    } else {
      items.push(renderRow(effect, editable, o.t));
    }
  }

  const addButton = editable && editing !== NEW_ID
    ? `<button type="button" class="ldm-fx-btn ldm-fx-btn--primary" data-ldm-fx-action="add">${esc(tr('sandbox.effects.add'))}</button>`
    : '';
  const body = items.length
    ? `<ul class="ldm-fx-list">${items.join('')}</ul>`
    : `<p class="ldm-fx-empty">${esc(tr('sandbox.effects.empty'))}</p>`;

  return `<section class="ldm-fx ldm-fx--${owner}" data-ldm-fx-owner="${owner}">
    <header class="ldm-fx-head">
      <h3 class="ldm-fx-title">${esc(tr('sandbox.effects.title'))}</h3>
      ${addButton}
    </header>
    <p class="ldm-fx-hint">${esc(tr(hintKey))}</p>
    ${body}
  </section>`;
}

// ══════════════════════════════════════════════════════════════
// Item use: copy the item's effects onto the actor (pure plan).
// The engine never applies an effect with only an itemId (see (2) above), so when an item is used
// this system creates or refreshes one ACTOR effect per enabled item effect. origin is exactly
// "item:<itemId>" and is the dedupe key, together with the base name ("<name> (<item name>)").
// ══════════════════════════════════════════════════════════════

/** Most actor effects one item use may create or refresh. */
export const ITEM_EFFECT_LIMIT = 20;
const ITEM_ORIGIN_PREFIX = 'item:';

function isDisabledFlag(value) {
  return value === true || value === 1;
}

/** "<name> (<item name>)", cut to the name limit. An empty base stays empty so normalizeEffect refuses it. */
function composeEffectName(base, itemName) {
  if (base === '') return '';
  const full = itemName ? `${base} (${itemName})` : base;
  return full.length > LIMITS.name ? full.slice(0, LIMITS.name) : full;
}

/** True when an existing actor effect is the copy of this item effect (same base name, from this item). */
function isCopyOf(row, base, fullName) {
  const name = textOf(row.name);
  return name === fullName || name === base || name.startsWith(`${base} (`);
}

/**
 * Plans what using an item does to the actor's effects. Pure: no window, no API.
 *
 * Input: { itemEffects, actorEffects, item: { id, name }, actorId, worldId }.
 * Output: { creates: [payload], updates: [{ id, patch }], skipped: n }.
 *  - a payload is { worldId, actorId, name, icon, origin, duration, disabled: false, changes }, already
 *    normalised by normalizeEffect (a failing normalisation is skipped, not thrown);
 *  - an existing actor effect with origin "item:<itemId>" and the same base name is UPDATED (duration and
 *    changes replaced, icon and name refreshed) instead of duplicated. Its disabled flag is kept, so a
 *    copy the GM switched off stays off;
 *  - disabled item effects, effects without changes and effects beyond ITEM_EFFECT_LIMIT are skipped.
 * Never throws. Hostile names are only cleaned here (control characters, length); the view escapes them.
 */
export function planItemEffectsApplication(input = {}) {
  const empty = (skipped) => ({ creates: [], updates: [], skipped });
  try {
    const o = isObject(input) ? input : {};
    const itemEffects = Array.isArray(o.itemEffects) ? o.itemEffects.filter(isObject) : [];
    const actorEffects = Array.isArray(o.actorEffects) ? o.actorEffects.filter(isObject) : [];
    const item = isObject(o.item) ? o.item : {};
    const itemId = typeof item.id === 'string' ? item.id : '';
    const actorId = typeof o.actorId === 'string' ? o.actorId : '';
    const worldId = typeof o.worldId === 'string' ? o.worldId : '';
    if (!ID_PATTERN.test(itemId) || !OWNER_ID_PATTERN.test(actorId) || !ID_PATTERN.test(worldId)) {
      return empty(itemEffects.length);
    }

    const itemName = cleanText(textOf(item.name)).slice(0, LIMITS.name);
    const origin = `${ITEM_ORIGIN_PREFIX}${itemId}`;
    const copies = actorEffects.filter((row) => row.origin === origin && typeof row.id === 'string');
    const claimed = new Set();
    const creates = [];
    const updates = [];
    let skipped = 0;

    for (const effect of itemEffects) {
      if (creates.length + updates.length >= ITEM_EFFECT_LIMIT) {
        skipped += 1;
        continue;
      }
      if (isDisabledFlag(effect.disabled)) {
        skipped += 1;
        continue;
      }
      if (!Array.isArray(effect.changes) || effect.changes.length === 0) {
        skipped += 1;
        continue;
      }
      const base = cleanText(textOf(effect.name));
      const name = composeEffectName(base, itemName);
      const result = normalizeEffect({
        name,
        origin,
        icon: textOf(effect.icon),
        duration: effect.duration,
        disabled: false,
        changes: effect.changes,
      });
      if (!result.ok) {
        skipped += 1;
        continue;
      }
      const fields = result.effect;
      const match = copies.find((row) => !claimed.has(row.id) && isCopyOf(row, base, fields.name));
      if (match) {
        claimed.add(match.id);
        updates.push({
          id: match.id,
          patch: { name: fields.name, icon: fields.icon, origin, duration: fields.duration, changes: fields.changes },
        });
      } else {
        creates.push({
          worldId,
          actorId,
          name: fields.name,
          icon: fields.icon,
          origin,
          duration: fields.duration,
          disabled: false,
          changes: fields.changes,
        });
      }
    }
    return { creates, updates, skipped };
  } catch {
    return empty(0);
  }
}

// ══════════════════════════════════════════════════════════════
// Engine layer (window.Loom). Nothing below runs at import time.
// ══════════════════════════════════════════════════════════════

const ATTACHED = Symbol.for('loom-demo-system.effects-view');
const defaultTr = translator(undefined);
const states = new WeakMap();

function engineLoom() {
  try {
    const loom = globalThis.window?.Loom;
    return loom && typeof loom === 'object' ? loom : undefined;
  } catch {
    return undefined;
  }
}

function engineEffects() {
  return engineLoom()?.effects;
}

function engineToast(text, type = 'error') {
  try {
    const loom = engineLoom();
    if (typeof loom?.showToast === 'function') loom.showToast(text, type);
  } catch {
    // A toast must never break the sheet.
  }
}

function worldIdOf() {
  try {
    const id = engineLoom()?.world?.id;
    return typeof id === 'string' && id !== '' ? id : null;
  } catch {
    return null;
  }
}

/** GET the owner's effects. Throws on failure (the callers decide what to show). */
async function fetchOwnerEffects(ownerKind, ownerId) {
  const api = engineEffects();
  const id = typeof ownerId === 'string' ? ownerId : '';
  if (!api || !OWNER_ID_PATTERN.test(id)) return [];
  const read = ownerKind === 'item' ? api.forItem : api.forActor;
  if (typeof read !== 'function') return [];
  const body = await read.call(api, id);
  const rows = Array.isArray(body) ? body : isObject(body) && Array.isArray(body.data) ? body.data : [];
  return rows.filter((row) => isObject(row) && typeof row.id === 'string');
}

/**
 * Loads the effects of an actor ('actor') or an item ('item'). Returns [] when the API is missing,
 * the id is unusable, or the request fails (the failure is shown as a toast). Never throws.
 */
export async function loadEffects(ownerKind, ownerId) {
  try {
    return await fetchOwnerEffects(ownerKind, ownerId);
  } catch (err) {
    engineToast(fill(defaultTr('sandbox.effects.loadFailed'), { message: messageOf(err) }), 'error');
    return [];
  }
}

function messageOf(err) {
  const text = err && typeof err === 'object' && typeof err.message === 'string' ? err.message : '';
  return text.slice(0, 200) || 'unknown error';
}

/** Translator for toasts: the engine's i18n when it is there, the English fallback otherwise. Never throws. */
function engineTranslator() {
  try {
    const loom = engineLoom();
    const i18n = loom?.i18n;
    const localize = i18n?.localize;
    return translator(typeof localize === 'function' ? (key) => localize.call(i18n, key) : undefined);
  } catch {
    return translator(undefined);
  }
}

/**
 * Copies the enabled effects of an item onto the actor (see planItemEffectsApplication). Creates
 * run first, then updates, ONE request at a time. A 403 or any other failure stops the run and
 * shows one localized toast; what was done before the failure is kept and reported.
 *
 * Returns { ok, created, updated, skipped, error }. Never throws. The caller shows the summary toast.
 */
export async function applyItemEffects(item, actorId, worldId) {
  const result = { ok: true, created: 0, updated: 0, skipped: 0, error: null };
  try {
    const api = engineEffects();
    if (!api || typeof api.create !== 'function' || typeof api.update !== 'function') {
      throw new Error('effects API is not available');
    }
    const itemId = isObject(item) && typeof item.id === 'string' ? item.id : '';
    const itemEffects = await fetchOwnerEffects('item', itemId);
    if (itemEffects.length === 0) return result;

    const actorEffects = await fetchOwnerEffects('actor', typeof actorId === 'string' ? actorId : '');
    const plan = planItemEffectsApplication({ itemEffects, actorEffects, item, actorId, worldId });
    result.skipped = plan.skipped;

    for (const payload of plan.creates) {
      await api.create(payload);
      result.created += 1;
    }
    for (const op of plan.updates) {
      await api.update(op.id, op.patch);
      result.updated += 1;
    }
    return result;
  } catch (err) {
    const tr = engineTranslator();
    const message = err && err.status === 403
      ? tr('sandbox.effects.forbidden')
      : fill(tr('sandbox.effects.applyFailed'), { message: messageOf(err) });
    engineToast(message, 'error');
    return { ...result, ok: false, error: messageOf(err) };
  }
}

function readOptions(options) {
  const src = isObject(options) ? options : {};
  const fn = (value, fallback) => (typeof value === 'function' ? value : fallback);
  return {
    ownerKind: src.ownerKind === 'item' ? 'item' : 'actor',
    getOwnerId: fn(src.getOwnerId, () => ''),
    getEffects: fn(src.getEffects, () => []),
    setEffects: fn(src.setEffects, () => {}),
    isEditable: fn(src.isEditable, () => false),
    rerender: fn(src.rerender, () => {}),
    t: typeof src.t === 'function' ? src.t : undefined,
  };
}

function stateOf(root) {
  let state = states.get(root);
  if (!state) {
    state = { editingId: null, draft: null, errors: [], busy: false, pendingFocus: null };
    states.set(root, state);
  }
  return state;
}

/**
 * The edit state of an attached block, for the sheet's own render:
 * renderEffectsBlock({ ..., editingId, draft, errors } ) with these values.
 */
export function getEffectsEditState(root) {
  const state = root && typeof root === 'object' ? states.get(root) : undefined;
  return {
    editingId: state?.editingId ?? null,
    draft: state?.draft ?? null,
    errors: state ? [...state.errors] : [],
  };
}

function safeCall(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function ownerIdOf(config) {
  const value = safeCall(() => config.getOwnerId(), '');
  if (typeof value === 'string') return value;
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

function listOf(config) {
  const value = safeCall(() => config.getEffects(), []);
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function findEffect(config, id) {
  return listOf(config).find((effect) => effect.id === id) ?? null;
}

function readAttr(el, name) {
  try {
    if (!el) return '';
    if (typeof el.getAttribute === 'function') {
      const value = el.getAttribute(name);
      return typeof value === 'string' ? value : '';
    }
    const prop = name.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = el.dataset?.[prop];
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

function parseIndex(text) {
  return /^\d{1,3}$/.test(text) ? Number(text) : -1;
}

function insideRoot(root, el) {
  if (!el) return false;
  if (el === root) return true;
  return typeof root.contains === 'function' ? root.contains(el) === true : true;
}

function reportFailure(config, err, key) {
  const tr = translator(config.t);
  const text = err && err.status === 403
    ? tr('sandbox.effects.forbidden')
    : fill(tr(key), { message: messageOf(err) });
  engineToast(text, 'error');
}

function focusMatch(root, state, focusKey) {
  try {
    if (typeof root.querySelectorAll !== 'function') return;
    const pending = state.pendingFocus;
    state.pendingFocus = null;
    const nodes = root.querySelectorAll('[data-ldm-fx-action],[data-ldm-fx-field]');
    for (const node of nodes) {
      const hit = pending
        ? readAttr(node, 'data-ldm-fx-field') === pending.field && readAttr(node, 'data-ldm-fx-index') === String(pending.index)
        : Boolean(focusKey) &&
          readAttr(node, 'data-ldm-fx-action') === focusKey.action &&
          readAttr(node, 'data-ldm-fx-id') === focusKey.id &&
          readAttr(node, 'data-ldm-fx-index') === focusKey.index;
      if (hit) {
        if (typeof node.focus === 'function') node.focus();
        return;
      }
    }
  } catch {
    // Focus is a convenience; a failed restore is ignored.
  }
}

/** Calls the sheet's rerender, then puts focus back on the control the user was using. */
function rerenderWithFocus(root, config, state, focusKey) {
  try {
    config.rerender();
  } catch {
    // The sheet's render failing is its own problem; the block state stays consistent.
  }
  focusMatch(root, state, focusKey);
}

async function reload(root, config) {
  const state = stateOf(root);
  try {
    const list = await fetchOwnerEffects(config.ownerKind, ownerIdOf(config));
    config.setEffects(list);
  } catch (err) {
    reportFailure(config, err, 'sandbox.effects.loadFailed');
  }
  rerenderWithFocus(root, config, state, null);
}

async function saveDraft(root, config, state) {
  if (state.busy || !state.draft) return;
  const result = normalizeEffect(state.draft);
  if (!result.ok) {
    state.errors = result.errors;
    rerenderWithFocus(root, config, state, null);
    return;
  }
  const creating = state.editingId === NEW_ID;
  const ownerId = ownerIdOf(config);
  if (creating && !ownerId) {
    engineToast(defaultTr('sandbox.effects.noOwner'), 'error');
    return;
  }
  if (!creating && !ID_PATTERN.test(String(state.editingId))) return;

  state.busy = true;
  state.errors = [];
  try {
    const api = engineEffects();
    if (!api) throw new Error('effects API is not available');
    if (creating) {
      const owner = config.ownerKind === 'item' ? { itemId: ownerId } : { actorId: ownerId };
      await api.create({ ...result.effect, worldId: worldIdOf(), ...owner });
    } else {
      await api.update(state.editingId, result.effect);
    }
    state.editingId = null;
    state.draft = null;
    state.busy = false;
    await reload(root, config);
  } catch (err) {
    reportFailure(config, err, 'sandbox.effects.saveFailed');
    state.busy = false;
    rerenderWithFocus(root, config, state, null);
  } finally {
    state.busy = false;
  }
}

async function toggleEffect(root, config, state, id) {
  if (state.busy || !ID_PATTERN.test(id)) return;
  const effect = findEffect(config, id);
  if (!effect) return;
  state.busy = true;
  try {
    const api = engineEffects();
    if (!api) throw new Error('effects API is not available');
    await api.update(id, { disabled: effect.disabled !== true ? true : false });
  } catch (err) {
    reportFailure(config, err, 'sandbox.effects.toggleFailed');
  } finally {
    state.busy = false;
  }
  await reload(root, config);
}

async function deleteEffect(root, config, state, id) {
  if (state.busy || !ID_PATTERN.test(id)) return;
  state.busy = true;
  try {
    const api = engineEffects();
    if (!api) throw new Error('effects API is not available');
    await api.delete(id);
    if (state.editingId === id) {
      state.editingId = null;
      state.draft = null;
    }
  } catch (err) {
    reportFailure(config, err, 'sandbox.effects.deleteFailed');
  } finally {
    state.busy = false;
  }
  await reload(root, config);
}

/** Runs one data-action. Synchronous state changes re-render at once; API work reloads afterwards. */
async function runAction(root, config, state, action, el) {
  const focusKey = {
    action,
    id: readAttr(el, 'data-ldm-fx-id'),
    index: readAttr(el, 'data-ldm-fx-index'),
  };
  const rerender = () => rerenderWithFocus(root, config, state, focusKey);
  const id = focusKey.id;

  switch (action) {
    case 'add':
      state.editingId = NEW_ID;
      state.draft = blankDraft();
      state.errors = [];
      return rerender();
    case 'edit': {
      if (!ID_PATTERN.test(id)) return undefined;
      const effect = findEffect(config, id);
      if (!effect) return undefined;
      state.editingId = id;
      state.draft = draftFromEffect(effect);
      state.errors = [];
      return rerender();
    }
    case 'cancel':
      state.editingId = null;
      state.draft = null;
      state.errors = [];
      return rerender();
    case 'add-change': {
      if (!state.draft) return undefined;
      if (state.draft.changes.length >= LIMITS.changes) {
        engineToast(defaultTr('sandbox.effects.tooManyChanges'), 'error');
        return undefined;
      }
      state.draft.changes.push({ key: '', mode: 'add', value: '' });
      state.pendingFocus = { field: 'change-key', index: state.draft.changes.length - 1 };
      return rerender();
    }
    case 'remove-change': {
      const index = parseIndex(focusKey.index);
      if (!state.draft || index < 0 || index >= state.draft.changes.length) return undefined;
      state.draft.changes.splice(index, 1);
      return rerender();
    }
    case 'save':
      return saveDraft(root, config, state);
    case 'toggle':
      return toggleEffect(root, config, state, id);
    case 'delete':
      return deleteEffect(root, config, state, id);
    default:
      return undefined;
  }
}

function closestAction(root, target) {
  if (!target || typeof target.closest !== 'function') return null;
  const el = target.closest('[data-ldm-fx-action]');
  if (!el || !insideRoot(root, el)) return null;
  return el;
}

function onChange(root, event) {
  const el = event?.target;
  const state = stateOf(root);
  if (!el || !insideRoot(root, el) || !state.draft) return;
  const field = readAttr(el, 'data-ldm-fx-field');
  const draft = state.draft;
  // Typed values go into the draft only. No re-render here, so focus stays in the input.
  switch (field) {
    case 'name':
    case 'origin':
    case 'icon':
    case 'duration':
      draft[field] = textOf(el.value);
      return;
    case 'disabled':
      draft.disabled = el.checked !== true;
      return;
    case 'change-key':
    case 'change-mode':
    case 'change-value': {
      const row = draft.changes[parseIndex(readAttr(el, 'data-ldm-fx-index'))];
      if (!row) return;
      if (field === 'change-mode') {
        if (EFFECT_MODES.includes(el.value)) row.mode = el.value;
        return;
      }
      row[field === 'change-key' ? 'key' : 'value'] = textOf(el.value);
      return;
    }
    default:
      return;
  }
}

async function onClick(root, config, event) {
  const el = closestAction(root, event?.target);
  if (!el) return;
  const action = readAttr(el, 'data-ldm-fx-action');
  if (!ACTIONS.has(action)) return;
  const state = stateOf(root);
  if (MUTATING_ACTIONS.has(action) && safeCall(() => config.isEditable() === true, false) !== true) {
    engineToast(translator(config.t)('sandbox.effects.readOnly'), 'warning');
    return;
  }
  await runAction(root, config, state, action, el);
}

/**
 * Attaches the block's behaviour to root: ONE delegated click listener and ONE delegated change
 * listener, both calling the same handler. Attaching twice keeps the listeners and replaces the
 * callbacks. Returns the detach function.
 *
 * Options: ownerKind ('actor' | 'item'), getOwnerId() (the actor or item id), getEffects() (the current
 * list), setEffects(list), isEditable() (GM or owner), rerender() (the sheet re-renders the block from
 * getEffectsEditState(root)), t(key, fallback) for toast text.
 */
export function attachEffects(root, options = {}) {
  if (!root || typeof root.addEventListener !== 'function') return () => {};
  const config = readOptions(options);
  const previous = root[ATTACHED];
  if (previous) {
    previous.config = config;
    return previous.detach;
  }

  const record = { config, detach: null };
  const listener = (event) => {
    try {
      if (event?.type === 'change') {
        onChange(root, event);
        return undefined;
      }
      return Promise.resolve(onClick(root, record.config, event)).catch(() => {
        // Never let a failure escape into the engine's event loop.
      });
    } catch {
      return undefined;
    }
  };
  root.addEventListener('click', listener);
  root.addEventListener('change', listener);
  record.detach = () => {
    root.removeEventListener?.('click', listener);
    root.removeEventListener?.('change', listener);
    if (root[ATTACHED] === record) delete root[ATTACHED];
    states.delete(root);
  };
  root[ATTACHED] = record;
  return record.detach;
}
