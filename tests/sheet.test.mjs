import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSheetContext,
  renderSheet,
  applyChange,
  applyItemChange,
  buildPatch,
  mergePatch,
  isEmptyPatch,
  resolveWriteTarget,
  planUse,
  resourceState,
  changeFromField,
  safeImageUrl,
  ACTOR_TYPES,
} from '../sheets/sandbox-sheet.mjs';
import { defaultConfig } from '../lib/config.mjs';

const HOSTILE = '<img src=x onerror=alert(1)>';

function cfgWith(mutate) {
  const cfg = defaultConfig();
  mutate(cfg);
  return cfg;
}

describe('buildSheetContext', () => {
  test('no actor gives the empty state', () => {
    const ctx = buildSheetContext(null, undefined, defaultConfig());
    assert.equal(ctx.empty, true);
    assert.match(renderSheet(ctx), /ldm-sheet--empty/);
  });

  test('missing systemData and items fall back to the config defaults', () => {
    const cfg = defaultConfig();
    const ctx = buildSheetContext({ id: 'a1', name: 'Bare', type: 'hero' }, undefined, cfg);
    const might = ctx.attributes.find((a) => a.key === 'might');
    assert.equal(might.value, 2, 'attribute default from config');
    const hp = ctx.resources.find((r) => r.key === 'hp');
    assert.equal(hp.value, 20, 'a missing resource entry starts full');
    assert.equal(hp.max, 20);
    assert.equal(ctx.notes, '');
    assert.equal(ctx.itemGroups.every((g) => g.count === 0), true);
    assert.equal(ctx.skillGroups.length, 3, 'one group per attribute that has skills');
  });

  test('an unknown actor type falls back to the generic label and bad config is sanitized', () => {
    const ctx = buildSheetContext({ id: 'a2', name: 'X', type: 'dragon', systemData: null }, [], { dice: 'nope' });
    assert.equal(ctx.empty, false);
    assert.equal(ctx.labels['sandbox.sheet.typeOther'], ctx.typeLabel);
    assert.equal(ctx.dice.mode, 'd20');
  });

  test('items are grouped by type, then by category, and unknown categories are kept', () => {
    const items = [
      { id: 'i1', name: 'Sword', type: 'weapon', data: { category: 'weapon', quantity: 2 } },
      { id: 'i2', name: 'Fireball', type: 'spell', data: { category: 'misc', cost: { res: 'mp', amount: 3 } } },
      { id: 'i3', name: 'Ghost', type: 'ability', data: { category: 'legacy_cat', roll: { enabled: true } } },
      null,
      'not-an-item',
    ];
    const ctx = buildSheetContext({ id: 'a3', name: 'Mix', type: 'villain', systemData: {} }, items, defaultConfig());
    const gear = ctx.itemGroups.find((g) => g.type === 'gear');
    const spell = ctx.itemGroups.find((g) => g.type === 'spell');
    const ability = ctx.itemGroups.find((g) => g.type === 'ability');
    assert.equal(gear.count, 1);
    assert.equal(spell.count, 1);
    assert.equal(ability.count, 1);
    assert.equal(gear.categories[0].label, 'Weapon');
    assert.equal(ability.categories[0].key, 'legacy_cat', 'unknown category kept as its raw key');
    assert.equal(spell.categories[0].items[0].costLabel, 'Cost 3 Mana');
    assert.equal(ability.categories[0].items[0].canRoll, true);
  });

  test('advantage and roll mode are normalized', () => {
    const ctx = buildSheetContext({ id: 'a4', name: 'n', type: 'hero', systemData: {} }, [], defaultConfig(), { advantage: 'bogus' });
    assert.equal(ctx.advantage, 'none');
    const adv = buildSheetContext({ id: 'a4', name: 'n', type: 'hero', systemData: {} }, [], defaultConfig(), { advantage: 'dis' });
    assert.equal(adv.advantage, 'dis');
  });

  test('ACTOR_TYPES lists hero, villain and beast', () => {
    assert.deepEqual([...ACTOR_TYPES], ['hero', 'villain', 'beast']);
  });
});

describe('removed config entries do not delete data', () => {
  test('a stored attribute that the config no longer lists survives a change', () => {
    const cfg = defaultConfig();
    const sys = { attrs: { might: 3, gone: 7 }, skills: { melee: 2, ghost: 5 }, res: {}, notes: '' };
    const next = applyChange(sys, cfg, { kind: 'attr', key: 'might', value: 4 });
    assert.equal(next.attrs.gone, 7, 'removed attribute keeps its stored value');
    assert.equal(next.attrs.might, 4);
    assert.equal(next.skills.ghost, 5, 'removed skill keeps its stored value');
    assert.equal(sys.attrs.might, 3, 'the input object is not mutated');
  });

  test('removed attribute is not shown in the context', () => {
    const sys = { attrs: { gone: 7 } };
    const ctx = buildSheetContext({ id: 'a5', name: 'n', type: 'hero', systemData: sys }, [], defaultConfig());
    assert.equal(ctx.attributes.some((a) => a.key === 'gone'), false);
  });
});

describe('escaping of hostile text', () => {
  test('hostile labels, names, notes and item text never reach the HTML raw', () => {
    const cfg = cfgWith((c) => {
      c.attributes[0].label = HOSTILE;
      c.resources[0].label = '"><script>alert(2)</script>';
      c.resources[0].color = 'red;"><b>x</b>';
      c.itemCategories[0].label = HOSTILE;
    });
    const items = [{ id: 'i9', name: '"><script>alert(3)</script>', type: 'gear', data: { category: 'weapon', description: HOSTILE, quantity: 1 } }];
    const actor = { id: 'a6', name: HOSTILE, type: 'beast', avatarUrl: 'javascript:alert(4)', systemData: { notes: '</textarea><img src=x onerror=alert(5)>' } };
    const html = renderSheet(buildSheetContext(actor, items, cfg, { isGM: true, editable: true }));
    assert.doesNotMatch(html, /<img\b/i);
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /<b>x/i);
    assert.doesNotMatch(html, /javascript:/i, 'javascript: avatar is dropped');
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(html, /&lt;\/textarea&gt;/);
  });

  test('a hostile resource colour falls back to the default', () => {
    const cfg = cfgWith((c) => {
      c.resources[0].color = 'url(javascript:x)';
    });
    const state = resourceState({}, cfg, 'hp');
    assert.match(state.color, /^#[0-9a-fA-F]{6}$/, 'colour is always a valid hex value');
  });
});

describe('resource clamping', () => {
  const cfg = defaultConfig();

  test('values above the max are clamped to the max', () => {
    const next = applyChange({ res: {} }, cfg, { kind: 'res', key: 'hp', value: 999 });
    assert.equal(next.res.hp.value, 20);
  });

  test('negative values are clamped to 0', () => {
    const next = applyChange({ res: {} }, cfg, { kind: 'res', key: 'hp', value: -5 });
    assert.equal(next.res.hp.value, 0);
  });

  test('a relative delta stops at 0 and at the max', () => {
    const low = applyChange({ res: { hp: { value: 0, max: null } } }, cfg, { kind: 'res', key: 'hp', delta: -1 });
    assert.equal(low.res.hp.value, 0);
    const high = applyChange({ res: { hp: { value: 20, max: null } } }, cfg, { kind: 'res', key: 'hp', delta: 1 });
    assert.equal(high.res.hp.value, 20);
  });

  test('a value that is not a number changes nothing', () => {
    const sys = { res: { hp: { value: 9, max: null } } };
    const next = applyChange(sys, cfg, { kind: 'res', key: 'hp', value: 'abc' });
    assert.equal(next.res.hp.value, 9);
    const nan = applyChange(sys, cfg, { kind: 'res', key: 'hp', value: Number.NaN });
    assert.equal(nan.res.hp.value, 9);
  });

  test('a stored max override is used and kept', () => {
    const sys = { res: { hp: { value: 5, max: 30 } } };
    const state = resourceState(sys, cfg, 'hp');
    assert.equal(state.max, 30);
    const next = applyChange(sys, cfg, { kind: 'res', key: 'hp', value: 99 });
    assert.deepEqual(next.res.hp, { value: 30, max: 30 });
  });

  test('a corrupt stored value counts as 0', () => {
    const state = resourceState({ res: { hp: { value: { x: 1 }, max: null } } }, cfg, 'hp');
    assert.equal(state.value, 0);
  });

  test('a resource the config no longer lists is ignored', () => {
    assert.equal(resourceState({}, cfg, 'nope'), null);
    const next = applyChange({ res: {} }, cfg, { kind: 'res', key: 'nope', value: 3 });
    assert.deepEqual(next.res, {});
  });
});

describe('attribute and skill clamping', () => {
  const cfg = defaultConfig();
  test('attributes stay inside min..max', () => {
    assert.equal(applyChange({}, cfg, { kind: 'attr', key: 'might', value: 99 }).attrs.might, 10);
    assert.equal(applyChange({}, cfg, { kind: 'attr', key: 'might', value: -3 }).attrs.might, 0);
  });
  test('skills stay inside 0..max', () => {
    assert.equal(applyChange({}, cfg, { kind: 'skill', key: 'melee', value: 50 }).skills.melee, 10);
    assert.equal(applyChange({}, cfg, { kind: 'skill', key: 'melee', value: -1 }).skills.melee, 0);
  });
  test('an unknown attribute key is ignored', () => {
    const next = applyChange({ attrs: {} }, cfg, { kind: 'attr', key: 'unknown', value: 3 });
    assert.deepEqual(next.attrs, {});
  });
});

describe('planUse (cost and uses)', () => {
  const cfg = defaultConfig();
  const sys = (mp, extra = {}) => ({ res: { mp: { value: mp, max: null } }, ...extra });

  test('insufficient resource is refused and nothing is planned', () => {
    const item = { data: { cost: { res: 'mp', amount: 4 } } };
    const plan = planUse(item, sys(3), cfg);
    assert.equal(plan.ok, false);
    assert.equal(plan.error, 'insufficient-resource');
    assert.equal(plan.patch, null);
  });

  test('uses at 0 is refused', () => {
    const item = { data: { uses: { value: 0, max: 3 } } };
    const plan = planUse(item, sys(5), cfg);
    assert.equal(plan.ok, false);
    assert.equal(plan.error, 'no-uses');
  });

  test('a negative cost is refused instead of refilling the resource', () => {
    const plan = planUse({ data: { cost: { res: 'mp', amount: -2 } } }, sys(1), cfg);
    assert.equal(plan.ok, false);
    assert.equal(plan.error, 'negative-cost');
  });

  test('NaN cost is refused', () => {
    assert.equal(planUse({ data: { cost: { res: 'mp', amount: Number.NaN } } }, sys(5), cfg).error, 'invalid-cost');
    assert.equal(planUse({ data: { cost: { res: 'mp', amount: 'lots' } } }, sys(5), cfg).error, 'invalid-cost');
  });

  test('fractional cost is refused', () => {
    assert.equal(planUse({ data: { cost: { res: 'mp', amount: 1.5 } } }, sys(5), cfg).error, 'invalid-cost');
  });

  test('a resource the config no longer has is refused', () => {
    assert.equal(planUse({ data: { cost: { res: 'stamina', amount: 1 } } }, sys(5), cfg).error, 'unknown-resource');
  });

  test('a uses object without a numeric value is refused', () => {
    assert.equal(planUse({ data: { uses: { max: 3 } } }, sys(5), cfg).error, 'invalid-uses');
  });

  test('a valid cost and uses produce the patch', () => {
    const item = { data: { cost: { res: 'mp', amount: 3 }, uses: { value: 2, max: 2 } } };
    const plan = planUse(item, sys(5), cfg);
    assert.equal(plan.ok, true);
    assert.equal(plan.error, null);
    assert.deepEqual(plan.patch.res, { mp: { value: 2, max: null } });
    assert.deepEqual(plan.patch.uses, { value: 1, max: 2 });
  });

  test('a cost of exactly the current amount empties the resource and does not go negative', () => {
    const plan = planUse({ data: { cost: { res: 'mp', amount: 5 } } }, sys(5), cfg);
    assert.equal(plan.ok, true);
    assert.equal(plan.patch.res.mp.value, 0);
  });

  test('a zero cost and no uses change nothing', () => {
    const plan = planUse({ data: { cost: { res: 'mp', amount: 0 } } }, sys(5), cfg);
    assert.deepEqual(plan, { ok: true, patch: { res: null, uses: null }, error: null });
  });

  test('an item with no cost and no uses is always usable', () => {
    const plan = planUse({ data: {} }, sys(0), cfg);
    assert.equal(plan.ok, true);
  });
});

describe('applyItemChange', () => {
  const cfg = defaultConfig();
  test('quantity is clamped to 0..9999 and an integer', () => {
    assert.equal(applyItemChange({}, cfg, { kind: 'item-qty', value: -4 }).quantity, 0);
    assert.equal(applyItemChange({}, cfg, { kind: 'item-qty', value: 2.9 }).quantity, 2);
    assert.equal(applyItemChange({}, cfg, { kind: 'item-qty', value: 99999 }).quantity, 9999);
  });
  test('uses are clamped to the uses max, and no uses object is created', () => {
    const data = applyItemChange({ uses: { value: 1, max: 3 } }, cfg, { kind: 'item-uses', value: 9 });
    assert.deepEqual(data.uses, { value: 3, max: 3 });
    const none = applyItemChange({}, cfg, { kind: 'item-uses', value: 2 });
    assert.equal(none.uses, undefined);
  });
  test('a NaN value changes nothing', () => {
    assert.deepEqual(applyItemChange({ quantity: 4 }, cfg, { kind: 'item-qty', value: 'x' }), { quantity: 4 });
  });
});

describe('changeFromField and safeImageUrl', () => {
  test('maps sheet fields to changes', () => {
    assert.deepEqual(changeFromField({ field: 'attr', key: 'might' }, '4'), { kind: 'attr', key: 'might', value: '4' });
    assert.deepEqual(changeFromField({ field: 'item-qty', id: 'i1' }, '2'), { kind: 'item-qty', itemId: 'i1', value: '2' });
    assert.equal(changeFromField({ field: 'item-qty' }, '2'), null, 'no item id, no change');
    assert.equal(changeFromField({ field: 'unknown' }, '2'), null);
  });

  test('only safe image sources are kept', () => {
    assert.equal(safeImageUrl('javascript:alert(1)'), '');
    assert.equal(safeImageUrl('data:text/html;base64,PGI+'), '');
    assert.equal(safeImageUrl('https://example.com/a.png'), 'https://example.com/a.png');
    assert.equal(safeImageUrl('/marketplace/x.png'), '/marketplace/x.png');
    assert.equal(safeImageUrl('//evil.example/x.png'), '');
    assert.equal(safeImageUrl(undefined), '');
  });
});

describe('renderSheet controls', () => {
  test('the configure button is only shown to the GM', () => {
    const cfg = defaultConfig();
    const actor = { id: 'a7', name: 'N', type: 'hero', systemData: {} };
    assert.match(renderSheet(buildSheetContext(actor, [], cfg, { isGM: true })), /data-action="configure"/);
    assert.doesNotMatch(renderSheet(buildSheetContext(actor, [], cfg, { isGM: false })), /data-action="configure"/);
  });

  test('read-only sheets disable write controls but keep rolls', () => {
    const cfg = defaultConfig();
    const actor = { id: 'a8', name: 'N', type: 'hero', systemData: {} };
    const html = renderSheet(buildSheetContext(actor, [], cfg, { editable: false }));
    assert.match(html, /ldm-sheet--readonly/);
    assert.match(html, /data-action="attr-roll"/);
    assert.doesNotMatch(html, /data-action="res-delta"[^>]*>(?![\s\S]*disabled)/);
    assert.match(html, /data-action="res-delta"[^>]*disabled/);
  });

  test('resource bars never exceed 100 percent or go below 0', () => {
    const cfg = defaultConfig();
    const actor = { id: 'a9', name: 'N', type: 'hero', systemData: { res: { hp: { value: 500, max: null } } } };
    const html = renderSheet(buildSheetContext(actor, [], cfg));
    assert.match(html, /width:100%/);
    assert.doesNotMatch(html, /width:-/);
  });

  test('item rows expose use only when they can roll, cost or spend uses', () => {
    const cfg = defaultConfig();
    const actor = { id: 'b1', name: 'N', type: 'hero', systemData: {} };
    const plain = renderSheet(buildSheetContext(actor, [{ id: 'g1', name: 'Rope', type: 'gear', data: {} }], cfg));
    assert.doesNotMatch(plain, /data-action="use-item"/);
    const usable = renderSheet(buildSheetContext(actor, [{ id: 'g2', name: 'Bolt', type: 'ability', data: { roll: { enabled: true } } }], cfg));
    assert.match(usable, /data-action="use-item" data-id="g2"/);
  });
});

// ══════════════════════════════════════════════════════════════
// Partial systemData patches (BUG 1: effect-applied values must never be written back)
// ══════════════════════════════════════════════════════════════

/** Every key path of a plain object, for "minimal patch" assertions. */
function leafPaths(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) out.push(...leafPaths(v, p));
    else out.push(p);
  }
  return out;
}

describe('buildPatch sends only the changed path', () => {
  const cfg = defaultConfig();

  test('an attribute patch is a single nested key', () => {
    const built = buildPatch({ attrs: { might: 1, wit: 5 } }, cfg, { kind: 'attr', key: 'might', value: 3 });
    assert.deepEqual(built, { systemData: { attrs: { might: 3 } } });
  });

  test('a skill patch is a single nested key', () => {
    assert.deepEqual(
      buildPatch({}, cfg, { kind: 'skill', key: 'melee', value: 4 }),
      { systemData: { skills: { melee: 4 } } },
    );
  });

  test('a notes patch is a single top-level key', () => {
    assert.deepEqual(buildPatch({}, cfg, { kind: 'notes', value: 'hello' }), { systemData: { notes: 'hello' } });
  });

  test('a resource value patch carries value and never max', () => {
    const built = buildPatch({ res: { hp: { value: 9, max: 30 } } }, cfg, { kind: 'res', key: 'hp', value: 7 });
    assert.deepEqual(built, { systemData: { res: { hp: { value: 7 } } } });
    assert.equal(Object.hasOwn(built.systemData.res.hp, 'max'), false);
  });

  test('a relative resource delta is computed from the view and sent as a value', () => {
    const built = buildPatch({ res: { hp: { value: 4, max: null } } }, cfg, { kind: 'res', key: 'hp', delta: -1 });
    assert.deepEqual(built, { systemData: { res: { hp: { value: 3 } } } });
  });

  test('an unrelated actor field never appears in the patch', () => {
    const sys = { attrs: { might: 1 }, res: { hp: { value: 2, max: null } }, notes: 'x' };
    const built = buildPatch(sys, cfg, { kind: 'attr', key: 'might', value: 2 });
    assert.deepEqual(leafPaths(built.systemData), ['attrs.might']);
  });
});

describe('buildPatch refuses invalid input (NaN ignored)', () => {
  const cfg = defaultConfig();

  test('NaN, empty and non-numeric values produce no patch', () => {
    assert.equal(buildPatch({}, cfg, { kind: 'attr', key: 'might', value: Number.NaN }), null);
    assert.equal(buildPatch({}, cfg, { kind: 'attr', key: 'might', value: '' }), null);
    assert.equal(buildPatch({}, cfg, { kind: 'res', key: 'hp', value: 'abc' }), null);
    assert.equal(buildPatch({}, cfg, { kind: 'res', key: 'hp', delta: Number.POSITIVE_INFINITY }), null);
  });

  test('unknown keys, unknown kinds and missing changes produce no patch', () => {
    assert.equal(buildPatch({}, cfg, { kind: 'attr', key: 'nope', value: 3 }), null);
    assert.equal(buildPatch({}, cfg, { kind: 'res', key: 'nope', value: 3 }), null);
    assert.equal(buildPatch({}, cfg, { kind: 'magic', key: 'x', value: 3 }), null);
    assert.equal(buildPatch({}, cfg, null), null);
  });

  test('applyChange keeps its old meaning for invalid input', () => {
    const sys = { attrs: { might: 3 } };
    assert.deepEqual(applyChange(sys, cfg, { kind: 'attr', key: 'might', value: Number.NaN }), sys);
  });
});

describe('buildPatch clamps to the configured limits', () => {
  const cfg = defaultConfig();

  test('attribute and skill values are clamped in the patch', () => {
    assert.deepEqual(buildPatch({}, cfg, { kind: 'attr', key: 'might', value: 99 }).systemData, { attrs: { might: 10 } });
    assert.deepEqual(buildPatch({}, cfg, { kind: 'attr', key: 'might', value: -3 }).systemData, { attrs: { might: 0 } });
    assert.deepEqual(buildPatch({}, cfg, { kind: 'skill', key: 'melee', value: 50 }).systemData, { skills: { melee: 10 } });
  });

  test('a resource value is clamped to the stored max when there is one', () => {
    const sys = { res: { hp: { value: 5, max: 30 } } };
    assert.deepEqual(buildPatch(sys, cfg, { kind: 'res', key: 'hp', value: 99 }).systemData, { res: { hp: { value: 30 } } });
    assert.deepEqual(buildPatch(sys, cfg, { kind: 'res', key: 'hp', value: -9 }).systemData, { res: { hp: { value: 0 } } });
  });
});

describe('mergePatch (deep merge, same rule as the server)', () => {
  const cfg = defaultConfig();

  test('two pending patches on different paths become one object', () => {
    const view = { attrs: { might: 2 }, res: { hp: { value: 20, max: null } } };
    let pending = {};
    pending = mergePatch(pending, buildPatch(view, cfg, { kind: 'attr', key: 'might', value: 3 }).systemData);
    pending = mergePatch(pending, buildPatch(view, cfg, { kind: 'res', key: 'hp', value: 7 }).systemData);
    pending = mergePatch(pending, buildPatch(view, cfg, { kind: 'res', key: 'mp', value: 2 }).systemData);
    assert.deepEqual(pending, { attrs: { might: 3 }, res: { hp: { value: 7 }, mp: { value: 2 } } });
  });

  test('a later value on the same path replaces the earlier one and keeps siblings', () => {
    const first = { res: { hp: { value: 7 }, mp: { value: 2 } } };
    const merged = mergePatch(first, { res: { hp: { value: 9 } } });
    assert.deepEqual(merged, { res: { hp: { value: 9 }, mp: { value: 2 } } });
  });

  test('two relative deltas queued before a flush both apply', () => {
    const sys = { res: { hp: { value: 10, max: null } } };
    let pending = {};
    for (let i = 0; i < 2; i += 1) {
      const view = mergePatch(sys, pending);
      pending = mergePatch(pending, buildPatch(view, cfg, { kind: 'res', key: 'hp', delta: 1 }).systemData);
    }
    assert.deepEqual(pending, { res: { hp: { value: 12 } } });
  });

  test('arrays replace and nothing mutates its inputs', () => {
    const base = { list: [1, 2, 3], nested: { a: 1 } };
    const patch = { list: [9], nested: { b: 2 } };
    const merged = mergePatch(base, patch);
    assert.deepEqual(merged, { list: [9], nested: { a: 1, b: 2 } });
    assert.deepEqual(base, { list: [1, 2, 3], nested: { a: 1 } });
    assert.deepEqual(patch, { list: [9], nested: { b: 2 } });
  });

  test('a non-object patch returns a copy of the base', () => {
    const base = { a: 1 };
    assert.deepEqual(mergePatch(base, null), { a: 1 });
    assert.notEqual(mergePatch(base, null), base);
  });

  test('a "__proto__" key is stored as an own key and never touches the prototype', () => {
    const patch = JSON.parse('{"__proto__":{"polluted":1}}');
    const merged = mergePatch({}, patch);
    assert.equal({}.polluted, undefined);
    assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  });
});

describe('no key is ever deleted by a patch', () => {
  const cfg = defaultConfig();

  test('no change kind emits a "-=" key', () => {
    const changes = [
      { kind: 'attr', key: 'might', value: 1 },
      { kind: 'skill', key: 'melee', value: 1 },
      { kind: 'res', key: 'hp', value: 1 },
      { kind: 'res', key: 'hp', delta: -1 },
      { kind: 'notes', value: 'n' },
    ];
    for (const change of changes) {
      const built = buildPatch({}, cfg, change);
      assert.equal(leafPaths(built.systemData).some((p) => p.includes('-=')), false);
    }
  });

  test('a stored key the config no longer lists survives a merged patch', () => {
    const sys = { attrs: { gone: 7, might: 2 }, res: { old: { value: 4, max: null }, hp: { value: 9, max: null } } };
    const merged = mergePatch(sys, buildPatch(sys, cfg, { kind: 'res', key: 'hp', value: 1 }).systemData);
    assert.equal(merged.attrs.gone, 7);
    assert.deepEqual(merged.res.old, { value: 4, max: null });
    assert.equal(merged.res.hp.value, 1);
  });

  test('isEmptyPatch reports a patch with no keys', () => {
    assert.equal(isEmptyPatch({}), true);
    assert.equal(isEmptyPatch(null), true);
    assert.equal(isEmptyPatch({ notes: '' }), false);
  });
});

describe('resolveWriteTarget (CLAUDE.md rule 6)', () => {
  test('no cast context always writes to the actor', () => {
    assert.deepEqual(resolveWriteTarget('a1', '', null), { ok: true, kind: 'actor' });
  });

  test('a linked cast writes to the actor', () => {
    assert.deepEqual(resolveWriteTarget('a1', 'c1', { actorId: 'a1', isLinked: true }), { ok: true, kind: 'actor' });
  });

  test('an unlinked (NPC) cast writes to the cast, never to the actor', () => {
    assert.deepEqual(
      resolveWriteTarget('a1', 'c1', { actorId: 'a1', isLinked: false }),
      { ok: true, kind: 'cast', id: 'c1' },
    );
  });

  test('a cast that could not be loaded is refused, not written to the actor', () => {
    assert.deepEqual(resolveWriteTarget('a1', 'c1', null), { ok: false });
  });

  test('a cast of another actor, or one without isLinked, is refused', () => {
    assert.deepEqual(resolveWriteTarget('a1', 'c1', { actorId: 'a2', isLinked: false }), { ok: false });
    assert.deepEqual(resolveWriteTarget('a1', 'c1', { actorId: 'a1' }), { ok: false });
  });
});
