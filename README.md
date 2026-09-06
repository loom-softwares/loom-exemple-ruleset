# Loom Demo System

A playable demonstration system for LoomVTT. Serves as a living reference — showcasing both ways to build character sheets (declarative schema and custom `.hbs` Handlebars templates) side-by-side in the same system for direct comparison.

## Features

- **3 Actor Types:** `hero` (custom `.hbs` sheet), `villain` and `beast` (declarative schema)
- **4 Item Types:** `weapon`, `armor`, `potion`, `scroll`
- **Attributes:** Might, Swift, Wits
- **Automatic Derivation:** Attack, Dodge, Initiative, and Detection bonuses
- **Weapon Actions:** "Attack" and "Damage" buttons that roll formulas and post chat cards
- **Custom Chat Card:** Two-tone gradient banner header with actor name
- **Active Effects (Buffs):** Provided automatically in declarative sheets, reimplemented manually in custom `.hbs` sheets
- **Hook `preRoll`:** Tags roll origin metadata
- **Keybind:** `Ctrl+Shift+D` greeting shortcut
- **Central Settings:** Integrates with Loom's settings registry via manifest `settings` and `settings.register()`
- **Initiative Calculation:** Demonstrates `rollInitiative` interface (reading configured attribute from settings)

## Directory Structure

```
loom-demo-system/
├── ruleset.json          # Manifest: engine, type, name, title, version, client,
│                          # actorTypes, itemTypes, styles, languages — EVERYTHING
│                          # the server needs to know (it never runs main.mjs)
├── main.mjs               # Entry point: registers the system, hooks, keybinds,
│                          # custom chat card wrap, custom sheet catalog — dispatch only,
│                          # never define core data or rules inline here
├── data/
│   ├── hero.mjs            # Default data — 1 file per actor type
│   ├── villain.mjs
│   ├── beast.mjs
│   └── prepare-data.mjs    # Derived data — dispatcher per type
│                          # (prepareHero / prepareVillain / prepareBeast),
│                          # not a single monolithic function with internal if/else
├── sheets/
│   └── hero-sheet.mjs      # Custom Window class (only needed when using .hbs)
├── templates/
│   └── hero-sheet.hbs      # Handlebars template, referenced by the class's PARTS
├── styles/
│   └── system.css          # System stylesheet — declared in ruleset.json "styles"
└── lang/
    ├── en.json             # English translations (core locale: 'en')
    └── pt-BR.json          # Portuguese translations (core locale: 'pt-BR')
```

Larger systems (like `srd5e`) naturally expand with a `scripts/` folder (roll engine, configs, helpers — separated by responsibility), but the root layout remains identical.

## Essential Developer Guidelines

### 1. Server Security & The Manifest (`ruleset.json`)

Rulesets (systems) run **100% client-side**. The server's `AddonLoader` intentionally ignores any `core` entry point for rulesets to prevent third-party code from executing in the privileged Node.js process.

Because the server never executes `main.mjs`, everything the server needs to validate must be declared as **static JSON** in `ruleset.json`:
- **`engine` & `type`:** Set `"engine": "loom"` and `"type": "ruleset"`.
- **`actorTypes` & `itemTypes`:** Arrays of allowed type names. The server's REST endpoints (`POST/PUT /api/actors` and `/api/items`) validate payloads strictly against these arrays. Custom actor types missing from `ruleset.json` will be rejected by `isValidActorType`. Custom item types not listed in `itemTypes` or the native list will be downgraded to `"equipment"`.
- **`styles`:** Only `.css` files explicitly listed in the `"styles"` array are injected into the DOM by `addon-client-loader.ts`. Placing files in `styles/` alone is not enough.
- **`languages`:** LoomVTT's core locale system uses standard codes (`'en'` and `'pt-BR'`). Declare `"lang": "en"` (pointing to `lang/en.json`) so the client loader matches the active language.

### 2. The Two Sheet Patterns

**Declarative (`getSheetSchema` / `getItemSheetSchema` in `main.mjs`)** — Recommended for most systems. The core engine renders the complete window from a JS schema without requiring any template files. Active Effects (Buffs) are provided out-of-the-box by `ActorSheetWindow`. Used here by `villain` and `beast`.

**Custom `.hbs` (`sheets/*.mjs` + `templates/*.hbs`)** — Use only when declarative schemas cannot express the required UI (complex bespoke layouts, external canvas widgets, etc.). Requires extending the base sheet:

```javascript
class HeroSheet extends LoomHandlebarsMixin(LoomActorSheet) {
  static PARTS = {
    main: { template: '/marketplace/rulesets/loom-demo-system/templates/hero-sheet.hbs' },
  };

  constructor(props) {
    super({
      ...props,
      id: props.id || `actor-sheet-${props.actorId}`,
      documentId: props.actorId, // CRITICAL: without documentId, loadDocument() will not load data!
    });
    this.actorId = props.actorId;
  }
}
```

Register the custom sheet in `main.mjs`:

```javascript
sheets.catalog('actor', 'hero', HeroSheet);
```

With custom sheets, any feature that `ActorSheetWindow` provides automatically (such as tabs or the Active Effects UI) must be managed manually by the sheet class.

### 3. Form Input Naming Convention (Auto-Save)

Input auto-save is handled automatically by `document-sheet.ts` and `LoomFormData` (which uses `:` as delimiter):
- `name="name"` → Saves directly to the document's top-level `name` field.
- `name="sd:attributes.might"` → Saves nested inside `systemData` (e.g. `actor.systemData.attributes.might`).

### 4. Initiative (`rollInitiative`)

The `rollInitiative(actor)` method in `defineSystem()` demonstrates the interface contract for system-driven formula calculation.

> **Note:** The core Combat Tracker (`sidebar.ts`) resolves initiative formulas via
> `Loom.settings.get(systemId, 'initiativeFormula') || '1d20'` or the `/combat/:worldId/dex-initiative`
> endpoint. Implementing `rollInitiative` documents the system math for programmatic rolls.

## How to Use

Copy this folder to:
`<DataRoot>/marketplace/rulesets/loom-demo-system/`
and activate it in the **Setup Hub → Rulesets**.

Or scaffold your own system with the CLI:

```bash
npm run create:ruleset -- my-system
```

Validate your system manifest and code at any time:

```bash
npm run validate:ruleset -- examples/loom-demo-system
# or directly:
node tools/validate-system.mjs examples/loom-demo-system
```
