# 🎲 Loom Demo System — Official Reference & Developer Guide

The **Loom Demo System** (`loom-demo-system`) is the official demonstration and educational boilerplate ruleset for **LoomVTT**. It is designed as a living reference and starting template for developers learning how to build, customize, and publish their own tabletop RPG systems within LoomVTT.

Distributed under the **[MIT License](./LICENSE)**: you have complete freedom to fork, modify, rename, distribute, and monetize any system built upon this codebase.

---

## 🧭 Guide Table of Contents

1. [Overview & Architecture](#-overview--architecture)
2. [Directory Structure](#-directory-structure)
3. [The Golden Rule: The `ruleset.json` Manifest & Security](#-the-golden-rule-the-rulesetjson-manifest--security)
4. [The Two Sheet Architectures in LoomVTT](#-the-two-sheet-architectures-in-loomvtt)
   - [A. Declarative Sheet (Schema-based)](#a-declarative-sheet-schema-based--fast--automatic)
   - [B. Custom Sheet (Handlebars `.hbs` + Mixin)](#b-custom-sheet-handlebars-hbs--mixin)
5. [Form Synchronization & Auto-Save (`sd:`)](#-form-synchronization--auto-save-sd)
6. [Data Derivation (`prepare-data.mjs`)](#-data-derivation-prepare-datamjs)
7. [Roll Dialog & Contextual Target Detection](#-roll-dialog--contextual-target-detection)
8. [Initiative & Combat Tracker Synchronization (`Loom.combat`)](#-initiative--combat-tracker-synchronization-loomcombat)
9. [Item Sheets (`DemoItemSheet`) & Inventory Management](#-item-sheets-demoitemsheet--inventory-management)
10. [Custom Chat Cards (`renderMessage.wrap`)](#-custom-chat-cards-rendermessagewrap)
11. [Step-by-Step: How to Build Your Own RPG System](#-step-by-step-how-to-build-your-own-rpg-system)
12. [Code Validation & Syntax Checks](#-code-validation--syntax-checks)
13. [License](#-license)

---

## 🌟 Overview & Architecture

LoomVTT follows a **Native Web** philosophy:
- **100% Client-Side:** Systems run directly in the player and GM browsers. The LoomVTT server **never executes system code**, ensuring robust host security and high performance.
- **Zero Build Tools:** No Webpack, Vite, React, or Babel required. The system runs pure JavaScript (ES Modules `.mjs`), Handlebars templates (`.hbs`), and vanilla CSS (`.css`).
- **Two Paradigms Side-by-Side:** Demonstrates both a declarative schema sheet (`villain`, `beast`) and a rich Handlebars custom sheet (`hero`), allowing you to compare development complexity directly.

---

## 📂 Directory Structure

```
loom-demo-system/
├── LICENSE                  # Permissive MIT License for developers
├── README.md                # This developer guide
├── ruleset.json             # Static manifest read by the server (types, styles, background, i18n)
├── main.mjs                  # Client entry point: defineSystem, hooks, wraps, and sheet catalog
├── assets/
│   └── BG.jpg               # System background/cover artwork
├── data/
│   ├── hero.mjs              # Default data for "hero" actor type
│   ├── villain.mjs           # Default data for "villain"
│   ├── beast.mjs             # Default data for "beast"
│   └── prepare-data.mjs      # Derived data calculation (attack/dodge/initiative bonuses, defenses)
├── sheets/
│   ├── hero-sheet.mjs        # HeroSheet extending LoomHandlebarsMixin(LoomActorSheet)
│   └── item-sheet.mjs        # DemoItemSheet extending LoomHandlebarsMixin(LoomItemSheet)
├── templates/
│   ├── hero-sheet.hbs        # Handlebars template for the Hero actor sheet
│   └── item-sheet.hbs        # Handlebars template for the Item sheet
├── styles/
│   └── system.css            # System stylesheet (sheets, roll dialogs, custom chat cards)
└── lang/
    ├── pt-BR.json            # Brazilian Portuguese localization
    └── en.json               # English localization
```

---

## 🔒 The Golden Rule: The `ruleset.json` Manifest & Security

Because the LoomVTT server never executes `main.mjs`, it inspects the static `ruleset.json` manifest to validate requests and payload schemas.

```json
{
  "name": "loom-demo-system",
  "title": "Loom Demo System",
  "version": "0.1.0",
  "engine": "loom",
  "type": "ruleset",
  "client": "main.mjs",
  "backgroundUrl": "/marketplace/rulesets/loom-demo-system/assets/BG.jpg",
  "coverUrl": "/marketplace/rulesets/loom-demo-system/assets/BG.jpg",
  "actorTypes": ["hero", "villain", "beast"],
  "itemTypes": ["weapon", "armor", "potion", "scroll"],
  "styles": ["styles/system.css"],
  "languages": [
    { "lang": "pt-BR", "name": "Português", "path": "lang/pt-BR.json" },
    { "lang": "en", "name": "English", "path": "lang/en.json" }
  ]
}
```

> [!IMPORTANT]
> 1. **`actorTypes` & `itemTypes`:** The REST API endpoints (`/api/actors` and `/api/items`) strictly validate document payloads against these arrays. If a new type is used in code without being declared in the manifest, the server will reject document creation!
> 2. **`styles`:** Loom only injects CSS files into the DOM if they are explicitly listed in the `"styles"` array.
> 3. **`backgroundUrl` / `coverUrl`:** Defines the official system cover and wallpaper, displayed in the **Setup Hub** card grid and used as the default login screen wallpaper for worlds powered by this system.

---

## 📑 The Two Sheet Architectures in LoomVTT

### A. Declarative Sheet (Schema-based) — Fast & Automatic
Recommended for monsters, NPCs, or streamlined systems. Requires no `.hbs` template files. Defined directly in `getSheetSchema(actorType)` in `main.mjs`:

```javascript
getSheetSchema(actorType) {
  return {
    tabs: [
      {
        id: 'attributes',
        label: 'Attributes',
        fields: [
          { key: 'attributes.might', label: 'Might', type: 'dots', max: 10 },
          { key: 'defense', label: 'Defense', type: 'number' }
        ]
      }
    ]
  };
}
```
**Benefits:** LoomVTT automatically renders the window, tab navigation, input fields, and native Active Effects (Buffs) management out-of-the-box.

---

### B. Custom Sheet (Handlebars `.hbs` + Mixin)
Recommended for flagship character sheets requiring custom bespoke art, layout widgets, and custom interactions (such as the `hero` sheet in this repository).

1. **Define the sheet class:**
```javascript
import { LoomHandlebarsMixin, LoomActorSheet } from '/_loom/sdk/index.js';

export class HeroSheet extends LoomHandlebarsMixin(LoomActorSheet) {
  static PARTS = {
    main: { template: '/marketplace/rulesets/loom-demo-system/templates/hero-sheet.hbs' }
  };

  constructor(props) {
    super({
      ...props,
      id: props.id || `actor-sheet-${props.actorId}`,
      documentId: props.actorId, // ESSENTIAL: Without documentId, loadDocument() will not fetch data!
    });
    this.actorId = props.actorId;
  }
}
```

2. **Register the sheet in `main.mjs`:**
```javascript
import { sheets } from '/_loom/sdk/index.js';
import { HeroSheet } from './sheets/hero-sheet.mjs';
import { DemoItemSheet } from './sheets/item-sheet.mjs';

sheets.catalog('actor', 'hero', HeroSheet);
sheets.catalog('item', '*', DemoItemSheet);
```

---

## ⚡ Form Synchronization & Auto-Save (`sd:`)

LoomVTT includes `LoomFormData`, a two-way form synchronization engine that automatically persists input changes to database documents without requiring manual `input` or `change` event listeners.

Follow the input `name` attribute convention:
- `name="name"` ➔ Persists to top-level `actor.name`.
- `name="sd:defense"` ➔ Persists to `actor.systemData.defense`.
- `name="sd:attributes:might"` (or `sd:attributes.might`) ➔ Persists to `actor.systemData.attributes.might`.

---

## 🧮 Data Derivation (`prepare-data.mjs`)

Every tabletop RPG distinguishes between base persisted stats (e.g. Strength score `8`) and dynamically derived values (e.g. Attack bonus `+4`, max HP, armor rating).

In LoomVTT, `prepareData(actor)` executes on the client whenever an actor is loaded or modified:

```javascript
export function prepareHero(actor) {
  const attrs = actor.systemData?.attributes || { might: 5, swift: 5, wits: 5 };
  
  // Calculate derived bonuses
  actor._bonus = {
    attack: Math.floor((attrs.might ?? 5) / 2),
    dodge: Math.floor((attrs.swift ?? 5) / 2),
    initiative: Math.floor((attrs.swift ?? 5) / 2),
  };

  // Derive total defense rating
  actor.defense = actor.systemData?.defense ?? (10 + actor._bonus.dodge);
}
```

---

## 🎯 Roll Dialog & Contextual Target Detection

Clicking rollable attributes or combat actions on the `HeroSheet` opens an interactive roll prompt powered by `LoomDialog.wait()`:

```javascript
// Detect active player targets on the canvas
const targets = window.Loom?.user?.targets || [];
const target = targets[0]; // Returns { name, defense, avatar, ... }

// Pre-fill target defense as the default Difficulty (DC)
const defaultDC = target ? target.defense : 10;
```

Features:
1. Displays the selected target card with avatar, name, and defense.
2. Allows fine-tuning situational modifiers (+/-) and DC.
3. Supports roll modes: **Normal** (`1d20`), **Advantage** (`2d20kh1`), or **Disadvantage** (`2d20kl1`).
4. Dispatches the roll to chat via `window.Loom.dispatchRoll({ formula, actorId, meta: { ... } })`.

---

## ⚔️ Initiative & Combat Tracker Synchronization (`Loom.combat`)

Initiative rolls operate with dedicated game logic:
1. **No Target or Difficulty (DC):** Unlike attacks, initiative is an ordering roll. The initiative prompt intentionally omits targets, DC fields, and success/failure checks.
2. **Combat Tracker Integration:**
   When rolling initiative, the system checks for an active encounter via `window.Loom.combat`:
   ```javascript
   const activeCombat = window.Loom?.combat;
   const combatant = activeCombat?.combatants?.find(c => c.actorId === this.actorId);
   ```
3. **Automatic Turn Reordering:**
   The total result updates the combatant directly in the Combat Tracker:
   ```javascript
   window.Loom.combats.updateCombatant(worldId, combatant.castId, { initiative: totalRoll });
   ```
   The combat sidebar tab reorders combatant turns instantly.

---

## 🎒 Item Sheets (`DemoItemSheet`) & Inventory Management

Demonstrates standalone item documents and sheets:
- **Extends `LoomItemSheet`:** Implemented in `sheets/item-sheet.mjs`.
- **Native Portrait/Image Picker:** Attributes with `data-action="pick-portrait"` and `data-edit="imgUrl"` open LoomVTT's built-in asset selector modal.
- **Contextual Fields by Type:** `templates/item-sheet.hbs` conditionally renders Damage formula for weapons, Defense bonuses for armor, and Healing values for potions.
- **Damage Rolling:** Built-in "Roll Damage" action evaluates item formulas (e.g. `1d8+2`) and renders chat cards.

---

## 🌐 Localization & i18n (`lang/*.json`)

LoomVTT features a native internationalization engine so that systems never need to hardcode UI strings.

### 1. Declaring Languages in `ruleset.json`
Declare translation bundles in the static manifest. Loom automatically loads and merges them into the active language registry:

```json
"languages": [
  { "lang": "en", "name": "English", "path": "lang/en.json" },
  { "lang": "pt-BR", "name": "Português (Brasil)", "path": "lang/pt-BR.json" }
]
```

### 2. Using `{{localize}}` in Handlebars Templates
In `.hbs` templates, translate labels, placeholders, and tooltips using the built-in `{{localize}}` helper:

```handlebars
<!-- Translate labels, tooltips, and placeholders -->
<label>{{localize "loom-demo-system.attributes.might"}}</label>
<input placeholder="{{localize "loom-demo-system.sheet.hero.namePlaceholder"}}" />
<button title="{{localize "loom-demo-system.actions.attack"}}">
  {{localize "loom-demo-system.actions.attack"}}
</button>
```

### 3. Using `window.Loom.i18n.localize()` in JavaScript
For script-driven UI elements (e.g. `LoomDialog.wait`, `showToast`, chat cards):

```javascript
export function localize(key, fallback = '') {
  const text = window.Loom?.i18n?.localize?.(key);
  return (text && text !== key) ? text : (fallback || key);
}

const title = localize('loom-demo-system.actions.attack', 'Attack');
```

---

## 💬 Custom Chat Cards (`renderMessage.wrap`)

LoomVTT provides `getWraps()` to intercept UI components without altering the engine core:

```javascript
getWraps().renderMessage.wrap((wrapped, msg, ctx) => {
  if (!msg.isRoll || msg.roll?.meta?.system !== 'Loom Demo') {
    return wrapped(msg, ctx); // Leave other system messages intact
  }

  // Render standardized card with actor avatar, dice breakdown,
  // and clear SUCCESS or FAIL badges compared against DC
  return `<div class="loom-demo-card">...</div>`;
});
```

---

## 🛠️ Step-by-Step: How to Build Your Own RPG System

To transform this demonstration into your own custom RPG:

1. **Update `ruleset.json`:**
   Change `"name"` and `"title"`, and declare all actor and item types your game requires.
2. **Configure Default Data in `data/`:**
   Create files for your actor types (e.g. `warrior.mjs`, `monster.mjs`) defining your stats (e.g. Strength, Dexterity, Willpower, Mana).
3. **Implement Calculations in `data/prepare-data.mjs`:**
   Code your game's rules (wound thresholds, attack bonuses, derived armor values).
4. **Design the Template in `templates/hero-sheet.hbs`:**
   Update field bindings to match your stats (always using the `name="sd:myAttribute"` convention).
5. **Theme with `styles/system.css`:**
   Customize color tokens (`--rpg-gold`, background shades, typography) to craft the unique atmosphere your game deserves.

---

## 🧪 Code Validation & Syntax Checks

Always verify module syntax before shipping updates:

```bash
node --check main.mjs
node --check sheets/hero-sheet.mjs
node --check sheets/item-sheet.mjs
node --check data/prepare-data.mjs
```

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](./LICENSE) file for details.

You are free to use, study, fork, modify, and build your own tabletop RPG systems for LoomVTT without restriction. Have fun building incredible worlds! 🚀
