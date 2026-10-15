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
  const rawAttrs = sd.attributes || actor.attributes || { might: 5, swift: 5, wits: 5 };
  const rawHp = sd.hp || actor.hp || { value: 20, max: 20 };
  const baseDefense = Number(sd.defense ?? actor.defense ?? 10);

  // Aggregate bonuses from owned items (weapons, armor, accessories, scrolls)
  const items = Array.isArray(actor.items) ? actor.items : [];
  let itemDefenseBonus = 0;
  let itemAttackBonus = 0;
  let itemDamageBonus = 0;
  let itemHpBonus = 0;
  let itemMightBonus = 0;
  let itemSwiftBonus = 0;
  let itemWitsBonus = 0;

  for (const item of items) {
    const isd = item.systemData || item.data || {};
    if (isd.defenseBonus) itemDefenseBonus += Number(isd.defenseBonus) || 0;
    if (isd.attackBonus) itemAttackBonus += Number(isd.attackBonus) || 0;
    if (isd.damageBonus) itemDamageBonus += Number(isd.damageBonus) || 0;
    if (isd.hpBonus) itemHpBonus += Number(isd.hpBonus) || 0;
    if (isd.mightBonus) itemMightBonus += Number(isd.mightBonus) || 0;
    if (isd.swiftBonus) itemSwiftBonus += Number(isd.swiftBonus) || 0;
    if (isd.witsBonus) itemWitsBonus += Number(isd.witsBonus) || 0;
  }

  const effectiveAttrs = {
    might: Number(rawAttrs.might || 0) + itemMightBonus,
    swift: Number(rawAttrs.swift || 0) + itemSwiftBonus,
    wits: Number(rawAttrs.wits || 0) + itemWitsBonus,
  };

  const baseBonus = computeBonuses(effectiveAttrs);
  const totalBonus = {
    ...baseBonus,
    attack: baseBonus.attack + itemAttackBonus,
  };

  const effectiveMaxHp = Math.max(1, Number(rawHp.max || 20) + itemHpBonus);
  const effectiveHp = {
    value: Number(rawHp.value ?? effectiveMaxHp),
    max: effectiveMaxHp,
  };

  actor.rawAttributes = rawAttrs;
  actor.attributes = effectiveAttrs;
  actor.hp = effectiveHp;
  actor.defense = baseDefense + itemDefenseBonus;
  actor.baseDefense = baseDefense;
  actor._itemDefenseBonus = itemDefenseBonus;
  actor._itemAttackBonus = itemAttackBonus;
  actor._itemDamageBonus = itemDamageBonus;
  actor._itemHpBonus = itemHpBonus;
  actor._itemAttrsBonus = {
    might: itemMightBonus,
    swift: itemSwiftBonus,
    wits: itemWitsBonus,
  };
  actor._dots = { might: effectiveAttrs.might || 0, swift: effectiveAttrs.swift || 0, wits: effectiveAttrs.wits || 0 };
  actor._bonus = totalBonus;
  actor._maxHp = effectiveMaxHp;
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
