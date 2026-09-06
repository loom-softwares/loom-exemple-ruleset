// ══════════════════════════════════════════════════════════════
// Loom Demo System — sheets/hero-sheet.mjs
// ══════════════════════════════════════════════════════════════
//
// Custom Handlebars sheet for the "hero" actor type — the "advanced" path,
// shown here alongside the declarative getSheetSchema() used by
// villain/beast in main.mjs. Use this pattern only when the declarative
// schema can't express what you need (custom layout, third-party widgets,
// etc.) — it is real extra code, not a shortcut.
//
// `LoomHandlebarsMixin(LoomActorSheet)` is the exact mechanism native
// systems use for a hand-written template (mirrors srd5e/wod6e — this is
// NOT Foundry sheet emulation, it's LoomVTT's own native equivalent).
import { LoomHandlebarsMixin, LoomActorSheet, api, showToast, showConfirm, showPrompt } from '/_loom/sdk/index.js';

export class HeroSheet extends LoomHandlebarsMixin(LoomActorSheet) {
  // `PARTS` mirrors ApplicationV2's static PARTS — the mixin reads this to
  // know which .hbs file(s) to fetch/compile/render for this window.
  static PARTS = {
    main: { template: '/marketplace/rulesets/loom-demo-system/templates/hero-sheet.hbs' },
  };

  /**
   * Custom sheets are NOT auto-wired with `documentId` — without this
   * constructor `this.options.documentId` stays undefined and the sheet
   * silently never loads the actor (see document-sheet.ts loadDocument:
   * `if (!this.options.documentId) return;`). Same minimal pattern
   * srd5e's Sdr5eCharacterSheet uses.
   * @param {Record<string, any>} props - Sheet options, must contain actorId.
   */
  constructor(props) {
    super({
      ...props,
      id: props.id || `actor-sheet-${props.actorId}`,
      documentId: props.actorId,
    });
    this.actorId = props.actorId;
  }

  // Tab bar. `Tabs` (client/components/tabs.ts) is a core-internal helper,
  // NOT exposed via the SDK — a ruleset only ever talks to the SDK surface,
  // so this hand-rolls the same convention (`data-action="tab-<id>"`,
  // `.tabs`/`.tab-button`/`.tab-content`/`.active` classes, already styled
  // globally in components.css) instead of importing something systems
  // can't actually reach.
  activeTab = 'attributes';

  // Active Effects ("Buffs" in Loom, /api/buffs) are core UI built into
  // ActorSheetWindow (the generic declarative sheet) — villain/beast get it
  // for free just by using getSheetSchema(). A custom sheet class like this
  // one does NOT inherit any of that, since it extends LoomActorSheet
  // directly, not ActorSheetWindow. This block is the minimal reimplementation
  // needed to have effects on a custom sheet too.
  buffs = [];

  /**
   * Loads the active buffs/effects list for this actor and triggers a re-render of the body.
   * @returns {Promise<void>}
   */
  async loadBuffs() {
    try {
      this.buffs = await api.get(`/buffs/actor/${this.actorId}`);
    } catch (e) {
      showToast(e?.message || 'Failed to load effects', 'error');
      this.buffs = [];
    }
    this.rerenderBody();
  }

  /**
   * Runs once, right after the first successful render — the right place to
   * kick off data that isn't part of the actor document itself.
   * @returns {Promise<void>}
   */
  async _onFirstRender() {
    await this.loadBuffs();
  }

  /**
   * Extends _prepareContext (defined by LoomDocumentSheet, see document-sheet.ts)
   * so the .hbs template can read `{{#each buffs}}` — the base context only
   * has `document`/`editable`/`user`, nothing sheet-specific.
   * @returns {Promise<Record<string, any>>} Extended template context.
   */
  async _prepareContext() {
    const base = await super._prepareContext();
    return {
      ...base,
      buffs: this.buffs,
      isAttributesTab: this.activeTab === 'attributes',
      isCombatTab: this.activeTab === 'combat',
      isEffectsTab: this.activeTab === 'effects',
    };
  }

  /**
   * `_onAction` (base-window.ts) already handles 'save'/'close'/etc and
   * falls through to `onAction` for anything it doesn't recognize — same
   * override point ActorSheetWindow uses.
   * @param {string} action - Action key from data-action.
   * @param {string} [id] - Optional ID passed from data-id.
   * @param {HTMLElement} [target] - The target element that triggered the action.
   * @returns {Promise<void>}
   */
  async onAction(action, id, target) {
    if (action?.startsWith('tab-')) {
      this.activeTab = action.slice(4);
      this.rerenderBody();
      return;
    }
    if (action === 'add-effect') return this.addEffect();
    if (action === 'edit-effect' && id) return this.editEffect(id);
    if (action === 'toggle-effect' && id) return this.toggleEffect(id);
    if (action === 'remove-effect' && id) return this.removeEffect(id);
  }

  /**
   * Creates a new Active Effect (Buff) document for this actor.
   * @returns {Promise<void>}
   */
  async addEffect() {
    try {
      await api.post('/buffs', {
        worldId: this.document?.worldId,
        actorId: this.actorId,
        name: `Effect ${this.buffs.length + 1}`,
        icon: '',
        origin: '',
        duration: -1,
        disabled: false,
        changes: [],
      });
      await this.loadBuffs();
      showToast('Effect added', 'success');
    } catch (e) {
      showToast(e?.message || 'Failed to add effect', 'error');
    }
  }

  /**
   * Prompts the user for a new name and updates an existing effect.
   * @param {string} buffId - ID of the effect to edit.
   * @returns {Promise<void>}
   */
  async editEffect(buffId) {
    const buff = this.buffs.find((b) => b.id === buffId);
    if (!buff) return;
    const name = await showPrompt('Edit Effect', 'Name', buff.name);
    if (!name) return;
    try {
      await api.put(`/buffs/${buffId}`, { name: name.trim() });
      await this.loadBuffs();
    } catch (e) {
      showToast(e?.message || 'Failed to update effect', 'error');
    }
  }

  /**
   * Toggles the active/disabled status of an effect.
   * @param {string} buffId - ID of the effect to toggle.
   * @returns {Promise<void>}
   */
  async toggleEffect(buffId) {
    const buff = this.buffs.find((b) => b.id === buffId);
    if (!buff) return;
    try {
      await api.put(`/buffs/${buffId}`, { disabled: !buff.disabled });
      await this.loadBuffs();
    } catch (e) {
      showToast(e?.message || 'Failed to toggle effect', 'error');
    }
  }

  /**
   * Prompts for confirmation and deletes an effect.
   * @param {string} buffId - ID of the effect to remove.
   * @returns {Promise<void>}
   */
  async removeEffect(buffId) {
    const confirmed = await showConfirm('Remove Effect', 'Remove this effect?');
    if (!confirmed) return;
    try {
      await api.delete(`/buffs/${buffId}`);
      await this.loadBuffs();
    } catch (e) {
      showToast(e?.message || 'Failed to remove effect', 'error');
    }
  }
}
