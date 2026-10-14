// Tests for lib/effects-view.mjs. No DOM: the engine is a fake window.Loom and the root is a fake
// with a recorded listener list. Run with: node --test tests/effects-view.test.mjs
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  EFFECT_MODES,
  normalizeEffect,
  effectSummary,
  renderEffectsBlock,
  loadEffects,
  attachEffects,
  getEffectsEditState,
  isSafeIcon,
  planItemEffectsApplication,
  applyItemEffects,
  ITEM_EFFECT_LIMIT,
} from '../lib/effects-view.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const VALID = Object.freeze({
  name: 'Shield',
  origin: 'Ring',
  icon: '/icons/shield.png',
  duration: 3,
  disabled: false,
  changes: [{ key: 'armor', mode: 'add', value: 2 }],
});

// ── normalizeEffect ─────────────────────────────────────────────

describe('normalizeEffect', () => {
  test('accepts a valid effect and returns only the known fields', () => {
    const result = normalizeEffect({ ...VALID, id: 'buff-1', worldId: 'w', actorId: 'a', extra: { deep: true } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.effect, VALID);
  });

  test('defaults: missing duration is permanent, missing flags are off, missing changes are empty', () => {
    const result = normalizeEffect({ name: 'Bare' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.effect, { name: 'Bare', origin: '', icon: '', duration: -1, disabled: false, changes: [] });
  });

  test('name is required and limited to 60 characters', () => {
    assert.equal(normalizeEffect({ name: '' }).ok, false);
    assert.equal(normalizeEffect({ name: '   ' }).ok, false);
    assert.equal(normalizeEffect({}).ok, false);
    assert.equal(normalizeEffect({ name: 'a'.repeat(60) }).ok, true);
    const tooLong = normalizeEffect({ name: 'a'.repeat(61) });
    assert.equal(tooLong.ok, false);
    assert.match(tooLong.errors.join(' '), /at most 60/);
  });

  test('origin is limited to 80 characters', () => {
    assert.equal(normalizeEffect({ name: 'x', origin: 'o'.repeat(80) }).ok, true);
    assert.equal(normalizeEffect({ name: 'x', origin: 'o'.repeat(81) }).ok, false);
  });

  test('name and origin must be text', () => {
    assert.equal(normalizeEffect({ name: 42 }).ok, false);
    assert.equal(normalizeEffect({ name: 'x', origin: { a: 1 } }).ok, false);
  });

  test('control characters are removed from text fields', () => {
    const result = normalizeEffect({ name: 'Bad\u0000\u0007name' });
    assert.equal(result.ok, true);
    assert.equal(result.effect.name, 'Badname');
  });

  test('icon: empty, /path and http(s) are accepted', () => {
    for (const icon of ['', '/a/b.png', 'https://example.com/i.png', 'http://example.com/i.png']) {
      assert.equal(normalizeEffect({ name: 'x', icon }).ok, true, icon);
    }
  });

  test('icon: javascript:, data:, protocol-relative, spaces and quotes are refused', () => {
    for (const icon of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:image/png;base64,AAAA',
      '//evil.example/x.png',
      'ftp://example.com/x.png',
      '/has space.png',
      '/quote"x.png',
      'not a url',
    ]) {
      const result = normalizeEffect({ name: 'x', icon });
      assert.equal(result.ok, false, icon);
      assert.equal(result.effect, null);
    }
  });

  test('icon longer than 512 characters is refused', () => {
    assert.equal(normalizeEffect({ name: 'x', icon: `/${'a'.repeat(511)}` }).ok, true);
    assert.equal(normalizeEffect({ name: 'x', icon: `/${'a'.repeat(512)}` }).ok, false);
  });

  test('isSafeIcon mirrors the rules', () => {
    assert.equal(isSafeIcon(''), true);
    assert.equal(isSafeIcon(undefined), true);
    assert.equal(isSafeIcon('/x.png'), true);
    assert.equal(isSafeIcon('javascript:1'), false);
    assert.equal(isSafeIcon(5), false);
  });

  test('duration: integers from -1 to 9999 are accepted, numeric text too', () => {
    assert.equal(normalizeEffect({ name: 'x', duration: -1 }).effect.duration, -1);
    assert.equal(normalizeEffect({ name: 'x', duration: 0 }).effect.duration, 0);
    assert.equal(normalizeEffect({ name: 'x', duration: 9999 }).effect.duration, 9999);
    assert.equal(normalizeEffect({ name: 'x', duration: '3' }).effect.duration, 3);
    assert.equal(normalizeEffect({ name: 'x', duration: ' -1 ' }).effect.duration, -1);
    assert.equal(normalizeEffect({ name: 'x', duration: '' }).effect.duration, -1);
  });

  test('duration: fractions, below -1, above the limit, NaN and Infinity are refused', () => {
    for (const duration of [2.5, -2, 10000, NaN, Infinity, '2.5', 'abc', '1e3', true]) {
      assert.equal(normalizeEffect({ name: 'x', duration }).ok, false, String(duration));
    }
  });

  test('disabled must be a boolean', () => {
    assert.equal(normalizeEffect({ name: 'x', disabled: true }).effect.disabled, true);
    assert.equal(normalizeEffect({ name: 'x', disabled: 'true' }).ok, false);
    assert.equal(normalizeEffect({ name: 'x', disabled: 1 }).ok, false);
  });

  test('changes: at most 20, and each must be an object', () => {
    const twenty = Array.from({ length: 20 }, () => ({ key: 'a', mode: 'add', value: 1 }));
    assert.equal(normalizeEffect({ name: 'x', changes: twenty }).ok, true);
    const twentyOne = [...twenty, { key: 'a', mode: 'add', value: 1 }];
    const tooMany = normalizeEffect({ name: 'x', changes: twentyOne });
    assert.equal(tooMany.ok, false);
    assert.match(tooMany.errors.join(' '), /at most 20/);
    assert.equal(normalizeEffect({ name: 'x', changes: 'nope' }).ok, false);
    assert.equal(normalizeEffect({ name: 'x', changes: [null] }).ok, false);
    assert.equal(normalizeEffect({ name: 'x', changes: ['text'] }).ok, false);
  });

  test('change modes are exactly the engine modes', () => {
    assert.deepEqual([...EFFECT_MODES], ['add', 'multiply', 'override', 'upgrade', 'downgrade']);
    assert.equal(Object.isFrozen(EFFECT_MODES), true);
    for (const mode of EFFECT_MODES) {
      const value = mode === 'override' ? 'text' : 2;
      assert.equal(normalizeEffect({ name: 'x', changes: [{ key: 'a', mode, value }] }).ok, true, mode);
    }
    for (const mode of ['set', 'ADD', 'subtract', '', undefined, 'toString']) {
      assert.equal(normalizeEffect({ name: 'x', changes: [{ key: 'a', mode, value: 1 }] }).ok, false, String(mode));
    }
  });

  test('change keys: dotted paths of letters, digits and underscores', () => {
    for (const key of ['might', 'hp.max', '_x', 'A1.b_2', 'a'.repeat(64)]) {
      assert.equal(normalizeEffect({ name: 'x', changes: [{ key, mode: 'add', value: 1 }] }).ok, true, key);
    }
    for (const key of ['', ' ', '1abc', 'a-b', 'a b', 'a..b', 'a.', '.a', 'a'.repeat(65), 'a/b', '../x', '<b>']) {
      assert.equal(normalizeEffect({ name: 'x', changes: [{ key, mode: 'add', value: 1 }] }).ok, false, JSON.stringify(key));
    }
    assert.equal(normalizeEffect({ name: 'x', changes: [{ mode: 'add', value: 1 }] }).ok, false);
  });

  test('change keys: prototype segments are refused in any position', () => {
    for (const key of ['__proto__', 'constructor', 'prototype', 'hp.__proto__', 'constructor.max', 'a.prototype.b']) {
      const result = normalizeEffect({ name: 'x', changes: [{ key, mode: 'override', value: 1 }] });
      assert.equal(result.ok, false, key);
    }
  });

  test('prototype keys in the input object do not leak into the effect', () => {
    const hostile = JSON.parse('{"name":"ok","__proto__":{"polluted":true},"constructor":{"x":1}}');
    const result = normalizeEffect(hostile);
    assert.equal(result.ok, true);
    assert.equal(Object.prototype.polluted, undefined);
    assert.deepEqual(Object.keys(result.effect).sort(), ['changes', 'disabled', 'duration', 'icon', 'name', 'origin']);
  });

  test('numeric values: finite numbers are kept, numeric text becomes a number', () => {
    const result = normalizeEffect({ name: 'x', changes: [{ key: 'a', mode: 'add', value: 1.5 }, { key: 'b', mode: 'multiply', value: '2' }] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.effect.changes, [
      { key: 'a', mode: 'add', value: 1.5 },
      { key: 'b', mode: 'multiply', value: 2 },
    ]);
  });

  test('numeric values: NaN and Infinity are refused, text for a numeric mode is refused', () => {
    assert.equal(normalizeEffect({ name: 'x', changes: [{ key: 'a', mode: 'add', value: NaN }] }).ok, false);
    assert.equal(normalizeEffect({ name: 'x', changes: [{ key: 'a', mode: 'add', value: Infinity }] }).ok, false);
    assert.equal(normalizeEffect({ name: 'x', changes: [{ key: 'a', mode: 'add', value: 'abc' }] }).ok, false);
    assert.equal(normalizeEffect({ name: 'x', changes: [{ key: 'a', mode: 'upgrade', value: '' }] }).ok, false);
    assert.equal(normalizeEffect({ name: 'x', changes: [{ key: 'a', mode: 'add', value: true }] }).ok, false);
    assert.equal(normalizeEffect({ name: 'x', changes: [{ key: 'a', mode: 'add' }] }).ok, false);
  });

  test('text values: override accepts short text, refuses longer than 80', () => {
    assert.equal(normalizeEffect({ name: 'x', changes: [{ key: 'a', mode: 'override', value: 'hello' }] }).effect.changes[0].value, 'hello');
    assert.equal(normalizeEffect({ name: 'x', changes: [{ key: 'a', mode: 'override', value: 'a'.repeat(80) }] }).ok, true);
    assert.equal(normalizeEffect({ name: 'x', changes: [{ key: 'a', mode: 'override', value: 'a'.repeat(81) }] }).ok, false);
  });

  test('huge strings are refused by length, not processed as text', () => {
    const huge = 'x'.repeat(2_000_000);
    assert.equal(normalizeEffect({ name: huge }).ok, false);
    assert.equal(normalizeEffect({ name: 'ok', origin: huge }).ok, false);
    assert.equal(normalizeEffect({ name: 'ok', changes: [{ key: 'a', mode: 'override', value: huge }] }).ok, false);
  });

  test('never throws: non-objects, hostile getters and odd types become errors', () => {
    assert.equal(normalizeEffect(null).ok, false);
    assert.equal(normalizeEffect('text').ok, false);
    assert.equal(normalizeEffect(undefined).ok, false);
    const throwing = {
      get name() {
        throw new Error('boom');
      },
    };
    const result = normalizeEffect(throwing);
    assert.equal(result.ok, false);
    assert.equal(result.effect, null);
    assert.ok(result.errors.length > 0);
  });
});

// ── effectSummary ───────────────────────────────────────────────

describe('effectSummary', () => {
  const identity = (key, fallback) => fallback;

  test('no changes gives the empty text', () => {
    assert.equal(effectSummary({ changes: [] }, identity), 'No changes');
    assert.equal(effectSummary({}, identity), 'No changes');
    assert.equal(effectSummary(null, identity), 'No changes');
  });

  test('describes each mode in short form', () => {
    const effect = {
      changes: [
        { key: 'might', mode: 'add', value: 2 },
        { key: 'speed', mode: 'add', value: -1 },
        { key: 'dmg', mode: 'multiply', value: 1.5 },
        { key: 'hp', mode: 'override', value: 10 },
        { key: 'armor', mode: 'upgrade', value: 3 },
        { key: 'fatigue', mode: 'downgrade', value: 2 },
      ],
    };
    assert.equal(
      effectSummary(effect, identity),
      'might +2, speed -1, dmg x1.5, hp = 10, armor at least 3, fatigue at most 2',
    );
  });

  test('uses translated templates when t returns text', () => {
    const t = (key) => (key === 'sandbox.effects.change.upgrade' ? '{key} no minimo {value}' : undefined);
    assert.equal(effectSummary({ changes: [{ key: 'armor', mode: 'upgrade', value: 3 }] }, t), 'armor no minimo 3');
  });

  test('a t that returns the key itself, or throws, falls back to English', () => {
    assert.equal(effectSummary({ changes: [{ key: 'a', mode: 'add', value: 1 }] }, (k) => k), 'a +1');
    assert.equal(
      effectSummary({ changes: [{ key: 'a', mode: 'add', value: 1 }] }, () => {
        throw new Error('nope');
      }),
      'a +1',
    );
  });

  test('hostile key and value text is escaped', () => {
    const out = effectSummary({ changes: [{ key: '<img src=x onerror=alert(1)>', mode: 'override', value: '"><script>' }] }, identity);
    assert.ok(!out.includes('<img'));
    assert.ok(!out.includes('<script'));
    assert.ok(out.includes('&lt;img'));
    assert.ok(out.includes('&quot;&gt;&lt;script&gt;'));
  });

  test('long summaries are cut to 160 characters', () => {
    const changes = Array.from({ length: 20 }, () => ({ key: 'longish_key_name', mode: 'override', value: 'v'.repeat(80) }));
    const out = effectSummary({ changes }, identity);
    assert.ok(out.length <= 160 + 1);
    assert.ok(out.endsWith('…'));
  });

  test('a changes entry with a non-object or unknown mode does not break it', () => {
    const out = effectSummary({ changes: [null, { key: 'a', mode: 'weird', value: 1 }, { key: '', mode: 'add', value: 1 }] }, identity);
    assert.equal(out, 'a 1');
  });
});

// ── renderEffectsBlock ──────────────────────────────────────────

describe('renderEffectsBlock', () => {
  const rows = [
    { id: 'buff-1', name: 'Shield', origin: 'Ring', icon: '/icons/s.png', duration: -1, disabled: false, changes: [{ key: 'armor', mode: 'add', value: 2 }] },
    { id: 'buff-2', name: 'Curse', origin: '', icon: '', duration: 3, disabled: true, changes: [{ key: 'speed', mode: 'multiply', value: 0.5 }] },
  ];

  test('empty state when there are no effects', () => {
    const html = renderEffectsBlock({ effects: [], editable: true, ownerKind: 'actor', t: null });
    assert.match(html, /No effects yet\./);
    assert.doesNotMatch(html, /ldm-fx-row/);
  });

  test('rows show name, origin, summary, state badge and duration', () => {
    const html = renderEffectsBlock({ effects: rows, editable: false, ownerKind: 'actor' });
    assert.match(html, /Shield/);
    assert.match(html, /Ring/);
    assert.match(html, /armor \+2/);
    assert.match(html, /Permanent/);
    assert.match(html, /ldm-fx-badge--on">Active</);
    assert.match(html, /Curse/);
    assert.match(html, /ldm-fx-badge--off">Off</);
    assert.match(html, /3 rounds/);
    assert.match(html, /speed x0\.5/);
    assert.match(html, /data-ldm-fx-owner="actor"/);
  });

  test('a one-round duration reads as "1 round"', () => {
    const html = renderEffectsBlock({ effects: [{ id: 'b', name: 'x', duration: 1, changes: [] }], editable: false });
    assert.match(html, /1 round</);
  });

  test('editable false hides every control and every data-action', () => {
    const html = renderEffectsBlock({ effects: rows, editable: false, ownerKind: 'actor', editingId: 'buff-1' });
    assert.doesNotMatch(html, /data-ldm-fx-action/);
    assert.doesNotMatch(html, /<input/);
    assert.doesNotMatch(html, /<button/);
  });

  test('editable rows carry edit, toggle and delete actions with the id', () => {
    const html = renderEffectsBlock({ effects: rows, editable: true, ownerKind: 'actor' });
    assert.match(html, /data-ldm-fx-action="add"/);
    assert.match(html, /data-ldm-fx-action="edit" data-ldm-fx-id="buff-1"/);
    assert.match(html, /data-ldm-fx-action="toggle" data-ldm-fx-id="buff-2"/);
    assert.match(html, /data-ldm-fx-action="delete" data-ldm-fx-id="buff-2"/);
  });

  test('editing id shows the inline form with values, change rows and buttons', () => {
    const html = renderEffectsBlock({ effects: rows, editable: true, ownerKind: 'actor', editingId: 'buff-1' });
    assert.match(html, /data-ldm-fx-field="name"/);
    assert.match(html, /value="Shield"/);
    assert.match(html, /data-ldm-fx-field="origin"/);
    assert.match(html, /data-ldm-fx-field="duration"/);
    assert.match(html, /data-ldm-fx-field="disabled"[^>]*checked/);
    assert.match(html, /value="armor"[^>]*data-ldm-fx-field="change-key" data-ldm-fx-index="0"/);
    assert.match(html, /data-ldm-fx-action="add-change"/);
    assert.match(html, /data-ldm-fx-action="remove-change" data-ldm-fx-id="buff-1" data-ldm-fx-index="0"/);
    assert.match(html, /data-ldm-fx-action="save" data-ldm-fx-id="buff-1"/);
    assert.match(html, /data-ldm-fx-action="cancel" data-ldm-fx-id="buff-1"/);
    assert.doesNotMatch(html, /data-ldm-fx-action="edit" data-ldm-fx-id="buff-1"/);
  });

  test('the change mode select marks the current mode and lists all modes', () => {
    const html = renderEffectsBlock({ effects: rows, editable: true, editingId: 'buff-1' });
    assert.match(html, /<option value="add" selected>/);
    for (const mode of EFFECT_MODES) assert.match(html, new RegExp(`<option value="${mode}"`));
  });

  test('the create form renders for the new-effect id with an empty draft and errors', () => {
    const html = renderEffectsBlock({ effects: [], editable: true, editingId: '__new__', errors: ['name is required'] });
    assert.match(html, /New effect/);
    assert.match(html, /data-ldm-fx-action="save" data-ldm-fx-id="__new__"/);
    assert.match(html, /role="alert"/);
    assert.match(html, /name is required/);
    assert.doesNotMatch(html, /No effects yet\./);
  });

  test('a supplied draft replaces the stored values inside the form', () => {
    const draft = { name: 'Typed', origin: '', icon: '', duration: '5', disabled: true, changes: [] };
    const html = renderEffectsBlock({ effects: rows, editable: true, editingId: 'buff-1', draft });
    assert.match(html, /value="Typed"/);
    assert.doesNotMatch(html, /value="Shield"/);
    assert.doesNotMatch(html, /data-ldm-fx-field="disabled"[^>]*checked/);
  });

  test('the item owner shows the honest item hint, the actor owner shows the actor hint', () => {
    const item = renderEffectsBlock({ effects: [], editable: false, ownerKind: 'item' });
    assert.match(item, /data-ldm-fx-owner="item"/);
    assert.match(item, /copied onto the character when the item is used/);
    assert.match(item, /Nothing applies the item effects by itself/);
    assert.doesNotMatch(item, /NOT applied/);
    const actor = renderEffectsBlock({ effects: [], editable: false, ownerKind: 'actor' });
    assert.match(actor, /derived values/);
    assert.doesNotMatch(actor, /NOT applied/);
  });

  test('hostile name, origin, icon and change key are escaped', () => {
    const hostile = [
      {
        id: 'buff-x',
        name: '<img src=x onerror=alert(1)>',
        origin: '"><script>alert(2)</script>',
        icon: 'javascript:alert(3)',
        duration: -1,
        disabled: false,
        changes: [{ key: '"><b onmouseover=x>', mode: 'add', value: 1 }],
      },
    ];
    const list = renderEffectsBlock({ effects: hostile, editable: true, editingId: 'buff-x' });
    const view = renderEffectsBlock({ effects: hostile, editable: true });
    for (const html of [list, view]) {
      assert.doesNotMatch(html, /<img src=x/);
      assert.doesNotMatch(html, /<script/);
      assert.doesNotMatch(html, /<b onmouseover/);
      assert.doesNotMatch(html, /src="javascript/i);
      assert.doesNotMatch(html, /href="javascript/i);
    }
    assert.match(view, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(view, /ldm-fx-icon--empty/);
  });

  test('a safe icon becomes an img with an escaped src', () => {
    const html = renderEffectsBlock({ effects: [{ id: 'b', name: 'x', icon: '/icons/a.png?v=2' }], editable: false });
    assert.match(html, /<img class="ldm-fx-icon" src="\/icons\/a\.png\?v=2" alt=""/);
  });

  test('an icon with a quote is refused and shows the placeholder', () => {
    const html = renderEffectsBlock({ effects: [{ id: 'b', name: 'x', icon: '/a.png?x="y' }], editable: false });
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /ldm-fx-icon--empty/);
  });

  test('a stored draft-less edit derives the form from the effect', () => {
    const html = renderEffectsBlock({ effects: rows, editable: true, editingId: 'buff-2' });
    assert.match(html, /value="Curse"/);
    assert.match(html, /data-ldm-fx-field="disabled"(?![^>]*checked)/);
  });

  test('a translator that throws or returns the key falls back to English', () => {
    const throwing = renderEffectsBlock({
      effects: [],
      editable: false,
      t: () => {
        throw new Error('x');
      },
    });
    assert.match(throwing, /No effects yet\./);
    const keyEcho = renderEffectsBlock({ effects: [], editable: false, t: (k) => k });
    assert.match(keyEcho, /No effects yet\./);
    assert.doesNotMatch(keyEcho, /sandbox\.effects\.empty/);
  });

  test('a translator that returns text is used, escaped', () => {
    const html = renderEffectsBlock({ effects: [], editable: false, t: (k, f) => (k === 'sandbox.effects.empty' ? '<b>vazio</b>' : f) });
    assert.match(html, /&lt;b&gt;vazio&lt;\/b&gt;/);
  });

  test('bad input never throws', () => {
    assert.doesNotThrow(() => renderEffectsBlock());
    assert.doesNotThrow(() => renderEffectsBlock(null));
    assert.doesNotThrow(() => renderEffectsBlock({ effects: 'nope', editable: 'yes', editingId: 42 }));
  });
});

// ── Engine layer: fake window.Loom and fake root ──────────────

function installLoom(options = {}) {
  const env = { calls: [], toasts: [], store: [] };
  env.store = [
    { id: 'buff-1', name: 'Shield', origin: 'Ring', icon: '', duration: -1, disabled: false, changes: [{ key: 'armor', mode: 'add', value: 2 }] },
  ];
  env.api = {
    forActor: async (id) => {
      env.calls.push(['forActor', id]);
      return env.store.map((row) => ({ ...row }));
    },
    forItem: async (id) => {
      env.calls.push(['forItem', id]);
      return [];
    },
    create: async (data) => {
      env.calls.push(['create', data]);
      const row = { id: 'buff-new', ...data };
      env.store.push(row);
      return row;
    },
    update: async (id, patch) => {
      env.calls.push(['update', id, patch]);
      const row = env.store.find((r) => r.id === id);
      if (row) Object.assign(row, patch);
      return row;
    },
    delete: async (id) => {
      env.calls.push(['delete', id]);
      env.store = env.store.filter((r) => r.id !== id);
      return { success: true };
    },
  };
  globalThis.window = {
    Loom: {
      effects: options.withApi === false ? undefined : env.api,
      showToast: (message, type) => env.toasts.push([message, type]),
      world: { id: 'world-1' },
    },
  };
  return env;
}

function fakeRoot() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
    },
    contains: () => true,
    querySelectorAll: () => [],
    listenerCount: (type) => (listeners.get(type) ?? []).length,
    dispatch(type, target) {
      return Promise.all((listeners.get(type) ?? []).map((fn) => fn({ type, target })));
    },
  };
}

/** A fake element with attributes. closest() finds itself when it carries a data-ldm-fx-action. */
function node(attrs = {}, props = {}) {
  return {
    getAttribute: (name) => (Object.hasOwn(attrs, name) ? attrs[name] : null),
    closest(selector) {
      return selector === '[data-ldm-fx-action]' && Object.hasOwn(attrs, 'data-ldm-fx-action') ? this : null;
    },
    ...props,
  };
}

function harness(options = {}) {
  const root = fakeRoot();
  const state = { list: [], rerenders: 0, ownerId: options.ownerId ?? 'actor-1', editable: options.editable ?? true };
  const config = {
    ownerKind: options.ownerKind ?? 'actor',
    getOwnerId: () => state.ownerId,
    getEffects: () => state.list,
    setEffects: (next) => {
      state.list = next;
    },
    isEditable: () => state.editable,
    rerender: () => {
      state.rerenders += 1;
    },
  };
  const detach = attachEffects(root, config);
  return { root, detach, state, config };
}

const click = (root, attrs) => root.dispatch('click', node(attrs));
const change = (root, attrs, value, checked) => root.dispatch('change', node(attrs, { value, checked }));
const action = (name, extra = {}) => ({ 'data-ldm-fx-action': name, ...extra });
const field = (name, index) => ({ 'data-ldm-fx-field': name, ...(index === undefined ? {} : { 'data-ldm-fx-index': String(index) }) });

describe('loadEffects', () => {
  let env;
  beforeEach(() => {
    env = installLoom();
  });
  afterEach(() => {
    delete globalThis.window;
  });

  test('returns the actor effects from the API', async () => {
    const rows = await loadEffects('actor', 'actor-1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'buff-1');
    assert.deepEqual(env.calls, [['forActor', 'actor-1']]);
  });

  test('uses forItem for items and accepts a { data } body', async () => {
    env.api.forItem = async () => ({ data: [{ id: 'buff-9', name: 'x' }, { name: 'no id' }, 'junk'] });
    const rows = await loadEffects('item', 'item-1');
    assert.deepEqual(rows, [{ id: 'buff-9', name: 'x' }]);
  });

  test('returns [] when there is no window, no Loom or no effects API', async () => {
    delete globalThis.window;
    assert.deepEqual(await loadEffects('actor', 'actor-1'), []);
    globalThis.window = {};
    assert.deepEqual(await loadEffects('actor', 'actor-1'), []);
    installLoom({ withApi: false });
    assert.deepEqual(await loadEffects('actor', 'actor-1'), []);
  });

  test('refuses an owner id that could change the URL, without calling the API', async () => {
    for (const bad of ['../x', 'a/b', '', 'a?b', null, undefined, 42]) {
      assert.deepEqual(await loadEffects('actor', bad), [], String(bad));
    }
    assert.equal(env.calls.length, 0);
  });

  test('a failed request returns [] and shows a toast, never throws', async () => {
    env.api.forActor = async () => {
      throw Object.assign(new Error('network down'), { status: 500 });
    };
    assert.deepEqual(await loadEffects('actor', 'actor-1'), []);
    assert.equal(env.toasts.length, 1);
    assert.match(env.toasts[0][0], /network down/);
    assert.equal(env.toasts[0][1], 'error');
  });
});

describe('attachEffects', () => {
  let env;
  beforeEach(async () => {
    env = installLoom();
  });
  afterEach(() => {
    delete globalThis.window;
  });

  async function loaded(options) {
    const h = harness(options);
    h.state.list = await loadEffects(h.config.ownerKind, h.state.ownerId);
    return h;
  }

  test('edit opens the form, save sends a normalised update and reloads the list', async () => {
    const h = await loaded();
    await click(h.root, action('edit', { 'data-ldm-fx-id': 'buff-1' }));
    assert.equal(getEffectsEditState(h.root).editingId, 'buff-1');
    assert.equal(getEffectsEditState(h.root).draft.name, 'Shield');

    await change(h.root, field('name'), 'Bless');
    await click(h.root, action('save', { 'data-ldm-fx-id': 'buff-1' }));

    assert.deepEqual(env.calls.find((c) => c[0] === 'update'), [
      'update',
      'buff-1',
      { name: 'Bless', origin: 'Ring', icon: '', duration: -1, disabled: false, changes: [{ key: 'armor', mode: 'add', value: 2 }] },
    ]);
    assert.equal(getEffectsEditState(h.root).editingId, null);
    assert.equal(h.state.list[0].name, 'Bless');
    assert.ok(h.state.rerenders >= 2);
  });

  test('add from an actor sheet sends actorId, worldId and the whole effect', async () => {
    const h = await loaded();
    await click(h.root, action('add'));
    assert.equal(getEffectsEditState(h.root).editingId, '__new__');

    await change(h.root, field('name'), 'Bless');
    await change(h.root, field('duration'), '3');
    await change(h.root, field('disabled'), undefined, true);
    await click(h.root, action('add-change', { 'data-ldm-fx-id': '__new__' }));
    await change(h.root, field('change-key', 0), 'armor');
    await change(h.root, field('change-mode', 0), 'multiply');
    await change(h.root, field('change-value', 0), '1.5');
    await click(h.root, action('save', { 'data-ldm-fx-id': '__new__' }));

    const create = env.calls.find((c) => c[0] === 'create');
    assert.deepEqual(create[1], {
      name: 'Bless',
      origin: '',
      icon: '',
      duration: 3,
      disabled: false,
      changes: [{ key: 'armor', mode: 'multiply', value: 1.5 }],
      worldId: 'world-1',
      actorId: 'actor-1',
    });
    assert.equal(getEffectsEditState(h.root).editingId, null);
  });

  test('add from an item sheet sends itemId and no actorId', async () => {
    env.api.forItem = async () => [];
    const h = await loaded({ ownerKind: 'item', ownerId: 'item-1' });
    await click(h.root, action('add'));
    await change(h.root, field('name'), 'Edge');
    await click(h.root, action('save', { 'data-ldm-fx-id': '__new__' }));
    const create = env.calls.find((c) => c[0] === 'create')[1];
    assert.equal(create.itemId, 'item-1');
    assert.equal(Object.hasOwn(create, 'actorId'), false);
    assert.equal(create.worldId, 'world-1');
  });

  test('an invalid draft is not sent and its errors are kept for the form', async () => {
    const h = await loaded();
    await click(h.root, action('add'));
    await click(h.root, action('save', { 'data-ldm-fx-id': '__new__' }));
    assert.equal(env.calls.some((c) => c[0] === 'create'), false);
    const { errors, editingId } = getEffectsEditState(h.root);
    assert.equal(editingId, '__new__');
    assert.ok(errors.some((e) => /name is required/.test(e)));
  });

  test('a double submit sends one request', async () => {
    const h = await loaded();
    await click(h.root, action('add'));
    await change(h.root, field('name'), 'Once');
    let release;
    env.api.create = (data) => {
      env.calls.push(['create', data]);
      return new Promise((resolve) => {
        release = () => resolve({ id: 'buff-new', ...data });
      });
    };
    const first = click(h.root, action('save', { 'data-ldm-fx-id': '__new__' }));
    const second = click(h.root, action('save', { 'data-ldm-fx-id': '__new__' }));
    await second;
    release();
    await first;
    assert.equal(env.calls.filter((c) => c[0] === 'create').length, 1);
  });

  test('a 403 shows the forbidden toast and keeps the draft open', async () => {
    const h = await loaded();
    env.api.update = async () => {
      throw Object.assign(new Error('Access denied: you do not own this actor'), { status: 403 });
    };
    await click(h.root, action('edit', { 'data-ldm-fx-id': 'buff-1' }));
    await change(h.root, field('name'), 'Denied');
    await click(h.root, action('save', { 'data-ldm-fx-id': 'buff-1' }));
    assert.equal(env.toasts.length, 1);
    assert.match(env.toasts[0][0], /cannot change this effect/);
    assert.equal(env.toasts[0][1], 'error');
    assert.equal(getEffectsEditState(h.root).editingId, 'buff-1');
    assert.equal(getEffectsEditState(h.root).draft.name, 'Denied');
  });

  test('a 403 on create and on delete is handled the same way and does not throw', async () => {
    const h = await loaded();
    env.api.create = async () => {
      throw Object.assign(new Error('denied'), { status: 403 });
    };
    env.api.delete = async () => {
      throw Object.assign(new Error('denied'), { status: 403 });
    };
    await click(h.root, action('add'));
    await change(h.root, field('name'), 'x');
    await click(h.root, action('save', { 'data-ldm-fx-id': '__new__' }));
    await click(h.root, action('delete', { 'data-ldm-fx-id': 'buff-1' }));
    assert.equal(env.toasts.filter((t) => /cannot change this effect/.test(t[0])).length, 2);
    assert.equal(env.store.length, 1);
  });

  test('a non-403 failure shows the message in the toast', async () => {
    const h = await loaded();
    env.api.delete = async () => {
      throw Object.assign(new Error('disk full'), { status: 500 });
    };
    await click(h.root, action('delete', { 'data-ldm-fx-id': 'buff-1' }));
    assert.match(env.toasts[0][0], /disk full/);
  });

  test('toggle flips disabled and reloads', async () => {
    const h = await loaded();
    await click(h.root, action('toggle', { 'data-ldm-fx-id': 'buff-1' }));
    assert.deepEqual(env.calls.find((c) => c[0] === 'update'), ['update', 'buff-1', { disabled: true }]);
    assert.equal(h.state.list[0].disabled, true);
    await click(h.root, action('toggle', { 'data-ldm-fx-id': 'buff-1' }));
    assert.deepEqual(env.calls.filter((c) => c[0] === 'update')[1], ['update', 'buff-1', { disabled: false }]);
  });

  test('delete removes the effect and reloads', async () => {
    const h = await loaded();
    await click(h.root, action('delete', { 'data-ldm-fx-id': 'buff-1' }));
    assert.deepEqual(env.calls.find((c) => c[0] === 'delete'), ['delete', 'buff-1']);
    assert.deepEqual(h.state.list, []);
  });

  test('cancel leaves the edit and discards the draft', async () => {
    const h = await loaded();
    await click(h.root, action('edit', { 'data-ldm-fx-id': 'buff-1' }));
    await click(h.root, action('cancel', { 'data-ldm-fx-id': 'buff-1' }));
    assert.deepEqual(getEffectsEditState(h.root), { editingId: null, draft: null, errors: [] });
    assert.equal(env.calls.some((c) => c[0] === 'update'), false);
  });

  test('add-change is capped at 20 and remove-change removes the row', async () => {
    const h = await loaded();
    await click(h.root, action('add'));
    for (let i = 0; i < 21; i += 1) await click(h.root, action('add-change', { 'data-ldm-fx-id': '__new__' }));
    assert.equal(getEffectsEditState(h.root).draft.changes.length, 20);
    assert.ok(env.toasts.some((t) => /at most 20 changes/.test(t[0])));
    await click(h.root, action('remove-change', { 'data-ldm-fx-id': '__new__', 'data-ldm-fx-index': '0' }));
    assert.equal(getEffectsEditState(h.root).draft.changes.length, 19);
    await click(h.root, action('remove-change', { 'data-ldm-fx-id': '__new__', 'data-ldm-fx-index': '99' }));
    assert.equal(getEffectsEditState(h.root).draft.changes.length, 19);
  });

  test('read-only sheets ignore mutating actions and say so', async () => {
    const h = await loaded({ editable: false });
    await click(h.root, action('add'));
    await click(h.root, action('toggle', { 'data-ldm-fx-id': 'buff-1' }));
    await click(h.root, action('delete', { 'data-ldm-fx-id': 'buff-1' }));
    assert.equal(getEffectsEditState(h.root).editingId, null);
    assert.equal(env.calls.some((c) => c[0] === 'update' || c[0] === 'delete' || c[0] === 'create'), false);
    assert.ok(env.toasts.some((t) => /cannot change effects/.test(t[0])));
  });

  test('ids that are not safe are never sent', async () => {
    const h = await loaded();
    for (const id of ['../x', 'a/b', 'a b', '']) {
      await click(h.root, action('toggle', { 'data-ldm-fx-id': id }));
      await click(h.root, action('delete', { 'data-ldm-fx-id': id }));
    }
    assert.equal(env.calls.some((c) => c[0] === 'update' || c[0] === 'delete'), false);
  });

  test('a change event only updates the draft and never re-renders', async () => {
    const h = await loaded();
    await click(h.root, action('add'));
    const before = h.state.rerenders;
    await change(h.root, field('name'), 'Typing');
    await change(h.root, field('icon'), '/x.png');
    await change(h.root, field('change-mode', 0), 'upgrade');
    await change(h.root, field('change-mode', 0), 'nonsense');
    assert.equal(h.state.rerenders, before);
    assert.equal(getEffectsEditState(h.root).draft.name, 'Typing');
    assert.equal(getEffectsEditState(h.root).draft.icon, '/x.png');
  });

  test('attaching twice keeps one listener per event and uses the newest callbacks', async () => {
    const h = await loaded();
    const second = { rerenders: 0 };
    const again = attachEffects(h.root, {
      ownerKind: 'actor',
      getOwnerId: () => 'actor-1',
      getEffects: () => h.state.list,
      setEffects: (next) => {
        h.state.list = next;
      },
      isEditable: () => true,
      rerender: () => {
        second.rerenders += 1;
      },
    });
    assert.equal(h.root.listenerCount('click'), 1);
    assert.equal(h.root.listenerCount('change'), 1);
    assert.equal(typeof again, 'function');
    await click(h.root, action('add'));
    assert.equal(h.state.rerenders, 0);
    assert.equal(second.rerenders, 1);
  });

  test('detach removes both listeners and clears the state', async () => {
    const h = await loaded();
    await click(h.root, action('add'));
    h.detach();
    assert.equal(h.root.listenerCount('click'), 0);
    assert.equal(h.root.listenerCount('change'), 0);
    assert.deepEqual(getEffectsEditState(h.root), { editingId: null, draft: null, errors: [] });
  });

  test('a root without addEventListener is a no-op with a detach function', () => {
    const detach = attachEffects(null, {});
    assert.equal(typeof detach, 'function');
    assert.doesNotThrow(detach);
    assert.equal(typeof attachEffects({}, {}), 'function');
  });

  test('events outside the block and events without a target do not throw', async () => {
    const h = await loaded();
    await h.root.dispatch('click', undefined);
    await h.root.dispatch('click', { closest: () => null });
    await h.root.dispatch('change', undefined);
    await h.root.dispatch('click', node({ 'data-ldm-fx-action': 'nope' }));
    assert.equal(env.calls.length, 1);
  });
});

// ── Item use: planItemEffectsApplication ────────────────────────
const ITEM = Object.freeze({ id: 'it-1', name: 'Prayer Book' });
const ITEM_EFFECT = (over = {}) => ({
  id: 'ie-1',
  name: 'Bless',
  icon: '',
  duration: 3,
  disabled: false,
  changes: [{ key: 'attrs.might', mode: 'add', value: 2 }],
  ...over,
});
const plan = (over = {}) =>
  planItemEffectsApplication({
    itemEffects: [ITEM_EFFECT()],
    actorEffects: [],
    item: ITEM,
    actorId: 'actor-1',
    worldId: 'world-1',
    ...over,
  });

describe('planItemEffectsApplication', () => {
  test('creates one actor effect with the item origin and the composed name', () => {
    assert.deepEqual(plan(), {
      creates: [
        {
          worldId: 'world-1',
          actorId: 'actor-1',
          name: 'Bless (Prayer Book)',
          icon: '',
          origin: 'item:it-1',
          duration: 3,
          disabled: false,
          changes: [{ key: 'attrs.might', mode: 'add', value: 2 }],
        },
      ],
      updates: [],
      skipped: 0,
    });
  });

  test('an existing copy with the same origin and base name is updated, not duplicated', () => {
    const existing = { id: 'a-9', name: 'Bless (Prayer Book)', origin: 'item:it-1', duration: 1, changes: [] };
    const result = plan({ actorEffects: [existing] });
    assert.equal(result.creates.length, 0);
    assert.equal(result.updates.length, 1);
    assert.equal(result.updates[0].id, 'a-9');
    assert.equal(result.updates[0].patch.duration, 3);
    assert.deepEqual(result.updates[0].patch.changes, [{ key: 'attrs.might', mode: 'add', value: 2 }]);
    assert.equal(result.updates[0].patch.origin, 'item:it-1');
  });

  test('an update keeps the disabled flag the GM set on the copy', () => {
    const existing = { id: 'a-9', name: 'Bless (Prayer Book)', origin: 'item:it-1', disabled: true, changes: [] };
    const result = plan({ actorEffects: [existing] });
    assert.equal('disabled' in result.updates[0].patch, false);
  });

  test('copies from another item or with another base name are not matched', () => {
    const other = { id: 'a-1', name: 'Bless (Prayer Book)', origin: 'item:it-2', changes: [] };
    const otherName = { id: 'a-2', name: 'Shield (Prayer Book)', origin: 'item:it-1', changes: [] };
    const result = plan({ actorEffects: [other, otherName] });
    assert.equal(result.updates.length, 0);
    assert.equal(result.creates.length, 1);
  });

  test('two item effects with the same name claim two different copies', () => {
    const copies = [{ id: 'a-1', name: 'Bless (Prayer Book)', origin: 'item:it-1', changes: [] }];
    const result = plan({ itemEffects: [ITEM_EFFECT({ id: 'x' }), ITEM_EFFECT({ id: 'y' })], actorEffects: copies });
    assert.equal(result.updates.length, 1);
    assert.equal(result.creates.length, 1);
  });

  test('disabled item effects are skipped (true or 1)', () => {
    const result = plan({ itemEffects: [ITEM_EFFECT({ disabled: true }), ITEM_EFFECT({ disabled: 1, name: 'B' })] });
    assert.equal(result.creates.length, 0);
    assert.equal(result.skipped, 2);
  });

  test('an item effect without changes is skipped', () => {
    const result = plan({ itemEffects: [ITEM_EFFECT({ changes: [] }), ITEM_EFFECT({ changes: null })] });
    assert.equal(result.creates.length, 0);
    assert.equal(result.skipped, 2);
  });

  test('at most 20 effects are created or refreshed per use; the rest are counted as skipped', () => {
    assert.equal(ITEM_EFFECT_LIMIT, 20);
    const many = Array.from({ length: 25 }, (_, i) => ITEM_EFFECT({ id: `ie-${i}`, name: `E${i}` }));
    const result = plan({ itemEffects: many });
    assert.equal(result.creates.length, 20);
    assert.equal(result.skipped, 5);
  });

  test('hostile names are cleaned and kept as data, and an over-long composed name is cut to the limit', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const result = plan({
      itemEffects: [ITEM_EFFECT({ name: `${hostile}\u0007` }), ITEM_EFFECT({ id: 'long', name: 'N'.repeat(61) })],
      item: { id: 'it-1', name: '"><script>x</script>' },
    });
    assert.equal(result.creates.length, 2);
    assert.ok(result.creates[0].name.startsWith(hostile));
    assert.equal(result.creates[0].name.includes('\u0007'), false);
    assert.ok(result.creates[0].name.length <= 60);
    assert.equal(result.creates[1].name.length, 60, 'the composed name is cut, not refused');
    assert.equal(result.skipped, 0);
  });

  test('a long base name is cut to 60 characters and the copy still matches on the next use', () => {
    const base = 'B'.repeat(60);
    const first = plan({ itemEffects: [ITEM_EFFECT({ name: base })] });
    assert.equal(first.creates[0].name, base);
    const second = plan({
      itemEffects: [ITEM_EFFECT({ name: base })],
      actorEffects: [{ id: 'a-5', name: first.creates[0].name, origin: 'item:it-1', changes: [] }],
    });
    assert.equal(second.updates.length, 1);
  });

  test('an effect that fails normalisation is skipped and the others still apply', () => {
    const result = plan({
      itemEffects: [
        ITEM_EFFECT({ icon: 'javascript:alert(1)' }),
        ITEM_EFFECT({ id: 'bad', changes: [{ key: 'constructor.x', mode: 'add', value: 1 }] }),
        ITEM_EFFECT({ id: 'ok', name: 'Good' }),
      ],
    });
    assert.equal(result.creates.length, 1);
    assert.equal(result.creates[0].name, 'Good (Prayer Book)');
    assert.equal(result.skipped, 2);
  });

  test('a missing item id, actor id or world id produces an empty plan that counts the effects', () => {
    assert.deepEqual(plan({ worldId: '' }), { creates: [], updates: [], skipped: 1 });
    assert.deepEqual(plan({ actorId: 'bad id!' }), { creates: [], updates: [], skipped: 1 });
    assert.deepEqual(plan({ item: { name: 'no id' } }), { creates: [], updates: [], skipped: 1 });
  });

  test('odd input never throws', () => {
    for (const bad of [null, undefined, 'x', { itemEffects: 'x' }, { itemEffects: [null, 5], item: 7 }]) {
      const result = planItemEffectsApplication(bad);
      assert.deepEqual(Object.keys(result).sort(), ['creates', 'skipped', 'updates']);
    }
  });
});

// ── Item use: applyItemEffects ─────────────────────────────────
function installItemLoom(options = {}) {
  const env = { calls: [], toasts: [], actorRows: [...(options.actorRows ?? [])], failCreateAt: options.failCreateAt ?? -1 };
  const itemRows = options.itemRows ?? [ITEM_EFFECT()];
  let createCount = 0;
  env.api = {
    forItem: async (id) => {
      env.calls.push(['forItem', id]);
      return itemRows.map((r) => ({ ...r }));
    },
    forActor: async (id) => {
      env.calls.push(['forActor', id]);
      return env.actorRows.map((r) => ({ ...r }));
    },
    create: async (data) => {
      env.calls.push(['create', data]);
      createCount += 1;
      if (createCount === env.failCreateAt) throw Object.assign(new Error('Access denied'), { status: 403 });
      env.actorRows.push({ id: `new-${createCount}`, ...data });
      return { id: `new-${createCount}` };
    },
    update: async (id, patch) => {
      env.calls.push(['update', id, patch]);
      return { id };
    },
  };
  globalThis.window = {
    Loom: {
      effects: options.withApi === false ? undefined : env.api,
      showToast: (message, type) => env.toasts.push([message, type]),
      world: { id: 'world-1' },
      i18n: options.i18n,
    },
  };
  return env;
}

describe('applyItemEffects', () => {
  afterEach(() => {
    delete globalThis.window;
  });

  test('creates run before updates, one at a time, and the counts are returned', async () => {
    const env = installItemLoom({
      itemRows: [ITEM_EFFECT({ id: 'ie-1' }), ITEM_EFFECT({ id: 'ie-2', name: 'Haste' })],
      actorRows: [{ id: 'a-1', name: 'Bless (Prayer Book)', origin: 'item:it-1', changes: [] }],
    });
    const result = await applyItemEffects(ITEM, 'actor-1', 'world-1');
    assert.deepEqual(result, { ok: true, created: 1, updated: 1, skipped: 0, error: null });
    const order = env.calls.filter((c) => c[0] === 'create' || c[0] === 'update').map((c) => c[0]);
    assert.deepEqual(order, ['create', 'update']);
    assert.equal(env.toasts.length, 0);
  });

  test('a 403 on a create stops the run, shows one forbidden toast and keeps what was done', async () => {
    const env = installItemLoom({
      itemRows: [ITEM_EFFECT({ id: 'a', name: 'One' }), ITEM_EFFECT({ id: 'b', name: 'Two' }), ITEM_EFFECT({ id: 'c', name: 'Three' })],
      failCreateAt: 2,
    });
    const result = await applyItemEffects(ITEM, 'actor-1', 'world-1');
    assert.equal(result.ok, false);
    assert.equal(result.created, 1);
    assert.equal(env.calls.filter((c) => c[0] === 'create').length, 2, 'the third create is never sent');
    assert.deepEqual(env.toasts, [["You cannot change this effect. Only the GM or the actor's owner can.", 'error']]);
  });

  test('another failure is reported in one toast and does not throw', async () => {
    const env = installItemLoom({ itemRows: [ITEM_EFFECT()] });
    env.api.create = async () => {
      throw new Error('boom');
    };
    const result = await applyItemEffects(ITEM, 'actor-1', 'world-1');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'boom');
    assert.deepEqual(env.toasts, [['Could not apply the item effects: boom', 'error']]);
  });

  test('the toast text is localised through window.Loom.i18n when it has the key', async () => {
    const env = installItemLoom({
      itemRows: [ITEM_EFFECT()],
      i18n: { localize: (key) => (key === 'sandbox.effects.applyFailed' ? 'Falha: {message}' : key) },
    });
    env.api.create = async () => {
      throw new Error('x');
    };
    await applyItemEffects(ITEM, 'actor-1', 'world-1');
    assert.deepEqual(env.toasts, [['Falha: x', 'error']]);
  });

  test('an item with no effects makes no actor request and no write', async () => {
    const env = installItemLoom({ itemRows: [] });
    const result = await applyItemEffects(ITEM, 'actor-1', 'world-1');
    assert.deepEqual(result, { ok: true, created: 0, updated: 0, skipped: 0, error: null });
    assert.equal(env.calls.some((c) => c[0] === 'forActor'), false);
    assert.equal(env.calls.some((c) => c[0] === 'create' || c[0] === 'update'), false);
  });

  test('a missing effects API or a missing window returns a failure and never throws', async () => {
    installItemLoom({ withApi: false });
    const noApi = await applyItemEffects(ITEM, 'actor-1', 'world-1');
    assert.equal(noApi.ok, false);
    delete globalThis.window;
    const noWindow = await applyItemEffects(ITEM, 'actor-1', 'world-1');
    assert.equal(noWindow.ok, false, 'no window means no effects API');
    assert.equal(noWindow.created, 0);
  });

  test('a null item or a hostile item id is a no-op', async () => {
    const env = installItemLoom();
    assert.equal((await applyItemEffects(null, 'actor-1', 'world-1')).ok, true);
    assert.equal((await applyItemEffects({ id: '../x' }, 'actor-1', 'world-1')).ok, true);
    assert.equal(env.calls.some((c) => c[0] === 'create'), false);
  });
});

describe('module source', () => {
  const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

  test('the module has no import side effects and no SDK import', () => {
    const source = read('lib/effects-view.mjs');
    assert.doesNotMatch(source, /from '\/_loom\/sdk/);
    assert.doesNotMatch(source, /^\s*(window|document)\./m);
  });

  test('every class used by the view is defined in the stylesheet', () => {
    const view = read('lib/effects-view.mjs');
    const css = read('styles/sandbox-effects.css');
    const used = new Set([...view.matchAll(/(?<![-w])ldm-fx-[a-z-]+/g)].map((m) => m[0]));
    const missing = [...used].filter((cls) => !css.includes(`.${cls}`));
    assert.deepEqual(missing, []);
  });
});

describe('i18n coverage', () => {
  // Keys written literally in the module, in either quote style (the mode map uses double quotes).
  const literalKeys = (view) =>
    [...new Set([...view.matchAll(/['"`](sandbox\.effects\.[A-Za-z.]+)['"`]/g)].map((m) => m[1]))];
  // Keys built from the engine's mode list: mode.<name> and change.<name>.
  const modeKeys = EFFECT_MODES.flatMap((mode) => [`sandbox.effects.mode.${mode}`, `sandbox.effects.change.${mode}`]);

  test('every sandbox.effects key used or built by the view exists in both language files', () => {
    const view = readFileSync(join(ROOT, 'lib/effects-view.mjs'), 'utf8');
    const used = [...new Set([...literalKeys(view), ...modeKeys])];
    assert.ok(used.length > 40, 'the scan finds the keys');
    assert.ok(used.includes('sandbox.effects.mode.override'), 'the mode family is included');
    for (const file of ['i18n/effects.en.json', 'i18n/effects.pt-BR.json']) {
      const dict = JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
      assert.deepEqual(used.filter((key) => !(key in dict)), [], file);
    }
  });

  test('the five mode labels have the agreed wording in both languages', () => {
    const en = JSON.parse(readFileSync(join(ROOT, 'i18n/effects.en.json'), 'utf8'));
    const pt = JSON.parse(readFileSync(join(ROOT, 'i18n/effects.pt-BR.json'), 'utf8'));
    assert.deepEqual(
      EFFECT_MODES.map((m) => en[`sandbox.effects.mode.${m}`]),
      ['Add', 'Multiply', 'Set to', 'At least', 'At most'],
    );
    assert.deepEqual(
      EFFECT_MODES.map((m) => pt[`sandbox.effects.mode.${m}`]),
      ['Somar', 'Multiplicar', 'Definir como', 'No mínimo', 'No máximo'],
    );
  });
});
