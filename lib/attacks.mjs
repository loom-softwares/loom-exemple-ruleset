import { attributeRollValue, validateConfig } from './config.mjs';
import { buildCheck, DICE_LIMITS } from './dice.mjs';
import { sumSources } from './check-sources.mjs';

const integer = (value, fallback = 0) => Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback;
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export function attackTotal(cfg, profile, actorData = {}, item = {}) {
  const c = validateConfig(cfg).config;
  const data = item?.data ?? item ?? {};
  const attack = data.attack ?? {};
  const sources = Array.isArray(attack.sources) && attack.sources.length ? attack.sources : profile.sources;
  const base = sumSources(sources, actorData, c, (key, score) => attributeRollValue(c, key, score));
  return clamp(base + integer(profile.bonus) + integer(attack.bonus), -DICE_LIMITS.maxModifier, DICE_LIMITS.maxModifier);
}

export function buildAttackRoll(cfg, profile, actorData = {}, item = {}) {
  const c = validateConfig(cfg).config;
  const data = item?.data ?? item ?? {};
  const attack = data.attack ?? {};
  const total = attackTotal(c, profile, actorData, item);
  const mode = ['system', 'd20', 'pool'].includes(profile.mode) ? profile.mode : 'system';
  const rollCfg = mode === 'system' ? c : {
    ...c,
    dice: {
      ...c.dice,
      mode,
      pool: { ...c.dice.pool, faces: integer(profile.faces, c.dice.pool.faces), successMin: integer(profile.successMin, c.dice.pool.successMin) },
    },
  };
  const check = buildCheck(rollCfg, { attrValue: total, skillValue: 0, bonus: 0 });
  const damageSources = Array.isArray(attack.damageSources) && attack.damageSources.length ? attack.damageSources : profile.damage?.sources;
  const damageFromSources = sumSources(damageSources, actorData, c, (key, score) => attributeRollValue(c, key, score));
  const damage = { ...profile.damage, base: integer(profile.damage?.base) + damageFromSources + integer(attack.damageBonus) };
  return {
    formula: check.formula,
    meta: {
      ...check.meta,
      kind: 'check',
      attack: { method: damage.method, base: clamp(damage.base, -999, 999), count: clamp(integer(damage.count, 1), 1, 100), faces: clamp(integer(damage.faces, 6), 2, 100), successMin: clamp(integer(damage.successMin, 5), 2, 100), critPairs: damage.critPairs === true, critFace: clamp(integer(damage.critFace, 10), 2, 100), target: (attack.defense ?? profile.target) !== null && (attack.defense ?? profile.target) !== undefined && Number.isFinite(Number(attack.defense ?? profile.target)) ? clamp(integer(attack.defense ?? profile.target), 0, 999) : null, label: String(profile.label ?? 'Attack').slice(0, 40) },
    },
  };
}

/** Calculates display-only damage from the actual server roll. It never writes HP or actor data. */
export function resolveAttackDamage(roll, interpreted) {
  const meta = roll?.meta?.attack;
  if (!meta || !['none', 'fixed', 'dice', 'successes', 'margin', 'pool'].includes(meta.method)) return null;
  const total = integer(roll.total);
  const poolView = interpreted?.mode === 'pool';
  let successes = poolView ? integer(interpreted.successes, total) : 0;
  if (meta.critPairs && poolView && Array.isArray(roll.terms)) {
    let criticalFaces = 0;
    for (const term of roll.terms) {
      if (term?.kind !== 'dice' || !Array.isArray(term.rolls)) continue;
      const dropped = new Set(Array.isArray(term.dropped) ? term.dropped : []);
      term.rolls.forEach((face, index) => { if (term.dropped?.[index] !== true && !dropped.has(index) && integer(face) >= meta.critFace) criticalFaces++; });
    }
    successes += Math.floor(criticalFaces / 2) * 2;
  }
  const defense = meta.target !== null && meta.target !== undefined && Number.isFinite(Number(meta.target)) ? integer(meta.target) : null;
  const hit = defense === null ? null : poolView ? successes >= defense : total >= defense;
  const margin = defense === null ? null : poolView ? Math.max(0, successes - defense) : Math.max(0, total - defense);
  const base = integer(meta.base);
  if (meta.method === 'none') return { hit, defense, successes, total, damage: null };
  if (meta.method === 'fixed') return { hit, defense, successes, total, damage: hit === false ? 0 : hit === true ? Math.max(0, base) : null };
  if (meta.method === 'successes') return { hit, defense, successes, total, damage: hit === false || hit === null ? null : Math.max(0, base + successes) };
  if (meta.method === 'margin') return { hit, defense, successes, total, damage: hit === false || hit === null ? null : Math.max(0, base + margin) };
  return { hit, defense, successes, total, damage: null };
}
