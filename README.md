# Loom Demo System: developer walkthrough

A complete, small ruleset for LoomVTT. The GM builds the rules in the system's own rule editor (attributes, skills, resources, item categories, dice, chat card, combat), and the code is short enough to read end to end. This page walks through it file by file.

Paths are relative to the ruleset folder (`loom-demo-system`). Behaviour marked **(not verified in a browser)** was read from the code and has not been run in a browser yet.

## Status

- Browser validation (a planned run on a local dev server with a test account) has **not run yet**.
- `npm test` passes: 417 tests, 0 failures (run on 2026-10-13).
- Everything else comes from reading this repo and the engine code it calls. Each claim names its file.
- Open items: `styles/system.css` is still listed in `ruleset.json` but its selectors belong to the previous system (none start with `ldm-`). See section 8.

## 1. What it is and what the GM can configure

Ruleset id `loom-demo-system`, version in `ruleset.json`. Three actor types (`hero`, `villain`, `beast`) share one sheet class. Item types on the sheet are `gear`, `ability` and `spell`; the legacy types `weapon`, `armor`, `potion` and `scroll` stay registered and use the same item sheet.

Everything the GM can change lives in one JSON config (section 4):

| Piece | Config path | Limits (`lib/config.mjs`, `LIMITS`) |
|---|---|---|
| Dice system | `dice.mode` = `d20` or `pool`; `dice.d20.*`; `dice.pool.*` | sides and faces 2..100; pool `maxDice` 1..50 |
| Attributes | `attributes[]`: key, label, min, max, default | at most 12; bounds within +/-999 |
| Skills | `skills[]`: key, label, attr, max, default | at most 40; max 0..100 |
| Resources | `resources[]`: key, label, max, color, showInCombat | at most 8; max 1..999 |
| Item categories | `itemCategories[]`: key, label | at most 24 |
| Item kinds | `abilityKinds` (labels for ability and spell) | at most 8 |
| Chat card | `card`: style, showFormula, showDice, accent, header, labels | header 80 characters |
| Combat initiative | `combat.initiative`: mode, attr, bonus | bonus +/-99 |

Dice: `d20` is one check, `1dN` plus modifiers, with critical and fumble thresholds. `pool` is a dice pool counted in successes (`Nd6cs>=5`), with an optional glitch rule.

Tour:

1. The GM presses **Shift+R** (keybind in `main.mjs`) or opens the rule editor from the system settings menu. Sections: Dice, Attributes, Skills, Resources, Item categories, Item kinds, Chat card, Combat, Import and export. Presets (`d20Classic`, `d6Pool`) and Reset are there too. Save stays disabled while validation errors exist (`windows/rule-editor.mjs`).
2. An actor sheet shows attributes, skills, resources (with +/- steps), items grouped by type, and notes. Attribute and skill buttons roll. Ability and spell buttons can pay a resource cost, and can roll and deal damage.
3. Every roll becomes a chat card drawn by this system (`cards/roll-card.mjs`).
4. **Shift+B** opens the combat panel for any user (`combat/tracker-window.mjs`). The engine's own Start combat button calls this system's initiative handler.

(not verified in a browser): the keybinds, the editor and the card layout.

## 2. File map

| Path | Job |
|---|---|
| `LICENSE` | MIT license. |
| `README.md` | This walkthrough. |
| `ruleset.json` | Static manifest the server and loader read: name, version, `client` entry, `styles`, `languages`, `actorTypes`, `itemTypes`. |
| `package.json` | Scripts `test`, `check`, `lang` (no dependencies). |
| `main.mjs` | Client entry. Calls `defineSystem`, runs every registration, registers keybinds. Wiring only (under 200 lines, enforced by a test). |
| `assets/BG.jpg` | Background and cover image named in the manifest. |
| `lib/helpers.mjs` | Pure helpers: `esc`, `slug`, `clamp`, `uid`, `deepClone`, `isPlainObject`. No engine access. |
| `lib/config.mjs` | The world config: defaults, presets, `validateConfig`, `parseConfig`, `serializeConfig`, the setting, `loadConfig`, `saveConfig`, `actorValue`, `defaultActorData`. |
| `lib/dice.mjs` | Dice logic: `buildCheck` (formula and meta), `buildExtra` (damage formula check), `interpret` (read a roll), `describe`, `rollCheck` (the only place that calls `window.Loom.dispatchRoll`). |
| `windows/rule-editor.mjs` | The GM editor window (`RuleEditorWindow`), its pure state and render helpers, `openRuleEditor`, `registerRuleEditorMenu`. |
| `sheets/sandbox-sheet.mjs` | Actor sheet (`registerActorSheet`): pure renderer, minimal write patches, cast rule, roll and item-use methods. |
| `sheets/item-sheet.mjs` | Item sheet class (`DemoItemSheet`) and `registerItemSheet`. |
| `sheets/item-view.mjs` | Pure item model: normalisation, context and escaped HTML of the item sheet. |
| `templates/item-sheet.hbs` | Shell for the item sheet: only `{{{body}}}`, the escaped HTML from `item-view.mjs`. |
| `cards/roll-card.mjs` | Chat card: `renderCard` (pure), the config cache, `registerRollCard` (the `renderRollCard` wrap). |
| `combat/index.mjs` | `registerCombat()`: runs the three combat registrations, each guarded. |
| `combat/initiative.mjs` | `combatInitiative` handler: computes totals for the selected tokens. |
| `combat/labels.mjs` | `combatantLabel` badges, the shared resource cache, the rate-limited sweeper. |
| `combat/tracker-window.mjs` | Player-visible combat panel: polling, turn marker, GM controls. |
| `styles/system.css` | Legacy stylesheet from the previous system. Still listed in the manifest; see section 8. |
| `styles/sandbox-sheet.css`, `-item.css`, `-card.css`, `-editor.css`, `-combat.css` | One stylesheet per module, every class prefixed (`ldm-sheet-`, `ldm-item-`, `ldm-card-`, `ldm-editor-`, `ldm-combat-`). |
| `i18n/<module>.en.json`, `i18n/<module>.pt-BR.json` | Translation fragments, one pair per module (`card`, `combat`, `config`, `editor`, `item`, `main`, `sheet`). Keys look like `sandbox.<module>.<name>`. |
| `lang/en.json`, `lang/pt-BR.json` | Generated from the fragments by `scripts/merge-lang.mjs`. The engine loads these two files (`languages` in the manifest). Do not edit by hand. |
| `scripts/merge-lang.mjs` | Merges the fragments into the two language files. |
| `tests/*.test.mjs` | Nine test files for `node --test`: config, dice, helpers, card, editor, item, sheet, combat, manifest. |
| `.agents/` | Guidance and skills for AI assistants working on this repo. The engine does not load them. |
| `.github/workflows/release.yml` | Builds the package on a version tag. |
| `CHANGELOG.md` | Change history. |

## 3. How the engine loads the system

Manifest fields the loader reads (`client/core/addon-client-loader.ts`):

| Field | Used for |
|---|---|
| `name` | Folder name under `/marketplace/rulesets/`. |
| `active` | `false` skips the system. |
| `client` | Entry module, imported as given. This demo uses `main.mjs`. The guide examples say `client.js`, but the value is just a path. |
| `styles` | Each file is fetched and injected. Files that are not listed are not loaded, even if present. |
| `languages` | The active language is loaded; `en` is the fallback. |
| `actorTypes`, `itemTypes` | Declared for the server's routes (see `docs/en/guide/system-creation.md`). |
| `backgroundUrl`, `coverUrl` | Setup screen artwork (per the guide; not verified in a browser). |

Load order: the engine sets `window.Loom` before it imports the ruleset's `client` module, so the `lib/` and sheet modules can read `window.Loom` as they run (`main.mjs` header). The SDK import is `/_loom/sdk/index.js`; this system uses `SystemRegistry`, `defineSystem`, `keybinds` and `showToast`.

`main.mjs` does five things:

```js
SystemRegistry.register(defineSystem({
  id: SYSTEM_ID, title: 'Loom Demo System', version: VERSION,
  actorTypes: ACTOR_TYPES, itemTypes: ITEM_TYPES,
  getDefaultData(type) { /* defaultActorData(getConfigSync(), type) */ },
}));

attempt('config setting', registerConfigSetting);
attempt('actor sheet', registerActorSheet);
attempt('item sheet', registerItemSheet);
attempt('roll card', () => registerRollCard().ok);
attempt('combat', registerCombat);
attempt('rule editor menu', registerRuleEditorMenu);
attempt('keybinds', registerKeybinds);

loadConfig({ fresh: true }).catch(() => {}); // warm the sync cache
```

- `attempt(name, fn)` logs a warning and carries on, so one failed registration never stops the others.
- Nothing registers itself at import time. Each module exports a function and `main.mjs` calls it.
- `getDefaultData` seeds new actors from the last known config (synchronous, never waits).

## 4. The config model

**Storage.** One world setting: module `loom-demo-system`, key `ruleConfig` (`CONFIG_MODULE`, `CONFIG_KEY` in `lib/config.mjs`). The value is JSON text, so the server stores a string. Two identifiers exist on purpose: the config module is `loom-demo-system`, while the `meta.system` marker on rolls is `loom-demo` (`CARD_SYSTEM_ID` in `cards/roll-card.mjs`, `SYSTEM_ID` in `lib/dice.mjs`).

**Shape** (the top level of `defaultConfig()`):

```js
{
  version: 1,
  name: 'My System',
  dice: { mode: 'd20',
    d20: { sides: 20, critMin: 20, fumbleMax: 1, targetLabel: 'DC' },
    pool: { faces: 6, successMin: 5, maxDice: 20, glitchOnOnes: false } },
  attributes: [{ key: 'might', label: 'Might', min: 0, max: 10, default: 2 }],
  skills: [{ key: 'melee', label: 'Melee', attr: 'might', max: 10, default: 0 }],
  resources: [{ key: 'hp', label: 'Health', max: 20, color: '#c0392b', showInCombat: true }],
  itemCategories: [{ key: 'weapon', label: 'Weapon' }],
  abilityKinds: { ability: 'Ability', spell: 'Spell' },
  card: { style: 'detailed', showFormula: true, showDice: true, accent: '#7c5cff',
    header: '{actor}: {label}', successLabel: 'successes', critLabel: 'Critical', fumbleLabel: 'Fumble' },
  combat: { initiative: { mode: 'attribute', attr: 'grace', bonus: 0 } },
}
```

**Validation.** `validateConfig(input)` returns `{ ok, config, errors }`:

- `config` is always a valid, sanitised v1 config. Unknown keys are dropped.
- `errors` lists every value that was changed, defaulted or dropped, in English (the editor shows them as they are).
- Keys must match `^[a-z][a-z0-9_]{0,23}$`. A key with bad characters is slugged, and that counts as an error.
- Lists are scanned up to 200 entries; duplicate keys are dropped.
- `parseConfig(text)` does the same for imported JSON text (at most 200,000 characters).

**Saving.** The editor calls `saveConfig(cfg)`, which:

1. calls `validateConfig` and refuses if `errors` is not empty (nothing is written);
2. refuses early when `user.isGM === false` (the server enforces this too);
3. calls `loom.settings.set(...)`, which sends `PUT /api/module-settings/:worldId/loom-demo-system/ruleConfig`. That route requires a GM (`server/applications/api/module-settings.ts`);
4. calls every `onConfigSaved` listener (the chat card cache uses this).

**Why sheets re-read on open.** No live sync exists between clients and the engine sends no config event to systems. Each sheet calls `loadConfig({ fresh: true })` in `loadDocument()`. The editor shows a "configuration changed elsewhere" notice when a reload finds different data. Render paths that cannot await use `getConfigSync()`, which returns the last config this module loaded or saved. The chat card refreshes its copy in the background at most every 2 seconds and never blocks a render.

**Editing.** The editor works on a draft (`draftFromConfig`, `configFromDraft`), shows validation live, and offers Import JSON and Export JSON (`parseConfig`, `serializeConfig`). Removing an attribute does not delete data: stored values stay, they just stop being shown.

## 5. A roll, end to end

Trace an attribute check. Clicking a skill follows the same path.

```
attr-roll button                     sheets/sandbox-sheet.mjs  _ldmRollAttr
  -> rollCheck(cfg, opts)            lib/dice.mjs              buildCheck -> { formula, meta }
  -> window.Loom.dispatchRoll        client/main.ts            (returns void)
  -> roll-dispatch.ts                client/screens/game-hud/  chatRollCommand and preRoll hooks,
                                                               then wsClient.send('chat.roll')
  -> server 'chat.roll' handler      server/index.ts           roll() from server/applications/dice/roller.ts;
                                                               stores the chat row, broadcasts chat.roll
  -> chat message card               client/screens/game-hud/  renderRollCardWrap(msg.roll, esc)
  -> this system's wrap              cards/roll-card.mjs       registerRollCard -> renderCard
```

**The formulas.** `buildCheck(cfg, { attrValue, skillValue, bonus, advantage })` builds them. `N` is attribute + skill + bonus, clamped to +/-1000.

| Mode | Plain | Advantage | Disadvantage |
|---|---|---|---|
| d20 | `1d20+5` | `2d20kh1+5` | `2d20kl1+5` |
| pool | `5d6cs>=5` | `6d6cs>=5` | `4d6cs>=5` |

In pool mode `n` is `N` clamped to `1..maxDice`; advantage adds a die and disadvantage removes one, still clamped. The server understands `cs>=N` and counts dice that meet it (`SuccessPool` in `server/applications/dice/roll-parts.ts`).

**The meta.** `buildCheck` sets `meta = { system: 'loom-demo', kind: 'check', mode, sides, critMin, fumbleMax }` (or `faces`, `successMin`, `glitchOnOnes` in pool mode). `rollCheck` adds `label` and `actorName`. The server attaches `meta` to the result as `roll.meta`.

**The server result.** `roll()` returns `{ formula, terms, total, mode, meta }`. A dice term has `kind: 'dice'`, `rolls[]`, `dropped[]`, `subtotal`, and `successes` when `cs` is used. In pool mode `total` equals the number of successes.

**Reading it** (`interpret(cfg, roll)` in `lib/dice.mjs`):

- d20: the natural value is the one kept die. Critical when it is at least `critMin`; fumble when it is at most `fumbleMax`. The modifier shown is `total - natural`.
- pool: successes are the sum of the `cs` term's `successes`. A die is a hit when it is at least `successMin`. Glitch is set when `glitchOnOnes` is on and more than half of the active dice show 1 (`ones * 2 > active`).

Critical and fumble are decided by the card from the natural die. The server does not know about them.

**Damage.** An item with `roll.damage` sends a second roll, validated first by `buildExtra`. It accepts only `NdF`, integer literals, `+`, `-` and parentheses, up to 100 characters and 100 dice. The card shows it with `meta.kind = 'damage'`, which has no hit or miss.

**What the sheet learns.** `dispatchRoll` returns nothing and the roll result is not returned to the caller. `rollCheck` returns `{ ok: true }` once the call was made, not when the roll is known. Results appear only on the chat card. (verified in code)

**Not handled by the demo.** The client-side `{kind:config}` custom dice syntax and letter dice (`1dv`) are engine features. The demo never sends them.

## 6. Sheets, items and writes

**Why our own sheets.** The engine's generic actor and item sheets replace the document with a raw fetch after `prepareData` has run, so a system's derived data is lost. Their item schema never reaches the client either. This system therefore ships its own classes that extend `LoomHandlebarsMixin(LoomActorSheet)` and `LoomItemSheet`, and registers them with `sheets.catalog(docType, typeName, Class)`. `'*'` is the fallback. (`demo-research-E-sheets.md`, `client/core/sheet-catalog.ts`)

**Rendering.** `renderSheet(ctx)` is a pure function that returns escaped HTML. The class sets `PARTS = {}` and writes the HTML in `compile()`, so no Handlebars part is needed for the actor sheet. The item sheet uses a shell template (`templates/item-sheet.hbs`).

**Writes, step by step.**

1. A typed value fires one `input` listener on the sheet root (event delegation). `changeFromField` turns it into a change.
2. `_ldmQueue` calls `buildPatch(view, cfg, change)`, which returns the minimal patch for that one path (for example `{ systemData: { attrs: { might: 3 } } }`). The patch is deep-merged into the pending patch.
3. Typing waits 300 ms; buttons flush at once. `_ldmFlush` serialises writes.
4. `_ldmWrite` sends one `PUT /api/actors/:id` (or `/api/cast/:id`) with `{ systemData: patch }`, then one `PUT /api/items/:id` with `{ data }` per changed item.

**Why minimal patches.** Actor responses return `systemData` with active effects already applied, so writing the whole object would store the effects as base values. `sheets/sandbox-sheet.mjs` documents the limit: the raw base values are not returned by actor routes, so a +/- on an attribute that an effect modifies stores the effective value plus or minus one as the base.

**Item routes.** Items are edited on the world route `/api/items/:id`, which is what `apiRoute` defaults to in the item sheet. The embedded route `/api/actors/:id/items/:itemId` has no GET by id, so opening an embedded item from it returns 404 (`docs/en/api/actors.md`, see the engine gap log).

**The cast rule.** `resolveWriteTarget(actorId, castId, cast)` decides where a patch goes:

| Case | Target |
|---|---|
| No cast context (sidebar, token click) | actor |
| Linked cast (`isLinked: true`, a PC) | actor |
| Unlinked cast (`isLinked: false`, an NPC) | `PUT /api/cast/:id` |
| Cast could not be loaded, or belongs to another actor | refused |

The engine opens the actor sheet from a token with only `{ actorId, worldId }` (`client/screens/game-hud/game-hud.ts`, around line 3161), so today every write goes to the actor. The NPC path works only when a `castId` is passed in.

**Item use.** `_ldmUseItem` flushes pending edits, then `planUse(item, sys, cfg)` checks the cost and the uses. It refuses (with a toast) on an unknown or short resource, or on zero uses. Otherwise it writes the new resource value and uses, then rolls the check and, if valid, the damage. Nothing is written if the plan is refused.

**Effects limitation.** The sheet can show effect-applied values but not base values, for the reason above. The NPC cast route returns raw rows, so the NPC path has no such gap.

## 7. Combat

Files: `combat/index.mjs` registers three things, each guarded:

- `initiative.mjs` installs the `combatInitiative` handler.
- `labels.mjs` installs the `combatantLabel` badge and holds the shared cache.
- `tracker-window.mjs` builds the panel and `openCombatPanel()`.

**Why a panel and badges.** Combat is one `combats` row with a `combatants` array. Engine combat events (`combat.started`, `combat.next`, `combat.updated`, `combat.ended`) are relayed only to sockets that pass the ownership check with the default permission of 0, which in practice means GM sockets (`server/index.ts` around lines 1334-1345; `server/applications/ws/channels.ts`). Players get no live combat updates, so the panel polls. The tracker has no extra columns or buttons, so the system adds one text badge per row.

**Initiative (`combatInitiative`).** The Start combat button calls the hook for the selected tokens with `ctx = { castIds, initiatives, health, rolls, pending }`. The handler pushes an async job into `ctx.pending`, and the UI waits for it. For each token it writes a total into `ctx.initiatives`. The server uses the total, clamped to -20..100. The UI always defers the d20 and ignores the formula for these tokens, so the system computes the total itself (`computeInitiative`):

| Mode | Total |
|---|---|
| `roll` (d20 config) | `1d{sides}` + attribute + bonus |
| `roll` (pool config) | successes of a pool sized by attribute + bonus (at least 1 die) |
| `attribute` | attribute + bonus |
| `fixed` | bonus |

The system posts a chat summary of the totals with the speaker "Combat". (not verified in a browser)

**Badges.** The `combatantLabel` listener writes `ctx.label` synchronously from the cache. The sweeper fills the cache in the background, then the system emits `combatantLabelsChanged` itself, because the engine never emits it and the sidebar redraws only on that event (`combat/labels.mjs`, `client/screens/game-hud/sidebar.ts`).

**Panel.** `openCombatPanel()` shows the round, the turn marker, the order and each combatant's resource bars. The marker follows the server's `currentTurn` over the stored `combatants` order, not the client's initiative sort. The GM also gets +/- buttons on resources and the Previous, Next and End buttons (POST routes under `/api/combat/:worldId`). Players see read-only bars.

**Request budget.** Every constant below is in the file named.

| What | Limit | Where |
|---|---|---|
| Combat row | every 3 s while the panel is open and visible; backs off to 30 s after errors; no overlapping requests | `tracker-window.mjs` `POLL_BASE_MS`, `POLL_MAX_MS` |
| Combatant reads (cast and actor) | each combatant at most every 9 s; at most 12 per pass; at most 4 in flight | `labels.mjs` `RECORD_CADENCE_MS`, `REFRESH_CAP`, `REQUEST_CONCURRENCY` |
| HTTP 429 | pause polling; `Retry-After` is not reachable from `api.get`, so 30 s is used | `labels.mjs` `RATE_LIMIT_DEFAULT_MS` |
| Panel config | refreshed at most every 30 s | `tracker-window.mjs` `CONFIG_REFRESH_MS` |
| Chat card config | refreshed at most every 2 s, never blocking | `cards/roll-card.mjs` `refreshMs` |

## 8. Engine limits the demo works around

Each row is a limit of the engine that this system works around, with the code that does it. Evidence files are in `.planning/reviews/` of the engine repo.

| Engine limit | Workaround in this system | Where |
|---|---|---|
| Generic sheets drop `prepareData` and the item schema | Own sheet classes registered per type | `sheets/sandbox-sheet.mjs`, `sheets/item-sheet.mjs` |
| Actor responses carry effect-applied `systemData`; writing it back stores effects | Minimal path patches, merged on the client | `buildPatch`, `mergePatch` in `sheets/sandbox-sheet.mjs` |
| No GET by id for embedded items | Item sheet uses the world item route | `sheets/item-sheet.mjs` (`apiRoute`) |
| `dispatchRoll` returns `void`; the sheet cannot read the result | Results shown only on the card; `rollCheck` reports dispatch, not the roll | `lib/dice.mjs` `rollCheck` |
| The `c` suffix in `cs>N` is parsed and ignored (a natural maximum does not count twice) | Critical is computed on the card from the natural die | `lib/dice.mjs` `interpret`; `server/applications/dice/roll-formula.ts` (the `c?` is consumed) |
| The docs omit `cs>=N`, which the parser accepts | The dice module uses `cs>=` | `lib/dice.mjs` `buildCheck` |
| `settings.get` returns defaults until world settings load; `whenReady` is missing from the SDK types | Config read through `window.Loom.settings.whenReady` and a fresh API read; `getConfigSync` can return defaults before the first load, so `main.mjs` warms the cache at boot | `lib/config.mjs` `loadConfig`, `getConfigSync` |
| `Loom.world` is set after the HUD opens, not at bootstrap | The config read guards it and falls back to the cache | `lib/config.mjs` `fetchStoredValue` |
| Players get no combat events | The combat panel polls `GET /api/combat/:worldId` | `combat/tracker-window.mjs` |
| The UI always defers initiative and ignores the formula | Totals computed in the `combatInitiative` hook | `combat/initiative.mjs` |
| `combatantLabelsChanged` is listened to but never emitted | The system emits it after badge text changes | `combat/labels.mjs` |
| No extra columns or buttons in the engine tracker | One text badge per row, plus the system's own panel | `combat/labels.mjs`, `combat/tracker-window.mjs` |
| No live sync between clients | Re-read on open; "changed elsewhere" notice in the editor | `sheets/sandbox-sheet.mjs` `loadDocument`, `windows/rule-editor.mjs` |
| The engine does not pass a `castId` when it opens a token's sheet | Cast rule implemented but only used when a `castId` is given | `resolveWriteTarget` in `sheets/sandbox-sheet.mjs` |

**Legacy leftover.** `styles/system.css` (about 2,000 lines) is still in the manifest's `styles` list. None of its selectors start with `ldm-`, and the rebuilt UI uses only the `sandbox-*.css` files. Removing it from the manifest is a follow-up; this walkthrough does not change it.

## 9. Extend it: add one field

Worked example: a `card.showModifier` switch that hides the "Mod" figure on d20 cards. The steps touch the same places that `card.showDice` already touches. Use `grep` on `showDice` to see them all.

**Step 1: schema and validation** (`lib/config.mjs`). Add the key in `sanitizeCard`, next to `showDice`. `boolOf` reports a non-boolean and uses the default.

```js
// sanitizeCard(card, errors)
showDice: boolOf(card.showDice, true, 'card.showDice', errors),
showModifier: boolOf(card.showModifier, true, 'card.showModifier', errors), // new
```

Also add `showModifier: true` to the `card` block of `defaultConfig()`. Without it the key is still sanitised, but the default config would not show it.

**Step 2: the card** (`cards/roll-card.mjs`). Read the flag in `cardView` and gate the existing modifier line:

```js
// cardView(cfg, t): add to the returned object
showModifier: card.showModifier !== false,

// renderCard: the existing line is  if (wantsDice && !isPool && view.natural !== undefined) {
if (card.showModifier && wantsDice && !isPool && view.natural !== undefined) {
```

**Step 3: the editor** (`windows/rule-editor.mjs`, `cardSection`). Add one checkbox next to the existing `showDice` line:

```js
${checkField('card.showModifier', T('sandbox.editor.showModifier', 'Show modifier'), card.showModifier === true)}
```

The editor's draft is a copy of the config, so the new key round-trips through `configFromDraft` and `saveConfig` without more code.

**Step 4: text** (`i18n/editor.en.json`, `i18n/editor.pt-BR.json`). Add `"sandbox.editor.showModifier"` to both fragments, then run `npm run lang`. A manifest test fails when a `sandbox.*` key used in code is missing from `lang/en.json`, and when the language files differ from the fragments.

**Step 5: the sheet.** No change. The sheet never reads `card`.

**Step 6: tests.** Add a default and a bad-value case in `tests/config.test.mjs`. In `tests/card.test.mjs`, the fixtures list every card key (`d20Cfg` and `poolCfg` near lines 20 and 29), so add `showModifier: true` there. Then copy the `showDice false` test (around line 192) and assert that the `ldm-card-mod` span is absent when `showModifier` is false.

**Step 7: run it.**

```
npm test
npm run check
```

## 10. Tests, language files and checks

| Command | What it does |
|---|---|
| `npm test` | `node --test`: 417 tests across nine files in `tests/`. Pure modules only; no browser and no engine needed. |
| `npm run check` | `npm test`, then `node --check main.mjs`. |
| `npm run lang` | `node scripts/merge-lang.mjs`: merges every `i18n/*.en.json` into `lang/en.json` and every `*.pt-BR.json` into `lang/pt-BR.json`. It is idempotent and writes nothing when a key has two different texts; it fails and writes nothing instead. Run it after any change to a fragment. (Not run during this walkthrough, because it writes files.) |

The manifest tests check that every stylesheet in `styles` exists and that every `sandbox.*` key used in code is in `lang/en.json`. They also check that no other product names appear in shipped files, that `main.mjs` stays under 200 lines, and that the code never imports `Hooks` from the SDK (the export is `LoomHooks`).

## 11. Security notes

- **Every string that reaches HTML is escaped.** `esc()` (`lib/helpers.mjs`) runs on every interpolated value in `renderSheet`, `renderItem`, `renderCard`, `renderEditor` and the combat panel. There is no raw HTML from config, roll meta, actor names or item names.
- **Config text is untrusted.** Any GM account or an imported JSON can write it. `validateConfig` strips control characters, limits lengths, slugs keys, validates colours (`#rrggbb`) and only allows the `{actor}`, `{label}` and `{result}` tokens in the card header. The card escapes the final string once.
- **Roll meta is untrusted.** A client sends `meta` with `dispatchRoll`. The card reads only the fields it expects, slices each to a fixed length, and escapes it. `meta.kind` only switches the card layout.
- **Damage formulas are checked before they reach the server.** `buildExtra` accepts only the server's grammar and the caps in `DICE_LIMITS`.
- **Writes are minimal and gated.** Sheets send only changed paths. Config saves require a GM on the server. The NPC cast path refuses when the cast cannot be verified, so it never writes to the wrong record.
- **Images are checked.** Portrait and image URLs pass through `safeImageUrl` (`sheets/sandbox-sheet.mjs`, `sheets/item-view.mjs`) before they are used.
- **Combat panel colours and labels** pass through `safeColor` and `cleanText`; resource numbers are clamped to 0..999.
- **Plain text in chat** (the initiative summary) relies on the chat renderer escaping plain content. (not verified in a browser)

## Release

The workflow in `.github/workflows/release.yml` runs on a version tag such as `v1.2.3`. It builds the package and stamps the tag's version into the manifest. `tests/manifest.test.mjs` checks that `ruleset.json` has a semver `version` and that the entry point is `main.mjs`. Note: `ruleset.json` says `0.2.0` and `package.json` says `0.1.0` today; the two are not kept in step.
