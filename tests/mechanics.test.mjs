import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, validateConfig, defaultActorData } from '../lib/config.mjs';
import { sumSources } from '../lib/check-sources.mjs';
import { buildAttackRoll, resolveAttackDamage } from '../lib/attacks.mjs';
import { interpret } from '../lib/dice.mjs';
import { planCast, planPrepare, planRecovery } from '../lib/casting.mjs';

function configured() {
  const cfg = defaultConfig();
  cfg.attributes = [
    { key: 'might', label: 'Might', min: 0, max: 20, default: 14, useD20Modifier: true, group: '' },
    { key: 'agility', label: 'Agility', min: 0, max: 20, default: 12, useD20Modifier: false, group: '' },
  ];
  cfg.skills = [{ key: 'melee', label: 'Melee', attr: 'might', max: 10, default: 3, group: '' }];
  cfg.saves = { enabled: true, entries: [{ key: 'fortitude', label: 'Fortitude', sources: [{ kind: 'attr', key: 'might', value: 'configured' }, { kind: 'skill', key: 'melee', value: 'rank' }], bonus: 2, target: null, showOnSheet: true }] };
  cfg.attacks = { enabled: true, profiles: [{ key: 'sword', label: 'Sword', sources: [{ kind: 'attr', key: 'might', value: 'modifier' }, { kind: 'skill', key: 'melee', value: 'rank' }], bonus: 1, target: null, mode: 'd20', damage: { method: 'margin', base: 3, count: 1, faces: 8, successMin: 5 } }] };
  cfg.magic = { enabled: true, defaultMethod: 'resource', methods: ['free', 'resource', 'spontaneous', 'prepared', 'uses', 'check'], levels: [{ key: 'circle1', label: 'Circle 1', rank: 1, capacityDefault: 2, free: false }], recovery: 'manual', checkProfiles: [] };
  return validateConfig(cfg).config;
}

test('configured sources add chosen values exactly once and honor the d20 modifier checkbox', () => {
  const cfg = configured();
  const actor = { attrs: { might: 14, agility: 12 }, skills: { melee: 3 } };
  assert.equal(sumSources(cfg.saves.entries[0].sources, actor, cfg, (key, score) => Math.floor((score - 10) / 2)) + 2, 7);
  assert.equal(sumSources([{ kind: 'attr', key: 'agility', value: 'configured' }], actor, cfg, () => -99), 12);
});

test('removed source references stay visible as removed and never contribute to totals', () => {
  const cfg = configured();
  const sources = [{ kind: 'attr', key: 'deleted-stat', value: 'modifier' }];
  const clean = validateConfig({ ...cfg, saves: { ...cfg.saves, entries: [{ ...cfg.saves.entries[0], sources }] } }).config;
  assert.deepEqual(clean.saves.entries[0].sources, [{ kind: 'attr', key: 'deleted-stat', value: 'modifier', removed: true }]);
  assert.equal(sumSources(clean.saves.entries[0].sources, { attrs: { 'deleted-stat': 20 } }, clean), 0);
});

test('attack snapshots separate defense and result damage, and do not invent a defense when absent', () => {
  const cfg = configured();
  const profile = cfg.attacks.profiles[0];
  const actor = { attrs: { might: 14 }, skills: { melee: 3 } };
  const built = buildAttackRoll(cfg, profile, actor);
  assert.equal(built.formula, '1d20+6');
  assert.equal(built.meta.attack.target, null);
  const roll = { total: 17, meta: { mode: 'd20', attack: { method: 'margin', base: 3, target: 15 } }, terms: [{ kind: 'dice', rolls: [11], dropped: [false] }] };
  assert.deepEqual(resolveAttackDamage(roll, interpret(cfg, roll)), { hit: true, defense: 15, successes: 0, total: 17, damage: 5 });
  assert.equal(resolveAttackDamage({ ...roll, meta: { ...roll.meta, attack: { method: 'margin', base: 3, target: null } } }, interpret(cfg, roll)).damage, null);
});

test('attack damage can use its own configured sources and pool threshold', () => {
  const cfg = configured();
  cfg.attacks.profiles[0].mode = 'pool'; cfg.attacks.profiles[0].faces = 10;
  cfg.attacks.profiles[0].successMin = 7;
  cfg.attacks.profiles[0].damage = { method: 'fixed', base: 2, sources: [{ kind: 'attr', key: 'might', value: 'modifier' }], count: 1, faces: 8, successMin: 5 };
  const clean = validateConfig(cfg).config;
  const built = buildAttackRoll(clean, clean.attacks.profiles[0], { attrs: { might: 14 }, skills: { melee: 3 } });
  assert.equal(built.meta.successMin, 7);
  assert.equal(built.meta.attack.base, 4);
  assert.equal(built.formula, '6d10cs>=7');
});

test('fixed damage waits for a known hit and becomes zero on a known miss', () => {
  const unresolved = { total: 14, meta: { attack: { method: 'fixed', base: 4, target: null } } };
  assert.equal(resolveAttackDamage(unresolved, { mode: 'd20', total: 14 }).damage, null);
  const miss = { ...unresolved, meta: { attack: { method: 'fixed', base: 4, target: 15 } } };
  assert.equal(resolveAttackDamage(miss, { mode: 'd20', total: 14 }).damage, 0);
});

test('paired critical pool faces add two effective successes per pair and ignore dropped dice', () => {
  const cfg = configured(); cfg.dice.mode = 'pool'; cfg.dice.pool.faces = 10; cfg.dice.pool.successMin = 6;
  const roll = { total: 2, meta: { mode: 'pool', attack: { method: 'successes', base: 1, target: 2, critPairs: true, critFace: 10 } }, terms: [{ kind: 'dice', rolls: [10, 10, 10, 4, 10], dropped: [false, false, false, false, true] }] };
  const result = resolveAttackDamage(roll, interpret(cfg, roll));
  assert.equal(result.successes, 5); // three ordinary hits plus one pair of critical faces
  assert.equal(result.damage, 6);
});

test('spontaneous, prepared, free, resource, uses, and recovery planners only alter the intended counters', () => {
  const cfg = configured();
  const base = defaultActorData(cfg);
  base.res.mp = { value: 4, max: 4 };
  const spell = { id: 'spell-a', data: { casting: { method: 'resource', resourceKey: 'mp', cost: 2 } } };
  const resource = planCast(spell, base, cfg);
  assert.equal(resource.patch.res.mp.value, 2);
  assert.equal(resource.patch.magic.slots.circle1.value, 2);
  const freeOverride = planCast({ id: 'spell-free', data: { casting: { method: 'resource', resourceKey: 'mp', cost: 0 }, cost: { res: 'mp', amount: 3 } } }, base, cfg);
  assert.equal(freeOverride.patch.res.mp.value, 4, 'an explicit configured zero cost overrides legacy item cost');
  const spontaneous = planCast({ id: 'spell-a', data: { casting: { method: 'spontaneous', levelKey: 'circle1' } } }, { ...base, magic: { ...base.magic, slots: { circle1: { value: 1, max: 2 } } } }, cfg);
  assert.equal(spontaneous.patch.magic.slots.circle1.value, 0);
  const preparedItem = { id: 'spell-a', data: { casting: { levelKey: 'circle1' } } };
  const prepared = planPrepare(preparedItem, { ...base, magic: { ...base.magic, slots: { circle1: { value: 0, max: 2 } } } }, cfg, 1, 'circle1');
  assert.equal(prepared.patch.magic.prepared['spell-a'].value, 1);
  assert.equal(planCast({ ...preparedItem, data: { casting: { method: 'prepared', levelKey: 'circle1' } } }, { ...base, ...prepared.patch }, cfg).patch.magic.prepared['spell-a'].value, 0);
  assert.equal(planCast({ id: 's', data: { casting: { method: 'free' } } }, base, cfg).ok, true);
  assert.equal(planCast({ id: 's', data: { casting: { method: 'uses', usesMax: 2 } } }, base, cfg).patch.magic.uses.s.value, 1);
  assert.equal(planRecovery({ ...base, magic: { slots: { circle1: { value: 0, max: 2 } }, prepared: {}, uses: {} } }, cfg, 'manual').patch.magic.slots.circle1.value, 2);
});

test('spontaneous casting can upcast to a higher selected slot and refuses a lower one', () => {
  const cfg = configured();
  cfg.magic.levels.push({ key: 'circle0', label: 'Circle 0', rank: 0, capacityDefault: 1, free: false });
  cfg.magic.levels.push({ key: 'circle2', label: 'Circle 2', rank: 2, capacityDefault: 1, free: false });
  const actor = defaultActorData(cfg);
  const spell = { id: 'upcast', data: { casting: { method: 'spontaneous', levelKey: 'circle1' } } };
  actor.magic.slots.circle1.value = 2;
  actor.magic.slots.circle2.value = 1;
  assert.equal(planCast(spell, actor, cfg, 'circle2').patch.magic.slots.circle2.value, 0);
  assert.equal(planCast(spell, actor, cfg, 'circle0').reason, 'level-too-low');
  assert.equal(planCast(spell, actor, cfg).patch.magic.slots.circle1.value, 1);
});
