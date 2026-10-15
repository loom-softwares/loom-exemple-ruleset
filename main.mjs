// ══════════════════════════════════════════════════════════════
// Loom Demo System — client entry point (wiring only)
// ══════════════════════════════════════════════════════════════
//
// The sandbox system: the GM builds the rules in the system's own editor (attributes, skills,
// resources, item categories, dice, chat card, combat). This file only registers the pieces;
// each piece lives in its own module and does nothing at import time.
//
// Load order (verified): client/main.ts sets window.Loom before any ruleset is imported, so the
// SDK and the modules that read window.Loom at import time see a complete engine.
// A system never runs server code: everything the server needs is in ruleset.json.

import { SystemRegistry, defineSystem, keybinds, showToast } from '/_loom/sdk/index.js';
import { registerConfigSetting, getConfigSync, loadConfig, defaultActorData } from './lib/config.mjs';
import { registerActorSheet } from './sheets/sandbox-sheet.mjs';
import { registerItemSheet } from './sheets/item-sheet.mjs';
import { registerRollCard } from './cards/roll-card.mjs';
import { registerCombat } from './combat/index.mjs';
import { openCombatPanel } from './combat/tracker-window.mjs';
import { openRuleEditor, registerRuleEditorMenu } from './windows/rule-editor.mjs';

const SYSTEM_ID = 'loom-demo-system';
const VERSION = '0.2.1';
const ACTOR_TYPES = ['hero', 'villain', 'beast'];
// Keep in sync with ruleset.json "itemTypes". The four legacy types stay so old worlds still load.
const ITEM_TYPES = ['gear', 'ability', 'spell', 'weapon', 'armor', 'potion', 'scroll'];

/** Translated text with an English fallback (the engine returns the key itself when missing). */
function t(key, fallback) {
  try {
    const text = globalThis.Loom?.i18n?.localize?.(key);
    return typeof text === 'string' && text && text !== key ? text : fallback;
  } catch {
    return fallback;
  }
}

/** Runs one registration. A failure is logged and never stops the others. */
function attempt(name, register) {
  try {
    if (register() === false) console.warn(`[${SYSTEM_ID}] ${name} was not registered (engine not ready?)`);
  } catch (err) {
    console.warn(`[${SYSTEM_ID}] ${name} registration failed`, err);
  }
}

function registerKeybinds() {
  const category = t('sandbox.main.keyCategory', 'Sandbox system');
  keybinds.register({
    id: 'open-rule-editor',
    label: t('sandbox.main.keyRuleEditor', 'Open the rule editor'),
    description: t('sandbox.main.keyRuleEditorHint', 'GM only: opens the rule editor of the sandbox system.'),
    defaultKey: 'Shift+R',
    category,
    onPress: () => {
      if (globalThis.Loom?.user?.isGM !== true) {
        showToast(t('sandbox.main.gmOnly', 'Only the GM can edit the rules.'), 'warning');
        return;
      }
      void openRuleEditor();
    },
  });
  keybinds.register({
    id: 'open-combat-panel',
    label: t('sandbox.main.keyCombatPanel', 'Open the combat panel'),
    description: t('sandbox.main.keyCombatPanelHint', 'Opens the combat panel of the sandbox system.'),
    defaultKey: 'Shift+B',
    category,
    onPress: () => {
      try {
        void openCombatPanel();
      } catch (err) {
        console.warn(`[${SYSTEM_ID}] combat panel failed to open`, err);
      }
    },
  });
  return true;
}

SystemRegistry.register(defineSystem({
  id: SYSTEM_ID,
  title: 'Loom Demo System',
  version: VERSION,
  actorTypes: ACTOR_TYPES,
  itemTypes: ITEM_TYPES,

  /**
   * Seeds the systemData of a new actor from the world config. Items seed themselves
   * (the engine's getItemDefaultData hook is never called), so other types get an empty object.
   * Synchronous: uses the last known config, never waits for a fetch.
   */
  getDefaultData(type) {
    if (!ACTOR_TYPES.includes(type)) return {};
    return defaultActorData(getConfigSync(), type);
  },
}));

attempt('config setting', registerConfigSetting);
attempt('actor sheet', registerActorSheet);
attempt('item sheet', registerItemSheet);
attempt('roll card', () => registerRollCard().ok);
attempt('combat', registerCombat);
attempt('rule editor menu', registerRuleEditorMenu);
attempt('keybinds', registerKeybinds);

// Warm the synchronous cache in the background; never blocks boot.
loadConfig({ fresh: true }).catch(() => {});
