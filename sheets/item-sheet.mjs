// ══════════════════════════════════════════════════════════════
// Loom Demo System — sheets/item-sheet.mjs
// ══════════════════════════════════════════════════════════════
//
// Ficha customizada Handlebars para itens do sistema (LoomItemSheet).
// Demonstra de forma didática:
// - Herança de LoomHandlebarsMixin(LoomItemSheet)
// - Edição de imagem/ícone via pickDocumentImage (data-action="pick-portrait")
// - Campos dinâmicos conforme o tipo de item (arma, armadura, poção)
// - Botão de ação direta para rolar o dano do item

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
   * Prepara o contexto para o template Handlebars com flags de tipo
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
   * Trata ações de clique da ficha de item (ex: rolar dano)
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
            label: `${doc.name || 'Item'} (Dano)`,
            actorAvatar: doc.imgUrl || '',
            actorName: doc.name || 'Item',
          },
        });
      }
      return;
    }

    // Delega pick-portrait / editImage para a classe base
    super.onAction?.(action, id, target);
  }
}
