// Derived-data computation, in its own file — kept separate from the
// default-data files (hero.mjs/villain.mjs/beast.mjs) and from main.mjs.
// Same convention srd5e uses (scripts/prepare-data.mjs): small shared
// helpers + one dispatcher function per actor type — NOT one generic
// function branching on `type` internally. Even though hero/villain/beast
// use identical math today, structuring it this way means the day one of
// them needs its own rule (e.g. beasts don't roll Wits-based skills), only
// that one function changes — nothing else has to be touched or re-tested.

/**
 * Computes derived combat and utility bonuses from primary attributes.
 * @param {Record<string, number>} attrs - Primary attribute values (might, swift, wits).
 * @returns {{ attack: number, dodge: number, initiative: number, detect: number }} Calculated modifiers.
 */
function computeBonuses(attrs) {
  return {
    attack: Math.floor((attrs.might || 0) / 2),
    dodge: Math.floor((attrs.swift || 0) / 2),
    initiative: Math.floor((attrs.swift || 0) / 2),
    detect: Math.floor((attrs.wits || 0) / 2),
  };
}

/**
 * Derives common transient fields and attaches them to the actor document.
 * Reads from systemData/system if top-level fields are not present.
 * @param {Record<string, any>} actor - Raw actor document from the store.
 * @returns {Record<string, any>} Mutated actor document with derived properties attached.
 */
function baseDerive(actor) {
  const sd = actor.systemData || actor.system || {};
  const attrs = sd.attributes || actor.attributes || { might: 5, swift: 5, wits: 5 };
  const hp = sd.hp || actor.hp || { value: 20, max: 20 };
  const defense = sd.defense ?? actor.defense ?? 10;

  actor.attributes = attrs;
  actor.hp = hp;
  actor.defense = defense;
  actor._dots = { might: attrs.might || 0, swift: attrs.swift || 0, wits: attrs.wits || 0 };
  actor._bonus = computeBonuses(attrs);
  actor._maxHp = hp.max || 20;
  return actor;
}

/**
 * Derives stats specific to the 'hero' actor type.
 * @param {Record<string, any>} actor - Raw hero actor document.
 * @returns {Record<string, any>} Prepared hero data.
 */
export function prepareHero(actor) {
  return baseDerive(actor);
}

/**
 * Derives stats specific to the 'villain' actor type.
 * @param {Record<string, any>} actor - Raw villain actor document.
 * @returns {Record<string, any>} Prepared villain data.
 */
export function prepareVillain(actor) {
  return baseDerive(actor);
}

/**
 * Derives stats specific to the 'beast' actor type.
 * @param {Record<string, any>} actor - Raw beast actor document.
 * @returns {Record<string, any>} Prepared beast data.
 */
export function prepareBeast(actor) {
  return baseDerive(actor);
}

/**
 * Dispatcher registered as `prepareData` in main.mjs — called every time an
 * actor is rendered (sheet, token tooltip, combat tracker row).
 * Always returns a new object; never mutates `actor` in place.
 * @param {Record<string, any>} actor - Actor document to prepare.
 * @returns {Record<string, any>} Prepared actor copy with derived properties.
 */
export function prepareData(actor) {
  if (actor.type === 'hero') return prepareHero(actor);
  if (actor.type === 'villain') return prepareVillain(actor);
  if (actor.type === 'beast') return prepareBeast(actor);
  return baseDerive(actor);
}
