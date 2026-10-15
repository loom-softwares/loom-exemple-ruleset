import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  renderEditor,
  renderPreview,
  moveRow,
  removeRow,
  addRow,
  updateRow,
  newRowTemplate,
  draftFromConfig,
  configFromDraft,
  draftErrors,
  baselineOf,
  isDirty,
  createEditorState,
  setPath,
  moveBlock,
  addBlock,
  removeBlock,
  addTab,
  removeTab,
  moveTab,
  unplacedBlocks,
  tabKeyFor,
  renderLayoutPreview,
  RuleEditorWindow,
} from '../windows/rule-editor.mjs';
import { defaultConfig, PRESETS, validateConfig, LAYOUT_BLOCKS, ITEM_LAYOUT_BLOCKS } from '../lib/config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function stateFor(cfg = defaultConfig(), extra = {}) {
  return { ...createEditorState(cfg), ...extra };
}

function saveButton(html) {
  const m = html.match(/<button[^>]*data-action="ed-save"[^>]*>/);
  return m ? m[0] : '';
}

// ---------------------------------------------------------------------------
// Escaping of hostile config text
// ---------------------------------------------------------------------------

test('renderEditor escapes hostile labels in every list', () => {
  const cfg = defaultConfig();
  cfg.attributes[0].label = '<img src=x onerror=x>';
  cfg.skills[0].label = '"><script>alert(1)</script>';
  cfg.resources[0].label = '<b onmouseover="x">hp</b>';
  cfg.itemCategories[0].label = '<svg onload=x>';
  const html = renderEditor(stateFor(cfg));
  assert.ok(!html.includes('<img src=x'), 'raw img tag must not be rendered');
  assert.ok(!html.includes('<script'), 'raw script tag must not be rendered');
  assert.ok(!html.includes('<svg onload'), 'raw svg tag must not be rendered');
  assert.ok(!html.includes('<b onmouseover'), 'raw b tag must not be rendered');
  assert.ok(html.includes('&lt;img src=x onerror=x&gt;'));
  assert.ok(html.includes('&quot;&gt;&lt;script&gt;'));
});

test('renderEditor escapes hostile system name and card header text', () => {
  const cfg = defaultConfig();
  cfg.name = '"><img src=x onerror=alert(1)>';
  cfg.card.header = '<script>x</script> {actor}';
  const html = renderEditor(stateFor(cfg));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('<script>x</script>'));
});

test('renderEditor escapes text typed in an unsaved draft', () => {
  const state = stateFor();
  state.draft.attributes[0].label = '<img src=x onerror=x>';
  state.draft.attributes[0].key = '"><script>';
  const html = renderEditor(state);
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('"><script>'));
});

test('renderEditor escapes the notice and import text', () => {
  const state = stateFor();
  state.notice = { kind: 'error', text: '<img src=x onerror=x>' };
  state.importText = '</textarea><img src=x onerror=x>';
  const html = renderEditor(state);
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;/textarea&gt;'));
});

// ---------------------------------------------------------------------------
// Empty states, errors, read-only, modes
// ---------------------------------------------------------------------------

test('an empty list renders the empty state and an enabled Add button', () => {
  const cfg = defaultConfig();
  cfg.attributes = [];
  const html = renderEditor(stateFor(cfg));
  assert.ok(html.includes('ldm-editor-empty'));
  assert.match(html, /data-action="ed-add" data-list="attributes">/);
});

test('validation errors disable Save', () => {
  const state = stateFor();
  state.draft.attributes[0].label = '';
  assert.ok(draftErrors(state.draft).length > 0);
  assert.match(saveButton(renderEditor(state)), /disabled/);
});

test('a valid draft keeps Save enabled', () => {
  const html = renderEditor(stateFor());
  assert.ok(draftErrors(stateFor().draft).length === 0);
  assert.doesNotMatch(saveButton(html), /disabled/);
});

test('duplicate item kind keys are an error and disable Save', () => {
  const state = stateFor();
  state.draft.abilityKinds = [{ key: 'ability', label: 'A' }, { key: 'ability', label: 'B' }];
  assert.ok(draftErrors(state.draft).some((e) => /unique/i.test(e)));
  assert.match(saveButton(renderEditor(state)), /disabled/);
});

test('read-only state shows the notice and no editing controls', () => {
  const html = renderEditor(createEditorState(defaultConfig(), { readOnly: true }));
  assert.ok(html.includes('ldm-editor-notice'));
  assert.ok(!html.includes('data-action="ed-save"'));
  assert.ok(!html.includes('data-field='));
});

test('dice mode switch shows only the fields of the selected mode', () => {
  const d20 = stateFor(PRESETS.d20Classic());
  const dHtml = renderEditor(d20);
  assert.ok(dHtml.includes('data-field="dice.d20.sides"'));
  assert.ok(!dHtml.includes('data-field="dice.pool.faces"'));

  const pool = stateFor(PRESETS.d6Pool());
  const pHtml = renderEditor(pool);
  assert.ok(pHtml.includes('data-field="dice.pool.faces"'));
  assert.ok(!pHtml.includes('data-field="dice.d20.sides"'));
});

test('the dice summary is the live describe() text of the active mode', () => {
  assert.ok(renderEditor(stateFor(PRESETS.d20Classic())).includes('Single check'));
  assert.ok(renderEditor(stateFor(PRESETS.d6Pool())).includes('Dice pool'));
});

test('keys of saved rows are fixed, keys of new rows are editable with a hint', () => {
  const state = stateFor();
  const html = renderEditor(state);
  assert.ok(!html.includes('data-field="key"'), 'saved rows must not expose an editable key');
  const fresh = stateFor();
  const row = fresh.draft.attributes[0];
  fresh.keyEditable.add(row);
  fresh.autoKey.add(row);
  const freshHtml = renderEditor(fresh);
  assert.ok(freshHtml.includes('data-field="key"'));
  assert.ok(freshHtml.includes('Created from the label'));
});

test('a loading state renders only the loading text', () => {
  const html = renderEditor({ loading: true });
  assert.ok(html.includes('ldm-editor-empty'));
  assert.ok(!html.includes('data-action="ed-save"'));
});

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

test('moveRow swaps with the neighbour and ignores out-of-range moves', () => {
  const list = [{ k: 'a' }, { k: 'b' }, { k: 'c' }];
  assert.deepEqual(moveRow(list, 0, 1).map((r) => r.k), ['b', 'a', 'c']);
  assert.deepEqual(moveRow(list, 2, -1).map((r) => r.k), ['a', 'c', 'b']);
  assert.deepEqual(moveRow(list, 0, -1).map((r) => r.k), ['a', 'b', 'c']);
  assert.deepEqual(moveRow(list, 2, 1).map((r) => r.k), ['a', 'b', 'c']);
  assert.deepEqual(moveRow(list, 9, 1).map((r) => r.k), ['a', 'b', 'c']);
  assert.deepEqual(moveRow(list, 1, 0).map((r) => r.k), ['a', 'b', 'c']);
});

test('moveRow and removeRow return new arrays and keep row identity', () => {
  const list = [{ k: 'a' }, { k: 'b' }];
  const moved = moveRow(list, 0, 1);
  assert.notEqual(moved, list);
  assert.equal(moved[0], list[1]);
  const removed = removeRow(list, 0);
  assert.equal(list.length, 2, 'input is not mutated');
  assert.equal(removed.length, 1);
  assert.equal(removed[0], list[1]);
});

test('removeRow removes one row and ignores invalid indexes', () => {
  const list = [{ k: 'a' }, { k: 'b' }];
  assert.deepEqual(removeRow(list, 1).map((r) => r.k), ['a']);
  assert.deepEqual(removeRow(list, 5).map((r) => r.k), ['a', 'b']);
  assert.deepEqual(removeRow(list, -1).map((r) => r.k), ['a', 'b']);
  assert.deepEqual(removeRow(undefined, 0), []);
});

test('addRow appends a deep copy of the template and respects the maximum', () => {
  const template = { key: '', label: '', min: 0 };
  const list = [{ key: 'x', label: 'X', min: 1 }];
  const next = addRow(list, template, 5);
  assert.equal(next.length, 2);
  assert.notEqual(next[1], template, 'template must be copied');
  next[1].label = 'changed';
  assert.equal(template.label, '');
  assert.equal(addRow(list, template, 1).length, 1, 'no row added beyond the maximum');
});

test('updateRow sets one field in place and keeps identity', () => {
  const list = [{ key: 'a', label: 'A' }];
  const row = list[0];
  const next = updateRow(list, 0, 'label', 'B');
  assert.equal(next[0], row);
  assert.equal(row.label, 'B');
});

test('newRowTemplate points a new skill at the first attribute', () => {
  const draft = draftFromConfig(defaultConfig());
  assert.equal(newRowTemplate('skills', draft).attr, 'might');
  assert.equal(newRowTemplate('attributes', draft).key, '');
  assert.equal(newRowTemplate('unknown', draft), null);
});

test('setPath writes nested fields and creates missing objects', () => {
  const obj = { dice: {} };
  setPath(obj, 'dice.d20.sides', 12);
  assert.equal(obj.dice.d20.sides, 12);
});

// ---------------------------------------------------------------------------
// Draft and dirty state
// ---------------------------------------------------------------------------

test('a loaded config is not dirty and round-trips through the draft', () => {
  for (const make of Object.values(PRESETS)) {
    const cfg = make();
    const state = createEditorState(cfg);
    assert.equal(isDirty(state), false);
    assert.equal(baselineOf(cfg), JSON.stringify(configFromDraft(state.draft)));
    assert.deepEqual(validateConfig(configFromDraft(state.draft)).config, validateConfig(cfg).config);
  }
});

test('editing the draft makes it dirty', () => {
  const state = stateFor();
  state.draft.name = 'Changed';
  assert.equal(isDirty(state), true);
});

test('ability kinds are stored as an object in the config and as rows in the draft', () => {
  const draft = draftFromConfig(defaultConfig());
  assert.ok(Array.isArray(draft.abilityKinds));
  assert.deepEqual(configFromDraft(draft).abilityKinds, { ability: 'Ability', spell: 'Spell' });
});

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

test('preview escapes a hostile header and accent', () => {
  const cfg = defaultConfig();
  cfg.card.header = '<img src=x onerror=alert(1)> {actor}';
  cfg.card.accent = '"><script>x</script>';
  const html = renderPreview(cfg);
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('<script>x'));
  assert.ok(html.includes('&lt;img src=x'));
});

test('preview substitutes the header tokens with a sample roll', () => {
  const cfg = defaultConfig();
  cfg.card.header = '{actor}: {label}';
  const html = renderPreview(cfg);
  assert.ok(html.includes('Sample hero: Melee'));
});

test('preview hides formula and dice when the config says so', () => {
  const cfg = defaultConfig();
  cfg.card.showFormula = false;
  cfg.card.showDice = false;
  const html = renderPreview(cfg);
  assert.ok(!html.includes('ldm-editor-preview-formula'));
  assert.ok(!html.includes('ldm-editor-preview-dice'));
});

test('preview of the pool mode reports successes', () => {
  const html = renderPreview(PRESETS.d6Pool());
  assert.match(html, /successes/);
  assert.ok(html.includes('ldm-editor-preview-result'));
});

// ---------------------------------------------------------------------------
// i18n coverage (every key used in code exists in both language files)
// ---------------------------------------------------------------------------

test('every sandbox.editor key used in code exists in both language files', () => {
  const source = readFileSync(join(root, 'windows', 'rule-editor.mjs'), 'utf8');
  const used = new Set([...source.matchAll(/'(sandbox\.editor\.[A-Za-z0-9_.]+)'/g)].map((m) => m[1]));
  const en = JSON.parse(readFileSync(join(root, 'i18n', 'editor.en.json'), 'utf8'));
  const pt = JSON.parse(readFileSync(join(root, 'i18n', 'editor.pt-BR.json'), 'utf8'));
  for (const key of used) {
    assert.ok(key in en, `missing in en: ${key}`);
    assert.ok(key in pt, `missing in pt-BR: ${key}`);
  }
  assert.deepEqual(Object.keys(pt).sort(), Object.keys(en).sort(), 'both files hold the same keys');
});

// ---------------------------------------------------------------------------
// Layout helpers (pure): moveBlock, addBlock, removeBlock, addTab, removeTab, moveTab, unplacedBlocks
// ---------------------------------------------------------------------------

function tabsOf(...specs) {
  return specs.map(([key, label, blocks, columns = 2]) => ({ key, label, columns, blocks: [...blocks] }));
}

const blockKeysOf = (tabs) => tabs.map((tab) => tab.blocks);

test('moveBlock swaps a block with its neighbour inside one tab', () => {
  const tabs = tabsOf(['a', 'A', ['resources', 'attributes', 'skills']], ['b', 'B', ['notes']]);
  assert.deepEqual(blockKeysOf(moveBlock(tabs, 0, 0, 1)), [['attributes', 'resources', 'skills'], ['notes']]);
  assert.deepEqual(blockKeysOf(moveBlock(tabs, 0, 2, -1)), [['resources', 'skills', 'attributes'], ['notes']]);
});

test('moveBlock ignores first-up, last-down, bad indexes and does not touch other tabs', () => {
  const tabs = tabsOf(['a', 'A', ['resources', 'skills']], ['b', 'B', ['notes']]);
  assert.deepEqual(blockKeysOf(moveBlock(tabs, 0, 0, -1)), [['resources', 'skills'], ['notes']]);
  assert.deepEqual(blockKeysOf(moveBlock(tabs, 0, 1, 1)), [['resources', 'skills'], ['notes']]);
  assert.deepEqual(blockKeysOf(moveBlock(tabs, 9, 0, 1)), [['resources', 'skills'], ['notes']]);
  assert.deepEqual(blockKeysOf(moveBlock(tabs, 0, 7, 1)), [['resources', 'skills'], ['notes']]);
  assert.deepEqual(moveBlock(undefined, 0, 0, 1), []);
});

test('moveBlock returns a new list and keeps tab identity', () => {
  const tabs = tabsOf(['a', 'A', ['resources', 'skills']], ['b', 'B', ['notes']]);
  const next = moveBlock(tabs, 0, 0, 1);
  assert.notEqual(next, tabs);
  assert.notEqual(next[0], tabs[0], 'the edited tab is a new object');
  assert.equal(next[1], tabs[1], 'other tabs keep their identity');
  assert.deepEqual(tabs[0].blocks, ['resources', 'skills'], 'the input is not mutated');
});

test('addBlock appends to a tab and refuses a block already placed anywhere in the list', () => {
  const tabs = tabsOf(['a', 'A', ['resources']], ['b', 'B', ['notes']]);
  assert.deepEqual(blockKeysOf(addBlock(tabs, 0, 'skills')), [['resources', 'skills'], ['notes']]);
  assert.deepEqual(blockKeysOf(addBlock(tabs, 0, 'notes')), [['resources'], ['notes']], 'duplicate on the same list refused');
  assert.deepEqual(blockKeysOf(addBlock(tabs, 1, 'resources')), [['resources'], ['notes']], 'duplicate across tabs refused');
});

test('addBlock refuses bad tab indexes, empty or non-text blocks and the per-tab maximum', () => {
  const tabs = tabsOf(['a', 'A', ['resources']]);
  assert.deepEqual(blockKeysOf(addBlock(tabs, 4, 'skills')), [['resources']]);
  assert.deepEqual(blockKeysOf(addBlock(tabs, 0, '')), [['resources']]);
  assert.deepEqual(blockKeysOf(addBlock(tabs, 0, null)), [['resources']]);
  const full = tabsOf(['a', 'A', Array.from({ length: 12 }, (_, i) => `b${i}`)]);
  assert.equal(addBlock(full, 0, 'extra')[0].blocks.length, 12, 'the 13th block is refused');
});

test('removeBlock removes one block and ignores bad indexes', () => {
  const tabs = tabsOf(['a', 'A', ['resources', 'skills', 'notes']]);
  assert.deepEqual(blockKeysOf(removeBlock(tabs, 0, 1)), [['resources', 'notes']]);
  assert.deepEqual(blockKeysOf(removeBlock(tabs, 0, 5)), [['resources', 'skills', 'notes']]);
  assert.deepEqual(blockKeysOf(removeBlock(tabs, 3, 0)), [['resources', 'skills', 'notes']]);
});

test('addTab appends an empty two-column tab keyed from the label, with unique keys', () => {
  const tabs = tabsOf(['main', 'Main', ['resources']]);
  const once = addTab(tabs, 'New tab');
  assert.equal(once.length, 2);
  assert.deepEqual(once[1], { key: 'new_tab', label: 'New tab', columns: 2, blocks: [] });
  assert.equal(addTab(once, 'New tab')[2].key, 'new_tab_2');
  assert.equal(addTab(tabs, '   ')[1].label, 'Tab', 'a blank label gets the default name');
  assert.equal(addTab(tabs, '')[1].key, 'tab');
});

test('addTab refuses tabs beyond the maximum of 8', () => {
  let tabs = tabsOf(['main', 'Main', []]);
  for (let i = 0; i < 20; i++) tabs = addTab(tabs, `Tab ${i}`);
  assert.equal(tabs.length, 8);
});

test('removeTab removes one tab and never removes the last one', () => {
  const tabs = tabsOf(['a', 'A', ['resources']], ['b', 'B', ['notes']]);
  assert.deepEqual(removeTab(tabs, 0).map((t) => t.key), ['b']);
  assert.deepEqual(removeTab(removeTab(tabs, 0), 0).map((t) => t.key), ['b'], 'the last tab stays');
  assert.deepEqual(removeTab(tabs, 5).map((t) => t.key), ['a', 'b']);
});

test('moveTab reorders tabs and ignores first-up and last-down', () => {
  const tabs = tabsOf(['a', 'A', []], ['b', 'B', []], ['c', 'C', []]);
  assert.deepEqual(moveTab(tabs, 2, -1).map((t) => t.key), ['a', 'c', 'b']);
  assert.deepEqual(moveTab(tabs, 0, -1).map((t) => t.key), ['a', 'b', 'c']);
  assert.deepEqual(moveTab(tabs, 2, 1).map((t) => t.key), ['a', 'b', 'c']);
});

test('unplacedBlocks lists the blocks no tab shows, in the order of allBlocks', () => {
  assert.deepEqual(unplacedBlocks(defaultConfig().layout.tabs, LAYOUT_BLOCKS), [], 'the default actor tabs place every block');
  assert.deepEqual(unplacedBlocks(defaultConfig().layout.itemTabs, ITEM_LAYOUT_BLOCKS), []);
  const tabs = tabsOf(['a', 'A', ['resources', 'notes']], ['b', 'B', ['skills']]);
  assert.deepEqual(unplacedBlocks(tabs, LAYOUT_BLOCKS), ['attributes', 'saves', 'attacks', 'magic', 'items:gear', 'items:ability', 'items:spell', 'items:other', 'effects']);
  assert.deepEqual(unplacedBlocks(undefined, ['notes']), ['notes']);
  assert.deepEqual(unplacedBlocks(tabs, undefined), []);
});

test('tabKeyFor builds a valid, unique key and skips the tab being renamed', () => {
  const tabs = tabsOf(['main', 'Main', []], ['gear_2', 'Gear', []]);
  assert.equal(tabKeyFor(tabs, 'Main Tab'), 'main_tab');
  assert.equal(tabKeyFor(tabs, 'Main'), 'main_2');
  assert.equal(tabKeyFor(tabs, 'Main', 0), 'main', 'renaming tab 0 may keep its own key');
  assert.equal(tabKeyFor(tabs, '123 !!!'), 'tab');
  assert.match(tabKeyFor(tabs, 'x'.repeat(60)), /^[a-z][a-z0-9_]{0,23}$/);
});

// ---------------------------------------------------------------------------
// Layout section rendering
// ---------------------------------------------------------------------------

function customLayoutConfig() {
  const cfg = defaultConfig();
  cfg.layout = {
    density: 'compact',
    skillGrouping: 'group',
    tabs: [
      { key: 'core', label: 'Core', columns: 3, blocks: ['resources'] },
      { key: 'more', label: 'More', columns: 1, blocks: ['notes', 'effects'] },
    ],
    itemTabs: defaultConfig().layout.itemTabs,
  };
  return cfg;
}

test('the Layout section renders both sheets with their tabs and blocks for the default config', () => {
  const html = renderEditor(stateFor());
  assert.ok(html.includes('data-ldm-layout="actor"'));
  assert.ok(html.includes('data-ldm-layout="item"'));
  assert.ok(html.includes('value="Main"'), 'tab label is shown in its input');
  assert.ok(html.includes('>Resources</span>'), 'a block is shown by its name, not its id');
  assert.ok(!html.includes('items:gear</span>'), 'raw block ids are never shown as chips');
  assert.ok(html.includes('No blocks left to add.'), 'every block is placed, so nothing can be added');
});

test('a custom layout shows its density, grouping and only the blocks that are free to add', () => {
  const html = renderEditor(stateFor(customLayoutConfig()));
  assert.match(html, /<option value="compact" selected>/);
  assert.match(html, /<option value="group" selected>/);
  assert.match(html, /<option value="skills">Skills<\/option>/);
  assert.doesNotMatch(html, /<option value="resources">/, 'a placed block is not offered');
  assert.doesNotMatch(html, /<option value="notes">/, 'a block on another tab is not offered');
});

test('unplaced blocks are listed in a notice that names the first tab', () => {
  const cfg = defaultConfig();
  cfg.layout.tabs[2].blocks = ['items:gear', 'items:other'];
  const html = renderEditor(stateFor(cfg));
  assert.ok(html.includes('Not on any tab: Magic.'), 'the notice names the unplaced block');
  assert.ok(html.includes('&quot;Main&quot;'), 'the notice names the tab that shows it');
  assert.ok(html.includes('Effects is always shown'), 'the effects note is always shown');
});

test('a hostile tab label is escaped in the tab bar and the input', () => {
  const cfg = defaultConfig();
  cfg.layout.tabs[0].label = '<img src=x onerror=x>';
  const html = renderEditor(stateFor(cfg));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img src=x onerror=x&gt;'));
});

test('a hostile attribute and skill group is escaped', () => {
  const cfg = defaultConfig();
  cfg.attributes[1].group = '"><script>x</script>';
  cfg.skills[0].group = '<b onmouseover="x">g</b>';
  const html = renderEditor(stateFor(cfg));
  assert.ok(!html.includes('<script>x</script>'));
  assert.ok(!html.includes('<b onmouseover'));
  assert.ok(html.includes('&quot;&gt;&lt;script&gt;x&lt;/script&gt;'));
});

test('group inputs are on every attribute and skill row, bound to that row', () => {
  const cfg = defaultConfig();
  const html = renderEditor(stateFor(cfg));
  for (let i = 0; i < cfg.attributes.length; i++) {
    assert.match(html, new RegExp(`data-field="group"[^>]*data-list="attributes" data-index="${i}"`));
  }
  for (let i = 0; i < cfg.skills.length; i++) {
    assert.match(html, new RegExp(`data-field="group"[^>]*data-list="skills" data-index="${i}"`));
  }
  assert.ok(html.includes('placeholder="optional"'));
});

test('each attribute has an optional d20 modifier checkbox saved on that row', () => {
  const win = new RuleEditorWindow();
  win.editorState.readOnly = false;
  const html = renderEditor(stateFor());
  assert.match(html, /data-field="useD20Modifier"[^>]*data-list="attributes" data-index="0"/);
  win.applyField({ type: 'checkbox', checked: true, dataset: { list: 'attributes', index: '0', field: 'useD20Modifier' } });
  assert.equal(win.editorState.draft.attributes[0].useD20Modifier, true);
  assert.equal(win.editorState.draft.attributes[1].useD20Modifier, false);
});

test('blank optional save difficulty remains null instead of becoming zero', () => {
  const win = new RuleEditorWindow();
  win.editorState.readOnly = false;
  win.editorState.draft.saves.entries.push({ key: 'will', label: 'Will', sources: [], bonus: 0, target: 12, showOnSheet: true });
  win.applyField({ type: 'number', value: '', dataset: { nestedList: 'saves.entries', index: '0', field: 'target', nullableNumber: 'true' } });
  assert.equal(win.editorState.draft.saves.entries[0].target, null);
});

test('attribute display selection is part of the system draft and layout has a visible sheet preview', () => {
  const win = new RuleEditorWindow();
  win.editorState.readOnly = false;
  win.applyField({ type: 'select-one', value: 'dots', dataset: { field: 'attributeDisplay' } });
  assert.equal(win.editorState.draft.attributeDisplay, 'dots');
  const html = renderEditor(stateFor());
  assert.match(html, /data-field="attributeDisplay"/);
  assert.match(html, /Sheet preview/);
  assert.match(html, /ldm-editor-layout-preview/);
});

test('applying a group edit changes only the row it belongs to', () => {
  const win = new RuleEditorWindow();
  win.editorState.readOnly = false;
  const el = (list, index, field, value) => ({ type: 'text', value, dataset: { list, index: String(index), field } });
  win.applyField(el('attributes', 1, 'group', 'Mind'));
  win.applyField(el('skills', 2, 'group', 'Field'));
  assert.equal(win.editorState.draft.attributes[1].group, 'Mind');
  assert.equal(win.editorState.draft.attributes[0].group, '');
  assert.equal(win.editorState.draft.skills[2].group, 'Field');
  assert.equal(win.editorState.draft.skills[0].group, '');
  assert.equal(isDirty(win.editorState), true);
});

test('a blur/change fired during refresh cannot start a nested editor update', () => {
  const win = new RuleEditorWindow();
  win.editorState.readOnly = false;
  win.element = {};
  const previous = win.editorState.draft.attributes[0].label;
  let renderCount = 0;
  win.rerenderBody = () => {
    renderCount++;
    win.onFieldEvent({
      target: { type: 'text', value: 'stale blur value', dataset: { list: 'attributes', index: '0', field: 'label' } },
    }, true);
  };

  win.refresh();

  assert.equal(renderCount, 1, 'the blur event must not re-enter the render');
  assert.equal(win.editorState.draft.attributes[0].label, previous, 'a detached field must not overwrite the draft');
});

test('validation errors of the layout are shown and disable Save', () => {
  const dupKey = stateFor();
  dupKey.draft.layout.tabs[1].key = dupKey.draft.layout.tabs[0].key;
  assert.ok(draftErrors(dupKey.draft).some((e) => /duplicate key/.test(e)));
  const dupKeyHtml = renderEditor(dupKey);
  assert.match(saveButton(dupKeyHtml), /disabled/);
  assert.ok(dupKeyHtml.includes('duplicate key'), 'the error is listed');

  const dupBlock = stateFor();
  dupBlock.draft.layout.tabs[1].blocks = ['resources'];
  assert.ok(draftErrors(dupBlock.draft).length > 0);
  assert.match(saveButton(renderEditor(dupBlock)), /disabled/);
});

test('new tabs have an editable key with the auto-slug hint; saved tabs show a fixed key', () => {
  const saved = renderEditor(stateFor());
  assert.ok(!saved.includes('data-field="key"'), 'saved tabs expose no editable key');
  const fresh = stateFor();
  const tab = fresh.draft.layout.tabs[0];
  fresh.keyEditable.add(tab);
  fresh.autoKey.add(tab);
  const freshHtml = renderEditor(fresh);
  assert.match(freshHtml, /data-field="key"[^>]*data-tab-list="tabs" data-index="0"/);
  assert.ok(freshHtml.includes('Created from the label'));
});

test('the layout preview is a schematic of the effective tabs, escaped and hidden from assistive tech', () => {
  const cfg = customLayoutConfig();
  cfg.layout.tabs[0].label = '"><img src=x onerror=x>';
  const html = renderLayoutPreview(validateConfig(cfg).config.layout.tabs, 'actor');
  assert.match(html, /aria-hidden="true"/);
  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /--ldm-editor-cols:3/);
  assert.ok(html.includes('Resources'));
  assert.equal(renderLayoutPreview([], 'actor'), '');
});

test('the editor section tabs use the shared tabs standard with ARIA wiring', () => {
  const state = stateFor();
  state.section = 'layout';
  const html = renderEditor(state);
  assert.ok(html.includes('class="ldm-tablist" role="tablist" aria-label="Editor sections"'));
  assert.equal((html.match(/role="tab"/g) ?? []).length, 13, 'one tab per section');
  assert.equal((html.match(/role="tabpanel"/g) ?? []).length, 13, 'one panel per section');
  assert.match(html, /data-ldm-tab="layout"[^>]*aria-selected="true"/);
  assert.match(html, /data-ldm-tab="dice"[^>]*aria-selected="false"/);
  const controls = [...html.matchAll(/aria-controls="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(controls.length, 13);
  for (const id of controls) assert.ok(html.includes(`id="${id}"`), `panel ${id} exists`);
  const active = html.match(/<div class="ldm-tabpanel" role="tabpanel"[^>]*data-ldm-panel="layout"[^>]*>/);
  assert.ok(active && !active[0].includes(' hidden'), 'the active section panel is visible');
  const other = html.match(/<div class="ldm-tabpanel" role="tabpanel"[^>]*data-ldm-panel="dice"[^>]*>/);
  assert.ok(other && other[0].includes(' hidden'), 'other section panels are hidden');
});

test('section panels stay in the markup, so their fields keep their values across tab changes', () => {
  const html = renderEditor(stateFor(PRESETS.d6Pool()));
  assert.ok(html.includes('data-field="dice.pool.faces"'), 'the hidden Dice panel still holds its fields');
});

// ---------------------------------------------------------------------------
// Layout actions on the window (no element in Node, so refresh is a no-op)
// ---------------------------------------------------------------------------

function windowFor(cfg = defaultConfig()) {
  const win = new RuleEditorWindow();
  win.editorState = stateFor(cfg);
  return win;
}

test('ed-tab-add adds a tab keyed from its default label, marked new and auto-keyed', () => {
  const win = windowFor();
  win.onAction('ed-tab-add', null, { dataset: { tabList: 'tabs' } });
  const tabs = win.editorState.draft.layout.tabs;
  assert.equal(tabs.length, 7);
  assert.equal(tabs[6].key, 'new_tab');
  assert.ok(win.editorState.keyEditable.has(tabs[6]));
  assert.ok(win.editorState.autoKey.has(tabs[6]));
});

test('ed-tab-add refuses a ninth tab and an unknown tab list', () => {
  const win = windowFor();
  for (let i = 0; i < 10; i++) win.onAction('ed-tab-add', null, { dataset: { tabList: 'tabs' } });
  assert.equal(win.editorState.draft.layout.tabs.length, 8);
  win.onAction('ed-tab-add', null, { dataset: { tabList: 'nope' } });
  assert.equal(win.editorState.draft.layout.tabs.length, 8);
});

test('ed-tab-remove never removes the last tab', () => {
  const win = windowFor();
  win.onAction('ed-tab-remove', null, { dataset: { tabList: 'itemTabs', index: '0' } });
  assert.equal(win.editorState.draft.layout.itemTabs.length, 3);
  for (let i = 0; i < 6; i++) win.onAction('ed-tab-remove', null, { dataset: { tabList: 'itemTabs', index: '0' } });
  assert.equal(win.editorState.draft.layout.itemTabs.length, 1);
});

test('ed-tab-move reorders the tabs of the list it names', () => {
  const win = windowFor();
  win.onAction('ed-tab-move', null, { dataset: { tabList: 'tabs', index: '1', dir: '1' } });
  assert.deepEqual(win.editorState.draft.layout.tabs.map((t) => t.key), ['main', 'magic', 'attacks', 'powers', 'gear', 'effects']);
});

test('ed-block-move and ed-block-remove work on the block of one tab', () => {
  const win = windowFor();
  win.onAction('ed-block-move', null, { dataset: { tabList: 'tabs', index: '0', block: '0', dir: '1' } });
  assert.deepEqual(win.editorState.draft.layout.tabs[0].blocks, ['attributes', 'resources', 'skills', 'saves']);
  win.onAction('ed-block-remove', null, { dataset: { tabList: 'tabs', index: '0', block: '2' } });
  assert.deepEqual(win.editorState.draft.layout.tabs[0].blocks, ['attributes', 'resources', 'saves']);
});

test('ed-block-add places a free block chosen in the picker and refuses placed or unknown ones', () => {
  const win = windowFor();
  // Free "notes": take it off the Gear tab first.
  win.onAction('ed-block-remove', null, { dataset: { tabList: 'tabs', index: '4', block: '2' } });
  const target = (index, value) => ({
    dataset: { tabList: 'tabs', index: String(index) },
    parentElement: { querySelector: () => ({ value }) },
  });
  win.onAction('ed-block-add', null, target(0, 'notes'));
  assert.deepEqual(win.editorState.draft.layout.tabs[0].blocks, ['resources', 'attributes', 'skills', 'saves', 'notes']);
  win.onAction('ed-block-add', null, target(0, 'resources'));
  win.onAction('ed-block-add', null, target(0, 'items:gear'));
  win.onAction('ed-block-add', null, target(0, 'not-a-block'));
  assert.equal(win.editorState.draft.layout.tabs[0].blocks.length, 5, 'placed and unknown blocks are refused');
  const gearCount = win.editorState.draft.layout.tabs.filter((t) => t.blocks.includes('items:gear')).length;
  assert.equal(gearCount, 1, 'items:gear stays on exactly one tab');
});

test('a new tab label types the key until the GM edits the key', () => {
  const win = windowFor();
  win.onAction('ed-tab-add', null, { dataset: { tabList: 'tabs' } });
  const index = win.editorState.draft.layout.tabs.length - 1;
  const field = (value, name) => ({ type: 'text', value, dataset: { tabList: 'tabs', index: String(index), field: name } });
  win.applyField(field('Night Owl', 'label'));
  assert.equal(win.editorState.draft.layout.tabs[index].label, 'Night Owl');
  assert.equal(win.editorState.draft.layout.tabs[index].key, 'night_owl');
  win.applyField(field('owls', 'key'));
  assert.equal(win.editorState.draft.layout.tabs[index].key, 'owls');
  win.applyField(field('Dusk', 'label'));
  assert.equal(win.editorState.draft.layout.tabs[index].key, 'owls', 'a key the GM edited is not overwritten');
});

test('columns and density edits reach the draft and the draft stays valid', () => {
  const win = windowFor();
  win.applyField({ type: 'select-one', value: '4', dataset: { tabList: 'tabs', index: '0', field: 'columns' } });
  assert.equal(win.editorState.draft.layout.tabs[0].columns, 4);
  win.applyField({ type: 'select-one', value: 'compact', dataset: { field: 'layout.density' } });
  assert.equal(win.editorState.draft.layout.density, 'compact');
  assert.ok(validateConfig(configFromDraft(win.editorState.draft)).ok);
});
