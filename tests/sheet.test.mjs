import { test, describe, afterEach } from 'node:test';
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
import { registerActorSheet, EFFECT_USE_TYPES } from '../sheets/sandbox-sheet.mjs';

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

  test('a selected d20 attribute keeps its score visible and adds its derived modifier to linked skills', () => {
    const cfg = defaultConfig();
    cfg.attributes[0].useD20Modifier = true;
    cfg.attributes[0].max = 20;
    const actor = { id: 'derived', name: 'Ada', type: 'hero', systemData: { attrs: { might: 16 }, skills: { melee: 2 } } };
    const ctx = buildSheetContext(actor, [], cfg);
    const might = ctx.attributes.find((a) => a.key === 'might');
    const melee = ctx.skillGroups.flatMap((g) => g.skills).find((s) => s.key === 'melee');
    assert.equal(might.value, 16, 'the character still edits the original score');
    assert.equal(might.modifier, 3);
    assert.equal(melee.modifier, 5, 'the linked skill adds its rank to the derived modifier');
    assert.match(renderSheet(ctx), />\+3<\/span>/, 'the attribute modifier is visible beside its score');
  });

  test('dots use Max as the number of points and fall back to numbers outside the supported range', () => {
    const cfg = defaultConfig();
    cfg.attributeDisplay = 'dots';
    cfg.attributes[0].min = 0;
    cfg.attributes[0].max = 5;
    const actor = { id: 'dots', name: 'Ada', type: 'hero', systemData: { attrs: { might: 3 } } };
    const html = renderSheet(buildSheetContext(actor, [], cfg));
    assert.equal((html.match(/class="ldm-sheet-dot(?: is-filled)?" data-action="attr-dot" data-key="might"/g) ?? []).length, 5);
    assert.equal((html.match(/class="ldm-sheet-dot is-filled" data-action="attr-dot" data-key="might"/g) ?? []).length, 3);
    assert.doesNotMatch(html, /name="attr\.might"/);

    cfg.attributes[0].max = 21;
    const fallback = renderSheet(buildSheetContext(actor, [], cfg));
    assert.match(fallback, /name="attr\.might"[^>]*max="21"/);
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
    const other = ctx.itemGroups.find((g) => g.type === 'other');
    assert.equal(gear.count, 0, 'a legacy weapon is not gear');
    assert.equal(other.count, 1, 'a legacy weapon goes to the other group');
    assert.equal(other.categories[0].label, 'Weapon');
    assert.equal(spell.count, 1);
    assert.equal(ability.count, 1);
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
    assert.doesNotMatch(html, /<img src=x onerror=/i);
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
    assert.deepEqual(changeFromField({ field: 'name' }, 'Conan'), { kind: 'name', value: 'Conan' });
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
    assert.match(html, /<h2 class="ldm-sheet-name">N<\/h2>/);
    assert.match(html, /data-action="attr-roll"/);
    assert.doesNotMatch(html, /data-action="res-delta"[^>]*>(?![\s\S]*disabled)/);
    assert.match(html, /data-action="res-delta"[^>]*disabled/);

    const editableHtml = renderSheet(buildSheetContext(actor, [], cfg, { editable: true }));
    assert.match(editableHtml, /<input[^>]*class="ldm-sheet-name ldm-sheet-name-input"[^>]*data-field="name"/);
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

// ══════════════════════════════════════════════════════════════
// Layout standard: tabs, blocks, attribute groups, skill grouping, legacy items
// ══════════════════════════════════════════════════════════════

const STUB_EFFECTS = () => '<p data-stub="effects">stub</p>';
const LAYOUT_BLOCKS_FOR_TEST = [
  'resources',
  'attributes',
  'skills',
  'attacks',
  'magic',
  'items:gear',
  'items:ability',
  'items:spell',
  'items:other',
  'notes',
  'effects',
];

/** Block names of one tab panel, in order. Null when the panel is not in the HTML. */
function panelBlocks(html, tabKey) {
  const start = html.indexOf(`data-ldm-panel="${tabKey}"`);
  if (start < 0) return null;
  const rest = html.slice(start);
  const next = rest.indexOf('data-ldm-panel=', 20);
  const slice = next < 0 ? rest : rest.slice(0, next);
  return [...slice.matchAll(/data-ldm-block="([^"]*)"/g)].map((m) => m[1]);
}

function sheetHtml(cfg, ui = {}, items = []) {
  const actor = { id: 'L1', name: 'Layout', type: 'hero', systemData: {} };
  const ctx = buildSheetContext(actor, items, cfg, { isGM: true, ...ui });
  return { ctx, html: renderSheet(ctx, { renderEffects: STUB_EFFECTS }) };
}

describe('layout: default tabs and blocks', () => {
  test('the default layout renders the main, attacks, magic and inventory tabs', () => {
    const { html } = sheetHtml(defaultConfig());
    assert.equal([...html.matchAll(/class="ldm-tab"/g)].length, 6);
    assert.deepEqual(panelBlocks(html, 'main'), ['resources', 'attributes', 'skills']);
    assert.deepEqual(panelBlocks(html, 'attacks'), ['attacks']);
    assert.deepEqual(panelBlocks(html, 'magic'), ['magic']);
    assert.deepEqual(panelBlocks(html, 'powers'), ['items:ability', 'items:spell']);
    assert.deepEqual(panelBlocks(html, 'gear'), ['items:gear', 'items:other', 'notes']);
    assert.deepEqual(panelBlocks(html, 'effects'), ['effects']);
  });

  test('the effects block uses the injected renderer', () => {
    const { html } = sheetHtml(defaultConfig());
    assert.match(html, /data-stub="effects"/);
  });

  test('block titles come from sandbox.layout keys and fall back to English', () => {
    const { ctx } = sheetHtml(defaultConfig());
    assert.equal(ctx.blockTitles.resources, 'Resources');
    assert.equal(ctx.blockTitles['items:other'], 'Other items');
    const localized = buildSheetContext({ id: 'L2', name: 'n', type: 'hero', systemData: {} }, [], defaultConfig(), {
      t: (key) => (key === 'sandbox.layout.block.resources' ? 'Recursos' : key),
    });
    assert.equal(localized.blockTitles.resources, 'Recursos');
    assert.equal(localized.blockTitles.skills, 'Skills', 'a missing key falls back');
  });
});

test('optional saves show a stored adjustment separately from the entered difficulty', () => {
  const cfg = defaultConfig();
  cfg.saves = { enabled: true, entries: [{ key: 'fortitude', label: 'Fortitude', sources: [], bonus: 1, target: 14, showOnSheet: true }] };
  cfg.layout.tabs[0].blocks.push('saves');
  const { html } = sheetHtml(cfg);
  assert.match(html, /data-field="save" data-key="fortitude" aria-label="Fortitude adjustment"/);
  assert.match(html, /class="[^"]*ldm-sheet-save-target"[^>]*value="14"/);
});

describe('layout: custom config', () => {
  test('one tab, 3 columns and compact density: no tab bar, right columns and density class', () => {
    const cfg = cfgWith((c) => {
      c.layout = {
        density: 'compact',
        skillGrouping: 'attribute',
        tabs: [{ key: 'all', label: 'All', columns: 3, blocks: [...LAYOUT_BLOCKS_FOR_TEST] }],
      };
    });
    const { html } = sheetHtml(cfg);
    assert.doesNotMatch(html, /class="ldm-tablist"/, 'no tab bar with a single tab');
    assert.doesNotMatch(html, /role="tab"/);
    assert.match(html, /--ldm-cols:3/);
    assert.match(html, /ldm-density-compact/);
    assert.deepEqual(panelBlocks(html, 'all'), LAYOUT_BLOCKS_FOR_TEST);
  });

  test('a config that omits effects still shows the effects block in the first tab', () => {
    const cfg = cfgWith((c) => {
      c.layout = {
        density: 'comfortable',
        skillGrouping: 'attribute',
        tabs: [
          { key: 'one', label: 'One', columns: 2, blocks: ['resources', 'attributes'] },
          { key: 'two', label: 'Two', columns: 1, blocks: ['notes'] },
        ],
      };
    });
    const { ctx, html } = sheetHtml(cfg);
    assert.equal(ctx.layout.tabs[0].blocks.includes('effects'), true, 'effects appended to the first tab');
    assert.equal(panelBlocks(html, 'one').includes('effects'), true);
    assert.equal(panelBlocks(html, 'two').includes('effects'), false);
  });
});

describe('layout: attribute groups', () => {
  test('each group gets its own titled sub-section and the ungrouped one has no title', () => {
    const cfg = cfgWith((c) => {
      c.attributes[0].group = 'Body';
      c.attributes[1].group = 'Body';
    });
    const { ctx, html } = sheetHtml(cfg);
    assert.deepEqual(ctx.attributeGroups.map((g) => g.group), ['Body', '']);
    assert.match(html, /<h4 class="ldm-sheet-subh">Body<\/h4>/);
    assert.equal([...html.matchAll(/class="ldm-sheet-attr-group"/g)].length, 2);
    assert.match(html, /<div class="ldm-sheet-attr-group"><div class="ldm-sheet-attr-grid">/, 'untitled group has no heading');
  });
});

describe('layout: skill grouping modes', () => {
  const skillCfg = (mode) => cfgWith((c) => {
    c.layout.skillGrouping = mode;
    c.skills[0].group = 'Combat';
    c.skills[1].group = 'Combat';
  });

  test('attribute: one section per attribute, titled with the attribute label', () => {
    const { ctx } = sheetHtml(skillCfg('attribute'));
    assert.deepEqual(ctx.skillGroups.map((g) => g.title), ['Might', 'Grace', 'Wits']);
    assert.equal(ctx.skillGroups[0].basedOn, true);
  });

  test('group: one section per skill group text', () => {
    const { ctx } = sheetHtml(skillCfg('group'));
    assert.equal(ctx.skillGroups[0].title, 'Combat');
    assert.equal(ctx.skillGroups[0].skills.length, 2);
    assert.equal(ctx.skillGroups[0].basedOn, false);
  });

  test('none: exactly one untitled section', () => {
    const { ctx, html } = sheetHtml(skillCfg('none'));
    assert.equal(ctx.skillGroups.length, 1);
    assert.equal(ctx.skillGroups[0].title, '');
    assert.doesNotMatch(html, /<h4 class="ldm-sheet-subh">Might/);
  });
});

describe('layout: escaping and removed data', () => {
  test('hostile group, tab and attribute labels are escaped', () => {
    const cfg = cfgWith((c) => {
      c.attributes[0].label = HOSTILE;
      c.attributes[0].group = HOSTILE;
      c.layout.tabs = [
        { key: 'main', label: HOSTILE, columns: 2, blocks: ['resources', 'attributes', 'skills'] },
        { key: 'other', label: 'Two', columns: 1, blocks: ['items:gear', 'items:other', 'items:ability', 'items:spell', 'notes', 'effects'] },
      ];
    });
    const { html } = sheetHtml(cfg);
    assert.doesNotMatch(html, /<img src=x onerror=/i);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });

  test('a removed attribute is not shown, but its stored value is kept', () => {
    const cfg = defaultConfig();
    const actor = { id: 'L3', name: 'n', type: 'hero', systemData: { attrs: { gone: 7 } } };
    const html = renderSheet(buildSheetContext(actor, [], cfg), { renderEffects: STUB_EFFECTS });
    assert.doesNotMatch(html, /gone/);
    assert.equal(actor.systemData.attrs.gone, 7);
  });
});

describe('layout: active tab', () => {
  test('a known tab is kept, an unknown or missing one falls back to the first tab', () => {
    const cfg = defaultConfig();
    const actor = { id: 'L4', name: 'n', type: 'hero', systemData: {} };
    assert.equal(buildSheetContext(actor, [], cfg, { activeTab: 'powers' }).activeTab, 'powers');
    assert.equal(buildSheetContext(actor, [], cfg, { activeTab: 'removed' }).activeTab, 'main');
    assert.equal(buildSheetContext(actor, [], cfg).activeTab, 'main');
  });

  test('xp tab is supported as active tab and renders active panel', () => {
    const cfg = defaultConfig();
    const actor = { id: 'L4', name: 'n', type: 'hero', systemData: { xp: { total: 50, current: 30, log: [] } } };
    const ctx = buildSheetContext(actor, [], cfg, { activeTab: 'xp' });
    assert.equal(ctx.activeTab, 'xp');
    const html = renderSheet(ctx);
    assert.match(html, /aria-selected="true"[^>]*data-ldm-tab="xp"|data-ldm-tab="xp"[^>]*aria-selected="true"/);
    assert.match(html, /data-ldm-panel="xp"/);
    assert.doesNotMatch(html, /data-ldm-panel="xp"[^>]*hidden/);
  });
});

describe('layout: items:other', () => {
  test('legacy types and unknown types are collected in the other group', () => {
    const items = [
      { id: 'o1', name: 'Blade', type: 'weapon', data: { quantity: 1 } },
      { id: 'o2', name: 'Plate', type: 'armor', data: {} },
      { id: 'o3', name: 'Elixir', type: 'potion', data: {} },
      { id: 'o4', name: 'Scroll', type: 'scroll', data: {} },
      { id: 'o5', name: 'Mystery', type: 'xyz', data: {} },
      { id: 'g1', name: 'Rope', type: 'gear', data: {} },
    ];
    const ctx = buildSheetContext({ id: 'L5', name: 'n', type: 'hero', systemData: {} }, items, defaultConfig());
    const otherGroup = ctx.itemGroups.find((g) => g.type === 'other');
    assert.equal(otherGroup.count, 5);
    assert.equal(ctx.itemGroups.find((g) => g.type === 'gear').count, 1);
    assert.equal(otherGroup.addLabel, '', 'legacy types cannot be created');
  });
});

// ── Item use copies the item's effects onto the actor ──────────
function installUseLoom(options = {}) {
  const env = {
    calls: [],
    toasts: [],
    chats: [],
    rolls: [],
    catalog: [],
    actorRows: [...(options.actorRows ?? [])],
    itemEffects: options.itemEffects ?? [],
  };
  const api = {
    get: async (url) => {
      env.calls.push(['get', url]);
      return [];
    },
    put: async (url, body) => {
      env.calls.push(['put', url, body]);
      return {};
    },
  };
  env.effects = {
    forItem: async (id) => {
      env.calls.push(['forItem', id]);
      return env.itemEffects.map((r) => ({ ...r }));
    },
    forActor: async (id) => {
      env.calls.push(['forActor', id]);
      return env.actorRows.map((r) => ({ ...r }));
    },
    create: async (data) => {
      env.calls.push(['create', data]);
      if (options.createError) throw options.createError;
      env.actorRows.push({ id: `new-${env.actorRows.length}`, ...data });
      return {};
    },
    update: async (id, patch) => {
      env.calls.push(['update', id, patch]);
      return {};
    },
  };
  globalThis.window = {
    Loom: {
      sheets: { catalog: (kind, type, Cls) => env.catalog.push([kind, type, Cls]) },
      LoomHandlebarsMixin: (Base) => Base,
      LoomActorSheet: class {
        constructor(props) {
          this.props = props;
          this.document = null;
          this.element = null;
          this.apiRoute = '/actors';
          this.renders = 0;
        }
        rerenderBody() {
          this.renders += 1;
        }
        async _reloadDocument() {}
      },
      api,
      effects: env.effects,
      showToast: (message, type) => env.toasts.push([message, type]),
      world: { id: 'world-1' },
      user: { isGM: true },
      dispatchRoll: options.noDispatch ? undefined : (roll) => env.rolls.push(roll),
      ChatMessage: {
        create: async (data) => {
          env.chats.push(data);
        },
      },
      i18n: { localize: (key) => key },
      clog: { error() {} },
    },
  };
  return env;
}

function useSheet(env, items, systemData = { res: { mp: { value: 5, max: null } } }) {
  registerActorSheet();
  const [, , SheetCls] = env.catalog.find((row) => row[0] === 'actor' && row[1] === 'hero');
  const sheet = new SheetCls({});
  const cfg = defaultConfig();
  sheet.document = { id: 'actor-1', name: 'Ada', type: 'hero', systemData, items };
  sheet._ldmCfg = cfg;
  sheet._ldmCfgSig = JSON.stringify(cfg);
  return sheet;
}

const COPY = Object.freeze({
  id: 'ie-1',
  name: 'Ember',
  icon: '',
  duration: 2,
  disabled: false,
  changes: [{ key: 'attrs.might', mode: 'add', value: 1 }],
});
const SPELL = Object.freeze({
  id: 'it-1',
  name: 'Fireball',
  type: 'spell',
  data: { category: 'fire', cost: { res: 'mp', amount: 2 }, roll: { enabled: false } },
});

describe('item use copies the item effects onto the actor', () => {
  afterEach(() => {
    delete globalThis.window;
  });

  test('EFFECT_USE_TYPES is ability, spell, potion and scroll only', () => {
    assert.deepEqual([...EFFECT_USE_TYPES], ['ability', 'spell', 'potion', 'scroll']);
  });

  test('a spell use pays the cost, creates the copy after the payment, toasts once and reloads the list', async () => {
    const env = installUseLoom({ itemEffects: [COPY] });
    const sheet = useSheet(env, [SPELL]);
    await sheet._ldmUseItem('it-1');

    const creates = env.calls.filter((c) => c[0] === 'create');
    assert.equal(creates.length, 1);
    assert.deepEqual(creates[0][1], {
      worldId: 'world-1',
      actorId: 'actor-1',
      name: 'Ember (Fireball)',
      icon: '',
      origin: 'item:it-1',
      duration: 2,
      disabled: false,
      changes: [{ key: 'attrs.might', mode: 'add', value: 1 }],
    });
    const paid = env.calls.findIndex((c) => c[0] === 'put');
    const created = env.calls.findIndex((c) => c[0] === 'create');
    assert.ok(paid >= 0 && paid < created, 'the cost is written before the effect is copied');
    assert.deepEqual(env.toasts, [['Applied 1 effect(s) from Fireball.', 'success']]);
    assert.equal(sheet._ldmEffects.length, 1);
    assert.equal(sheet._ldmEffects[0].origin, 'item:it-1');
  });

  test('every effect-use type copies its effects (ability, spell, potion, scroll)', async () => {
    for (const type of EFFECT_USE_TYPES) {
      const env = installUseLoom({ itemEffects: [COPY] });
      const item = { id: 'it-1', name: 'Thing', type, data: { uses: { value: 2, max: 2 } } };
      const sheet = useSheet(env, [item]);
      await sheet._ldmUseItem('it-1');
      assert.equal(env.calls.filter((c) => c[0] === 'create').length, 1, type);
    }
  });

  test('gear and weapons never copy their effects, even when the use is paid', async () => {
    for (const type of ['gear', 'weapon']) {
      const env = installUseLoom({ itemEffects: [COPY] });
      const item = { id: 'it-1', name: 'Kit', type, data: { cost: { res: 'mp', amount: 1 } } };
      const sheet = useSheet(env, [item]);
      await sheet._ldmUseItem('it-1');
      assert.equal(env.calls.some((c) => c[0] === 'forItem'), false, type);
      assert.equal(env.calls.some((c) => c[0] === 'create'), false, type);
    }
  });

  test('a refused use (not enough resource) applies nothing and reads no effects', async () => {
    const env = installUseLoom({ itemEffects: [COPY] });
    const sheet = useSheet(env, [{ ...SPELL, data: { cost: { res: 'mp', amount: 99 } } }]);
    await sheet._ldmUseItem('it-1');
    assert.equal(env.calls.some((c) => c[0] === 'put'), false);
    assert.equal(env.calls.some((c) => c[0] === 'forItem' || c[0] === 'create'), false);
    assert.equal(env.toasts.some((t) => t[1] === 'success'), false);
  });

  test('a rolled use copies its effects only when the roll was dispatched', async () => {
    const ability = { id: 'it-1', name: 'Strike', type: 'ability', data: { roll: { enabled: true, attr: '', skill: '', bonus: 0 } } };

    const ok = installUseLoom({ itemEffects: [COPY] });
    await useSheet(ok, [ability])._ldmUseItem('it-1');
    assert.equal(ok.rolls.length, 1);
    assert.equal(ok.calls.filter((c) => c[0] === 'create').length, 1);

    const refused = installUseLoom({ itemEffects: [COPY], noDispatch: true });
    await useSheet(refused, [ability])._ldmUseItem('it-1');
    assert.equal(refused.calls.some((c) => c[0] === 'forItem'), false);
    assert.equal(refused.calls.some((c) => c[0] === 'create'), false);
  });

  test('a spell roll adds the configured derived attribute modifier', async () => {
    const env = installUseLoom();
    const spell = { id: 'it-1', name: 'Fireball', type: 'spell', data: { roll: { enabled: true, attr: 'might', skill: '', bonus: 0 } } };
    const sheet = useSheet(env, [spell], { attrs: { might: 16 } });
    sheet._ldmCfg.attributes[0].useD20Modifier = true;
    sheet._ldmCfg.attributes[0].max = 20;

    await sheet._ldmUseItem('it-1');

    assert.equal(env.rolls.length, 1);
    assert.equal(env.rolls[0].formula, '1d20+3');
  });

  test('skill ranks render as dots grouped by dotGroup, and stay numeric above 20', () => {
    const cfg = defaultConfig();
    cfg.skillDisplay = 'dots';
    cfg.dotStyle = 'square';
    cfg.dotGroup = 5;
    cfg.skills[0].max = 10;
    cfg.skills[1].max = 21;
    const actor = { id: 'sk', name: 'Ada', type: 'hero', systemData: { skills: { melee: 4, ranged: 2 } } };
    const html = renderSheet(buildSheetContext(actor, [], cfg));
    const melee = html.match(/<button[^>]*data-action="skill-dot" data-key="melee"[^>]*>/g) ?? [];
    assert.equal(melee.length, 10);
    assert.equal(melee.filter((b) => b.includes('is-filled')).length, 4);
    assert.equal(melee.filter((b) => b.includes('is-group-end')).length, 1, 'one gap after the 5th dot, none after the last');
    assert.match(html, /data-dot-style="square"/);
    assert.doesNotMatch(html, /data-action="skill-dot" data-key="ranged"/);
    assert.match(html, /name="skill\.ranged"/);
  });

  test('clicking a dot writes that attribute score immediately', async () => {
    const env = installUseLoom();
    const sheet = useSheet(env, [], { attrs: { might: 2 } });
    sheet._ldmCfg.attributeDisplay = 'dots';
    sheet._ldmCfg.attributes[0].max = 5;

    await sheet.onAction('attr-dot', null, { dataset: { key: 'might', value: '4' } });

    const call = env.calls.find((entry) => entry[0] === 'put');
    assert.deepEqual(call[2], { systemData: { attrs: { might: 4 } } });
  });

  test('clicking a skill dot writes the rank, and the last filled dot lowers it by one', async () => {
    const env = installUseLoom();
    const sheet = useSheet(env, [], { skills: { melee: 3 } });
    sheet._ldmCfg.skillDisplay = 'dots';

    await sheet.onAction('skill-dot', null, { dataset: { key: 'melee', value: '3' } });

    const call = env.calls.find((entry) => entry[0] === 'put');
    assert.deepEqual(call[2], { systemData: { skills: { melee: 2 } } });
  });

  test('an item without effects reads its own effects, writes no copy and toasts nothing', async () => {
    const env = installUseLoom({ itemEffects: [] });
    const sheet = useSheet(env, [SPELL]);
    await sheet._ldmUseItem('it-1');
    assert.equal(env.calls.filter((c) => c[0] === 'forItem').length, 1);
    assert.equal(env.calls.some((c) => c[0] === 'create' || c[0] === 'forActor'), false);
    assert.deepEqual(env.toasts, []);
  });

  test('a forbidden copy keeps the use and shows only the forbidden toast', async () => {
    const env = installUseLoom({
      itemEffects: [COPY],
      createError: Object.assign(new Error('Access denied'), { status: 403 }),
    });
    const sheet = useSheet(env, [SPELL]);
    await sheet._ldmUseItem('it-1');
    assert.equal(env.calls.some((c) => c[0] === 'put'), true, 'the cost was still paid');
    assert.deepEqual(env.toasts, [["You cannot change this effect. Only the GM or the actor's owner can.", 'error']]);
  });

  test('an unlinked NPC cast does not receive actor effect copies', async () => {
    const env = installUseLoom({ itemEffects: [COPY] });
    const sheet = useSheet(env, [{ ...SPELL, data: { uses: { value: 1, max: 1 } } }]);
    sheet._ldmCast = { id: 'cast-1', systemData: {} };
    await sheet._ldmUseItem('it-1');
    assert.equal(env.calls.some((c) => c[0] === 'forItem' || c[0] === 'create'), false);
  });
});

// ── Use button for effect-use types and effects-only items ────
describe('Use button rule and effects-only items', () => {
  afterEach(() => {
    delete globalThis.window;
  });

  const actorForButtons = { id: 'b1', name: 'N', type: 'hero', systemData: {} };

  test('an effects-only spell and an empty ability show the Use button; gear without roll, cost or uses does not', () => {
    const cfg = defaultConfig();
    const html = renderSheet(buildSheetContext(actorForButtons, [
      { id: 's1', name: 'Native Power', type: 'spell', data: {} },
      { id: 'a1', name: 'Empty Ability', type: 'ability', data: {} },
      { id: 'p1', name: 'Tonic', type: 'potion', data: {} },
      { id: 'g1', name: 'Rope', type: 'gear', data: {} },
      { id: 'w1', name: 'Blade', type: 'weapon', data: {} },
    ], cfg));
    assert.match(html, /data-action="use-item" data-id="s1"/);
    assert.match(html, /data-action="use-item" data-id="a1"/);
    assert.match(html, /data-action="use-item" data-id="p1"/);
    assert.doesNotMatch(html, /data-action="use-item" data-id="g1"/);
    assert.doesNotMatch(html, /data-action="use-item" data-id="w1"/);
  });

  test('planUse on an item with no cost and no uses is ok with an empty patch', () => {
    const plan = planUse({ id: 's1', type: 'spell', data: {} }, {}, defaultConfig());
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.patch, { res: null, uses: null });
  });

  test('an effects-only spell use pays nothing, sends no resource or uses PUT, posts the message and copies its effects', async () => {
    const env = installUseLoom({ itemEffects: [COPY] });
    const sheet = useSheet(env, [{ id: 'it-1', name: 'Fireball', type: 'spell', data: {} }]);
    await sheet._ldmUseItem('it-1');
    assert.equal(env.calls.some((c) => c[0] === 'put'), false, 'no PUT for an effects-only use');
    assert.equal(env.chats.length, 1, 'the short use message is posted');
    assert.equal(env.rolls.length, 0, 'nothing is rolled');
    assert.equal(env.calls.filter((c) => c[0] === 'create').length, 1);
    assert.deepEqual(env.toasts, [['Applied 1 effect(s) from Fireball.', 'success']]);
  });

  test('an effects-less empty ability use only posts the message: no PUT, no roll, no effects toast', async () => {
    const env = installUseLoom({ itemEffects: [] });
    const sheet = useSheet(env, [{ id: 'it-1', name: 'Shrug', type: 'ability', data: {} }]);
    await sheet._ldmUseItem('it-1');
    assert.equal(env.calls.some((c) => c[0] === 'put' || c[0] === 'create'), false);
    assert.equal(env.rolls.length, 0);
    assert.equal(env.chats.length, 1);
    assert.deepEqual(env.toasts, []);
  });
});
