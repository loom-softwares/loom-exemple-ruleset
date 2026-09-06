// ══════════════════════════════════════════════════════════════
// Loom Demo System — sheets/item-sheet.mjs
// ══════════════════════════════════════════════════════════════
//
// Custom Handlebars sheet for system items (LoomItemSheet).
// Demonstrates as an educational reference:
// - Inheritance from LoomHandlebarsMixin(LoomItemSheet)
// - Native image/icon picking via data-action="pick-portrait"
// - Contextual properties by item type (weapon, armor, potion, scroll)
// - Direct action button to roll weapon damage

import { LoomHandlebarsMixin, LoomItemSheet } from '/_loom/sdk/index.js';

export class DemoItemSheet extends LoomHandlebarsMixin(LoomItemSheet) {
  static PARTS = {
    main: { template: '/marketplace/rulesets/loom-demo-system/templates/item-sheet.hbs' },
  };

  constructor(props) {
    super({
      ...props,
      id: props.id || `item-sheet-${props.itemId || props.documentId}`,
      documentId: props.itemId || props.documentId,
      width: props.width || 480,
      height: props.height || 'auto',
    });
    this.itemId = props.itemId || props.documentId;
  }

  /**
   * Prepares template context with item type flags and systemData shortcuts.
   * @returns {Promise<Record<string, any>>}
   */
  async _prepareContext() {
    const base = await super._prepareContext();
    const doc = this.document || {};
    const sd = doc.systemData || doc.data || {};

    return {
      ...base,
      document: doc,
      systemData: sd,
      isWeapon: doc.type === 'weapon',
      isArmor: doc.type === 'armor',
      isPotion: doc.type === 'potion',
      isScroll: doc.type === 'scroll',
    };
  }

  /**
   * Action dispatcher for item sheet UI buttons (e.g. roll damage).
   * @param {string} action - Action key.
   * @param {string} [id] - Optional ID.
   * @param {HTMLElement} [target] - Target element.
   */
  async onAction(action, id, target) {
    if (action === 'roll-damage') {
      const doc = this.document || {};
      const sd = doc.systemData || doc.data || {};
      const formula = sd.damage || '1d6';

      if (window.Loom?.dispatchRoll) {
        window.Loom.dispatchRoll({
          formula,
          meta: {
            system: 'Loom Demo',
            label: `${doc.name || 'Item'} (Damage)`,
            actorAvatar: doc.imgUrl || '',
            actorName: doc.name || 'Item',
          },
        });
      }
      return;
    }

    // Delegate pick-portrait / image selection to base class
    super.onAction?.(action, id, target);
  }
}
