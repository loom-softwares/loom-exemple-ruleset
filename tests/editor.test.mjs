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
} from '../windows/rule-editor.mjs';
import { defaultConfig, PRESETS, validateConfig } from '../lib/config.mjs';

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
