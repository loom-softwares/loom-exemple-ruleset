// Default systemData for a new "beast" actor — see data/hero.mjs for why
// this is its own file instead of a branch in a shared function.
export const beastDefaults = {
  attributes: { might: 8, swift: 6, wits: 1 },
  hp: { value: 25, max: 25 },
  defense: 12,
};
