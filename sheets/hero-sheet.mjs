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
import { LoomHandlebarsMixin, LoomActorSheet, LoomDialog, api, showToast, showConfirm, showPrompt, windowManager } from '/_loom/sdk/index.js';
import { DemoItemSheet } from './item-sheet.mjs';

/**
 * Obtém o alvo (token) atualmente selecionado pelo usuário na mesa (canvas).
 * Se houver um alvo selecionado, retorna o nome, avatar e a Defesa dele.
 */
function getActiveTarget() {
  const targets = window.Loom?.user?.targets || [];
  if (!targets.length) return null;
  const target = targets[0];
  let actor = null;
  if (target.actorId && window.Loom?.actors?.get) {
    actor = window.Loom.actors.get(target.actorId);
  }
  const name = target.name || actor?.name || 'Alvo';
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
    const attrs = doc.attributes || sd.attributes || { might: 5, swift: 5, wits: 5 };
    const hp = doc.hp || sd.hp || { value: 20, max: 20 };
    const defense = doc.defense ?? sd.defense ?? 10;

    const bonus = {
      attack: Math.floor(((attrs.might ?? 5)) / 2),
      dodge: Math.floor(((attrs.swift ?? 5)) / 2),
      initiative: Math.floor(((attrs.swift ?? 5)) / 2),
      detect: Math.floor(((attrs.wits ?? 5)) / 2),
      ...(doc._bonus || {}),
    };

    // Ensure document properties are directly reachable by template
    doc.attributes = attrs;
    doc.hp = hp;
    doc.defense = defense;
    doc._bonus = bonus;

    const maxHp = hp.max || 1;
    const hpVal = hp.value ?? maxHp;
    const hpPercent = Math.max(0, Math.min(100, Math.round((hpVal / maxHp) * 100)));

    const attributesList = [
      {
        key: 'might',
        label: 'Might',
        ptLabel: 'Força / Might',
        icon: 'fa-solid fa-hand-fist',
        color: 'attr-might',
        desc: 'Poder físico & impacto',
        value: attrs.might ?? 5,
        bonus: bonus.attack,
        bonusLabel: 'Ataque',
      },
      {
        key: 'swift',
        label: 'Swift',
        ptLabel: 'Agilidade / Swift',
        icon: 'fa-solid fa-bolt',
        color: 'attr-swift',
        desc: 'Reflexos & esquiva',
        value: attrs.swift ?? 5,
        bonus: bonus.dodge,
        bonusLabel: 'Esquiva / Ini',
      },
      {
        key: 'wits',
        label: 'Wits',
        ptLabel: 'Astúcia / Wits',
        icon: 'fa-solid fa-brain',
        color: 'attr-wits',
        desc: 'Astúcia & percepção',
        value: attrs.wits ?? 5,
        bonus: bonus.detect,
        bonusLabel: 'Percepção',
      },
    ];

    const items = Array.isArray(doc.items) ? doc.items : [];

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

    if (action === 'roll-item' && id) {
      return this.rollItem(id);
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
   * Caixa de Rolagem interativa (Roll Dialog):
   * Exibe a fórmula base, detecta se há um alvo selecionado na mesa (puxando a Defesa dele como DC),
   * permite configurar modificador situacional e vantagem/desvantagem antes de enviar para o chat.
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
            <span class="target-tag"><i class="fa-solid fa-bullseye"></i> Alvo Selecionado</span>
            <span class="target-name">${target.name}</span>
          </div>
          <div class="target-defense-pill">
            <span class="def-title">DEFESA DO ALVO</span>
            <span class="def-num">${target.defense}</span>
          </div>
        </div>`
      : `<div class="roll-dialog-no-target">
          <i class="fa-solid fa-crosshairs"></i> Nenhum alvo selecionado na mesa (DC padrão: 10).
        </div>`;

    const contentHtml = `
      <div class="loom-roll-dialog-body">
        ${targetHtml}

        <div class="roll-dialog-stats-row">
          <div class="roll-dialog-stat-item">
            <span class="stat-label">Teste / Ação</span>
            <span class="stat-val">${label}</span>
          </div>
          <div class="roll-dialog-stat-item">
            <span class="stat-label">Fórmula Base</span>
            <span class="stat-val formula">${baseFormula}</span>
          </div>
        </div>

        <div class="roll-dialog-form-grid">
          <div class="roll-dialog-field">
            <label for="roll-dc-input"><i class="fa-solid fa-shield"></i> Dificuldade (DC / Defesa)</label>
            <input type="number" id="roll-dc-input" value="${defaultDiff}" min="0" class="dialog-input" />
            <span class="field-hint">${target ? 'Pré-preenchido com a Defesa do alvo' : 'Defina a DC do teste'}</span>
          </div>

          <div class="roll-dialog-field">
            <label for="roll-mod-input"><i class="fa-solid fa-plus-minus"></i> Modificador Situacional</label>
            <input type="number" id="roll-mod-input" value="0" class="dialog-input" />
            <span class="field-hint">Bônus ou penalidade (+2, -1, etc.)</span>
          </div>
        </div>

        <div class="roll-dialog-field full-width">
          <label for="roll-mode-select"><i class="fa-solid fa-dice"></i> Tipo de Rolagem</label>
          <select id="roll-mode-select" class="dialog-select">
            <option value="normal" selected>Normal (1d20)</option>
            <option value="advantage">Vantagem (Rola 2d20, pega o Maior)</option>
            <option value="disadvantage">Desvantagem (Rola 2d20, pega o Menor)</option>
          </select>
        </div>
      </div>
    `;

    const result = await LoomDialog.wait({
      window: { title: `Caixa de Rolagem — ${label}` },
      width: 440,
      classes: ['loom-roll-box-window'],
      content: contentHtml,
      buttons: [
        {
          action: 'roll',
          label: '<i class="fa-solid fa-dice-d20"></i> Rolar Dados',
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
          label: 'Cancelar',
          variant: 'ghost',
        },
      ],
    });

    if (!result || !result.confirmed) return;

    // Constrói a fórmula com vantagem/desvantagem e modificadores
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
          actorName: doc.name || 'Herói',
          attr: attrKey,
          action: actionType,
        },
      });
    } else {
      showToast(`🎲 ${label}: ${formula} vs DC ${result.dc}`, 'info');
    }
  }

  /**
   * Abre a Caixa de Rolagem para teste de atributo.
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
   * Abre a Caixa de Rolagem para manobras de combate.
   * @param {'attack' | 'dodge' | 'initiative'} actionType
   */
  async rollCombat(actionType) {
    const doc = this.document || {};
    const bonus = doc._bonus || {};
    let mod = 0;
    let label = 'Combate';

    if (actionType === 'attack') {
      mod = bonus.attack ?? Math.floor(((doc.attributes?.might ?? 5)) / 2);
      label = 'Ataque';
    } else if (actionType === 'dodge') {
      mod = bonus.dodge ?? Math.floor(((doc.attributes?.swift ?? 5)) / 2);
      label = 'Esquiva';
    } else if (actionType === 'initiative') {
      mod = bonus.initiative ?? Math.floor(((doc.attributes?.swift ?? 5)) / 2);
      label = 'Iniciativa';
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
   * Abre a janela customizada de Item (DemoItemSheet).
   * @param {string} itemId
   */
  openItemSheet(itemId) {
    windowManager.open(`item-sheet-${itemId}`, DemoItemSheet, { itemId });
  }

  /**
   * Rola dano de um item pertencente ao ator.
   * @param {string} itemId
   */
  rollItem(itemId) {
    const doc = this.document || {};
    const items = doc.items || [];
    const item = items.find((i) => i.id === itemId);
    if (!item) return;

    const damage = item.systemData?.damage || item.data?.damage || '1d6';
    if (window.Loom?.dispatchRoll) {
      window.Loom.dispatchRoll({
        formula: damage,
        actorId: this.actorId,
        meta: {
          system: 'Loom Demo',
          label: `${item.name} (Dano)`,
          actorAvatar: doc.avatarUrl || '',
          actorName: doc.name || 'Herói',
        },
      });
    }
  }

  /**
   * Cria um novo item associado a este ator.
   */
  async createItem() {
    try {
      await api.post('/items', {
        worldId: this.document?.worldId,
        actorId: this.actorId,
        name: 'Nova Espada',
        type: 'weapon',
        systemData: {
          damage: '1d8+2',
          damageType: 'Cortante',
          range: 'Corpo a corpo',
        },
      });
      await this._reloadDocument();
      showToast('Item criado!', 'success');
    } catch (e) {
      showToast(e?.message || 'Erro ao criar item', 'error');
    }
  }

  /**
   * Exclui um item pertencente ao ator após confirmação.
   */
  async deleteItem(itemId) {
    const confirmed = await showConfirm('Excluir Item', 'Tem certeza que deseja excluir este item?');
    if (!confirmed) return;
    try {
      await api.delete(`/items/${itemId}`);
      await this._reloadDocument();
      showToast('Item excluído', 'info');
    } catch (e) {
      showToast(e?.message || 'Erro ao excluir item', 'error');
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
