// Shared "tabs + grid" layout standard for the sandbox windows (actor sheet, item sheet,
// rule editor). Every window lays out its fields through these helpers so the look and the
// keyboard behaviour stay the same everywhere, and developers theme them with CSS variables
// (see styles/sandbox-layout.css).
//
// Pure module: no `window` or `document` at import time, safe to import in plain Node.
// The only DOM code is `attachTabs`, which is thin and not unit-tested.
//
// Exports:
//   clampColumns(value) -> 1..4 integer
//   renderTabs({ idPrefix, tabs, activeKey, labelOf, panels, ariaLabel }) -> HTML string
//   renderGrid(blocksHtml, columns) -> HTML string
//   renderBlock({ key, title, body }) -> HTML string (body is TRUSTED HTML built by the caller)
//   nextTabKey(tabs, activeKey, dir) -> key | null
//   firstTabKey(tabs) / lastTabKey(tabs) -> key | null
//   handleTabEvent(event, { tabs, activeKey }) -> new key | null
//   attachTabs(root, { getTabs, getActive, setActive, rerender }) -> detach function
//
// Callers are responsible for escaping every piece of data they put into `panels` and
// `body`. Everything this module derives from input (labels, keys, titles, ariaLabel) is
// escaped here.
//
// Optional localized string used by callers as `ariaLabel`: sandbox.layout.tablist

import { esc } from './helpers.mjs';

const MAX_COLUMNS = 4;
const DEFAULT_PREFIX = 'ldm';
const TAB_ATTR = 'data-ldm-tab';

/** Coerces any input to a grid column count: an integer clamped to 1..4. */
export function clampColumns(value) {
  let n;
  try {
    n = typeof value === 'number' ? value : Number(value);
  } catch {
    return 1;
  }
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_COLUMNS, Math.max(1, Math.floor(n)));
}

function safeString(value) {
  try {
    return value === null || value === undefined ? '' : String(value);
  } catch {
    return '';
  }
}

/** Reduces text to the id alphabet [a-z0-9_-]. Returns '' when nothing usable is left. */
function idPart(value) {
  return safeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * Normalizes the tabs input: drops non-object entries, coerces keys and labels to strings,
 * and keeps only the first tab for a duplicated key. Never throws.
 */
function normalizeTabs(tabs) {
  if (!Array.isArray(tabs)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of tabs) {
    if (raw === null || typeof raw !== 'object') continue;
    const key = safeString(raw.key);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      label: safeString(raw.label),
      columns: clampColumns(raw.columns),
      blocks: raw.blocks,
    });
  }
  return out;
}

function keysOf(tabs) {
  return normalizeTabs(tabs).map((tab) => tab.key);
}

/**
 * Renders a tab set. With exactly one tab, returns only the panel (no tab bar).
 * With more than one tab, returns a `.ldm-tabs` wrapper with a tablist and one tabpanel
 * per tab; inactive panels carry the `hidden` attribute.
 * `panels` maps tab keys to already-built, already-escaped HTML. Returns '' when there are
 * no valid tabs.
 */
export function renderTabs(options) {
  const opts = options !== null && typeof options === 'object' ? options : {};
  const tabs = normalizeTabs(opts.tabs);
  if (tabs.length === 0) return '';

  const prefix = idPart(opts.idPrefix) || DEFAULT_PREFIX;
  const panels = opts.panels !== null && typeof opts.panels === 'object' ? opts.panels : {};
  const keys = tabs.map((tab) => tab.key);
  const active = typeof opts.activeKey === 'string' && keys.includes(opts.activeKey)
    ? opts.activeKey
    : keys[0];

  const panelHtml = (key) =>
    Object.prototype.hasOwnProperty.call(panels, key) && typeof panels[key] === 'string'
      ? panels[key]
      : '';

  if (tabs.length === 1) {
    const tab = tabs[0];
    return `<div class="ldm-tabpanel ldm-grid-host" data-ldm-panel="${esc(tab.key)}" style="--ldm-cols:${clampColumns(tab.columns)}">${panelHtml(tab.key)}</div>`;
  }

  const labelFor = (tab) => {
    if (typeof opts.labelOf === 'function') {
      try {
        return safeString(opts.labelOf(tab));
      } catch {
        return tab.label;
      }
    }
    return tab.label;
  };

  const buttons = [];
  const panelBlocks = [];
  tabs.forEach((tab, index) => {
    const seg = idPart(tab.key) || 'tab';
    const tabId = `${prefix}-tab-${index}-${seg}`;
    const panelId = `${prefix}-panel-${index}-${seg}`;
    const isActive = tab.key === active;
    buttons.push(
      `<button type="button" role="tab" class="ldm-tab" ${TAB_ATTR}="${esc(tab.key)}" ` +
        `id="${tabId}" aria-selected="${isActive ? 'true' : 'false'}" ` +
        `aria-controls="${panelId}" tabindex="${isActive ? '0' : '-1'}">${esc(labelFor(tab))}</button>`,
    );
    panelBlocks.push(
      `<div class="ldm-tabpanel" role="tabpanel" id="${panelId}" aria-labelledby="${tabId}" ` +
        `data-ldm-panel="${esc(tab.key)}" tabindex="0" style="--ldm-cols:${clampColumns(tab.columns)}"` +
        `${isActive ? '' : ' hidden'}>${panelHtml(tab.key)}</div>`,
    );
  });

  const labelAttr = safeString(opts.ariaLabel) ? ` aria-label="${esc(opts.ariaLabel)}"` : '';
  return (
    `<div class="ldm-tabs">` +
    `<div class="ldm-tablist" role="tablist"${labelAttr}>${buttons.join('')}</div>` +
    panelBlocks.join('') +
    `</div>`
  );
}

/** Wraps already-built block HTML (array of strings) in a `.ldm-grid` with N columns. */
export function renderGrid(blocksHtml, columns) {
  const blocks = Array.isArray(blocksHtml)
    ? blocksHtml.filter((html) => typeof html === 'string')
    : [];
  return `<div class="ldm-grid" style="--ldm-cols:${clampColumns(columns)}">${blocks.join('')}</div>`;
}

/**
 * Renders one block card. The title is shown only when non-empty. `key` and `title` are
 * escaped. `body` is TRUSTED HTML: the caller must build and escape it.
 */
export function renderBlock({ key, title, body } = {}) {
  const heading = safeString(title).trim();
  const titleHtml = heading ? `<h3 class="ldm-block-title">${esc(heading)}</h3>` : '';
  const bodyHtml = typeof body === 'string' ? body : safeString(body);
  return (
    `<section class="ldm-block" data-ldm-block="${esc(safeString(key))}">` +
    `${titleHtml}<div class="ldm-block-body">${bodyHtml}</div></section>`
  );
}

/**
 * Returns the key one step away from `activeKey` in `dir` (-1 previous, +1 next), wrapping
 * around. An unknown `activeKey` starts from the first tab (+1) or the last tab (-1).
 * Returns null when there are no tabs.
 */
export function nextTabKey(tabs, activeKey, dir) {
  const keys = keysOf(tabs);
  if (keys.length === 0) return null;
  const step = dir < 0 ? -1 : dir > 0 ? 1 : 0;
  const index = keys.indexOf(safeString(activeKey));
  if (step === 0) return index === -1 ? keys[0] : keys[index];
  if (index === -1) return step > 0 ? keys[0] : keys[keys.length - 1];
  const n = keys.length;
  return keys[(((index + step) % n) + n) % n];
}

export function firstTabKey(tabs) {
  const keys = keysOf(tabs);
  return keys.length ? keys[0] : null;
}

export function lastTabKey(tabs) {
  const keys = keysOf(tabs);
  return keys.length ? keys[keys.length - 1] : null;
}

function readTabKey(el) {
  if (!el || typeof el !== 'object') return null;
  if (typeof el.getAttribute === 'function') {
    const value = el.getAttribute(TAB_ATTR);
    return typeof value === 'string' ? value : null;
  }
  if (el.dataset && typeof el.dataset.ldmTab === 'string') return el.dataset.ldmTab;
  return null;
}

/**
 * Decides what a click or keydown means for the tab set.
 * - click on a tab button selects that tab (unknown keys return null)
 * - ArrowLeft / ArrowRight move from the focused tab (wrapping), Home / End jump to the ends
 * - keydown anywhere outside a tab button (text inputs, for example) is ignored
 * Returns the new active key, or null when the event is not about tabs.
 */
export function handleTabEvent(event, state) {
  if (!event || typeof event !== 'object') return null;
  const tabs = state && typeof state === 'object' ? state.tabs : undefined;
  const activeKey = state && typeof state === 'object' ? state.activeKey : undefined;
  const keys = keysOf(tabs);
  if (keys.length === 0) return null;

  const target = event.target;
  const tabEl = target && typeof target.closest === 'function' ? target.closest(`[${TAB_ATTR}]`) : null;
  const tabKey = readTabKey(tabEl);

  if (event.type === 'click') {
    if (tabKey === null || !keys.includes(tabKey)) return null;
    return tabKey;
  }

  if (event.type !== 'keydown') return null;
  if (tabKey === null) return null;

  const base = keys.includes(tabKey) ? tabKey : keys.includes(safeString(activeKey)) ? safeString(activeKey) : keys[0];
  switch (event.key) {
    case 'ArrowLeft':
      return nextTabKey(tabs, base, -1);
    case 'ArrowRight':
      return nextTabKey(tabs, base, 1);
    case 'Home':
      return firstTabKey(tabs);
    case 'End':
      return lastTabKey(tabs);
    default:
      return null;
  }
}

const ATTACHED = Symbol('ldm-tabs-attached');

function focusTab(root, key) {
  if (typeof root.querySelectorAll !== 'function') return;
  const buttons = root.querySelectorAll(`[${TAB_ATTR}]`);
  for (const button of buttons) {
    if (readTabKey(button) === key && typeof button.focus === 'function') {
      button.focus();
      return;
    }
  }
}

/**
 * Adds ONE delegated click and ONE delegated keydown listener on `root`. The callbacks are
 * read on every event, so they always see current state. Attaching twice to the same root is
 * a no-op. Returns a detach function. Not unit-tested (DOM layer): `node --check` only.
 */
export function attachTabs(root, callbacks) {
  const noop = () => {};
  if (!root || typeof root.addEventListener !== 'function') return noop;
  if (root[ATTACHED]) return noop;
  const cbs = callbacks && typeof callbacks === 'object' ? callbacks : {};

  const onEvent = (event) => {
    try {
      const tabs = typeof cbs.getTabs === 'function' ? cbs.getTabs() : [];
      const activeKey = typeof cbs.getActive === 'function' ? cbs.getActive() : null;
      const next = handleTabEvent(event, { tabs, activeKey });
      if (next === null) return;
      if (event.type === 'keydown' && typeof event.preventDefault === 'function') {
        event.preventDefault();
      }
      if (next !== activeKey && typeof cbs.setActive === 'function') cbs.setActive(next);
      if (typeof cbs.rerender === 'function') cbs.rerender(next);
      if (event.type === 'keydown') focusTab(root, next);
    } catch {
      // A failed tab change must never escape into the engine event loop.
    }
  };

  root.addEventListener('click', onEvent);
  root.addEventListener('keydown', onEvent);
  root[ATTACHED] = true;

  return function detach() {
    root.removeEventListener('click', onEvent);
    root.removeEventListener('keydown', onEvent);
    delete root[ATTACHED];
  };
}
