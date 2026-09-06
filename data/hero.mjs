// Default systemData for a new "hero" actor. One file per actor type (same
// convention wod5e uses: many small imported modules instead of one big
// switch) — main.mjs just imports and dispatches by type.
export const heroDefaults = {
  attributes: { might: 5, swift: 5, wits: 5 },
  hp: { value: 20, max: 20 },
  defense: 10,
};
