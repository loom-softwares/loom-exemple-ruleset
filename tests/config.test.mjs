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
  attributeRollValue,
  loadConfig,
  saveConfig,
  onConfigSaved,
  registerConfigSetting,
  getConfigSync,
  clearConfigCache,
  LAYOUT_BLOCKS,
  ITEM_LAYOUT_BLOCKS,
  LAYOUT_LIMITS,
  defaultLayout,
  resolveLayout,
  resolveItemLayout,
  groupedList,
  skillSections,
  blockLabelKey,
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

test('defaultConfig is a valid v2 config with zero validation errors', () => {
  const cfg = expectClean(defaultConfig());
  assert.equal(cfg.version, 2);
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

describe('optional d20 attribute modifiers', () => {
  test('uses floor((score - 10) / 2) only when enabled', () => {
    const cfg = defaultConfig();
    cfg.attributes[0].useD20Modifier = true;
    assert.equal(attributeRollValue(cfg, 'might', 16), 3);
    assert.equal(attributeRollValue(cfg, 'might', 9), -1);
    assert.equal(attributeRollValue(cfg, 'might', 8), -1);
    assert.equal(attributeRollValue(cfg, 'grace', 16), 16, 'other attributes keep their raw value');
  });

  test('missing and malformed flags safely default to disabled', () => {
    const cfg = defaultConfig();
    delete cfg.attributes[0].useD20Modifier;
    assert.equal(validateConfig(cfg).config.attributes[0].useD20Modifier, false);
    cfg.attributes[0].useD20Modifier = 'yes';
    assert.equal(validateConfig(cfg).config.attributes[0].useD20Modifier, false);
    assert.equal(attributeRollValue(cfg, 'might', 16), 16);
  });
});

test('attribute display mode is dots or numbers and defaults to numbers', () => {
  const cfg = defaultConfig();
  assert.equal(cfg.attributeDisplay, 'number');
  cfg.attributeDisplay = 'dots';
  assert.equal(validateConfig(cfg).config.attributeDisplay, 'dots');
  cfg.attributeDisplay = 'bars';
  assert.equal(validateConfig(cfg).config.attributeDisplay, 'number');
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
    assert.equal(version, 2);
    const migrated = migrateConfig(noVersion);
    assert.equal(migrated.version, 2);
    assert.deepEqual(migrated, base);
  });

  test('an unknown future version keeps every known key', () => {
    const base = PRESETS.d6Pool();
    const future = { ...deepClone(base), version: 9, futureField: { deep: true } };
    const migrated = migrateConfig(future);
    assert.equal(migrated.version, 2);
    assert.deepEqual(migrated.attributes, base.attributes);
    assert.deepEqual(migrated.skills, base.skills);
    assert.deepEqual(migrated.resources, base.resources);
    assert.deepEqual(migrated.dice, base.dice);
    assert.equal('futureField' in migrated, false);
  });

  test('a v1 config retains old data and disables newly introduced optional mechanics', () => {
    const old = deepClone(PRESETS.d20Classic());
    old.version = 1;
    delete old.saves;
    delete old.attacks;
    delete old.magic;
    const migrated = migrateConfig(old);
    assert.equal(migrated.version, 2);
    assert.deepEqual(migrated.attributes, old.attributes);
    assert.deepEqual(migrated.skills, old.skills);
    assert.deepEqual(migrated.resources, old.resources);
    assert.deepEqual(migrated.saves, { enabled: false, entries: [] });
    assert.equal(migrated.attacks.enabled, true);
    assert.equal(migrated.attacks.profiles[0].key, 'basic');
    assert.equal(migrated.magic.enabled, true);
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
    assert.deepEqual(calls.api, [`/module-settings/world-1/${encodeURIComponent(CONFIG_MODULE)}`]);
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

// ---------------------------------------------------------------------------
// Layout (actor tabs, item tabs), group field and migration
// ---------------------------------------------------------------------------

/** Config with the layout patched; everything else default. */
function withLayout(patch) {
  return withCfg({ layout: { ...defaultLayout(), ...patch } });
}

function flatBlocks(tabs) {
  return tabs.flatMap((tab) => tab.blocks);
}

const ACTOR_DEFAULT_TABS = [
  { key: 'main', label: 'Main', columns: 1, blocks: ['resources', 'attributes', 'skills', 'saves'], blockSpans: {} },
  { key: 'attacks', label: 'Attacks', columns: 1, blocks: ['attacks'], blockSpans: {} },
  { key: 'magic', label: 'Magic', columns: 1, blocks: ['magic'], blockSpans: {} },
  { key: 'powers', label: 'Powers', columns: 1, blocks: ['items:ability', 'items:spell'], blockSpans: {} },
  { key: 'gear', label: 'Gear', columns: 1, blocks: ['items:gear', 'items:other', 'notes'], blockSpans: {} },
  { key: 'effects', label: 'Effects', columns: 1, blocks: ['effects'], blockSpans: {} },
];

const ITEM_DEFAULT_TABS = [
  { key: 'details', label: 'Details', columns: 2, blocks: ['details', 'uses'], blockSpans: {} },
  { key: 'rules', label: 'Rules', columns: 2, blocks: ['roll', 'cost'], blockSpans: {} },
  { key: 'effects', label: 'Effects', columns: 1, blocks: ['effects'], blockSpans: {} },
  { key: 'text', label: 'Description', columns: 1, blocks: ['description'], blockSpans: {} },
];

describe('layout defaults', () => {
  test('default actor and item layouts are valid and deterministic', () => {
    const cfg = expectClean(defaultConfig());
    assert.deepEqual(cfg.layout.tabs, ACTOR_DEFAULT_TABS);
    assert.deepEqual(cfg.layout.itemTabs, ITEM_DEFAULT_TABS);
    assert.equal(cfg.layout.density, 'comfortable');
    assert.equal(cfg.layout.skillGrouping, 'attribute');
    assert.equal(serializeConfig(defaultConfig()), serializeConfig(defaultConfig()));
  });

  test('both presets carry the default layout and validate cleanly', () => {
    for (const name of Object.keys(PRESETS)) {
      const cfg = expectClean(PRESETS[name]());
      assert.deepEqual(cfg.layout, defaultLayout());
    }
  });

  test('block lists are frozen and complete', () => {
    assert.ok(Object.isFrozen(LAYOUT_BLOCKS));
    assert.ok(Object.isFrozen(ITEM_LAYOUT_BLOCKS));
    assert.deepEqual(
      [...LAYOUT_BLOCKS],
      ['resources', 'attributes', 'skills', 'saves', 'attacks', 'magic', 'items:gear', 'items:ability', 'items:spell', 'items:other', 'notes', 'effects'],
    );
    assert.deepEqual([...ITEM_LAYOUT_BLOCKS], ['details', 'uses', 'roll', 'cost', 'description', 'effects']);
    assert.equal(LAYOUT_LIMITS.maxTabs, 8);
    assert.equal(LAYOUT_LIMITS.maxBlocksPerTab, 12);
    assert.equal(LAYOUT_LIMITS.minColumns, 1);
    assert.equal(LAYOUT_LIMITS.maxColumns, 4);
    assert.equal(LAYOUT_LIMITS.label, 40);
  });
});

describe('layout tab rules', () => {
  test('unknown block is an error and is dropped', () => {
    const r = validateConfig(withLayout({ tabs: [{ key: 'main', label: 'Main', columns: 2, blocks: ['resources', 'bogus'] }] }));
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' | '), /bogus/);
    assert.deepEqual(r.config.layout.tabs[0].blocks, ['resources']);
  });

  test('an item block in the actor tabs is an error', () => {
    const r = validateConfig(withLayout({ tabs: [{ key: 'main', label: 'Main', columns: 1, blocks: ['details', 'skills'] }] }));
    assert.equal(r.ok, false);
    assert.deepEqual(r.config.layout.tabs[0].blocks, ['skills']);
  });

  test('an actor block in the item tabs is an error', () => {
    const r = validateConfig(withLayout({ itemTabs: [{ key: 'details', label: 'D', columns: 1, blocks: ['resources', 'uses'] }] }));
    assert.equal(r.ok, false);
    assert.deepEqual(r.config.layout.itemTabs[0].blocks, ['uses']);
  });

  test('a block in two actor tabs is an error and keeps the first occurrence', () => {
    const r = validateConfig(withLayout({
      tabs: [
        { key: 'a', label: 'A', columns: 1, blocks: ['skills', 'notes'] },
        { key: 'b', label: 'B', columns: 1, blocks: ['notes', 'resources'] },
      ],
    }));
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' | '), /notes/);
    assert.deepEqual(r.config.layout.tabs.map((t) => t.blocks), [['skills', 'notes'], ['resources']]);
  });

  test('a block in two item tabs is an error and keeps the first occurrence', () => {
    const r = validateConfig(withLayout({
      itemTabs: [
        { key: 'a', label: 'A', columns: 1, blocks: ['roll'] },
        { key: 'b', label: 'B', columns: 1, blocks: ['roll', 'cost'] },
      ],
    }));
    assert.equal(r.ok, false);
    assert.deepEqual(r.config.layout.itemTabs.map((t) => t.blocks), [['roll'], ['cost']]);
  });

  test('the same block twice in one tab is an error', () => {
    const r = validateConfig(withLayout({ tabs: [{ key: 'main', label: 'Main', columns: 1, blocks: ['resources', 'resources'] }] }));
    assert.equal(r.ok, false);
    assert.deepEqual(r.config.layout.tabs[0].blocks, ['resources']);
  });

  test('empty tab lists fall back to the default tabs with an error', () => {
    const actor = validateConfig(withLayout({ tabs: [] }));
    assert.equal(actor.ok, false);
    assert.deepEqual(actor.config.layout.tabs, defaultLayout().tabs);
    const item = validateConfig(withLayout({ itemTabs: [] }));
    assert.equal(item.ok, false);
    assert.deepEqual(item.config.layout.itemTabs, defaultLayout().itemTabs);
  });

  test('a non-list tabs value falls back to the default tabs', () => {
    const r = validateConfig(withLayout({ tabs: 'main' }));
    assert.equal(r.ok, false);
    assert.deepEqual(r.config.layout.tabs, defaultLayout().tabs);
  });

  test('missing tab keys use the defaults silently', () => {
    const cfg = expectClean(withCfg({ layout: { density: 'compact' } }));
    assert.equal(cfg.layout.density, 'compact');
    assert.deepEqual(cfg.layout.tabs, defaultLayout().tabs);
    assert.deepEqual(cfg.layout.itemTabs, defaultLayout().itemTabs);
  });

  test('duplicate tab keys are dropped and the tab count is capped at 8', () => {
    const dup = validateConfig(withLayout({
      tabs: [
        { key: 'main', label: 'Main', columns: 1, blocks: ['resources'] },
        { key: 'main', label: 'Again', columns: 1, blocks: ['skills'] },
      ],
    }));
    assert.equal(dup.ok, false);
    assert.equal(dup.config.layout.tabs.length, 1);
    const many = validateConfig(withLayout({
      tabs: Array.from({ length: 9 }, (_, i) => ({ key: `tab${i}`, label: `T${i}`, columns: 1, blocks: [] })),
    }));
    assert.equal(many.config.layout.tabs.length, 8);
    assert.match(many.errors.join(' | '), /at most 8/);
  });

  test('columns clamp to 1..4 and default to 2 when missing', () => {
    const cols = (c) => validateConfig(withLayout({ tabs: [{ key: 'a', label: 'A', columns: c, blocks: ['notes'] }] })).config.layout.tabs[0].columns;
    assert.equal(cols(0), 1);
    assert.equal(cols(9), 4);
    assert.equal(cols('x'), 2);
    assert.equal(cols(2.6), 3);
    const clean = expectClean(withLayout({ tabs: [{ key: 'a', label: 'A', blocks: ['notes'] }] }));
    assert.equal(clean.layout.tabs[0].columns, 2);
  });

  test('item tab columns follow the same clamp', () => {
    const cols = (c) => validateConfig(withLayout({ itemTabs: [{ key: 'a', label: 'A', columns: c, blocks: ['cost'] }] })).config.layout.itemTabs[0].columns;
    assert.equal(cols(-3), 1);
    assert.equal(cols(7), 4);
  });

  test('invalid density and skillGrouping fall back with an error', () => {
    const r = validateConfig(withCfg({ layout: { density: 'huge', skillGrouping: 'x' } }));
    assert.equal(r.ok, false);
    assert.equal(r.config.layout.density, 'comfortable');
    assert.equal(r.config.layout.skillGrouping, 'attribute');
    assert.equal(validateConfig(withLayout({ density: 'compact', skillGrouping: 'none' })).config.layout.skillGrouping, 'none');
  });

  test('a block missing from every tab is not an error (resolveLayout shows it)', () => {
    expectClean(withLayout({ tabs: [{ key: 'only', label: 'Only', columns: 1, blocks: ['notes'] }] }));
  });
});

describe('layout hostile input', () => {
  const hostile = [null, 'x', 5, [], [null], [42], [{}], ['notes'], {}, { tabs: 'x' }, { tabs: {} }, { itemTabs: [null] }];

  test('never throws on any layout shape and the result re-validates', () => {
    for (const layout of hostile) {
      const cfg = withCfg({ layout });
      assert.doesNotThrow(() => validateConfig(cfg));
      assert.doesNotThrow(() => resolveLayout(cfg));
      assert.doesNotThrow(() => resolveItemLayout(cfg));
      const once = validateConfig(cfg).config;
      assert.equal(validateConfig(once).ok, true);
    }
  });

  test('labels with markup stay inert text', () => {
    const label = '<img onerror=x>"><script>';
    const r = validateConfig(withLayout({
      tabs: [{ key: 'main', label, columns: 1, blocks: ['notes'] }],
      itemTabs: [{ key: 'd', label, columns: 1, blocks: ['cost'] }],
    }));
    assert.equal(r.config.layout.tabs[0].label, label);
    assert.equal(r.config.layout.itemTabs[0].label, label);
  });

  test('__proto__ keys do not pollute prototypes', () => {
    const raw = JSON.parse('{"layout":{"__proto__":{"polluted":true},"tabs":[{"__proto__":{"x":1},"key":"ok","label":"Ok","blocks":["notes"]}]}}');
    const r = validateConfig(raw);
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal(({}).x, undefined);
    assert.equal(r.config.layout.tabs[0].key, 'ok');
    assert.deepEqual(r.config.layout.tabs[0].blocks, ['notes']);
  });

  test('cyclic objects in tabs and blocks do not throw', () => {
    const cyc = {};
    cyc.self = cyc;
    cyc.tabs = [cyc];
    const block = {};
    block.loop = block;
    const tabs = [cyc, { key: 'main', label: 'M', columns: 1, blocks: [block, 'notes'] }];
    assert.doesNotThrow(() => validateConfig(withLayout({ tabs })));
    const r = validateConfig(withLayout({ tabs }));
    assert.deepEqual(r.config.layout.tabs.map((t) => t.key), ['main']);
    assert.deepEqual(r.config.layout.tabs[0].blocks, ['notes']);
  });

  test('huge lists are capped', () => {
    const tabs = Array.from({ length: 5000 }, (_, i) => ({ key: `t${i}`, label: 'T', columns: 1, blocks: ['notes', 'notes'] }));
    const r = validateConfig(withLayout({ tabs }));
    assert.equal(r.config.layout.tabs.length, 8);
    const blocks = Array.from({ length: 5000 }, () => 'resources');
    const r2 = validateConfig(withLayout({ tabs: [{ key: 'main', label: 'M', columns: 1, blocks }] }));
    assert.deepEqual(r2.config.layout.tabs[0].blocks, ['resources']);
  });
});

describe('layout idempotence', () => {
  const messy = [
    { layout: { density: 'weird', skillGrouping: 9, tabs: [{ key: 'A B', label: '', columns: 99, blocks: ['skills', 'bogus', 'skills'] }, { key: 'A B' }, null] } },
    { layout: { tabs: [{ key: 'x', blocks: ['notes', 'items:gear'] }, { key: 'y', blocks: ['notes', 'details'] }], itemTabs: [{ key: 'd', blocks: ['details', 'resources', 'uses'] }, { key: 'd' }] } },
    { layout: { tabs: [], itemTabs: 'none' } },
    { layout: 'nope' },
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

describe('resolveLayout and resolveItemLayout', () => {
  test('missing actor blocks go to the first tab in canonical order and other tabs are kept', () => {
    const cfg = withLayout({
      tabs: [
        { key: 'a', label: 'A', columns: 1, blocks: ['notes'] },
        { key: 'b', label: 'B', columns: 3, blocks: ['skills'] },
      ],
    });
    const layout = resolveLayout(cfg);
    assert.deepEqual(layout.tabs, [
      { key: 'a', label: 'A', columns: 1, blocks: ['notes', 'resources', 'attributes', 'items:gear', 'items:ability', 'items:spell', 'items:other', 'effects'], blockSpans: {} },
      { key: 'b', label: 'B', columns: 3, blocks: ['skills'], blockSpans: {} },
    ]);
  });

  test('every actor block is shown exactly once for any valid layout', () => {
    const configs = [defaultConfig(), PRESETS.d6Pool(), withLayout({ tabs: [{ key: 'only', label: 'Only', columns: 4, blocks: [] }] })];
    for (const cfg of configs) {
      const optional = flatBlocks(cfg.layout.tabs).filter((key) => ['saves', 'attacks', 'magic'].includes(key));
      const allowed = optional.filter((key) => key === 'saves' ? cfg.saves.enabled && cfg.saves.entries.some((entry) => entry.showOnSheet) : key === 'attacks' ? cfg.attacks.enabled && cfg.attacks.profiles.length : cfg.magic.enabled);
      assert.deepEqual(flatBlocks(resolveLayout(cfg).tabs).sort(), [...LAYOUT_BLOCKS.filter((key) => !['saves', 'attacks', 'magic'].includes(key)), ...allowed].sort());
    }
  });

  test('an actor config that omits effects still shows it, in the first tab', () => {
    const cfg = withLayout({ tabs: [{ key: 'main', label: 'Main', columns: 1, blocks: ['resources'] }] });
    const tabs = resolveLayout(cfg).tabs;
    assert.equal(tabs.length, 1);
    assert.ok(tabs[0].blocks.includes('effects'));
  });

  test('an item config that omits effects still shows it, in the first item tab', () => {
    const cfg = withLayout({ itemTabs: [{ key: 'x', label: 'X', columns: 1, blocks: ['cost'] }, { key: 'y', label: 'Y', columns: 1, blocks: ['description'] }] });
    const { tabs } = resolveItemLayout(cfg);
    assert.ok(tabs[0].blocks.includes('effects'));
    assert.ok(!tabs[1].blocks.includes('effects'));
    assert.deepEqual(flatBlocks(tabs).sort(), [...ITEM_LAYOUT_BLOCKS].sort());
  });

  test('missing item blocks go to the first item tab in canonical order', () => {
    const cfg = withLayout({
      itemTabs: [
        { key: 'x', label: 'X', columns: 1, blocks: ['cost'] },
        { key: 'y', label: 'Y', columns: 2, blocks: ['description'] },
      ],
    });
    const { tabs } = resolveItemLayout(cfg);
    assert.deepEqual(tabs[0].blocks, ['cost', 'details', 'uses', 'roll', 'effects']);
    assert.deepEqual(tabs[1], { key: 'y', label: 'Y', columns: 2, blocks: ['description'], blockSpans: {} });
  });

  test('empty tab lists resolve to the default layout with every block', () => {
    const actor = resolveLayout(withLayout({ tabs: [] }));
    assert.deepEqual(actor.tabs.map((t) => t.key), ['main', 'attacks', 'magic', 'powers', 'gear', 'effects']);
    assert.deepEqual(flatBlocks(actor.tabs).sort(), [...LAYOUT_BLOCKS.filter((key) => key !== 'saves')].sort());
    assert.deepEqual(resolveItemLayout(withLayout({ itemTabs: [] })), { tabs: defaultLayout().itemTabs });
  });

  test('resolution is safe for null and does not mutate the config', () => {
    assert.deepEqual(resolveLayout(null), resolveLayout(defaultConfig()));
    assert.deepEqual(resolveItemLayout(null), resolveItemLayout(defaultConfig()));
    const cfg = withLayout({ tabs: [{ key: 'a', label: 'A', columns: 1, blocks: ['notes'] }] });
    const before = serializeConfig(cfg);
    resolveLayout(cfg);
    resolveItemLayout(cfg);
    assert.equal(serializeConfig(cfg), before);
  });
});

describe('groupedList', () => {
  test('keeps the order of first appearance and puts ungrouped items in ""', () => {
    const items = [
      { name: 'a', group: 'Combat' },
      { name: 'b', group: 'Social' },
      { name: 'c', group: 'Combat' },
      { name: 'd' },
      { name: 'e', group: 'Social' },
      { name: 'f', group: '  ' },
    ];
    assert.deepEqual(groupedList(items), [
      { group: 'Combat', items: [items[0], items[2]] },
      { group: 'Social', items: [items[1], items[4]] },
      { group: '', items: [items[3], items[5]] },
    ]);
  });

  test('hostile group values are data and never special keys', () => {
    const groups = groupedList([{ group: '__proto__' }, { group: 'constructor' }, { group: 5 }, null]);
    assert.deepEqual(groups.map((g) => g.group), ['__proto__', 'constructor', '']);
    assert.deepEqual(groups[2].items.length, 2);
  });

  test('non-lists give an empty result', () => {
    for (const value of [null, 'x', {}, undefined]) assert.deepEqual(groupedList(value), []);
  });
});

describe('skillSections', () => {
  const skills = [
    { key: 'melee', label: 'Melee', attr: 'might', group: 'Combat', max: 10, default: 0 },
    { key: 'ranged', label: 'Ranged', attr: 'grace', group: 'Combat', max: 10, default: 0 },
    { key: 'lore', label: 'Lore', attr: 'wits', group: 'Knowledge', max: 10, default: 0 },
    { key: 'stray', label: 'Stray', attr: 'gone', group: '', max: 10, default: 0 },
  ];
  const summary = (sections) => sections.map((s) => ({ key: s.key, title: s.title, skills: s.skills.map((k) => k.key) }));

  test('attribute mode groups by attribute, and a missing attribute gives the untitled section', () => {
    const cfg = withCfg({ skills });
    assert.deepEqual(summary(skillSections(cfg)), [
      { key: 'might', title: 'Might', skills: ['melee'] },
      { key: 'grace', title: 'Grace', skills: ['ranged'] },
      { key: 'wits', title: 'Wits', skills: ['lore'] },
      { key: '', title: '', skills: ['stray'] },
    ]);
  });

  test('group mode groups by the skill group, and an empty group has no title', () => {
    const cfg = withCfg({ skills, layout: { ...defaultLayout(), skillGrouping: 'group' } });
    assert.deepEqual(summary(skillSections(cfg)), [
      { key: 'Combat', title: 'Combat', skills: ['melee', 'ranged'] },
      { key: 'Knowledge', title: 'Knowledge', skills: ['lore'] },
      { key: '', title: '', skills: ['stray'] },
    ]);
  });

  test('none mode gives exactly one untitled section with every skill', () => {
    const cfg = withCfg({ skills, layout: { ...defaultLayout(), skillGrouping: 'none' } });
    assert.deepEqual(summary(skillSections(cfg)), [
      { key: 'all', title: '', skills: ['melee', 'ranged', 'lore', 'stray'] },
    ]);
  });

  test('a skill whose attribute was removed is shown in the untitled section, not dropped', () => {
    const cfg = withCfg({ attributes: [{ key: 'might', label: 'Might', min: 0, max: 10, default: 2 }], skills: [{ key: 'lore', label: 'Lore', attr: 'wits', max: 10, default: 0 }] });
    const sections = skillSections(cfg);
    assert.deepEqual(summary(sections), [{ key: '', title: '', skills: ['lore'] }]);
  });

  test('never throws on hostile input', () => {
    assert.doesNotThrow(() => skillSections(null));
    assert.doesNotThrow(() => skillSections({ skills: 'x' }));
  });
});

describe('blockLabelKey', () => {
  test('actor blocks map to sandbox.layout.block.<name>', () => {
    assert.equal(blockLabelKey('resources'), 'sandbox.layout.block.resources');
    assert.equal(blockLabelKey('items:gear'), 'sandbox.layout.block.items_gear');
    assert.equal(blockLabelKey('effects'), 'sandbox.layout.block.effects');
  });

  test('item blocks map to sandbox.layout.item.<name>', () => {
    assert.equal(blockLabelKey('details'), 'sandbox.layout.item.details');
    assert.equal(blockLabelKey('description'), 'sandbox.layout.item.description');
    assert.equal(blockLabelKey('effects', 'item'), 'sandbox.layout.item.effects');
  });

  test('unknown or non-text blocks give an empty key', () => {
    assert.equal(blockLabelKey('bogus'), '');
    assert.equal(blockLabelKey(undefined), '');
    assert.equal(blockLabelKey(42), '');
  });

  test('every block has a key', () => {
    for (const block of LAYOUT_BLOCKS) assert.notEqual(blockLabelKey(block), '');
    for (const block of ITEM_LAYOUT_BLOCKS) assert.notEqual(blockLabelKey(block), '');
  });
});

describe('group field and migration of configs written before layout', () => {
  test('an old config without layout or group gets the defaults and loses nothing', () => {
    const old = deepClone(defaultConfig());
    delete old.layout;
    for (const a of old.attributes) delete a.group;
    for (const s of old.skills) delete s.group;
    expectClean(old);
    assert.deepEqual(migrateConfig(old), defaultConfig());
  });

  test('an old preset without the new keys keeps every value', () => {
    const old = deepClone(PRESETS.d6Pool());
    delete old.layout;
    for (const a of old.attributes) delete a.group;
    for (const s of old.skills) delete s.group;
    assert.deepEqual(migrateConfig(old), PRESETS.d6Pool());
  });

  test('group is trimmed and cut to 40 characters with an error', () => {
    const r = validateConfig(withCfg({ skills: [{ key: 'a', label: 'A', group: `  ${'x'.repeat(50)}  `, max: 5, default: 0 }] }));
    assert.equal(r.ok, false);
    assert.equal(r.config.skills[0].group.length, 40);
  });

  test('non-text group is cleared with an error', () => {
    const r = validateConfig(withCfg({ attributes: [{ key: 'might', label: 'Might', group: 5, min: 0, max: 10, default: 2 }] }));
    assert.equal(r.ok, false);
    assert.equal(r.config.attributes[0].group, '');
  });
});
