// ══════════════════════════════════════════════════════════════
// Loom Demo System — sheets/item-sheet.mjs
// ══════════════════════════════════════════════════════════════
//
// Configurable item sheet (LoomItemSheet). One class for every item type: gear, ability,
// spell, weapon, armor, potion, scroll (and '*' as the fallback). The generic item sheet
// discards the system's data model, so this class ships its own render and save path.
//
// Pure logic (normalization, context, HTML) lives in sheets/item-view.mjs and is tested in
// plain Node. This file only wires it to the engine:
// - the config is re-read with loadConfig({ fresh: true }) on open and before each save;
// - edits are debounced (300 ms) and saved with one PUT to /api/items/:id (the world route
//   also refreshes the owning actor for embedded items);
// - one delegated listener (the engine's data-action dispatch, plus the form change/input
//   listener of the document sheet) handles every control;
// - focus and caret are restored after a re-render, so typing is not lost.

import { LoomHandlebarsMixin, LoomItemSheet, api, sheets, showToast } from '/_loom/sdk/index.js';
import { loadConfig, resolveItemLayout } from '../lib/config.mjs';
import { isPlainObject } from '../lib/helpers.mjs';
import { attachTabs } from '../lib/layout-view.mjs';
import { attachEffects, loadEffects } from '../lib/effects-view.mjs';
import {
  ITEM_TYPES,
  applyField,
  buildItemContext,
  normalizeItemData,
  normalizeItemName,
  renderItem,
  safeImageUrl,
} from './item-view.mjs';

const SAVE_DEBOUNCE_MS = 300;
const IMG_MAX = 500;

/** Translator for the sheet: localized text, English fallback, never throws. */
function t(key, fallback) {
  try {
    const out = window.Loom?.i18n?.localize?.(key);
    return typeof out === 'string' && out !== '' && out !== key ? out : fallback;
  } catch {
    return fallback;
  }
}

export class DemoItemSheet extends LoomHandlebarsMixin(LoomItemSheet) {
  static PARTS = {
    main: { template: '/marketplace/rulesets/loom-demo-system/templates/item-sheet.hbs' },
  };

  get dataKey() { return 'data'; }

  constructor(props) {
    super({
      ...props,
      id: props.id || `item-sheet-${props.itemId || props.documentId}`,
      documentId: props.itemId || props.documentId,
      width: props.width || 440,
      height: props.height || 'auto',
    });
    this.itemId = props.itemId || props.documentId;
    this._cfg = null;
    this._cfgSignature = '';
    this._configChanged = false;
    this._pendingFields = new Map();
    this._formSaveTimer = undefined;
    this._focusSnapshot = null;
    this._portraitRejected = false;
    // Active tab key; kept across re-renders. Normalized to the first tab when unknown.
    this._activeTab = null;
    // Effects of this item, reloaded on every render (the engine has no live sync for them).
    this._effects = [];
    // Root element the tab and effects listeners were attached to (attach once per root).
    this._listenersRoot = null;
    this._effectsDetach = null;
  }

  /**
   * Reads the world config and remembers whether it differs from the previous read, so the
   * sheet can show a "configuration changed" hint. Never throws (loadConfig falls back).
   */
  async _readConfig() {
    const cfg = await loadConfig({ fresh: true });
    const signature = JSON.stringify(cfg);
    if (this._cfgSignature && signature !== this._cfgSignature) this._configChanged = true;
    this._cfgSignature = signature;
    this._cfg = cfg;
    return cfg;
  }

  async mount() {
    await this._readConfig();
    return super.mount();
  }

  async _prepareContext() {
    const base = await super._prepareContext();
    const cfg = this._cfg || (await this._readConfig());
    const editable = Boolean(this.document) && Boolean(this.isEditable);
    this._effects = await this._loadEffects();
    const ctx = buildItemContext(this.document || {}, cfg, t, {
      editable,
      configChanged: this._configChanged,
      portraitRejected: this._portraitRejected,
      activeTab: this._activeTab,
      effects: this._effects,
    });
    // Keep the normalized tab (an unknown key falls back to the first tab).
    this._activeTab = ctx.activeTab;
    return { ...base, body: renderItem(ctx) };
  }

  /** Effects of this item. Never throws: a failed load shows an empty list. */
  async _loadEffects() {
    try {
      const list = await loadEffects('item', this.itemId);
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  _postRender(...args) {
    if (typeof super._postRender === 'function') super._postRender(...args);
    this._restoreFocus();
    this._bindListeners();
  }

  /**
   * Attaches the tab and effects listeners to the sheet root. The root survives body
   * re-renders, so each listener is attached once per root; a new root gets its own.
   */
  _bindListeners() {
    const root = this.element;
    if (!root || this._listenersRoot === root) return;
    if (this._effectsDetach) this._effectsDetach();
    attachTabs(root, {
      getTabs: () => this._tabList(),
      getActive: () => this._activeTab,
      setActive: (key) => { this._activeTab = key; },
      rerender: (key) => this._showTab(key),
    });
    this._effectsDetach = attachEffects(root, {
      ownerKind: 'item',
      getOwnerId: () => this.itemId,
      getEffects: () => this._effects,
      setEffects: (list) => { this._effects = Array.isArray(list) ? list : []; },
      isEditable: () => Boolean(this.document) && Boolean(this.isEditable),
      rerender: () => { void this._reloadDocument(); },
    });
    this._listenersRoot = root;
  }

  /** Tab list of the current config (same order and keys the body was rendered with). */
  _tabList() {
    return resolveItemLayout(this._cfg || null).tabs;
  }

  /** Shows one tab and hides the others, in place: no body re-render, focus stays put. */
  _showTab(key) {
    this._activeTab = key;
    if (!this.element) return;
    for (const tab of this.element.querySelectorAll('.ldm-tab')) {
      const selected = tab.getAttribute('data-ldm-tab') === key;
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.setAttribute('tabindex', selected ? '0' : '-1');
    }
    for (const panel of this.element.querySelectorAll('.ldm-tabpanel[role="tabpanel"]')) {
      panel.hidden = panel.getAttribute('data-ldm-panel') !== key;
    }
  }

  /** Anti-blur: puts focus and caret back on the field the user was typing in. */
  _restoreFocus() {
    const snap = this._focusSnapshot;
    this._focusSnapshot = null;
    if (!snap || !this.element) return;
    const field = this.element.querySelector(`[data-field="${snap.field}"]`);
    if (!field || field.disabled) return;
    field.focus({ preventScroll: true });
    if (snap.selStart !== null && typeof field.setSelectionRange === 'function') {
      try { field.setSelectionRange(snap.selStart, snap.selEnd); } catch { /* not a text control */ }
    }
  }

  onAction(action, id, target) {
    if (action === 'clear-portrait') {
      if (!this.document || !this.isEditable) return;
      this._pendingFields.set('portrait', '');
      void this._flushPendingFields();
      return;
    }
    if (typeof super.onAction === 'function') super.onAction(action, id, target);
  }

  /** Single change/input entry point for every control in the sheet. */
  _onChangeForm(event) {
    const el = event?.target;
    const field = el?.dataset?.field;
    if (!field || !this.document || !this.isEditable) return;

    let value;
    if (el.type === 'checkbox') value = el.checked;
    else if (el.type === 'number') value = el.value.trim() === '' ? NaN : Number(el.value);
    else value = el.value;
    this._pendingFields.set(field, value);

    // Remember the caret only while typing; a committed change (select, blur) drops it.
    this._focusSnapshot = event.type === 'input'
      ? { field, selStart: el.selectionStart ?? null, selEnd: el.selectionEnd ?? null }
      : null;

    clearTimeout(this._formSaveTimer);
    this._formSaveTimer = setTimeout(() => {
      this._formSaveTimer = undefined;
      void this._flushPendingFields();
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Applies every pending field to a copy of the stored data, normalizes it and sends one PUT.
   * Key references that no longer exist are kept (normalizeItemData does not touch them).
   */
  async _flushPendingFields() {
    if (!this.document || this._pendingFields.size === 0) return;
    const pending = this._pendingFields;
    this._pendingFields = new Map();

    try {
      const type = typeof this.document.type === 'string' ? this.document.type : 'gear';
      const cfg = await this._readConfig();

      let data = isPlainObject(this.document.data) ? this.document.data : {};
      let name;
      let imgUrl;
      this._portraitRejected = false;

      for (const [field, value] of pending) {
        if (field === 'name') {
          name = normalizeItemName(value);
        } else if (field === 'portrait') {
          const raw = typeof value === 'string' ? value.trim().slice(0, IMG_MAX) : '';
          if (raw === '' || safeImageUrl(raw)) imgUrl = raw;
          else this._portraitRejected = true;
        } else {
          data = applyField(data, field, value);
        }
      }

      const body = { data: normalizeItemData(data, cfg, type) };
      if (name !== undefined && name !== '') body.name = name;
      if (imgUrl !== undefined) body.imgUrl = imgUrl;

      await api.put(`${this.apiRoute}/${this.document.id}`, body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(t('sandbox.item.saveFailed', `Could not save the item: ${message}`), 'error');
    }
    await this._reloadDocument();
  }
}

/**
 * Registers the sheet for every item type and the '*' fallback. Called from main.mjs.
 * Nothing registers itself at import time.
 */
export function registerItemSheet() {
  for (const type of [...ITEM_TYPES, '*']) sheets.catalog('item', type, DemoItemSheet);
}
