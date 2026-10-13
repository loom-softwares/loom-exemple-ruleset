import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, abilityKindLabel } from '../lib/config.mjs';
import {
  ITEM_TYPES,
  applyField,
  buildItemContext,
  itemLabels,
  normalizeItemData,
  normalizeItemName,
  renderItem,
  safeImageUrl,
} from '../sheets/item-view.mjs';

const HOSTILE_NAME = '<img src=x onerror="alert(1)">';

function hostileConfig() {
  const cfg = defaultConfig();
  cfg.itemCategories = [
    { key: 'weapon', label: '"><script>alert(2)</script>' },
    { key: 'misc', label: 'Misc' },
  ];
  cfg.abilityKinds = { ability: '<svg onload=alert(3)>', spell: 'Spell' };
  return cfg;
}

// ── Escaping ─────────────────────────────────────────────────────

test('hostile name, description and config labels are escaped', () => {
  const cfg = hostileConfig();
  const item = {
    id: 'i1',
    type: 'gear',
    name: HOSTILE_NAME,
    data: { category: 'weapon', description: '"><script>x()</script>' },
  };
  const html = renderItem(buildItemContext(item, cfg));

  assert.ok(!html.includes('<script'), 'no script tag from labels or description');
  assert.ok(!html.includes('<img'), 'no img tag from the name');
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'), 'name is escaped in the input value');
  assert.ok(html.includes('&quot;&gt;&lt;script&gt;x()&lt;/script&gt;'), 'description is escaped');
  assert.ok(html.includes('&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;'), 'category label is escaped');
});

test('hostile ability kind label in the header is escaped', () => {
  const cfg = hostileConfig();
  const html = renderItem(buildItemContext({ id: 'a1', type: 'ability', data: {} }, cfg));
  assert.ok(!html.includes('<svg'));
  assert.ok(html.includes('&lt;svg onload=alert(3)&gt;'));
});

test('hostile removed key is escaped in the select option', () => {
  const cfg = defaultConfig();
  const data = { roll: { enabled: true, attr: '"><b>x</b>', skill: '', bonus: 0, damage: '' } };
  const html = renderItem(buildItemContext({ id: 'g', type: 'gear', data }, cfg));
  assert.ok(!html.includes('<b>x</b>'));
  assert.ok(html.includes('(removed) &quot;&gt;&lt;b&gt;x&lt;/b&gt;'));
});

test('quotes in the damage formula stay inside the attribute', () => {
  const cfg = defaultConfig();
  const html = renderItem(buildItemContext({ id: 'w', type: 'weapon', data: { roll: { damage: '1d6"onmouseover="x' } } }, cfg));
  assert.ok(!html.includes('"onmouseover="'), 'quote cannot break out of value attribute');
});

test('a javascript: portrait is never used as an image source', () => {
  const cfg = defaultConfig();
  const html = renderItem(buildItemContext({ id: 'p', type: 'gear', imgUrl: 'javascript:alert(1)', data: {} }, cfg));
  assert.ok(!html.includes('src="javascript'));
  assert.ok(!html.includes('<img class="ldm-item-img" src='));
  assert.ok(html.includes('ldm-item-img--empty'));
});

// ── Normalization ────────────────────────────────────────────────

test('normalize fills every missing field with a default', () => {
  const cfg = defaultConfig();
  const out = normalizeItemData({}, cfg, 'gear');
  assert.equal(out.category, cfg.itemCategories[0].key);
  assert.equal(out.description, '');
  assert.equal(out.quantity, 1);
  assert.deepEqual(out.roll, { enabled: false, attr: '', skill: '', bonus: 0, damage: '' });
  assert.deepEqual(out.cost, { res: '', amount: 0 });
  assert.equal('uses' in out, false, 'gear has no uses');
});

test('normalize rejects NaN, Infinity and non-numeric input', () => {
  const cfg = defaultConfig();
  const out = normalizeItemData(
    { quantity: NaN, cost: { amount: NaN }, roll: { bonus: NaN } },
    cfg,
    'gear',
  );
  assert.equal(out.quantity, 1);
  assert.equal(out.cost.amount, 0);
  assert.equal(out.roll.bonus, 0);

  const inf = normalizeItemData({ quantity: Infinity, cost: { amount: -Infinity } }, cfg, 'gear');
  assert.equal(inf.quantity, 1);
  assert.equal(inf.cost.amount, 0);
});

test('normalize clamps negatives and huge numbers', () => {
  const cfg = defaultConfig();
  const neg = normalizeItemData({ quantity: -5, cost: { amount: -1 }, roll: { bonus: -1000 } }, cfg, 'gear');
  assert.equal(neg.quantity, 0);
  assert.equal(neg.cost.amount, 0);
  assert.equal(neg.roll.bonus, -99);

  const huge = normalizeItemData({ quantity: 1e300, cost: { amount: 1e300 }, roll: { bonus: 1e9 } }, cfg, 'gear');
  assert.equal(huge.quantity, 9999);
  assert.equal(huge.cost.amount, 999);
  assert.equal(huge.roll.bonus, 99);
});

test('normalize rejects wrong types and accepts numeric strings', () => {
  const cfg = defaultConfig();
  const wrong = normalizeItemData(
    { quantity: 'abc', description: { x: 1 }, roll: 'yes', cost: 'free', category: 42 },
    cfg,
    'gear',
  );
  assert.equal(wrong.quantity, 1);
  assert.equal(wrong.description, '');
  assert.equal(wrong.roll.enabled, false);
  assert.deepEqual(wrong.cost, { res: '', amount: 0 });
  assert.equal(wrong.category, cfg.itemCategories[0].key, 'a non-string category falls back');

  const str = normalizeItemData({ quantity: '7', roll: { enabled: 'yes' } }, cfg, 'gear');
  assert.equal(str.quantity, 7);
  assert.equal(str.roll.enabled, false, 'only a real true enables the roll');
});

test('uses are clamped to their maximum and exist only on usage types', () => {
  const cfg = defaultConfig();
  const potion = normalizeItemData({ uses: { value: 50, max: 3 } }, cfg, 'potion');
  assert.deepEqual(potion.uses, { value: 3, max: 3 });

  const gear = normalizeItemData({ uses: { value: 1, max: 2 } }, cfg, 'gear');
  assert.equal('uses' in gear, false);

  const ability = normalizeItemData({ quantity: 4 }, cfg, 'ability');
  assert.equal('quantity' in ability, false, 'abilities have no quantity');
  assert.deepEqual(ability.uses, { value: 0, max: 0 });
});

test('unknown junk is dropped and control characters are removed', () => {
  const cfg = defaultConfig();
  const out = normalizeItemData(
    { evil: '<img>', roll: { enabled: true, script: 'x' }, description: 'ok\u0000\u0007' },
    cfg,
    'spell',
  );
  assert.equal('evil' in out, false);
  assert.equal('script' in out.roll, false);
  assert.equal(out.description, 'ok');
});

test('long text is capped and a non-object data value gives defaults', () => {
  const cfg = defaultConfig();
  const out = normalizeItemData({ description: 'a'.repeat(10000) }, cfg, 'gear');
  assert.equal(out.description.length, 4000);
  assert.equal(normalizeItemName('x'.repeat(200)).length, 80);

  const fromJunk = normalizeItemData('junk', cfg, 'gear');
  assert.equal(fromJunk.quantity, 1);
  assert.equal(fromJunk.description, '');
});

test('item name is single line and trimmed', () => {
  assert.equal(normalizeItemName('  a\nb\tc  '), 'a b c');
  assert.equal(normalizeItemName(42), '');
});

// ── Removed-key references ───────────────────────────────────────

test('removed keys are kept as stored and shown as removed', () => {
  const cfg = defaultConfig();
  const data = {
    category: 'gone_cat',
    roll: { enabled: true, attr: 'ghost_attr', skill: 'ghost_skill', bonus: 1, damage: '' },
    cost: { res: 'old_mana', amount: 3 },
  };
  const norm = normalizeItemData(data, cfg, 'spell');
  assert.equal(norm.category, 'gone_cat');
  assert.equal(norm.roll.attr, 'ghost_attr');
  assert.equal(norm.roll.skill, 'ghost_skill');
  assert.equal(norm.cost.res, 'old_mana');
  assert.equal(norm.cost.amount, 3);

  const ctx = buildItemContext({ id: 's1', type: 'spell', data }, cfg);
  assert.equal(ctx.roll.attr.value, 'ghost_attr');
  assert.equal(ctx.roll.attr.removed, true);
  const selected = ctx.roll.attr.options.find((o) => o.value === 'ghost_attr');
  assert.equal(selected.label, '(removed) ghost_attr');
  assert.equal(selected.selected, true);
  assert.equal(ctx.removedCount, 4);

  const html = renderItem(ctx);
  assert.match(html, /<option value="ghost_attr" selected>\(removed\) ghost_attr<\/option>/);
  assert.match(html, /ldm-item-removed/);
  assert.match(html, /ldm-item-notice/);
});

test('a removed key survives an unrelated edit', () => {
  const cfg = defaultConfig();
  const data = { roll: { enabled: true, attr: 'ghost_attr', skill: '', bonus: 0, damage: '' } };
  const edited = applyField(data, 'roll.bonus', 2);
  const norm = normalizeItemData(edited, cfg, 'gear');
  assert.equal(norm.roll.attr, 'ghost_attr', 'the stored reference is not reset');
  assert.equal(norm.roll.bonus, 2);
  assert.equal(data.roll.bonus, 0, 'applyField does not mutate its input');
});

test('a valid reference is not marked removed', () => {
  const cfg = defaultConfig();
  const attrKey = cfg.attributes[0].key;
  const skillKey = cfg.skills[0] ? cfg.skills[0].key : '';
  const ctx = buildItemContext(
    { id: 'g', type: 'gear', data: { roll: { enabled: true, attr: attrKey, skill: skillKey, bonus: 0, damage: '' } } },
    cfg,
  );
  assert.equal(ctx.roll.attr.removed, false);
  assert.equal(ctx.roll.attr.options.find((o) => o.value === attrKey).selected, true);
  assert.equal(ctx.removedCount, 0);
});

// ── Damage formula ───────────────────────────────────────────────

test('an invalid damage formula is shown with an error', () => {
  const cfg = defaultConfig();
  const ctx = buildItemContext(
    { id: 'w', type: 'weapon', name: 'Blade', data: { roll: { enabled: true, damage: '1d6 + @might' } } },
    cfg,
  );
  assert.ok(ctx.roll.damageError, 'error code is set');
  const html = renderItem(ctx);
  assert.match(html, /Invalid damage formula/);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /id="ldm-item-damage-error"/);
  assert.equal(ctx.roll.damage, '1d6 + @might', 'the invalid text is kept so the GM can fix it');
});

test('a valid damage formula shows no error', () => {
  const cfg = defaultConfig();
  const ctx = buildItemContext({ id: 'w', type: 'weapon', data: { roll: { damage: '2d6+1' } } }, cfg);
  assert.equal(ctx.roll.damageError, '');
  const html = renderItem(ctx);
  assert.doesNotMatch(html, /aria-invalid/);
  assert.doesNotMatch(html, /ldm-item-damage-error/);
});

// ── Type fields and labels ───────────────────────────────────────

test('abilities and spells have uses and no quantity; gear has quantity and no uses', () => {
  const cfg = defaultConfig();
  const ability = buildItemContext({ id: 'a', type: 'ability', data: {} }, cfg);
  const gear = buildItemContext({ id: 'g', type: 'gear', data: {} }, cfg);
  const potion = buildItemContext({ id: 'p', type: 'potion', data: {} }, cfg);
  assert.equal(ability.showQuantity, false);
  assert.equal(ability.showUses, true);
  assert.equal(gear.showQuantity, true);
  assert.equal(gear.showUses, false);
  assert.equal(potion.showQuantity, true);
  assert.equal(potion.showUses, true);

  const html = renderItem(ability);
  assert.doesNotMatch(html, /data-field="quantity"/);
  assert.match(html, /data-field="uses\.value"/);
});

test('every item type renders the same roll, cost and description fields', () => {
  const cfg = defaultConfig();
  for (const type of ITEM_TYPES) {
    const html = renderItem(buildItemContext({ id: type, type, data: {} }, cfg));
    assert.match(html, /data-field="roll\.enabled"/, type);
    assert.match(html, /data-field="cost\.res"/, type);
    assert.match(html, /data-field="description"/, type);
  }
});

test('the kind label comes from the configuration, with a fallback', () => {
  const cfg = defaultConfig();
  cfg.abilityKinds = { ability: 'Trait', spell: 'Power' };
  assert.equal(buildItemContext({ type: 'ability', data: {} }, cfg).typeLabel, 'Trait');
  assert.equal(abilityKindLabel(cfg, 'spell'), 'Power');

  const noKinds = defaultConfig();
  delete noKinds.abilityKinds;
  assert.equal(buildItemContext({ type: 'spell', data: {} }, noKinds).typeLabel, 'Spell');
  assert.equal(buildItemContext({ type: 'armor', data: {} }, noKinds).typeLabel, 'Armor');
});

test('read-only context disables every control and hides the portrait clear button', () => {
  const cfg = defaultConfig();
  const html = renderItem(buildItemContext(
    { id: 'r', type: 'potion', imgUrl: '/a.png', data: { description: 'x' } },
    cfg,
    undefined,
    { editable: false },
  ));
  const tags = html.match(/<(input|select|textarea)\b[^>]*>/g) || [];
  assert.ok(tags.length > 0);
  for (const tag of tags) assert.match(tag, / disabled/, tag);
  assert.doesNotMatch(html, /data-action="clear-portrait"/);
  assert.match(html, /ldm-item-notice/);
});

test('a rejected portrait and a changed configuration show their notices', () => {
  const cfg = defaultConfig();
  const html = renderItem(buildItemContext(
    { id: 'n', type: 'gear', data: {} },
    cfg,
    undefined,
    { portraitRejected: true, configChanged: true },
  ));
  assert.match(html, /role="alert"/);
  assert.match(html, /not allowed/);
  assert.match(html, /configuration changed/);
});

// ── Helpers ──────────────────────────────────────────────────────

test('safeImageUrl accepts site paths and http(s) only', () => {
  assert.equal(safeImageUrl('/marketplace/x.png'), '/marketplace/x.png');
  assert.equal(safeImageUrl('https://example.com/a.png'), 'https://example.com/a.png');
  for (const bad of [
    'javascript:alert(1)',
    '//evil.example/x.png',
    'data:image/png;base64,AAAA',
    '/a"onerror=alert(1)',
    '/a b.png',
    ' /a.png',
    42,
    null,
  ]) {
    assert.equal(safeImageUrl(bad), '', String(bad));
  }
});

test('translator that throws, echoes the key or is missing falls back to English', () => {
  assert.equal(itemLabels(() => { throw new Error('boom'); }).name, 'Name');
  assert.equal(itemLabels((key) => key).types.gear, 'Gear');
  assert.equal(itemLabels().roll, 'Roll');
  const pt = itemLabels((key, fallback) => (key === 'sandbox.item.name' ? 'Nome' : fallback));
  assert.equal(pt.name, 'Nome');
  assert.equal(pt.roll, 'Roll');
});

test('applyField creates nested paths without mutating the source', () => {
  const src = { roll: { enabled: false } };
  const out = applyField(src, 'cost.amount', 5);
  assert.deepEqual(out.cost, { amount: 5 });
  assert.equal('cost' in src, false);
  assert.deepEqual(applyField('junk', 'roll.enabled', true), { roll: { enabled: true } });
});
