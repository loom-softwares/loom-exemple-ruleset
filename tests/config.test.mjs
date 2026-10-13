import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIG_MODULE,
  CONFIG_KEY,
  LIMITS,
  defaultConfig,
  PRESETS,
  validateConfig,
  migrateConfig,
  parseConfig,
  serializeConfig,
  attributeList,
  skillList,
  resourceList,
  categoryList,
  abilityKindLabel,
  defaultActorData,
  defaultItemData,
  actorValue,
  loadConfig,
  saveConfig,
  onConfigSaved,
  registerConfigSetting,
  getConfigSync,
  clearConfigCache,
} from '../lib/config.mjs';
import { deepClone } from '../lib/helpers.mjs';

/** Valid config with one field replaced. Used to build targeted cases. */
function withCfg(patch) {
  const base = defaultConfig();
  return { ...base, ...patch };
}

function expectClean(input) {
  const result = validateConfig(input);
  assert.equal(result.ok, true, `expected no errors, got: ${result.errors.join(' | ')}`);
  assert.deepEqual(result.errors, []);
  return result.config;
}

function errorsOf(input) {
  const result = validateConfig(input);
  assert.equal(result.ok, false, 'expected validation errors');
  return result.errors.join(' | ');
}

// ---------------------------------------------------------------------------
// Constants and defaults
// ---------------------------------------------------------------------------

test('module constants identify the setting', () => {
  assert.equal(CONFIG_MODULE, 'loom-demo-system');
  assert.equal(CONFIG_KEY, 'ruleConfig');
});

test('defaultConfig is a valid v1 config with zero validation errors', () => {
  const cfg = expectClean(defaultConfig());
  assert.equal(cfg.version, 1);
  assert.equal(cfg.dice.mode, 'd20');
});

test('defaultConfig is deterministic and returns a fresh object each call', () => {
  const a = defaultConfig();
  const b = defaultConfig();
  assert.deepEqual(a, b);
  assert.equal(serializeConfig(a), serializeConfig(b));
  a.attributes.push({ key: 'extra', label: 'Extra', min: 0, max: 1, default: 0 });
  assert.equal(defaultConfig().attributes.length, 3, 'mutating one copy must not change the next');
});

test('both presets pass validation with zero errors and are deterministic', () => {
  for (const name of Object.keys(PRESETS)) {
    const first = PRESETS[name]();
    expectClean(first);
    assert.equal(serializeConfig(first), serializeConfig(PRESETS[name]()), `${name} must be deterministic`);
  }
  assert.equal(PRESETS.d6Pool().dice.mode, 'pool');
  assert.equal(PRESETS.d20Classic().dice.mode, 'd20');
});

test('presets and the default use neutral names and no game or VTT brand words', () => {
  const brands = /dungeon|d&d|\bdnd\b|foundry|pathfinder|pf2e|roll20|fantasy grounds|warhammer|vampire|world of darkness|\bwod\b|shadowrun|savage|pokemon|tabletop/i;
  const texts = [defaultConfig(), PRESETS.d20Classic(), PRESETS.d6Pool()].map((c) => JSON.stringify(c));
  for (const text of texts) assert.doesNotMatch(text, brands);
});

// ---------------------------------------------------------------------------
// validateConfig: shape, never throws
// ---------------------------------------------------------------------------

describe('validateConfig never throws', () => {
  const hostiles = [
    ['undefined', undefined],
    ['null', null],
    ['number', 42],
    ['NaN', Number.NaN],
    ['string', 'hello'],
    ['boolean', true],
    ['array', [1, 2, 3]],
    ['empty array', []],
    ['function', () => 1],
    ['symbol', Symbol('x')],
  ];

  for (const [label, value] of hostiles) {
    test(`returns a valid config for ${label}`, () => {
      const result = validateConfig(value);
      assert.equal(result.ok, false);
      assert.equal(validateConfig(result.config).ok, true);
      assert.equal(typeof result.errors[0], 'string');
    });
  }

  test('a getter that throws does not escape', () => {
    const evil = {};
    Object.defineProperty(evil, 'attributes', {
      enumerable: true,
      get() {
        throw new Error('nope');
      },
    });
    const result = validateConfig(evil);
    assert.equal(result.ok, false);
    assert.equal(validateConfig(result.config).ok, true);
  });

  test('a Proxy that throws on every read does not escape', () => {
    const proxy = new Proxy({}, {
      get() {
        throw new Error('trap');
      },
      ownKeys() {
        throw new Error('trap');
      },
    });
    assert.doesNotThrow(() => validateConfig(proxy));
    assert.equal(validateConfig(proxy).ok, false);
  });

  test('a cyclic object is handled', () => {
    const cyclic = { name: 'loop' };
    cyclic.attributes = cyclic;
    cyclic.skills = cyclic;
    assert.doesNotThrow(() => validateConfig(cyclic));
  });

  test('prototype-pollution keys are data, never a prototype change', () => {
    const hostile = JSON.parse('{"__proto__":{"isAdmin":true},"constructor":{"prototype":{"polluted":1}},"attributes":[{"key":"__proto__"},{"key":"constructor"}]}');
    const result = validateConfig(hostile);
    assert.equal({}.isAdmin, undefined);
    assert.equal({}.polluted, undefined);
    assert.equal(Object.getPrototypeOf(result.config), Object.prototype);
    assert.equal(validateConfig(result.config).ok, true);
  });

  test('a prototype-pollution key inside abilityKinds stays as data', () => {
    const hostile = JSON.parse('{"abilityKinds":{"__proto__":"x","constructor":"Ctor","ability":"Ability"}}');
    const result = validateConfig(hostile);
    assert.equal({}.x, undefined);
    assert.equal(Object.getPrototypeOf(result.config.abilityKinds), Object.prototype);
    assert.equal(Object.prototype.hasOwnProperty.call(result.config.abilityKinds, 'constructor'), true);
    assert.equal(validateConfig(result.config).ok, true);
  });

  test('huge strings are cut to the limits and do not blow up', () => {
    const huge = 'x'.repeat(5_000_000);
    const result = validateConfig({ name: huge, card: { header: huge } });
    assert.ok(result.config.name.length <= LIMITS.name);
    assert.ok(result.config.card.header.length <= LIMITS.headerMax);
    assert.equal(validateConfig(result.config).ok, true);
  });

  test('a sparse array with a huge length is read in bounded time', () => {
    const sparse = [];
    sparse.length = 1_000_000_000;
    const started = Date.now();
    const result = validateConfig({ attributes: sparse, skills: sparse });
    assert.ok(Date.now() - started < 2000, 'must not iterate the full length');
    assert.equal(validateConfig(result.config).ok, true);
  });

  test('a list of 100k items is capped at the limit', () => {
    const many = Array.from({ length: 100_000 }, (_, i) => ({ key: `k${i % 9}`, label: 'x' }));
    const cfg = expectLimitsOk(validateConfig({ attributes: many }).config);
    assert.ok(cfg.attributes.length <= LIMITS.attributes);
  });
});

function expectLimitsOk(cfg) {
  assert.equal(validateConfig(cfg).ok, true);
  return cfg;
}

test('unknown keys are dropped from the sanitized config', () => {
  const cfg = expectLimitsOk(validateConfig({ ...defaultConfig(), secret: 'x', dice: { mode: 'd20', extra: 1 } }).config);
  assert.equal('secret' in cfg, false);
  assert.equal('extra' in cfg.dice, false);
});

// ---------------------------------------------------------------------------
// validateConfig: the contract limits
// ---------------------------------------------------------------------------

describe('keys and labels', () => {
  test('a valid config reports no errors', () => {
    expectClean(defaultConfig());
  });

  test('an uppercase key is slugged with a message, the row survives', () => {
    const result = validateConfig(withCfg({ attributes: [{ key: 'Might', label: 'Might', min: 0, max: 5, default: 1 }] }));
    assert.equal(result.config.attributes[0].key, 'might');
    assert.ok(result.errors.some((e) => e.includes('changed to "might"')));
  });

  test('a key that cannot be slugged is dropped', () => {
    const result = validateConfig(withCfg({ attributes: [{ key: '!!!', label: 'Nope' }] }));
    assert.equal(result.config.attributes.length, 0);
    assert.ok(result.errors.some((e) => e.includes('dropped')));
  });

  test('a duplicate key is dropped, the first one kept', () => {
    const result = validateConfig(withCfg({
      attributes: [
        { key: 'might', label: 'First', min: 0, max: 5, default: 1 },
        { key: 'might', label: 'Second', min: 0, max: 5, default: 1 },
      ],
    }));
    assert.equal(result.config.attributes.length, 1);
    assert.equal(result.config.attributes[0].label, 'First');
    assert.ok(result.errors.some((e) => e.includes('duplicate')));
  });

  test('a key longer than 24 characters is not accepted as-is', () => {
    const key = `a${'b'.repeat(30)}`;
    const result = validateConfig(withCfg({ attributes: [{ key, label: 'Long' }] }));
    assert.equal(result.ok, false);
    assert.ok(result.config.attributes.every((a) => /^[a-z][a-z0-9_]{0,23}$/.test(a.key)));
  });

  test('an empty label falls back to the key and is reported', () => {
    const result = validateConfig(withCfg({ attributes: [{ key: 'grit', label: '   ', min: 0, max: 5, default: 1 }] }));
    assert.equal(result.config.attributes[0].label, 'grit');
    assert.equal(result.ok, false);
  });

  test('a label longer than 40 characters is cut', () => {
    const result = validateConfig(withCfg({ attributes: [{ key: 'grit', label: 'x'.repeat(200), min: 0, max: 5, default: 1 }] }));
    assert.equal(result.config.attributes[0].label.length, LIMITS.label);
    assert.equal(result.ok, false);
  });

  test('control characters in labels are replaced', () => {
    const result = validateConfig(withCfg({ attributes: [{ key: 'grit', label: 'Gr\u0000it\n', min: 0, max: 5, default: 1 }] }));
    assert.equal(result.config.attributes[0].label, 'Gr it');
  });
});

describe('list sizes', () => {
  const make = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

  test('attributes are capped at 12', () => {
    const attrs = make(13, 'a').map((key) => ({ key, label: key, min: 0, max: 5, default: 0 }));
    const result = validateConfig(withCfg({ attributes: attrs }));
    assert.equal(result.config.attributes.length, LIMITS.attributes);
    assert.equal(LIMITS.attributes, 12);
    assert.equal(result.ok, false);
  });

  test('skills are capped at 40', () => {
    const skills = make(41, 's').map((key) => ({ key, label: key, attr: '', max: 5, default: 0 }));
    const result = validateConfig(withCfg({ skills }));
    assert.equal(result.config.skills.length, 40);
  });

  test('resources are capped at 8', () => {
    const res = make(9, 'r').map((key) => ({ key, label: key, max: 5, color: '#112233', showInCombat: true }));
    const result = validateConfig(withCfg({ resources: res }));
    assert.equal(result.config.resources.length, 8);
  });

  test('item categories are capped at 24', () => {
    const cats = make(25, 'c').map((key) => ({ key, label: key }));
    const result = validateConfig(withCfg({ itemCategories: cats }));
    assert.equal(result.config.itemCategories.length, 24);
  });

  test('ability kinds are capped at 8', () => {
    const kinds = {};
    for (let i = 0; i < 9; i++) kinds[`k${i}`] = `Kind ${i}`;
    const result = validateConfig(withCfg({ abilityKinds: kinds }));
    assert.equal(Object.keys(result.config.abilityKinds).length, 8);
  });

  test('a list field that is not an array is ignored and reported', () => {
    const result = validateConfig(withCfg({ attributes: 'nope' }));
    assert.deepEqual(result.config.attributes, []);
    assert.equal(result.ok, false);
  });
});

describe('numeric clamps and coherence', () => {
  test('dice sides are clamped to 2..100', () => {
    const low = validateConfig({ dice: { d20: { sides: 1 } } }).config.dice.d20;
    const high = validateConfig({ dice: { d20: { sides: 5000 } } }).config.dice.d20;
    assert.equal(low.sides, 2);
    assert.equal(high.sides, 100);
  });

  test('pool faces are clamped to 2..100 and successMin stays within 2..faces', () => {
    const cfg = validateConfig({ dice: { mode: 'pool', pool: { faces: 6, successMin: 9 } } }).config;
    assert.equal(cfg.dice.pool.faces, 6);
    assert.equal(cfg.dice.pool.successMin, 6);
    const low = validateConfig({ dice: { mode: 'pool', pool: { faces: 6, successMin: 0 } } }).config;
    assert.equal(low.dice.pool.successMin, 2);
  });

  test('faces of 2 forces successMin to 2', () => {
    const cfg = validateConfig({ dice: { mode: 'pool', pool: { faces: 2 } } }).config;
    assert.equal(cfg.dice.pool.faces, 2);
    assert.equal(cfg.dice.pool.successMin, 2);
  });

  test('critMin stays within 1..sides and fumbleMax within 0..sides', () => {
    const cfg = validateConfig({ dice: { d20: { sides: 12, critMin: 99, fumbleMax: -4 } } }).config;
    assert.equal(cfg.dice.d20.critMin, 12);
    assert.equal(cfg.dice.d20.fumbleMax, 0);
  });

  test('maxDice is clamped to 1..50', () => {
    assert.equal(validateConfig({ dice: { pool: { maxDice: 0 } } }).config.dice.pool.maxDice, 1);
    assert.equal(validateConfig({ dice: { pool: { maxDice: 9999 } } }).config.dice.pool.maxDice, 50);
  });

  test('attribute min above max is swapped and reported', () => {
    const result = validateConfig(withCfg({ attributes: [{ key: 'grit', label: 'Grit', min: 9, max: 2, default: 5 }] }));
    const a = result.config.attributes[0];
    assert.equal(a.min, 2);
    assert.equal(a.max, 9);
    assert.ok(a.default >= a.min && a.default <= a.max);
    assert.equal(result.ok, false);
  });

  test('attribute default outside min..max is clamped and reported', () => {
    const result = validateConfig(withCfg({ attributes: [{ key: 'grit', label: 'Grit', min: 1, max: 4, default: 50 }] }));
    assert.equal(result.config.attributes[0].default, 4);
    assert.equal(result.ok, false);
  });

  test('a missing attribute default becomes 0 clamped into range without an error', () => {
    const result = validateConfig({ attributes: [{ key: 'grit', label: 'Grit', min: 3, max: 9 }] });
    assert.equal(result.config.attributes[0].default, 3);
    assert.equal(result.ok, true);
  });

  test('a numeric string is accepted for a number field', () => {
    const cfg = validateConfig({ dice: { d20: { sides: '12' } } }).config;
    assert.equal(cfg.dice.d20.sides, 12);
  });

  test('a non-numeric value falls back and is reported', () => {
    const result = validateConfig({ dice: { d20: { sides: 'twelve' } } });
    assert.equal(result.config.dice.d20.sides, 20);
    assert.equal(result.ok, false);
  });

  test('NaN and Infinity are not accepted as numbers', () => {
    const cfg = validateConfig({ dice: { d20: { sides: Number.NaN } } }).config;
    const inf = validateConfig({ dice: { d20: { sides: Number.POSITIVE_INFINITY } } }).config;
    assert.equal(cfg.dice.d20.sides, 20);
    assert.equal(inf.dice.d20.sides, 20);
  });

  test('skill max is clamped to 0..100 and default to 0..max', () => {
    const cfg = validateConfig(withCfg({ skills: [{ key: 'melee', label: 'Melee', attr: 'might', max: 500, default: 999 }] })).config;
    assert.equal(cfg.skills[0].max, 100);
    assert.equal(cfg.skills[0].default, 100);
  });

  test('resource max is clamped to 1..999', () => {
    const cfg = validateConfig(withCfg({ resources: [{ key: 'hp', label: 'HP', max: 0, color: '#c0392b' }] })).config;
    assert.equal(cfg.resources[0].max, 1);
  });

  test('combat initiative bonus is clamped to -99..99', () => {
    const cfg = validateConfig({ combat: { initiative: { mode: 'fixed', bonus: 5000 } } }).config;
    assert.equal(cfg.combat.initiative.bonus, 99);
  });
});

describe('references and colours', () => {
  test('a skill attr that is not an attribute is cleared and reported', () => {
    const result = validateConfig(withCfg({ skills: [{ key: 'melee', label: 'Melee', attr: 'nope', max: 5, default: 0 }] }));
    assert.equal(result.config.skills[0].attr, '');
    assert.equal(result.ok, false);
  });

  test('a skill attr that names an existing attribute is kept', () => {
    const cfg = expectClean(defaultConfig());
    assert.equal(cfg.skills.find((s) => s.key === 'melee').attr, 'might');
  });

  test('removing an attribute clears skills that pointed at it', () => {
    const base = defaultConfig();
    const cfg = validateConfig({ ...base, attributes: base.attributes.filter((a) => a.key !== 'might') }).config;
    assert.equal(cfg.skills.find((s) => s.key === 'melee').attr, '');
  });

  test('combat initiative attribute mode without an attribute falls back to roll', () => {
    const result = validateConfig({ combat: { initiative: { mode: 'attribute', attr: '' } } });
    assert.equal(result.config.combat.initiative.mode, 'roll');
    assert.equal(result.ok, false);
  });

  test('combat initiative attr that does not exist is cleared', () => {
    const result = validateConfig({ combat: { initiative: { mode: 'attribute', attr: 'ghost' } } });
    assert.equal(result.config.combat.initiative.attr, '');
    assert.equal(result.config.combat.initiative.mode, 'roll');
  });

  test('accent must be #rrggbb and is stored lowercase', () => {
    assert.equal(validateConfig({ card: { accent: '#AABBCC' } }).config.card.accent, '#aabbcc');
    const bad = validateConfig({ card: { accent: 'red' } });
    assert.equal(bad.config.card.accent, '#7c5cff');
    assert.equal(bad.ok, false);
    assert.equal(validateConfig({ card: { accent: '#abc' } }).ok, false);
    assert.equal(validateConfig({ card: { accent: '#zzzzzz' } }).ok, false);
  });

  test('resource colour must be #rrggbb', () => {
    const result = validateConfig(withCfg({ resources: [{ key: 'hp', label: 'HP', max: 5, color: 'javascript:alert(1)' }] }));
    assert.equal(result.config.resources[0].color, '#888888');
    assert.equal(result.ok, false);
  });
});

describe('card header', () => {
  test('only the tokens {actor}, {label} and {result} survive', () => {
    const result = validateConfig({ card: { header: '{actor} {evil} {label} {result}' } });
    assert.equal(result.config.card.header, '{actor} {label} {result}');
    assert.equal(result.ok, false);
  });

  test('a header that is only unknown tokens falls back to the default', () => {
    const result = validateConfig({ card: { header: '{nope}' } });
    assert.equal(result.config.card.header, '{actor}: {label}');
    assert.equal(result.ok, false);
  });

  test('header is cut to 80 characters', () => {
    const result = validateConfig({ card: { header: `{actor} ${'z'.repeat(300)}` } });
    assert.ok(result.config.card.header.length <= LIMITS.headerMax);
    assert.equal(result.ok, false);
  });

  test('a non-text header falls back to the default', () => {
    const result = validateConfig({ card: { header: 42 } });
    assert.equal(result.config.card.header, '{actor}: {label}');
  });

  test('HTML in the header is stored as text (escaping happens at render time)', () => {
    const result = validateConfig({ card: { header: '<img src=x onerror=alert(1)> {label}' } });
    assert.equal(result.config.card.header, '<img src=x onerror=alert(1)> {label}');
  });

  test('card enums and booleans fall back when invalid', () => {
    const result = validateConfig({ card: { style: 'huge', showFormula: 'yes' } });
    assert.equal(result.config.card.style, 'detailed');
    assert.equal(result.config.card.showFormula, true);
    assert.equal(result.ok, false);
  });
});

describe('ability kinds', () => {
  test('defaults are used when the field is missing', () => {
    const result = validateConfig({});
    assert.deepEqual(result.config.abilityKinds, { ability: 'Ability', spell: 'Spell' });
  });

  test('an empty object falls back to the defaults and is reported', () => {
    const result = validateConfig({ abilityKinds: {} });
    assert.deepEqual(result.config.abilityKinds, { ability: 'Ability', spell: 'Spell' });
    assert.equal(result.ok, false);
  });

  test('invalid kind keys are slugged or dropped, invalid labels dropped', () => {
    const result = validateConfig({ abilityKinds: { 'Big Move': 'Big move', '': 'x', ok: 42 } });
    assert.equal(result.config.abilityKinds.big_move, 'Big move');
    assert.equal(result.config.abilityKinds.ok, 'ok', 'a non-text label falls back to the key');
    assert.equal(Object.keys(result.config.abilityKinds).length, 2);
    assert.equal(result.ok, false);
  });
});

// ---------------------------------------------------------------------------
// Idempotence: sanitized output is always clean and stable
// ---------------------------------------------------------------------------

describe('sanitized output is a fixed point', () => {
  const messy = [
    { name: '  a  ', dice: { mode: 'weird', d20: { sides: -4 }, pool: { faces: 'x' } } },
    { attributes: [{ key: 'A B', label: '', min: 99, max: -99, default: 'z' }, { key: 'A B' }] },
    { skills: [{ key: 'x', attr: 'missing', max: 'many' }], resources: [{ key: 'r', color: 'nope' }] },
    { card: { header: '{actor}{actor}{zzz}', accent: '#FFF' }, combat: { initiative: { mode: 'attribute', attr: '' } } },
    { abilityKinds: { '!!': 'x', ok_kind: 'Ok' } },
    'not an object at all',
    null,
  ];

  for (const [i, input] of messy.entries()) {
    test(`case ${i} re-validates with zero errors and the same result`, () => {
      const once = validateConfig(input).config;
      const twice = validateConfig(once);
      assert.equal(twice.ok, true, twice.errors.join(' | '));
      assert.deepEqual(twice.config, once);
    });
  }
});

// ---------------------------------------------------------------------------
// migrateConfig and parseConfig
// ---------------------------------------------------------------------------

describe('migrateConfig', () => {
  test('a config with no version keeps its known keys', () => {
    const base = defaultConfig();
    const { version, ...noVersion } = base;
    assert.equal(version, 1);
    const migrated = migrateConfig(noVersion);
    assert.equal(migrated.version, 1);
    assert.deepEqual(migrated, base);
  });

  test('an unknown future version keeps every known key', () => {
    const base = PRESETS.d6Pool();
    const future = { ...deepClone(base), version: 9, futureField: { deep: true } };
    const migrated = migrateConfig(future);
    assert.equal(migrated.version, 1);
    assert.deepEqual(migrated.attributes, base.attributes);
    assert.deepEqual(migrated.skills, base.skills);
    assert.deepEqual(migrated.resources, base.resources);
    assert.deepEqual(migrated.dice, base.dice);
    assert.equal('futureField' in migrated, false);
  });

  test('a valid v1 config is unchanged by migration', () => {
    assert.deepEqual(migrateConfig(defaultConfig()), defaultConfig());
    assert.deepEqual(migrateConfig(PRESETS.d20Classic()), PRESETS.d20Classic());
  });

  test('non-object input returns the defaults and never throws', () => {
    for (const raw of [null, undefined, 'x', 5, [], () => 1]) {
      assert.deepEqual(migrateConfig(raw), defaultConfig());
    }
  });
});

describe('parseConfig', () => {
  test('valid JSON text round-trips to the same config', () => {
    const text = serializeConfig(PRESETS.d6Pool());
    const result = parseConfig(text);
    assert.equal(result.ok, true);
    assert.deepEqual(result.config, PRESETS.d6Pool());
  });

  test('invalid JSON reports an error and returns defaults', () => {
    const result = parseConfig('{not json');
    assert.equal(result.ok, false);
    assert.deepEqual(result.config, defaultConfig());
  });

  test('a JSON array or scalar is rejected', () => {
    assert.equal(parseConfig('[1,2]').ok, false);
    assert.equal(parseConfig('"text"').ok, false);
    assert.equal(parseConfig('null').ok, false);
  });

  test('non-string input is rejected without throwing', () => {
    for (const value of [undefined, null, 5, {}, []]) {
      const result = parseConfig(value);
      assert.equal(result.ok, false);
      assert.equal(validateConfig(result.config).ok, true);
    }
  });

  test('oversized text is rejected', () => {
    const result = parseConfig(`{"name":"${'x'.repeat(LIMITS.importChars)}"}`);
    assert.equal(result.ok, false);
    assert.equal(validateConfig(result.config).ok, true);
  });

  test('a hostile __proto__ payload from JSON never pollutes', () => {
    const result = parseConfig('{"__proto__":{"admin":true},"dice":{"mode":"pool"}}');
    assert.equal({}.admin, undefined);
    assert.equal(result.config.dice.mode, 'pool');
  });
});

describe('serializeConfig', () => {
  test('serializes the sanitized config, not the raw input', () => {
    const text = serializeConfig({ ...defaultConfig(), secret: 'drop me', name: 'x'.repeat(500) });
    assert.equal(text.includes('drop me'), false);
    const parsed = JSON.parse(text);
    assert.ok(parsed.name.length <= LIMITS.name);
  });

  test('is pretty JSON and stable', () => {
    const a = serializeConfig(defaultConfig());
    assert.equal(a, serializeConfig(defaultConfig()));
    assert.ok(a.includes('\n  '));
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('list helpers', () => {
  test('attributeList, skillList, resourceList and categoryList return arrays, empty when absent', () => {
    const cfg = defaultConfig();
    assert.equal(attributeList(cfg).length, 3);
    assert.equal(skillList(cfg).length, 4);
    assert.equal(resourceList(cfg).length, 2);
    assert.equal(categoryList(cfg).length, 4);
    assert.deepEqual(attributeList({}), []);
    assert.deepEqual(skillList(null), []);
    assert.deepEqual(resourceList(undefined), []);
    assert.deepEqual(categoryList({ itemCategories: 'x' }), []);
  });

  test('abilityKindLabel returns the label, or the kind when unknown', () => {
    const cfg = defaultConfig();
    assert.equal(abilityKindLabel(cfg, 'spell'), 'Spell');
    assert.equal(abilityKindLabel(cfg, 'unknown'), 'unknown');
    assert.equal(abilityKindLabel(cfg, 'constructor'), 'constructor');
    assert.equal(abilityKindLabel(cfg, 42), '');
    assert.equal(abilityKindLabel(null, 'spell'), 'spell');
  });
});

describe('defaultActorData', () => {
  test('fills every attribute, skill and resource with its default', () => {
    const data = defaultActorData(defaultConfig(), 'hero');
    assert.deepEqual(data.attrs, { might: 2, grace: 2, wits: 2 });
    assert.deepEqual(data.skills, { melee: 0, ranged: 0, stealth: 0, lore: 0 });
    assert.deepEqual(data.res, {
      hp: { value: 20, max: null },
      mp: { value: 10, max: null },
    });
    assert.equal(data.notes, '');
  });

  test('works with an unsanitized config and never throws', () => {
    const data = defaultActorData({ attributes: 'bad' }, 'beast');
    assert.deepEqual(data.attrs, {});
    assert.deepEqual(data.res, {});
  });
});

describe('defaultItemData', () => {
  test('gear gets quantity 1, abilities and spells do not', () => {
    const cfg = defaultConfig();
    assert.equal(defaultItemData(cfg, 'gear').quantity, 1);
    assert.equal(defaultItemData(cfg, 'weapon').quantity, 1);
    assert.equal('quantity' in defaultItemData(cfg, 'ability'), false);
    assert.equal('quantity' in defaultItemData(cfg, 'spell'), false);
  });

  test('uses the first category and always includes disabled roll and cost', () => {
    const data = defaultItemData(defaultConfig(), 'spell');
    assert.equal(data.category, 'weapon');
    assert.deepEqual(data.roll, { enabled: false, attr: '', skill: '', bonus: 0, damage: '' });
    assert.deepEqual(data.cost, { res: '', amount: 0 });
  });

  test('empty category list gives an empty category', () => {
    assert.equal(defaultItemData({ itemCategories: [] }, 'gear').category, '');
  });
});

describe('actorValue', () => {
  const cfg = defaultConfig();

  test('reads an attribute from an actor with systemData', () => {
    const actor = { systemData: { attrs: { might: 7 } } };
    assert.equal(actorValue(actor, cfg, 'attr', 'might'), 7);
  });

  test('also accepts the systemData object directly', () => {
    assert.equal(actorValue({ attrs: { wits: 4 } }, cfg, 'attr', 'wits'), 4);
  });

  test('a missing value resolves to the config default', () => {
    assert.equal(actorValue({ systemData: {} }, cfg, 'attr', 'might'), 2);
    assert.equal(actorValue({ systemData: {} }, cfg, 'skill', 'melee'), 0);
  });

  test('values are clamped to the config bounds', () => {
    const actor = { systemData: { attrs: { might: 999 }, skills: { melee: -5 } } };
    assert.equal(actorValue(actor, cfg, 'attr', 'might'), 10);
    assert.equal(actorValue(actor, cfg, 'skill', 'melee'), 0);
  });

  test('a non-numeric stored value falls back to the default', () => {
    const actor = { systemData: { attrs: { might: 'lots' } } };
    assert.equal(actorValue(actor, cfg, 'attr', 'might'), 2);
  });

  test('unknown keys resolve to 0 and inherited properties are ignored', () => {
    const actor = { systemData: { attrs: {} } };
    assert.equal(actorValue(actor, cfg, 'attr', 'ghost'), 0);
    assert.equal(actorValue(actor, cfg, 'attr', 'constructor'), 0);
    assert.equal(actorValue({ systemData: { attrs: {} } }, cfg, 'skill', 'toString'), 0);
  });

  test('an unknown kind resolves to 0 and null actors do not throw', () => {
    assert.equal(actorValue(null, cfg, 'res', 'hp'), 0);
    assert.equal(actorValue(undefined, cfg, 'attr', 'might'), 2);
  });
});

// ---------------------------------------------------------------------------
// Engine boundary, tested against a fake window.Loom
// ---------------------------------------------------------------------------

describe('engine boundary with a fake Loom', () => {
  let saved;
  let calls;
  let store;

  function fakeLoom(overrides = {}) {
    calls = { get: [], set: [], register: [], whenReady: [], api: [] };
    store = { value: undefined };
    const loom = {
      world: { id: 'world-1' },
      user: { isGM: true },
      i18n: { localize: (key) => key },
      settings: {
        whenReady: async (module) => {
          calls.whenReady.push(module);
        },
        get: (module, key) => {
          calls.get.push([module, key]);
          return store.value;
        },
        set: async (module, key, value) => {
          calls.set.push([module, key, value]);
          store.value = value;
        },
        register: (module, key, config) => {
          calls.register.push([module, key, config]);
        },
      },
      api: {
        get: async (path) => {
          calls.api.push(path);
          return { data: {}, error: null };
        },
      },
      ...overrides,
    };
    return loom;
  }

  beforeEach(() => {
    saved = Object.getOwnPropertyDescriptor(globalThis, 'Loom');
  });

  afterEach(() => {
    if (saved) Object.defineProperty(globalThis, 'Loom', saved);
    else delete globalThis.Loom;
  });

  test('without an engine every function degrades safely', async () => {
    delete globalThis.Loom;
    assert.deepEqual(await loadConfig(), defaultConfig());
    assert.deepEqual(await loadConfig({ fresh: false }), defaultConfig());
    assert.equal(registerConfigSetting(), false);
    const saveResult = await saveConfig(defaultConfig());
    assert.equal(saveResult.ok, false);
    assert.equal(typeof onConfigSaved(() => {}), 'function');
  });

  test('loadConfig waits for whenReady and fetches fresh from the GET route', async () => {
    globalThis.Loom = fakeLoom();
    const stored = PRESETS.d6Pool();
    globalThis.Loom.api.get = async (path) => {
      calls.api.push(path);
      return { data: { [CONFIG_KEY]: serializeConfig(stored) }, error: null };
    };
    const cfg = await loadConfig();
    assert.deepEqual(calls.whenReady, [CONFIG_MODULE]);
    assert.deepEqual(calls.api, [`/module-settings/world-1/${CONFIG_MODULE}`]);
    assert.deepEqual(cfg, stored);
    assert.equal(calls.get.length, 0, 'fresh load must not use the cache');
  });

  test('loadConfig with fresh false reads the engine cache', async () => {
    globalThis.Loom = fakeLoom();
    store.value = serializeConfig(PRESETS.d20Classic());
    const cfg = await loadConfig({ fresh: false });
    assert.deepEqual(cfg, PRESETS.d20Classic());
    assert.deepEqual(calls.api, []);
  });

  test('a fresh load with no active world falls back to the cache', async () => {
    globalThis.Loom = fakeLoom({ world: undefined });
    store.value = serializeConfig(PRESETS.d6Pool());
    assert.deepEqual(await loadConfig(), PRESETS.d6Pool());
    assert.deepEqual(calls.api, []);
  });

  test('a failing fetch falls back to the cache, then to the defaults', async () => {
    globalThis.Loom = fakeLoom();
    globalThis.Loom.api.get = async () => {
      throw new Error('offline');
    };
    store.value = serializeConfig(PRESETS.d6Pool());
    assert.deepEqual(await loadConfig(), PRESETS.d6Pool());
    store.value = undefined;
    assert.deepEqual(await loadConfig(), defaultConfig());
  });

  test('a stored object (not text) is accepted and sanitized', async () => {
    globalThis.Loom = fakeLoom();
    globalThis.Loom.api.get = async () => ({ data: { [CONFIG_KEY]: { name: 'Object form', dice: { mode: 'pool' } } }, error: null });
    const cfg = await loadConfig();
    assert.equal(cfg.name, 'Object form');
    assert.equal(cfg.dice.mode, 'pool');
  });

  test('stored garbage yields a valid config, never an exception', async () => {
    globalThis.Loom = fakeLoom();
    globalThis.Loom.api.get = async () => ({ data: { [CONFIG_KEY]: '<script>alert(1)</script>' }, error: null });
    const cfg = await loadConfig();
    assert.equal(validateConfig(cfg).ok, true);
    assert.deepEqual(cfg, defaultConfig());
  });

  test('a server error envelope is treated as a failed fetch', async () => {
    globalThis.Loom = fakeLoom();
    globalThis.Loom.api.get = async () => ({ data: null, error: 'denied' });
    store.value = serializeConfig(PRESETS.d20Classic());
    assert.deepEqual(await loadConfig(), PRESETS.d20Classic());
  });

  test('a missing whenReady does not stop the load', async () => {
    globalThis.Loom = fakeLoom();
    delete globalThis.Loom.settings.whenReady;
    store.value = serializeConfig(PRESETS.d6Pool());
    globalThis.Loom.world = undefined;
    assert.deepEqual(await loadConfig(), PRESETS.d6Pool());
  });

  test('saveConfig writes the sanitized JSON text and notifies listeners', async () => {
    globalThis.Loom = fakeLoom();
    const seen = [];
    const unsubscribe = onConfigSaved((cfg) => seen.push(cfg));
    const result = await saveConfig(PRESETS.d6Pool());
    assert.deepEqual(result, { ok: true, errors: [] });
    assert.equal(calls.set.length, 1);
    const [module, key, value] = calls.set[0];
    assert.equal(module, CONFIG_MODULE);
    assert.equal(key, CONFIG_KEY);
    assert.equal(typeof value, 'string');
    assert.deepEqual(JSON.parse(value), PRESETS.d6Pool());
    assert.equal(seen.length, 1);
    seen[0].name = 'mutated by listener';
    assert.equal(PRESETS.d6Pool().name, 'Dice Pool d6', 'listeners get a copy');

    unsubscribe();
    await saveConfig(defaultConfig());
    assert.equal(seen.length, 1, 'unsubscribed listener is not called');
  });

  test('a throwing listener does not block the others', async () => {
    globalThis.Loom = fakeLoom();
    let secondCalled = false;
    const off1 = onConfigSaved(() => {
      throw new Error('bad listener');
    });
    const off2 = onConfigSaved(() => {
      secondCalled = true;
    });
    const result = await saveConfig(defaultConfig());
    assert.equal(result.ok, true);
    assert.equal(secondCalled, true);
    off1();
    off2();
  });

  test('saveConfig refuses a config with validation errors and writes nothing', async () => {
    globalThis.Loom = fakeLoom();
    const result = await saveConfig({ ...defaultConfig(), attributes: [{ key: 'Bad Key!', label: '' }] });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
    assert.equal(calls.set.length, 0);
  });

  test('saveConfig refuses for a known non-GM user and writes nothing', async () => {
    globalThis.Loom = fakeLoom({ user: { isGM: false } });
    const result = await saveConfig(defaultConfig());
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /GM/);
    assert.equal(calls.set.length, 0);
  });

  test('a rejected settings write is reported, not thrown', async () => {
    globalThis.Loom = fakeLoom();
    globalThis.Loom.settings.set = async () => {
      throw new Error('HTTP 403');
    };
    const result = await saveConfig(defaultConfig());
    assert.deepEqual(result, { ok: false, errors: ['HTTP 403'] });
  });

  test('saveConfig with garbage input never throws', async () => {
    globalThis.Loom = fakeLoom();
    for (const value of [undefined, null, 'x', [], 7]) {
      const result = await saveConfig(value);
      assert.equal(typeof result.ok, 'boolean');
    }
  });

  test('registerConfigSetting registers a world String setting with a valid default', () => {
    globalThis.Loom = fakeLoom();
    assert.equal(registerConfigSetting(), true);
    const [module, key, config] = calls.register[0];
    assert.equal(module, CONFIG_MODULE);
    assert.equal(key, CONFIG_KEY);
    assert.equal(config.scope, 'world');
    assert.equal(config.type, String);
    assert.equal(config.config, false);
    assert.equal(validateConfig(JSON.parse(config.default)).ok, true);
  });

  test('registerConfigSetting uses the localized name when the engine has one', () => {
    globalThis.Loom = fakeLoom();
    globalThis.Loom.i18n.localize = (key) => (key === 'sandbox.config.settingName' ? 'Configuração' : key);
    registerConfigSetting();
    assert.equal(calls.register[0][2].name, 'Configuração');
  });

  test('registerConfigSetting survives an engine without settings.register', () => {
    globalThis.Loom = { settings: {} };
    assert.equal(registerConfigSetting(), false);
  });
});

// ---------------------------------------------------------------------------
// Synchronous cached getter (used by render paths that cannot await)
// ---------------------------------------------------------------------------

describe('getConfigSync', () => {
  let saved;

  beforeEach(() => {
    saved = Object.getOwnPropertyDescriptor(globalThis, 'Loom');
    clearConfigCache();
  });

  afterEach(() => {
    clearConfigCache();
    if (saved) Object.defineProperty(globalThis, 'Loom', saved);
    else delete globalThis.Loom;
  });

  test('without an engine returns the default config', () => {
    delete globalThis.Loom;
    assert.deepEqual(getConfigSync(), defaultConfig());
  });

  test('reads the engine cache when nothing was loaded yet', () => {
    const stored = PRESETS.d6Pool();
    globalThis.Loom = {
      settings: { get: () => serializeConfig(stored) },
    };
    assert.deepEqual(getConfigSync(), stored);
  });

  test('falls back to the default when the cache holds garbage', () => {
    globalThis.Loom = { settings: { get: () => '{not json' } };
    assert.deepEqual(getConfigSync(), defaultConfig());
  });

  test('returns the last loaded config as a copy, not a live reference', async () => {
    const stored = PRESETS.d20Classic();
    globalThis.Loom = {
      world: { id: 'w' },
      user: { isGM: true },
      settings: { whenReady: async () => {}, get: () => undefined, set: async () => {} },
      api: { get: async () => ({ data: { [CONFIG_KEY]: serializeConfig(stored) }, error: null }) },
    };
    await loadConfig();
    const first = getConfigSync();
    assert.deepEqual(first, stored);
    first.attributes.push({ key: 'x', label: 'X', min: 0, max: 1, default: 0 });
    assert.deepEqual(getConfigSync(), stored, 'mutating the result must not change the cache');
  });
});
