// Default systemData for a new "villain" actor — see data/hero.mjs for why
// this is its own file instead of a branch in a shared function.
export const villainDefaults = {
  attributes: { might: 7, swift: 3, wits: 4 },
  hp: { value: 15, max: 15 },
  defense: 8,
};
