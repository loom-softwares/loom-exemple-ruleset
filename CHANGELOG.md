# Changelog

All notable changes to this project are documented here.
Each release tag `vX.Y.Z` publishes the section headed `## [X.Y.Z]` as its release notes.

## [Unreleased]

## [0.2.0] - 2026-10-13

The demo system becomes an open sandbox: a place to test and learn how to build a system on Loom.
The GM defines the rules from inside the system instead of editing code.

### Added
- Rule editor (GM only; keybind Shift+R; a GM button on the actor sheet): attributes, skills, resources,
  item categories, ability kinds, the dice system, the chat card and combat initiative. Live
  validation, presets (classic d20 and d6 pool), reset, and JSON import/export.
- Two dice systems: a single d20 check (target number, critical and fumble) or a pool of d6 counted
  in successes. Advantage and disadvantage work in both modes.
- Configurable actor sheet for hero, villain and beast: attributes, skills, resources, items grouped
  by category, roll buttons, and a GM button that opens the rule editor.
- Configurable item sheet for gear, ability and spell items, with an optional roll and an optional
  resource cost. The four legacy types (weapon, armor, potion, scroll) use the same sheet.
- Chat card for the system's rolls, with the successes count, critical and fumble labels and an
  accent color, all set in the rule editor. Card text is escaped.
- Combat: initiative from the configured dice or attribute, a combat panel (Shift+B) that refreshes
  every 3 seconds for every player, with the turn marker, round, and resource bars, and per-combatant
  resource labels in the tracker.
- Translations for every visible string (English and Portuguese, Brazil).

### Changed
- Settings are registered from code: the world configuration is one setting, edited in the rule
  editor. The old "language" and "initiative attribute" manifest settings are removed.
- The manifest lists every stylesheet of the sandbox; the old hero sheet styles remain as-is.
- Language files are generated from i18n fragments with `npm run lang`.

### Removed
- The hero sheet, its template, the per-type default data files and the inline language bundles.
  The engine loads the manifest languages itself.

### Development
- Unit tests run with `npm test` and are required before the release zip is built.

