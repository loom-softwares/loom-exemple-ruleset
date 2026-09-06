// ══════════════════════════════════════════════════════════════
// Loom Demo System — client-side entry point
// ══════════════════════════════════════════════════════════════
//
// Playable demo system. Serves as:
// 1. Live example of how to build a LoomVTT system
// 2. Manual test fixture for the engine
// 3. Reference for the scaffold (scripts/create-loom-package.mjs)
//
// A system never runs any code on the server (see server/applications/addons/loader.ts) —
// everything a system needs the server to know about (actorTypes, itemTypes, styles,
// languages) must ALSO be declared as static JSON in ruleset.json, not just here.

import { SystemRegistry, defineSystem, LoomHooks, keybinds, showToast, getWraps, sheets, settings } from '/_loom/sdk/index.js';
import { HeroSheet } from './sheets/hero-sheet.mjs';
import { DemoItemSheet } from './sheets/item-sheet.mjs';
import { heroDefaults } from './data/hero.mjs';
import { villainDefaults } from './data/villain.mjs';
import { beastDefaults } from './data/beast.mjs';
import { prepareData } from './data/prepare-data.mjs';
import { enBundle, ptBundle } from './data/locales.mjs';

// ── Eagerly register language bundles into Loom's central i18n engine ─
// Ensures all {{localize "key"}} helpers in templates and scripts work immediately
if (window.Loom?.i18n?.registerLang) {
  window.Loom.i18n.registerLang('en', enBundle);
  window.Loom.i18n.registerLang('pt-BR', ptBundle);
  window.Loom.i18n.registerLang('pt', ptBundle);
}

SystemRegistry.register(defineSystem({
  id: 'loom-demo-system',
  title: 'Loom Demo System',
  version: '0.1.0',

  // Keep this list in sync with ruleset.json's "actorTypes"/"itemTypes" — the
  // server validates create/update requests against the manifest copy (it
  // never executes this file), the client uses this copy to render menus.
  actorTypes: ['hero', 'villain', 'beast'],
  itemTypes: ['weapon', 'armor', 'potion', 'scroll'],

  // The system's actual CSS lives in styles/system.css, declared in
  // ruleset.json ("styles": [...]) and injected by addon-client-loader.ts —
  // don't put a loose CSS string here, it would duplicate/diverge from the
  // real file over time.

  // ── Default data ──────────────────────────────────────────
  // Called once when a new actor/item of this type is created, to seed its
  // `systemData` (the free-form blob a system owns inside each document).
  // Each type's data lives in its own file under data/ (imported above) —
  // this just dispatches, it never defines the shapes itself.
  /**
   * Returns default systemData for a given actor type.
   * @param {string} type - Actor subtype ('hero', 'villain', 'beast').
   * @returns {Record<string, any>} Default systemData payload.
   */
  getDefaultData(type) {
    if (type === 'hero') return heroDefaults;
    if (type === 'villain') return villainDefaults;
    if (type === 'beast') return beastDefaults;
    return {};
  },

  // ── Validation ────────────────────────────────────────────
  // Called before every save of an actor's systemData. Return `valid: false`
  // to reject the write — the sheet shows `errors` to the user and the save
  // is aborted. Optional: a system with no rules to enforce can omit this.
  /**
   * Validates actor systemData before saving changes.
   * @param {string} type - Actor subtype.
   * @param {Record<string, any>} data - The systemData object to validate.
   * @returns {{ valid: boolean, errors?: string[] }} Validation result.
   */
  validateData(type, data) {
    const errors = [];
    if (data.hp?.value > data.hp?.max) errors.push('HP cannot exceed max HP');
    for (const attr of ['might', 'swift', 'wits']) {
      const val = data.attributes?.[attr];
      if (val !== undefined && (val < 0 || val > 10)) errors.push(`${attr} must be between 0 and 10`);
    }
    return { valid: errors.length === 0, errors };
  },

  // ── Data preparation ──────────────────────────────────────
  // Defined in data/prepare-data.mjs (imported above), not inline here —
  // same convention srd5e uses (scripts/prepare-data.mjs): a dispatcher
  // (prepareHero/prepareVillain/prepareBeast, one function per actor type,
  // not one function branching on `type` internally) so each type's rules
  // can diverge later without touching the others.
  prepareData,

  // ── Initiative ────────────────────────────────────────────
  // Defined in the LoomSystem interface: allows the system to declare its
  // formula calculation programmatically based on actor stats.
  // Note for developers: The core Combat Tracker (sidebar.ts) resolves the
  // formula via settingsRegistry (e.g. system initiativeFormula setting) or '1d20'
  // or the /combat/:worldId/dex-initiative endpoint. Implementing this method
  // here demonstrates the interface contract for system-driven rolls.
  /**
   * Calculates initiative roll formula and initial total for an actor.
   * Reads the configured attribute from settings ('loom-demo-system.initiativeBonusAttr').
   * @param {Record<string, any>} actor - Actor document data.
   * @returns {{ formula: string, total: number }} Initiative formula and initial total.
   */
  rollInitiative(actor) {
    const attrKey = settings.get('loom-demo-system', 'initiativeBonusAttr') || 'swift';
    const bonus = Math.floor(((actor.attributes?.[attrKey] ?? actor.attributes?.swift ?? 5) / 2));
    const formula = `1d20${bonus >= 0 ? '+' : ''}${bonus}`;
    return { formula, total: 0 };
  },

  // ── Sheet schema (actor) ──────────────────────────────────
  // Declarative sheet layout: the core renders this into a real sheet with
  // no template file needed on the system's side. This is the recommended
  // path for most systems — a fully custom Window class (registered via
  // sheetCatalog, with its own .hbs template) exists for cases the
  // declarative schema can't express, but adds real complexity and isn't
  // needed here.
  /**
   * Returns declarative sheet layout schema for actor types.
   * @param {string} actorType - Actor subtype ('villain', 'beast', etc.).
   * @returns {import('/_loom/sdk/index.js').SheetSchema | null} Sheet layout schema.
   */
  getSheetSchema(actorType) {
    return {
      tabs: [
        {
          id: 'attributes',
          label: 'Attributes',
          icon: '🎯',
          fields: [
            // 'dots' renders clickable pips (classic Storyteller/WoD look).
            // max MUST match validateData's real range (0-10 below) and the
            // highest default value any type actually seeds (beast.might=8,
            // data/beast.mjs) — max: 5 here would silently clamp villain/beast
            // to 5 pips on screen while the stored value stayed 7/8 underneath.
            { key: 'attributes.might', label: 'Might', type: 'dots', max: 10 },
            { key: 'attributes.swift', label: 'Swift', type: 'dots', max: 10 },
            { key: 'attributes.wits', label: 'Wits', type: 'dots', max: 10 },
            { key: 'defense', label: 'Defense', type: 'number' },
          ],
        },
        {
          id: 'combat',
          label: 'Combat',
          icon: '⚔️',
          fields: [
            { key: 'hp.value', label: 'Current HP', type: 'number' },
            { key: 'hp.max', label: 'Max HP', type: 'number' },
          ],
        },
      ],
    };
  },

  // ── Sheet schema (item) ────────────────────────────────────
  /**
   * Returns declarative sheet layout schema for item types.
   * @param {string} itemType - Item subtype ('weapon', 'armor', 'potion', etc.).
   * @returns {import('/_loom/sdk/index.js').SheetSchema | null} Item sheet layout schema.
   */
  getItemSheetSchema(itemType) {
    if (itemType === 'weapon') {
      return {
        tabs: [{
          id: 'main',
          label: 'Weapon',
          fields: [
            { key: 'damage', label: 'Damage', type: 'text' },
            { key: 'damageType', label: 'Type', type: 'text' },
            { key: 'range', label: 'Range', type: 'text' },
            // type: 'actions' renders one button per entry; clicking it
            // resolves `formula` (with @-references into the owning actor's
            // RAW systemData — see getItemDefaultData below) and posts a
            // roll card to chat via dispatchRoll — this is how "attack" and
            // "damage" buttons work without any custom chat-card code.
            {
              key: 'actions',
              label: 'Actions',
              type: 'actions',
            },
          ],
        }],
      };
    }
    if (itemType === 'armor') {
      return { tabs: [{ id: 'main', label: 'Armor', fields: [
        { key: 'defenseBonus', label: 'Defense Bonus', type: 'number' },
      ]}]};
    }
    if (itemType === 'potion') {
      return { tabs: [{ id: 'main', label: 'Potion', fields: [
        { key: 'healAmount', label: 'Healing', type: 'text' },
        { key: 'effect', label: 'Effect', type: 'textarea' },
      ]}]};
    }
    return null;
  },

  // ── Default data (items) ───────────────────────────────────
  // Same idea as getDefaultData above, but for item documents. Note the
  // `actions` array on weapons: each entry is {id, label, formula} and
  // is what the 'actions' field above renders as buttons — this is the
  // whole mechanism behind "attack roll" / "damage roll" cards, no extra
  // wiring required beyond declaring the data.
  //
  // IMPORTANT: `formula` is resolved against the actor's RAW systemData
  // (see actor-sheet-window.ts `runItemAction` -> `resolveFormula`), never
  // against the derived fields computed in `prepareData()` above — `@bonus.attack`
  // would NOT work here, since `_bonus` only exists transiently for display.
  // Reference real stored paths only, e.g. `@attributes.might`.
  /**
   * Returns default systemData for newly created items of a given type.
   * @param {string} itemType - Item subtype ('weapon', 'armor', 'potion', 'scroll').
   * @returns {Record<string, any>} Default item systemData payload.
   */
  getItemDefaultData(itemType) {
    if (itemType === 'weapon') {
      return {
        damage: '1d6',
        damageType: 'physical',
        range: 'melee',
        actions: [
          { id: 'attack', label: 'Attack', formula: '1d20 + @attributes.might' },
          { id: 'damage', label: 'Damage', formula: '1d6' },
        ],
      };
    }
    if (itemType === 'armor') return { defenseBonus: 2 };
    if (itemType === 'potion') return { healAmount: '2d4+2', effect: '' };
    if (itemType === 'scroll') return { effect: '' };
    return {};
  },
}));

// ── Hook: tag every roll with which system produced it ─────────
// `LoomHooks.on(...)` lets a system observe/modify a roll before it's sent
// to chat — here we just stamp `meta.system` so the chat card below knows
// which rolls belong to this system.
LoomHooks.on('preRoll', (ctx) => {
  if (ctx.meta) ctx.meta.system = 'Loom Demo';
});

// ── Custom chat card ─────────────────────────────────────────────
// `getWraps().renderMessage` is a "wrap" point: every chat
// message — not just rolls — is rendered by calling this chain. `wrapped`
// is either the core's default renderer or the next system's own wrapper if
// more than one is stacked, so ALWAYS fall through to `wrapped(msg, ctx)`
// for anything you don't want to customize — otherwise you silently break
// every other message type (OOC text, other systems' rolls, GM whispers).
//
// Here we only take over rendering for OUR OWN rolls (tagged above via
// `meta.system`), replacing the default header/name block with a two-tone
// banner, and leave the actual dice widget to the core's renderRollCard —
// no need to reimplement dice math/formatting to have a custom look.
/**
 * Helper to translate keys using Loom's native i18n engine (window.Loom.i18n.localize).
 * @param {string} key - Translation key in lang/*.json
 * @param {string} [fallback] - Fallback text if key is unresolved
 * @returns {string}
 */
function localize(key, fallback = '') {
  const text = window.Loom?.i18n?.localize?.(key);
  return (text && text !== key) ? text : (fallback || key);
}

// ── Custom chat card ─────────────────────────────────────────────
// Custom roll card with standard sizing, actor portrait, high visibility,
// clear formula / total breakdown, and native i18n support.
getWraps().renderMessage.wrap((wrapped, msg, ctx) => {
  if (!msg.isRoll || !msg.roll || msg.roll.meta?.system !== 'Loom Demo') {
    return wrapped(msg, ctx);
  }

  const { esc, canSeeRoll } = ctx;
  const sp = msg.speaker || {};
  const actorName = msg.roll.meta?.actorName || sp.actorName || msg.userName || localize('loom-demo-system.hero', 'Hero');
  const actorAvatar = msg.roll.meta?.actorAvatar || sp.actorAvatar || sp.avatarUrl || msg.userAvatar || '';
  const rollLabel = msg.roll.meta?.label || localize('loom-demo-system.actions.roll', 'Roll');

  if (!canSeeRoll) {
    return `<div class="sidebar-message loom-demo-card" data-message-id="${esc(msg.id || '')}">
      <div class="loom-demo-card-header">
        <div class="loom-card-identity">
          <div class="loom-card-avatar">
            ${actorAvatar ? `<img src="${esc(actorAvatar)}" class="loom-card-avatar-img" alt="" />` : `<i class="fa-solid fa-shield-halved"></i>`}
          </div>
          <span class="loom-demo-card-name">${esc(actorName)}</span>
        </div>
      </div>
      <div class="sidebar-message-body">
        <div class="sidebar-message-text sidebar-message-whisper"><i class="fa-solid fa-dice-d20"></i> ${localize('loom-demo-system.chat.blindRoll', 'Blind roll')}</div>
      </div>
    </div>`;
  }

  const roll = msg.roll;
  const diceTerm = roll.terms?.find((t) => t.kind === 'dice');
  const d20Val = diceTerm?.rolls?.[0];
  const modTerm = roll.terms?.find((t) => t.kind === 'modifier');
  const modVal = modTerm?.value;

  const isCrit20 = diceTerm?.faces === 20 && d20Val === 20;
  const isCrit1 = diceTerm?.faces === 20 && d20Val === 1;
  const critBadge = isCrit20
    ? `<span class="loom-crit-badge crit-success">${localize('loom-demo-system.chat.critical', 'CRITICAL!')}</span>`
    : isCrit1
    ? `<span class="loom-crit-badge crit-fail">${localize('loom-demo-system.chat.fumble', 'FUMBLE!')}</span>`
    : '';

  // Automatically synchronize with Combat Tracker when initiative is rolled
  if (msg.roll?.meta?.isInitiative && msg.roll.meta?.actorId) {
    const activeCombat = window.Loom?.combat || window.Loom?.combats?.active;
    const worldId = window.Loom?.world?.id;
    if (activeCombat && worldId) {
      const combatants = Array.isArray(activeCombat.combatants)
        ? activeCombat.combatants
        : Array.from(activeCombat.combatants?.values?.() || activeCombat.combatants || []);
      const combatant = combatants.find(
        (c) => c.actorId === msg.roll.meta.actorId || c.id === msg.roll.meta.actorId || c.castId === msg.roll.meta.actorId
      );
      if (combatant && combatant.initiative !== roll.total) {
        const castId = combatant.castId || combatant.id;
        window.Loom?.combats?.updateCombatant?.(worldId, castId, { initiative: roll.total })
          ?.catch?.(() => {});
      }
    }
  }

  return `<div class="sidebar-message loom-demo-card" data-message-id="${esc(msg.id || '')}">
    <!-- Header: Actor Avatar + Identity + Roll Type -->
    <div class="loom-demo-card-header">
      <div class="loom-card-identity">
        <div class="loom-card-avatar">
          ${actorAvatar ? `<img src="${esc(actorAvatar)}" class="loom-card-avatar-img" alt="${esc(actorName)}" />` : `<i class="fa-solid fa-shield-halved"></i>`}
        </div>
        <div class="loom-card-titles">
          <span class="loom-card-actor-name">${esc(actorName)}</span>
          <span class="loom-card-roll-tag">${esc(rollLabel)}</span>
        </div>
      </div>
      <div class="loom-card-header-icon">
        <i class="fa-solid ${msg.roll.meta?.isInitiative ? 'fa-bolt' : 'fa-dice-d20'}"></i>
      </div>
    </div>

    <!-- Body: Standard Sizing + Visible Roll Breakdown -->
    <div class="loom-demo-card-body">
      <div class="loom-card-formula-row">
        <span class="loom-card-formula-pill">
          <i class="fa-solid fa-dice"></i> ${esc(roll.formula)}
        </span>
        ${critBadge}
      </div>

      ${(() => {
        if (msg.roll.meta?.isInitiative) {
          const inCombat = msg.roll.meta?.inCombat;
          return `<div class="loom-card-initiative-row">
            <span class="loom-card-initiative-chip">
              <i class="fa-solid fa-bolt"></i> ${localize('loom-demo-system.chat.turnOrder', 'TURN ORDER')}
            </span>
            ${inCombat ? `<span class="loom-initiative-status in-combat"><i class="fa-solid fa-swords"></i> ${localize('loom-demo-system.chat.combatTracker', 'Combat Tracker')}</span>` : ''}
          </div>`;
        }

        const difficulty = msg.roll.meta?.difficulty;
        const targetName = msg.roll.meta?.targetName;
        if (difficulty === undefined && !targetName) return '';
        const isSuccess = difficulty !== undefined ? (roll.total >= difficulty) : null;
        const resultBadge = isSuccess === true
          ? `<span class="loom-crit-badge crit-success"><i class="fa-solid fa-check"></i> ${localize('loom-demo-system.chat.success', 'SUCCESS')}</span>`
          : isSuccess === false
          ? `<span class="loom-crit-badge crit-fail"><i class="fa-solid fa-xmark"></i> ${localize('loom-demo-system.chat.fail', 'FAIL')}</span>`
          : '';

        return `<div class="loom-card-target-row">
          <span class="loom-card-target-chip">
            <i class="fa-solid fa-bullseye"></i> ${targetName ? `${localize('loom-demo-system.chat.target', 'Target')}: <strong>${esc(targetName)}</strong> (${localize('loom-demo-system.stats.defense', 'Def')} ${difficulty})` : `${localize('loom-demo-system.chat.difficulty', 'Difficulty')}: <strong>DC ${difficulty}</strong>`}
          </span>
          ${resultBadge}
        </div>`;
      })()}

      <div class="loom-card-result-row">
        <div class="loom-card-breakdown">
          ${d20Val !== undefined ? `<span class="breakdown-die"><i class="fa-solid fa-dice-d20"></i> ${d20Val}</span>` : ''}
          ${modVal !== undefined ? `<span class="breakdown-op">${modVal >= 0 ? '+' : '-'}</span><span class="breakdown-mod">${Math.abs(modVal)}</span>` : ''}
        </div>
        <div class="loom-card-total-box ${isCrit20 ? 'glow-success' : ''} ${isCrit1 ? 'glow-fail' : ''}">
          <span class="total-label">${msg.roll.meta?.isInitiative ? localize('loom-demo-system.chat.initiative', 'INITIATIVE') : localize('loom-demo-system.chat.total', 'TOTAL')}</span>
          <span class="total-number">${roll.total}</span>
        </div>
      </div>
    </div>
  </div>`;
});

// ── Keybind: greeting ───────────────────────────────────────────
// `keybinds.register(...)` adds an entry to the core keybind settings
// screen (user-remappable) and wires `onPress`. Purely illustrative here.
keybinds.register({
  id: 'loom-demo-hello',
  label: 'Greeting',
  description: 'Shows a greeting message from the demo system',
  defaultKey: 'Ctrl+Shift+D',
  category: 'Loom Demo',
  onPress: () => showToast('⚔️ Loom Demo System active!', 'success'),
});

// ── Settings registration ────────────────────────────────────
// Registers settings programmatically with Loom's central settings registry.
// Settings declared in ruleset.json also appear in Setup Hub / Module Settings.
settings.register('loom-demo-system', 'language', {
  name: 'Language / Idioma',
  hint: 'System language for sheets, roll dialogs, and chat cards',
  scope: 'client',
  config: true,
  type: String,
  choices: {
    'pt-BR': 'Português (Brasil)',
    'en': 'English',
  },
  default: 'pt-BR',
  onChange: (val) => {
    if (document.documentElement) {
      document.documentElement.lang = val;
    }
    // Rerender open windows to reflect language change
    window.Loom?.windows?.getAll?.()?.forEach((win) => {
      win.rerenderBody?.();
    });
  },
});

settings.register('loom-demo-system', 'initiativeBonusAttr', {
  name: 'Initiative Attribute',
  hint: 'Attribute used to calculate the initiative bonus (might, swift, or wits)',
  scope: 'world',
  config: true,
  type: String,
  default: 'swift',
});

// ── Custom sheet registration ────────────────────────────────
// `sheets.catalog(docType, typeName, SheetClass)` overrides the generic
// declarative sheet for these types.
sheets.catalog('actor', 'hero', HeroSheet);
sheets.catalog('item', '*', DemoItemSheet);

console.log('[Loom Demo System] Loaded!');

