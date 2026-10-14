// Tests for lib/layout-view.mjs and the shared layout assets.
// Run with: node --test tests/layout-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  clampColumns,
  renderTabs,
  renderGrid,
  renderBlock,
  nextTabKey,
  firstTabKey,
  lastTabKey,
  handleTabEvent,
} from '../lib/layout-view.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readRepo = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const TABS = [
  { key: 'main', label: 'Main', columns: 2 },
  { key: 'gear', label: 'Gear', columns: 1 },
  { key: 'notes', label: 'Notes', columns: 3 },
];
const PANELS = { main: '<p>MAIN</p>', gear: '<p>GEAR</p>', notes: '<p>NOTES</p>' };

/** Builds a fake event target whose closest() finds a tab element with the given key. */
function tabTarget(key) {
  const el = {
    getAttribute: (name) => (name === 'data-ldm-tab' ? key : null),
  };
  return { closest: (sel) => (sel.includes('data-ldm-tab') ? el : null) };
}
const nonTabTarget = { closest: () => null };

test('single tab renders no tab bar, only the panel', () => {
  const html = renderTabs({ idPrefix: 'x', tabs: [TABS[0]], panels: PANELS });
  assert.equal(html.includes('role="tablist"'), false);
  assert.equal(html.includes('role="tab"'), false);
  assert.equal(html.includes('<p>MAIN</p>'), true);
  assert.equal(html.includes('ldm-tabs'), false);
});

test('multiple tabs render a tablist with aria wiring and one visible panel', () => {
  const html = renderTabs({ idPrefix: 'sheet', tabs: TABS, activeKey: 'gear', panels: PANELS });
  assert.equal((html.match(/role="tab"/g) || []).length, 3);
  assert.equal((html.match(/role="tabpanel"/g) || []).length, 3);
  assert.equal((html.match(/aria-selected="true"/g) || []).length, 1);
  assert.match(html, /data-ldm-tab="gear"[^>]*aria-selected="true"/);
  // Inactive panels are hidden; exactly one panel is visible.
  const panels = html.match(/<div class="ldm-tabpanel"[^>]*>/g) || [];
  assert.equal(panels.length, 3);
  assert.equal(panels.filter((p) => !p.includes(' hidden')).length, 1);
  // Aria wiring: each tab controls its panel and each panel is labelled by its tab.
  const tabIds = [...html.matchAll(/role="tab"[^>]*?id="([^"]+)"/g)].map((m) => m[1]);
  const controls = [...html.matchAll(/aria-controls="([^"]+)"/g)].map((m) => m[1]);
  const panelIds = [...html.matchAll(/role="tabpanel" id="([^"]+)"/g)].map((m) => m[1]);
  const labelledBy = [...html.matchAll(/aria-labelledby="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(controls, panelIds);
  assert.deepEqual(labelledBy, tabIds);
  assert.equal(new Set([...tabIds, ...panelIds]).size, 6);
});

test('unknown activeKey falls back to the first tab', () => {
  const html = renderTabs({ tabs: TABS, activeKey: 'nope', panels: PANELS });
  assert.match(html, /data-ldm-tab="main"[^>]*aria-selected="true"/);
  assert.match(html, /data-ldm-tab="main"[^>]*aria-selected="true"/);
});

test('columns are clamped to integers 1..4 and never taken raw', () => {
  assert.equal(clampColumns(0), 1);
  assert.equal(clampColumns(9), 4);
  assert.equal(clampColumns(NaN), 1);
  assert.equal(clampColumns('3; background:red'), 1);
  assert.equal(clampColumns(2.7), 2);
  assert.equal(clampColumns(undefined), 1);
  assert.equal(clampColumns(Symbol('x')), 1);

  const hostile = [
    { key: 'a', label: 'A', columns: '3; background:red' },
    { key: 'b', label: 'B', columns: 9 },
  ];
  const html = renderTabs({ tabs: hostile, panels: {} });
  const styles = [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(styles.length >= 2);
  for (const style of styles) {
    assert.match(style, /^--ldm-cols:[1-4]$/);
  }
  const grid = renderGrid(['<p>x</p>'], 'NaN; color:red');
  assert.equal(grid, '<div class="ldm-grid" style="--ldm-cols:1"><p>x</p></div>');
});

test('hostile labels and keys are escaped and ids are sanitized', () => {
  const tabs = [
    { key: '"><script>x</script>', label: '<img src=x onerror=alert(1)>', columns: 1 },
    { key: 'ok', label: 'He said "hi"', columns: 1 },
  ];
  const html = renderTabs({ idPrefix: 'a b"<', tabs, panels: {} });
  assert.equal(html.includes('<img'), false);
  assert.equal(html.includes('<script'), false);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('&quot;&gt;&lt;script&gt;'));
  assert.ok(html.includes('He said &quot;hi&quot;'));
  const ids = [...html.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 4);
  for (const id of ids) assert.match(id, /^[a-z0-9_-]+$/);
});

test('panel HTML is inserted as given (caller escapes it)', () => {
  const html = renderTabs({ tabs: TABS, activeKey: 'main', panels: { main: '<b>bold</b>' } });
  assert.ok(html.includes('<b>bold</b>'));
});

test('renderBlock escapes title and key, and leaves body as given', () => {
  const html = renderBlock({ key: 'x"><i>', title: '<u>T</u>', body: '<b>ok</b>' });
  assert.ok(html.includes('data-ldm-block="x&quot;&gt;&lt;i&gt;"'));
  assert.ok(html.includes('<h3 class="ldm-block-title">&lt;u&gt;T&lt;/u&gt;</h3>'));
  assert.ok(html.includes('<b>ok</b>'));
});

test('renderBlock omits the title element when the title is empty', () => {
  assert.equal(renderBlock({ key: 'k', title: '', body: 'x' }).includes('<h3'), false);
  assert.equal(renderBlock({ key: 'k', title: '   ', body: 'x' }).includes('<h3'), false);
  assert.equal(renderBlock({ key: 'items:gear', title: 'Gear', body: '' }).includes('data-ldm-block="items:gear"'), true);
});

test('renderGrid wraps given blocks and ignores non-string entries', () => {
  const html = renderGrid(['<p>a</p>', 42, '<p>b</p>'], 2);
  assert.equal(html, '<div class="ldm-grid" style="--ldm-cols:2"><p>a</p><p>b</p></div>');
  assert.equal(renderGrid('nope', 2), '<div class="ldm-grid" style="--ldm-cols:2"></div>');
});

test('nextTabKey wraps in both directions', () => {
  assert.equal(nextTabKey(TABS, 'notes', 1), 'main');
  assert.equal(nextTabKey(TABS, 'main', -1), 'notes');
  assert.equal(nextTabKey(TABS, 'main', 1), 'gear');
  assert.equal(nextTabKey(TABS, 'unknown', 1), 'main');
  assert.equal(nextTabKey(TABS, 'unknown', -1), 'notes');
});

test('firstTabKey, lastTabKey and empty tabs', () => {
  assert.equal(firstTabKey(TABS), 'main');
  assert.equal(lastTabKey(TABS), 'notes');
  assert.equal(firstTabKey([]), null);
  assert.equal(lastTabKey([]), null);
  assert.equal(nextTabKey([], 'x', 1), null);
});

test('handleTabEvent: click selects the tab, ignores unknown and non-tab targets', () => {
  const state = { tabs: TABS, activeKey: 'main' };
  assert.equal(handleTabEvent({ type: 'click', target: tabTarget('gear') }, state), 'gear');
  assert.equal(handleTabEvent({ type: 'click', target: tabTarget('nope') }, state), null);
  assert.equal(handleTabEvent({ type: 'click', target: nonTabTarget }, state), null);
});

test('handleTabEvent: arrows, Home and End on a focused tab', () => {
  const state = { tabs: TABS, activeKey: 'main' };
  const key = (k, tab = 'main') => ({ type: 'keydown', key: k, target: tabTarget(tab) });
  assert.equal(handleTabEvent(key('ArrowRight'), state), 'gear');
  assert.equal(handleTabEvent(key('ArrowLeft'), state), 'notes');
  assert.equal(handleTabEvent(key('ArrowRight', 'notes'), state), 'main');
  assert.equal(handleTabEvent(key('Home', 'notes'), state), 'main');
  assert.equal(handleTabEvent(key('End'), state), 'notes');
});

test('handleTabEvent: unknown keys and keys outside a tab are ignored', () => {
  const state = { tabs: TABS, activeKey: 'main' };
  assert.equal(handleTabEvent({ type: 'keydown', key: 'a', target: tabTarget('main') }, state), null);
  assert.equal(handleTabEvent({ type: 'keydown', key: 'ArrowRight', target: nonTabTarget }, state), null);
  assert.equal(handleTabEvent({ type: 'mouseover', target: tabTarget('gear') }, state), null);
  assert.equal(handleTabEvent(null, state), null);
  assert.equal(handleTabEvent({ type: 'click', target: tabTarget('gear') }, null), null);
});

test('empty tabs never throw', () => {
  assert.equal(renderTabs({ tabs: [] }), '');
  assert.equal(renderTabs({}), '');
  assert.equal(renderTabs(), '');
  assert.equal(handleTabEvent({ type: 'click', target: tabTarget('x') }, { tabs: [], activeKey: null }), null);
  assert.equal(handleTabEvent({ type: 'keydown', key: 'Home', target: tabTarget('x') }, { tabs: [] }), null);
});

test('renderBlock class names are declared in the stylesheet', () => {
  const css = readRepo('styles/sandbox-layout.css');
  const markup = [
    renderTabs({ idPrefix: 'p', tabs: TABS, panels: PANELS }),
    renderTabs({ tabs: [TABS[0]], panels: PANELS }),
    renderGrid([renderBlock({ key: 'k', title: 'T', body: 'b' })], 2),
  ].join('');
  const names = new Set();
  for (const m of markup.matchAll(/class="([^"]*)"/g)) {
    for (const name of m[1].split(/\s+/)) if (name) names.add(name);
  }
  assert.ok(names.size >= 8);
  for (const name of names) {
    assert.match(css, new RegExp(`\\.${name}(?![A-Za-z0-9_-])`), `missing .${name} in CSS`);
  }
});

const en = JSON.parse(readRepo('i18n/layout.en.json'));
const pt = JSON.parse(readRepo('i18n/layout.pt-BR.json'));

test('i18n files have identical key sets and the expected keys', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(pt).sort());
  for (const key of Object.keys(en)) {
    assert.ok(key.startsWith('sandbox.layout.'), key);
    assert.equal(typeof en[key], 'string');
    assert.ok(en[key].length > 0 && pt[key].length > 0, `empty value for ${key}`);
  }
  const required = [
    'sandbox.layout.tablist',
    'sandbox.layout.block.resources',
    'sandbox.layout.block.attributes',
    'sandbox.layout.block.skills',
    'sandbox.layout.block.items_gear',
    'sandbox.layout.block.items_ability',
    'sandbox.layout.block.items_spell',
    'sandbox.layout.block.items_other',
    'sandbox.layout.block.notes',
    'sandbox.layout.block.effects',
    'sandbox.layout.item.details',
    'sandbox.layout.item.uses',
    'sandbox.layout.item.roll',
    'sandbox.layout.item.cost',
    'sandbox.layout.item.description',
    'sandbox.layout.item.effects',
  ];
  for (const key of required) {
    assert.ok(key in en, `en missing ${key}`);
    assert.ok(key in pt, `pt-BR missing ${key}`);
  }
  assert.equal(en['sandbox.layout.block.effects'], 'Effects');
  assert.equal(pt['sandbox.layout.block.effects'], 'Efeitos');
  assert.equal(en['sandbox.layout.item.effects'], 'Effects');
  assert.equal(pt['sandbox.layout.item.effects'], 'Efeitos');
});

test('every sandbox.layout key mentioned by the module and CSS exists', () => {
  const sources = [readRepo('lib/layout-view.mjs'), readRepo('styles/sandbox-layout.css')];
  const mentioned = new Set();
  for (const src of sources) {
    for (const m of src.matchAll(/sandbox\.layout\.[A-Za-z0-9_.:-]+/g)) {
      mentioned.add(m[0].replace(/\.+$/, ''));
    }
  }
  assert.ok(mentioned.has('sandbox.layout.tablist'));
  for (const key of mentioned) {
    assert.ok(key in en, `mentioned key ${key} missing from i18n`);
  }
});

/** Splits CSS (comments removed) into innermost rules: { selector, body }. */
function cssRules(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push({ selector: m[1].trim(), body: m[2] });
  }
  return rules;
}

test('theme variables are never declared on component rules (outside density)', () => {
  const css = readRepo('styles/sandbox-layout.css');
  const restricted = /--ldm-(accent|gap|pad|radius|surface|border|text|muted)\s*:/;
  const component = /\.ldm-(tabs|grid|block)(?![\w-])/;
  let checked = 0;
  for (const rule of cssRules(css)) {
    if (rule.selector.includes('ldm-density-')) continue;
    if (!component.test(rule.selector)) continue;
    checked++;
    for (const line of rule.body.split('\n')) {
      assert.equal(restricted.test(line), false, `"${line.trim()}" declared in rule "${rule.selector}"`);
    }
  }
  assert.ok(checked > 0, 'expected component rules to be checked');
});

test('every var(--ldm-*) use has a fallback', () => {
  const css = readRepo('styles/sandbox-layout.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const uses = [...css.matchAll(/var\(\s*--ldm-[\w-]+\s*(\)|,)/g)].map((m) => m[1]);
  assert.ok(uses.length > 10, 'expected var(--ldm-*) uses in the stylesheet');
  assert.ok(uses.every((ending) => ending === ','), 'a var(--ldm-*) use has no fallback');
});

// Block-to-key mapping comes from the real config module, so the test fails if the two drift.
import { LAYOUT_BLOCKS, ITEM_LAYOUT_BLOCKS, blockLabelKey } from '../lib/config.mjs';

test('every actor block has a label key in both i18n files', () => {
  for (const block of LAYOUT_BLOCKS) {
    const key = blockLabelKey(block);
    assert.ok(key.startsWith('sandbox.layout.block.'), `${block} -> ${key}`);
    assert.ok(key in en, `en missing ${key} for block ${block}`);
    assert.ok(key in pt, `pt-BR missing ${key} for block ${block}`);
  }
});

test('every item block has a label key in both i18n files', () => {
  for (const block of ITEM_LAYOUT_BLOCKS) {
    const key = blockLabelKey(block, 'item');
    assert.ok(key.startsWith('sandbox.layout.item.'), `${block} -> ${key}`);
    assert.ok(key in en, `en missing ${key} for item block ${block}`);
    assert.ok(key in pt, `pt-BR missing ${key} for item block ${block}`);
  }
});

test('no sandbox.layout.block.* or sandbox.layout.item.* key is unused', () => {
  const used = new Set([
    ...LAYOUT_BLOCKS.map((b) => blockLabelKey(b)),
    ...ITEM_LAYOUT_BLOCKS.map((b) => blockLabelKey(b, 'item')),
  ]);
  for (const key of Object.keys(en)) {
    if (!key.startsWith('sandbox.layout.block.') && !key.startsWith('sandbox.layout.item.')) continue;
    assert.ok(used.has(key), `${key} is not used by any layout block`);
  }
  for (const key of Object.keys(pt)) {
    if (!key.startsWith('sandbox.layout.block.') && !key.startsWith('sandbox.layout.item.')) continue;
    assert.ok(used.has(key), `pt-BR ${key} is not used by any layout block`);
  }
});
