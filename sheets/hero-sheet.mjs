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
import { LoomHandlebarsMixin, LoomActorSheet, LoomDialog, api, showToast, showConfirm, showPrompt, windowManager, settings } from '/_loom/sdk/index.js';
import { DemoItemSheet } from './item-sheet.mjs';
import { enBundle, ptBundle } from '../data/locales.mjs';

/**
 * Helper to translate keys using Loom's native i18n engine (window.Loom.i18n.localize).
 * Demonstrates client-side localization for script dialogs, UI labels, and toasts.
 * @param {string} key - Translation key in lang/*.json
 * @param {string} [fallback] - Fallback text if key is unresolved
 * @returns {string}
 */
export function localize(key, fallback = '') {
  const text = window.Loom?.i18n?.localize?.(key);
  if (text && text !== key) return text;

  // Fallback to configured language bundle
  const chosenLang = settings.get('loom-demo-system', 'language') || document.documentElement?.lang || 'pt-BR';
  const bundle = chosenLang.startsWith('en') ? enBundle : ptBundle;
  const resolved = key.split('.').reduce((o, k) => o?.[k], bundle) || bundle[key];
  if (resolved) return resolved;

  return fallback || key;
}

/**
 * Retrieves the token target currently selected by the user on the canvas.
 * If a target is selected, returns its name, avatar, and defense rating.
 * @returns {{ name: string, defense: number, avatar: string, targetId: string, actorId: string } | null}
 */
function getActiveTarget() {
  const targets = window.Loom?.user?.targets || [];
  if (!targets.length) return null;
  const target = targets[0];
  let actor = null;
  if (target.actorId && window.Loom?.actors?.get) {
    actor = window.Loom.actors.get(target.actorId);
  }
  const name = target.name || actor?.name || localize('loom-demo-system.chat.target', 'Target');
  const defense = target.systemData?.defense ?? actor?.systemData?.defense ?? actor?.defense ?? 10;
  const avatar = target.imgUrl || target.avatarUrl || actor?.avatarUrl || '';
  return { name, defense, avatar, targetId: target.id, actorId: target.actorId };
}

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
      width: props.width || 660,
      height: props.height || 620,
    });
    this.actorId = props.actorId;
  }

  // Tab bar active state
  activeTab = 'attributes';

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
   * Runs once, right after the first successful render.
   * @returns {Promise<void>}
   */
  async _onFirstRender() {
    await this.loadBuffs();
  }

  /**
   * Extends _prepareContext so the .hbs template has access to:
   * - buffs list
   * - actor items / inventory
   * - hpPercent for dynamic health bar
   * - attributesList with icons, labels, values and derived bonuses
   * - tab state booleans
   * @returns {Promise<Record<string, any>>} Extended template context.
   */
  async _prepareContext() {
    const base = await super._prepareContext();
    const doc = this.document || {};
    const sd = doc.systemData || doc.system || {};
    const rawAttrs = sd.attributes || doc.attributes || { might: 5, swift: 5, wits: 5 };
    const rawHp = sd.hp || doc.hp || { value: 20, max: 20 };
    const baseDefense = Number(sd.defense ?? doc.defense ?? 10);

    const items = Array.isArray(doc.items) ? doc.items : [];
    let itemDefenseBonus = 0;
    let itemAttackBonus = 0;
    let itemDamageBonus = 0;
    let itemHpBonus = 0;
    let itemMightBonus = 0;
    let itemSwiftBonus = 0;
    let itemWitsBonus = 0;

    for (const item of items) {
      const isd = item.systemData || item.data || {};
      if (isd.defenseBonus) itemDefenseBonus += Number(isd.defenseBonus) || 0;
      if (isd.attackBonus) itemAttackBonus += Number(isd.attackBonus) || 0;
      if (isd.damageBonus) itemDamageBonus += Number(isd.damageBonus) || 0;
      if (isd.hpBonus) itemHpBonus += Number(isd.hpBonus) || 0;
      if (isd.mightBonus) itemMightBonus += Number(isd.mightBonus) || 0;
      if (isd.swiftBonus) itemSwiftBonus += Number(isd.swiftBonus) || 0;
      if (isd.witsBonus) itemWitsBonus += Number(isd.witsBonus) || 0;
    }

    const effectiveAttrs = {
      might: Number(rawAttrs.might || 0) + itemMightBonus,
      swift: Number(rawAttrs.swift || 0) + itemSwiftBonus,
      wits: Number(rawAttrs.wits || 0) + itemWitsBonus,
    };

    const bonus = {
      attack: Math.floor((effectiveAttrs.might || 0) / 2) + itemAttackBonus,
      dodge: Math.floor((effectiveAttrs.swift || 0) / 2),
      initiative: Math.floor((effectiveAttrs.swift || 0) / 2),
      detect: Math.floor((effectiveAttrs.wits || 0) / 2),
      ...(doc._bonus || {}),
    };

    const effectiveMaxHp = Math.max(1, Number(rawHp.max || 20) + itemHpBonus);
    const hpVal = Number(rawHp.value ?? effectiveMaxHp);
    const effectiveHp = {
      value: hpVal,
      max: effectiveMaxHp,
    };

    // Ensure document properties are directly reachable by template
    doc.rawAttributes = rawAttrs;
    doc.attributes = effectiveAttrs;
    doc.hp = effectiveHp;
    doc.defense = baseDefense + itemDefenseBonus;
    doc.baseDefense = baseDefense;
    doc._bonus = bonus;
    doc._itemDefenseBonus = itemDefenseBonus;
    doc._itemAttackBonus = itemAttackBonus;
    doc._itemDamageBonus = itemDamageBonus;
    doc._itemHpBonus = itemHpBonus;
    doc._itemAttrsBonus = {
      might: itemMightBonus,
      swift: itemSwiftBonus,
      wits: itemWitsBonus,
    };

    const hpPercent = Math.max(0, Math.min(100, Math.round((hpVal / effectiveMaxHp) * 100)));
    const attrs = effectiveAttrs;
    const attributesList = [
      {
        key: 'might',
        label: localize('loom-demo-system.attributes.might', 'Might'),
        icon: 'fa-solid fa-hand-fist',
        color: 'attr-might',
        desc: localize('loom-demo-system.attributes.mightDesc', 'Physical power & impact'),
        value: attrs.might ?? 5,
        bonus: bonus.attack,
        bonusLabel: localize('loom-demo-system.actions.attack', 'Attack'),
      },
      {
        key: 'swift',
        label: localize('loom-demo-system.attributes.swift', 'Swift'),
        icon: 'fa-solid fa-bolt',
        color: 'attr-swift',
        desc: localize('loom-demo-system.attributes.swiftDesc', 'Reflexes & agility'),
        value: attrs.swift ?? 5,
        bonus: bonus.dodge,
        bonusLabel: `${localize('loom-demo-system.actions.dodge', 'Dodge')} / ${localize('loom-demo-system.actions.initiative', 'Init')}`,
      },
      {
        key: 'wits',
        label: localize('loom-demo-system.attributes.wits', 'Wits'),
        icon: 'fa-solid fa-brain',
        color: 'attr-wits',
        desc: localize('loom-demo-system.attributes.witsDesc', 'Cunning & awareness'),
        value: attrs.wits ?? 5,
        bonus: bonus.detect,
        bonusLabel: localize('loom-demo-system.actions.perception', 'Perception'),
      },
    ];

    return {
      ...base,
      document: doc,
      buffs: this.buffs,
      items,
      hpPercent,
      attributesList,
      isAttributesTab: this.activeTab === 'attributes',
      isCombatTab: this.activeTab === 'combat',
      isItemsTab: this.activeTab === 'items',
      isEffectsTab: this.activeTab === 'effects',
    };
  }

  /**
   * Action dispatcher for UI buttons. Handles tabs, rolls, effects,
   * items, and delegates portrait picking to LoomDocumentSheet.
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

    if (action === 'roll-attribute') {
      const attr = target?.dataset?.attr || id;
      return this.rollAttribute(attr);
    }

    if (action === 'roll-combat') {
      const type = target?.dataset?.type || id;
      return this.rollCombat(type);
    }

    if (action === 'open-item' && id) {
      return this.openItemSheet(id);
    }

    if (action === 'roll-item-attack' && id) {
      return this.rollItemAttack(id);
    }

    if ((action === 'roll-item-damage' || action === 'roll-item') && id) {
      return this.rollItemDamage(id);
    }

    if (action === 'use-item' && id) {
      return this.useItem(id);
    }

    if (action === 'add-item') {
      return this.createItem();
    }

    if (action === 'delete-item' && id) {
      return this.deleteItem(id);
    }

    if (action === 'add-effect') return this.addEffect();
    if (action === 'edit-effect' && id) return this.editEffect(id);
    if (action === 'toggle-effect' && id) return this.toggleEffect(id);
    if (action === 'remove-effect' && id) return this.removeEffect(id);

    // Fallback: allows pick-portrait, save, auto-save to work via base class
    super.onAction?.(action, id, target);
  }

  /**
   * Interactive Roll Dialog:
   * Displays the base formula, checks if a canvas target is selected (pre-filling target defense as DC),
   * and allows configuring situational modifiers and advantage/disadvantage before dispatching to chat.
   */
  async promptRollDialog({ label, baseFormula, bonus, actionType, attrKey }) {
    const doc = this.document || {};
    const target = getActiveTarget();
    const defaultDiff = target ? target.defense : 10;

    const targetHtml = target
      ? `<div class="roll-dialog-target-card">
          <div class="target-avatar">
            ${target.avatar ? `<img src="${target.avatar}" alt="${target.name}" />` : `<i class="fa-solid fa-crosshairs"></i>`}
          </div>
          <div class="target-info">
            <span class="target-tag"><i class="fa-solid fa-bullseye"></i> ${localize('loom-demo-system.dialog.targetSelected', 'Target Selected')}</span>
            <span class="target-name">${target.name}</span>
          </div>
          <div class="target-defense-pill">
            <span class="def-title">${localize('loom-demo-system.dialog.targetDefense', 'TARGET DEFENSE')}</span>
            <span class="def-num">${target.defense}</span>
          </div>
        </div>`
      : `<div class="roll-dialog-no-target">
          <i class="fa-solid fa-crosshairs"></i> ${localize('loom-demo-system.dialog.noTarget', 'No target selected on canvas (Default DC: 10).')}
        </div>`;

    const contentHtml = `
      <div class="loom-roll-dialog-body">
        ${targetHtml}

        <div class="roll-dialog-stats-row">
          <div class="roll-dialog-stat-item">
            <span class="stat-label">${localize('loom-demo-system.dialog.checkAction', 'Check / Action')}</span>
            <span class="stat-val">${label}</span>
          </div>
          <div class="roll-dialog-stat-item">
            <span class="stat-label">${localize('loom-demo-system.dialog.baseFormula', 'Base Formula')}</span>
            <span class="stat-val formula">${baseFormula}</span>
          </div>
        </div>

        <div class="roll-dialog-form-grid">
          <div class="roll-dialog-field">
            <label for="roll-dc-input"><i class="fa-solid fa-shield"></i> ${localize('loom-demo-system.dialog.difficulty', 'Difficulty (DC / Defense)')}</label>
            <input type="number" id="roll-dc-input" value="${defaultDiff}" min="0" class="dialog-input" />
            <span class="field-hint">${target ? localize('loom-demo-system.dialog.targetHint', 'Pre-filled with target defense') : localize('loom-demo-system.dialog.dcHint', 'Set check DC')}</span>
          </div>

          <div class="roll-dialog-field">
            <label for="roll-mod-input"><i class="fa-solid fa-plus-minus"></i> ${localize('loom-demo-system.dialog.modifier', 'Situational Modifier')}</label>
            <input type="number" id="roll-mod-input" value="0" class="dialog-input" />
            <span class="field-hint">${localize('loom-demo-system.dialog.modifierHint', 'Bonus or penalty (+2, -1, etc.)')}</span>
          </div>
        </div>

        <div class="roll-dialog-field full-width">
          <label for="roll-mode-select"><i class="fa-solid fa-dice"></i> ${localize('loom-demo-system.dialog.rollMode', 'Roll Mode')}</label>
          <select id="roll-mode-select" class="dialog-select">
            <option value="normal" selected>${localize('loom-demo-system.dialog.modeNormal', 'Normal (1d20)')}</option>
            <option value="advantage">${localize('loom-demo-system.dialog.modeAdvantage', 'Advantage (Roll 2d20, keep highest)')}</option>
            <option value="disadvantage">${localize('loom-demo-system.dialog.modeDisadvantage', 'Disadvantage (Roll 2d20, keep lowest)')}</option>
          </select>
        </div>
      </div>
    `;

    const result = await LoomDialog.wait({
      window: { title: `${localize('loom-demo-system.actions.roll', 'Roll')} — ${label}` },
      width: 440,
      classes: ['loom-roll-box-window'],
      content: contentHtml,
      buttons: [
        {
          action: 'roll',
          label: `<i class="fa-solid fa-dice-d20"></i> ${localize('loom-demo-system.dialog.rollDice', 'Roll Dice')}`,
          default: true,
          variant: 'primary',
          callback: (_event, _button, dialog) => {
            const body = dialog.getBody();
            const dc = Number(body?.querySelector('#roll-dc-input')?.value ?? defaultDiff);
            const mod = Number(body?.querySelector('#roll-mod-input')?.value ?? 0);
            const mode = body?.querySelector('#roll-mode-select')?.value ?? 'normal';
            return { dc, mod, mode, confirmed: true };
          },
        },
        {
          action: 'cancel',
          label: localize('loom-demo-system.dialog.cancel', 'Cancel'),
          variant: 'ghost',
        },
      ],
    });

    if (!result || !result.confirmed) return;

    // Build formula with roll mode and modifiers
    let dice = '1d20';
    if (result.mode === 'advantage') dice = '2d20kh1';
    if (result.mode === 'disadvantage') dice = '2d20kl1';

    const totalMod = (bonus || 0) + (result.mod || 0);
    const sign = totalMod >= 0 ? '+' : '-';
    const formula = `${dice} ${sign} ${Math.abs(totalMod)}`;

    if (window.Loom?.dispatchRoll) {
      window.Loom.dispatchRoll({
        formula,
        actorId: this.actorId,
        meta: {
          system: 'Loom Demo',
          label,
          difficulty: result.dc,
          targetName: target?.name || null,
          targetAvatar: target?.avatar || null,
          actorAvatar: doc.avatarUrl || '',
          actorName: doc.name || 'Hero',
          attr: attrKey,
          action: actionType,
        },
      });
    } else {
      showToast(`🎲 ${label}: ${formula} vs DC ${result.dc}`, 'info');
    }
  }

  /**
   * Opens the roll dialog for an attribute check.
   * @param {string} attrKey - 'might', 'swift', or 'wits'
   */
  async rollAttribute(attrKey) {
    if (!attrKey) return;
    const doc = this.document || {};
    const attrs = doc.attributes || doc.systemData?.attributes || {};
    const val = attrs[attrKey] ?? 5;
    const bonus = Math.floor(val / 2);
    const sign = bonus >= 0 ? '+' : '';
    const baseFormula = `1d20 ${sign} ${bonus}`;
    const label = attrKey.charAt(0).toUpperCase() + attrKey.slice(1) + ' Check';

    await this.promptRollDialog({
      label,
      baseFormula,
      bonus,
      attrKey,
    });
  }

  /**
   * Opens the Roll Dialog for combat maneuvers.
   * @param {'attack' | 'dodge' | 'initiative'} actionType
   */
  async rollCombat(actionType) {
    if (actionType === 'initiative') {
      return this.rollInitiative();
    }

    const doc = this.document || {};
    const bonus = doc._bonus || {};
    let mod = 0;
    let label = localize('loom-demo-system.title', 'Combat');

    if (actionType === 'attack') {
      mod = bonus.attack ?? Math.floor(((doc.attributes?.might ?? 5)) / 2);
      label = localize('loom-demo-system.actions.attack', 'Attack');
    } else if (actionType === 'dodge') {
      mod = bonus.dodge ?? Math.floor(((doc.attributes?.swift ?? 5)) / 2);
      label = localize('loom-demo-system.actions.dodge', 'Dodge');
    }

    const sign = mod >= 0 ? '+' : '';
    const baseFormula = `1d20 ${sign} ${mod}`;

    await this.promptRollDialog({
      label,
      baseFormula,
      bonus: mod,
      actionType,
    });
  }

  /**
   * Dedicated Initiative roll:
   * - Bypasses DC / target defense check.
   * - No Success or Failure badges in chat.
   * - Directly integrates with Loom.combat to update turn order in the Combat Tracker!
   */
  async rollInitiative() {
    const doc = this.document || {};
    const bonus = doc._bonus?.initiative ?? Math.floor(((doc.attributes?.swift ?? 5)) / 2);
    const sign = bonus >= 0 ? '+' : '';
    const baseFormula = `1d20 ${sign} ${bonus}`;

    const activeCombat = window.Loom?.combat || window.Loom?.combats?.active;
    const combatants = Array.isArray(activeCombat?.combatants)
      ? activeCombat.combatants
      : Array.from(activeCombat?.combatants?.values?.() || activeCombat?.combatants || []);
    const combatant = combatants.find((c) => c.actorId === this.actorId || c.id === this.actorId || c.castId === this.actorId);

    const combatNoticeHtml = combatant
      ? `<div class="roll-initiative-combat-card active">
          <i class="fa-solid fa-swords"></i>
          <div>
            <strong>${localize('loom-demo-system.dialog.activeInCombat', 'Active in Combat!')}</strong>
            <p>${localize('loom-demo-system.dialog.activeInCombatDesc', 'The result will be sent directly to the Combat Tracker to order your turn.')}</p>
          </div>
        </div>`
      : `<div class="roll-initiative-combat-card">
          <i class="fa-solid fa-bolt"></i>
          <div>
            <strong>${localize('loom-demo-system.dialog.turnOrder', 'Turn Order')}</strong>
            <p>${localize('loom-demo-system.dialog.turnOrderDesc', 'Rolls character swiftness to determine initiative position for the round.')}</p>
          </div>
        </div>`;

    const contentHtml = `
      <div class="loom-roll-dialog-body">
        ${combatNoticeHtml}

        <div class="roll-dialog-stats-row">
          <div class="roll-dialog-stat-item">
            <span class="stat-label">${localize('loom-demo-system.dialog.character', 'Character')}</span>
            <span class="stat-val">${doc.name || localize('loom-demo-system.hero', 'Hero')}</span>
          </div>
          <div class="roll-dialog-stat-item">
            <span class="stat-label">${localize('loom-demo-system.dialog.baseFormula', 'Base Formula')} (${localize('loom-demo-system.attributes.swift', 'Swift')})</span>
            <span class="stat-val formula">${baseFormula}</span>
          </div>
        </div>

        <div class="roll-dialog-form-grid">
          <div class="roll-dialog-field full-width">
            <label for="init-mod-input"><i class="fa-solid fa-plus-minus"></i> ${localize('loom-demo-system.dialog.modifier', 'Situational Modifier')}</label>
            <input type="number" id="init-mod-input" value="0" class="dialog-input" />
            <span class="field-hint">${localize('loom-demo-system.dialog.modifierHint', 'Bonus or penalty (+2, -1, etc.)')}</span>
          </div>

          <div class="roll-dialog-field full-width">
            <label for="init-mode-select"><i class="fa-solid fa-dice"></i> ${localize('loom-demo-system.dialog.rollMode', 'Roll Mode')}</label>
            <select id="init-mode-select" class="dialog-select">
              <option value="normal" selected>${localize('loom-demo-system.dialog.modeNormal', 'Normal (1d20)')}</option>
              <option value="advantage">${localize('loom-demo-system.dialog.modeAdvantage', 'Advantage (Roll 2d20, keep highest)')}</option>
              <option value="disadvantage">${localize('loom-demo-system.dialog.modeDisadvantage', 'Disadvantage (Roll 2d20, keep lowest)')}</option>
            </select>
          </div>
        </div>
      </div>
    `;

    const result = await LoomDialog.wait({
      window: { title: `${localize('loom-demo-system.actions.initiative', 'Initiative')} — ${doc.name || localize('loom-demo-system.hero', 'Hero')}` },
      width: 420,
      classes: ['loom-roll-box-window', 'loom-initiative-window'],
      content: contentHtml,
      buttons: [
        {
          action: 'roll',
          label: `<i class="fa-solid fa-bolt"></i> ${localize('loom-demo-system.dialog.rollInitiative', 'Roll Initiative')}`,
          default: true,
          variant: 'primary',
          callback: (_event, _button, dialog) => {
            const body = dialog.getBody();
            const mod = Number(body?.querySelector('#init-mod-input')?.value ?? 0);
            const mode = body?.querySelector('#init-mode-select')?.value ?? 'normal';
            return { mod, mode, confirmed: true };
          },
        },
        {
          action: 'cancel',
          label: localize('loom-demo-system.dialog.cancel', 'Cancel'),
          variant: 'ghost',
        },
      ],
    });

    if (!result || !result.confirmed) return;

    let dice = '1d20';
    if (result.mode === 'advantage') dice = '2d20kh1';
    if (result.mode === 'disadvantage') dice = '2d20kl1';

    const totalMod = (bonus || 0) + (result.mod || 0);
    const modSign = totalMod >= 0 ? '+' : '-';
    const formula = `${dice} ${modSign} ${Math.abs(totalMod)}`;

    if (window.Loom?.dispatchRoll) {
      window.Loom.dispatchRoll({
        formula,
        actorId: this.actorId,
        meta: {
          system: 'Loom Demo',
          label: localize('loom-demo-system.actions.initiative', 'Initiative'),
          isInitiative: true,
          actorId: this.actorId,
          inCombat: !!combatant,
          actorAvatar: doc.avatarUrl || '',
          actorName: doc.name || localize('loom-demo-system.hero', 'Hero'),
        },
      });
    } else {
      showToast(`⚡ ${localize('loom-demo-system.actions.initiative', 'Initiative')}: ${formula}`, 'info');
    }
  }

  /**
   * Opens the custom Item sheet (DemoItemSheet).
   * @param {string} itemId
   */
  openItemSheet(itemId) {
    windowManager.open(`item-sheet-${itemId}`, DemoItemSheet, { itemId });
  }

  /**
   * Rolls damage for an item owned by this actor.
   * @param {string} itemId
   */
  /**
   * Rolls attack with a character-owned weapon, adding Might and weapon attack bonus.
   * @param {string} itemId
   */
  async rollItemAttack(itemId) {
    const doc = this.document || {};
    const items = doc.items || [];
    const item = items.find((i) => i.id === itemId);
    if (!item) return;

    const attrs = doc.attributes || doc.systemData?.attributes || {};
    const mightBonus = Math.floor((attrs.might ?? 5) / 2);
    const itemAtkBonus = Number(item.systemData?.attackBonus || item.data?.attackBonus || 0);
    const totalBonus = mightBonus + itemAtkBonus;
    const sign = totalBonus >= 0 ? '+' : '';
    const baseFormula = `1d20 ${sign} ${totalBonus}`;
    const label = `${item.name} (${localize('loom-demo-system.actions.attack', 'Attack')})`;

    await this.promptRollDialog({
      label,
      baseFormula,
      bonus: totalBonus,
      actionType: 'attack',
    });
  }

  /**
   * Rolls damage for an item owned by this actor.
   * @param {string} itemId
   */
  rollItemDamage(itemId) {
    const doc = this.document || {};
    const items = doc.items || [];
    const item = items.find((i) => i.id === itemId);
    if (!item) return;

    const isd = item.systemData || item.data || {};
    let damage = isd.damage || '1d6';
    const dmgBonus = Number(isd.damageBonus || 0);
    if (dmgBonus !== 0) {
      const sign = dmgBonus > 0 ? '+' : '';
      damage = `${damage}${sign}${dmgBonus}`;
    }

    if (window.Loom?.dispatchRoll) {
      window.Loom.dispatchRoll({
        formula: damage,
        actorId: this.actorId,
        meta: {
          system: 'Loom Demo',
          label: `${item.name} (${localize('loom-demo-system.actions.damage', 'Damage')})`,
          actorAvatar: doc.avatarUrl || '',
          actorName: doc.name || localize('loom-demo-system.hero', 'Hero'),
        },
      });
    } else {
      showToast(`🎲 ${item.name}: ${damage}`, 'info');
    }
  }

  /**
   * Backward compatibility alias for rollItem.
   */
  rollItem(itemId) {
    return this.rollItemDamage(itemId);
  }

  /**
   * Uses a consumable item (e.g. potion), rolling its healing formula.
   * @param {string} itemId
   */
  async useItem(itemId) {
    const doc = this.document || {};
    const items = doc.items || [];
    const item = items.find((i) => i.id === itemId);
    if (!item) return;

    const healFormula = item.systemData?.healAmount || item.data?.healAmount || '2d4+2';
    if (window.Loom?.dispatchRoll) {
      window.Loom.dispatchRoll({
        formula: healFormula,
        actorId: this.actorId,
        meta: {
          system: 'Loom Demo',
          label: `${item.name} (${localize('loom-demo-system.items.healing', 'Healing')})`,
          actorAvatar: doc.avatarUrl || '',
          actorName: doc.name || localize('loom-demo-system.hero', 'Hero'),
        },
      });
    } else {
      showToast(`❤️ ${item.name}: ${healFormula}`, 'success');
    }
  }

  /**
   * Creates a new item associated with this actor.
   */
  async createItem() {
    try {
      await api.post('/items', {
        worldId: this.document?.worldId,
        actorId: this.actorId,
        name: localize('loom-demo-system.items.defaultWeaponName', 'New Sword'),
        type: 'weapon',
        systemData: {
          damage: '1d8+2',
          damageType: localize('loom-demo-system.items.defaultSlashing', 'Slashing'),
          range: localize('loom-demo-system.items.defaultMelee', 'Melee'),
        },
      });
      await this._reloadDocument();
      showToast(localize('loom-demo-system.items.created', 'Item created!'), 'success');
    } catch (e) {
      showToast(e?.message || 'Error creating item', 'error');
    }
  }

  /**
   * Deletes an item owned by this actor after user confirmation.
   */
  async deleteItem(itemId) {
    const confirmed = await showConfirm(
      localize('loom-demo-system.items.delete', 'Delete Item'),
      localize('loom-demo-system.items.confirmDelete', 'Are you sure you want to delete this item?')
    );
    if (!confirmed) return;
    try {
      await api.delete(`/items/${itemId}`);
      await this._reloadDocument();
      showToast(localize('loom-demo-system.items.deleted', 'Item deleted'), 'info');
    } catch (e) {
      showToast(e?.message || 'Error deleting item', 'error');
    }
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
    const confirmed = await showConfirm(
      localize('loom-demo-system.effects.delete', 'Remove Effect'),
      localize('loom-demo-system.effects.confirmDelete', 'Remove this effect?')
    );
    if (!confirmed) return;
    try {
      await api.delete(`/buffs/${buffId}`);
      await this.loadBuffs();
      showToast('Effect removed', 'info');
    } catch (e) {
      showToast(e?.message || 'Failed to remove effect', 'error');
    }
  }
}
