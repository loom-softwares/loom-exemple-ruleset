// Tests for lib/dice.mjs. Run with: node --test tests/dice.test.mjs
// Configs are built inline (no dependency on lib/config.mjs).
// The check against the REAL server parser lives outside this repo (it needs the engine's
// TypeScript roller); see the scratch script noted in the report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCheck, buildExtra, interpret, describe, rollCheck, DICE_LIMITS } from '../lib/dice.mjs';

const d20Cfg = {
  version: 1,
  name: 'Test d20',
  dice: { mode: 'd20', d20: { sides: 20, critMin: 20, fumbleMax: 1, targetLabel: 'DC' } },
};

const poolCfg = {
  version: 1,
  name: 'Test pool',
  dice: { mode: 'pool', pool: { faces: 6, successMin: 5, maxDice: 20, glitchOnOnes: true } },
};

const SERVER_FORMULA = /^(\d+d\d+(kh1|kl1)?|\d+d\d+cs>=\d+)([+-]\d+)?$/;

test('d20: plain check is 1d20 with a signed modifier', () => {
  const r = buildCheck(d20Cfg, { attrValue: 2, skillValue: 3, bonus: 1 });
  assert.equal(r.formula, '1d20+6');
  assert.equal(r.meta.system, 'loom-demo');
  assert.equal(r.meta.kind, 'check');
  assert.equal(r.meta.mode, 'd20');
  assert.equal(r.meta.sides, 20);
  assert.equal(r.meta.critMin, 20);
  assert.equal(r.meta.fumbleMax, 1);
  assert.equal(r.meta.successMin, undefined);
});

test('d20: advantage keeps the highest of two, disadvantage the lowest', () => {
  assert.equal(buildCheck(d20Cfg, { attrValue: 1, advantage: 'adv' }).formula, '2d20kh1+1');
  assert.equal(buildCheck(d20Cfg, { attrValue: 1, advantage: 'dis' }).formula, '2d20kl1+1');
});

test('d20: zero and negative modifiers', () => {
  assert.equal(buildCheck(d20Cfg, {}).formula, '1d20+0');
  assert.equal(buildCheck(d20Cfg, { attrValue: -2, skillValue: -1 }).formula, '1d20-3');
  assert.equal(buildCheck(d20Cfg, { attrValue: 1, skillValue: 1, bonus: -2, advantage: 'dis' }).formula, '2d20kl1+0');
});

test('d20: non-numeric and unknown inputs fall back to safe values', () => {
  const r = buildCheck(d20Cfg, { attrValue: 'abc', skillValue: null, bonus: NaN, advantage: 'weird' });
  assert.equal(r.formula, '1d20+0');
});

test('d20: the modifier is clamped so a huge value cannot bloat the formula', () => {
  const r = buildCheck(d20Cfg, { attrValue: 10 ** 9 });
  assert.equal(r.formula, `1d20+${DICE_LIMITS.maxModifier}`);
});

test('pool: count is attr+skill+bonus, clamped to 1..maxDice', () => {
  assert.equal(buildCheck(poolCfg, { attrValue: 3, skillValue: 2 }).formula, '5d6cs>=5');
  assert.equal(buildCheck(poolCfg, { attrValue: 0, skillValue: 0 }).formula, '1d6cs>=5');
  assert.equal(buildCheck(poolCfg, { attrValue: -9 }).formula, '1d6cs>=5');
  assert.equal(buildCheck(poolCfg, { attrValue: 30 }).formula, '20d6cs>=5');
});

test('pool: advantage adds one die, disadvantage removes one, both stay clamped', () => {
  assert.equal(buildCheck(poolCfg, { attrValue: 3, advantage: 'adv' }).formula, '4d6cs>=5');
  assert.equal(buildCheck(poolCfg, { attrValue: 3, advantage: 'dis' }).formula, '2d6cs>=5');
  assert.equal(buildCheck(poolCfg, { attrValue: 0, advantage: 'dis' }).formula, '1d6cs>=5');
  assert.equal(buildCheck(poolCfg, { attrValue: 20, advantage: 'adv' }).formula, '20d6cs>=5');
});

test('pool: meta carries the success rule and the glitch flag', () => {
  const r = buildCheck(poolCfg, { attrValue: 2 });
  assert.equal(r.meta.mode, 'pool');
  assert.equal(r.meta.faces, 6);
  assert.equal(r.meta.successMin, 5);
  assert.equal(r.meta.glitchOnOnes, true);
  assert.equal(r.meta.sides, undefined);
});

test('pool: successMin is kept within 2..faces even for a broken config', () => {
  const broken = { dice: { mode: 'pool', pool: { faces: 6, successMin: 99 } } };
  assert.equal(buildCheck(broken, { attrValue: 1 }).formula, '1d6cs>=6');
});

test('buildCheck formulas have the shape the server grammar accepts', () => {
  const cases = [];
  for (const advantage of ['none', 'adv', 'dis']) {
    for (const attrValue of [-30, -1, 0, 1, 7, 50]) {
      cases.push(buildCheck(d20Cfg, { attrValue, advantage }).formula);
      cases.push(buildCheck(poolCfg, { attrValue, advantage }).formula);
    }
  }
  for (const f of cases) assert.match(f, SERVER_FORMULA, f);
});

test('buildExtra accepts plain dice, integers, parentheses and unary minus', () => {
  const ok = {
    '1d6': '1d6',
    '2d8+3': '2d8+3',
    ' 1 d 6 ': '1d6',
    '1D6': '1d6',
    'd6': 'd6',
    '1d6+-2': '1d6+-2',
    '-(1d4)': '-(1d4)',
    '(1d6+2)': '(1d6+2)',
    '3': '3',
    '1d6-(2d4+1)': '1d6-(2d4+1)',
  };
  for (const [input, expected] of Object.entries(ok)) {
    const r = buildExtra(input);
    assert.equal(r.ok, true, input);
    assert.equal(r.formula, expected, input);
  }
});

test('buildExtra rejects anything outside plain dice, integers and + - ( )', () => {
  const bad = [
    '', '   ', 1, null, undefined,
    '1d6kh1', '2d20kl1', '1d6x', '1d6r', '1d6cs>=5', '1d6cf<=1', // modifiers and counters
    '1d6+@str', '@str', // variables
    'min(1,2)', 'max(1d6,2)', 'floor(1d6/2)', // functions and division
    '1d6*2', '1d6/2', // multiplication
    '1dF', '4dF', // fate dice
    '+1d6', // leading plus is not a server prefix
    '0d6', '1d1', '1d1001', '1d0', // zero dice, bad faces
    '101d6', '60d6+50d6', // dice cap
    '1001', '1d6+1001', // literal cap
    '(1d6', '1d6)', '()', '1d6+', '1d6++2', '1d', 'd', '1dd6', // structure
    '1d6;rm', '1d6 \n\t x', '1d6"', '<img>', // junk characters
    '1d6 2d', // whitespace is stripped first, so this is "1d62d" (dangling d): rejected
    'x'.repeat(DICE_LIMITS.maxExtraLength + 1),
  ];
  for (const input of bad) {
    const r = buildExtra(input);
    assert.equal(r.ok, false, JSON.stringify(input));
    assert.equal(r.formula, '');
  }
});

test('buildExtra enforces the length cap at the boundary', () => {
  // '1d6' + 48 x '+1' = 99 chars: accepted. One more '+1' = 101 chars: rejected by length.
  const atLimit = '1d6' + '+1'.repeat(48);
  assert.equal(atLimit.length, 99);
  assert.equal(buildExtra(atLimit).ok, true);
  const over = atLimit + '+1';
  assert.equal(over.length, 101);
  assert.deepEqual(buildExtra(over), { ok: false, formula: '', error: 'too-long' });
});

test('interpret: d20 natural, crit and fumble from a kept die', () => {
  const roll = {
    formula: '2d20kh1+3',
    total: 23,
    terms: [
      { kind: 'dice', count: 2, faces: 20, rolls: [20, 5], dropped: [false, true], subtotal: 20 },
      { kind: 'modifier', value: 3 },
    ],
    meta: { mode: 'd20', critMin: 20, fumbleMax: 1 },
  };
  const r = interpret(d20Cfg, roll);
  assert.equal(r.mode, 'd20');
  assert.equal(r.total, 23);
  assert.equal(r.natural, 20);
  assert.equal(r.crit, true);
  assert.equal(r.fumble, false);
  assert.deepEqual(r.dice, [
    { value: 20, dropped: false },
    { value: 5, dropped: true },
  ]);
});

test('interpret: d20 fumble on 1 and no crit in the middle', () => {
  const roll = { total: 1, terms: [{ kind: 'dice', count: 1, faces: 20, rolls: [1], dropped: [false] }] };
  const r = interpret(d20Cfg, roll);
  assert.equal(r.natural, 1);
  assert.equal(r.fumble, true);
  assert.equal(r.crit, false);
});

test('interpret: pool successes come from the term, hits and glitch from the dice', () => {
  const roll = {
    total: 3,
    terms: [{ kind: 'dice', count: 5, faces: 6, rolls: [5, 1, 6, 2, 1], dropped: [false, false, false, false, false], subtotal: 3, successes: 2 }],
    meta: { mode: 'pool', successMin: 5, glitchOnOnes: true },
  };
  // two dice show 1 out of five: 2*2 > 5 is false, no glitch
  const r = interpret(poolCfg, roll);
  assert.equal(r.mode, 'pool');
  assert.equal(r.successes, 2);
  assert.equal(r.glitch, false);
  assert.deepEqual(r.dice.map((d) => d.hit), [true, false, true, false, false]);
});

test('interpret: pool glitch when more than half of the active dice show 1', () => {
  const roll = {
    total: 0,
    terms: [{ kind: 'dice', count: 4, faces: 6, rolls: [1, 1, 1, 6], dropped: [false, false, false, false], subtotal: 0, successes: 1 }],
    meta: { mode: 'pool', successMin: 5, glitchOnOnes: true },
  };
  assert.equal(interpret(poolCfg, roll).glitch, true); // 3 of 4 is more than half
  const exactlyHalf = { ...roll, terms: [{ ...roll.terms[0], rolls: [1, 1, 6, 6] }] };
  assert.equal(interpret(poolCfg, exactlyHalf).glitch, false); // 2 of 4 is not more than half
});

test('interpret: glitch is off when the rule is off, and dropped dice do not count', () => {
  const noRule = {
    total: 0,
    terms: [{ kind: 'dice', count: 2, faces: 6, rolls: [1, 1], dropped: [false, false], successes: 0 }],
    meta: { mode: 'pool', successMin: 5, glitchOnOnes: false },
  };
  assert.equal(interpret(poolCfg, noRule).glitch, false);
  const droppedOnes = {
    total: 0,
    terms: [{ kind: 'dice', count: 3, faces: 6, rolls: [1, 1, 6], dropped: [true, true, false], successes: 0 }],
    meta: { mode: 'pool', successMin: 5, glitchOnOnes: true },
  };
  assert.equal(interpret(poolCfg, droppedOnes).glitch, false); // one active die, showing 6
});

test('interpret: malformed or missing input never throws', () => {
  for (const roll of [undefined, null, {}, { terms: 'x' }, { terms: [null, { kind: 'dice' }] }, { total: 'NaN', meta: 5 }]) {
    const d = interpret(d20Cfg, roll);
    assert.equal(d.mode, 'd20');
    assert.equal(d.total, 0);
    assert.deepEqual(d.dice, []);
    const p = interpret(poolCfg, roll);
    assert.equal(p.mode, 'pool');
    assert.equal(p.successes, 0);
  }
});

test('describe returns a non-empty description for both modes', () => {
  assert.match(describe(d20Cfg), /1d20/);
  assert.match(describe(poolCfg), /d6/);
  assert.match(describe(poolCfg), /glitch/i);
});

test('rollCheck returns { ok: false } when there is no window (plain Node)', async () => {
  assert.equal(typeof globalThis.window, 'undefined');
  const r = await rollCheck(d20Cfg, { attrValue: 1 });
  assert.deepEqual(r, { ok: false, error: 'no-dispatch' });
});

test('rollCheck dispatches through window.Loom.dispatchRoll with the built formula and meta', async () => {
  const calls = [];
  globalThis.window = {
    Loom: {
      dispatchRoll(payload) {
        calls.push(payload);
      },
    },
  };
  try {
    const r = await rollCheck(poolCfg, {
      actorId: 'a1',
      label: 'Melee',
      attrValue: 2,
      skillValue: 1,
      advantage: 'adv',
      mode: 'gmroll',
      extraMeta: { actorName: 'Ana', kind: 'spoofed', mode: 'spoofed' },
    });
    assert.deepEqual(r, { ok: true, formula: '4d6cs>=5' });
    assert.equal(calls.length, 1);
    const p = calls[0];
    assert.equal(p.formula, '4d6cs>=5');
    assert.equal(p.actorId, 'a1');
    assert.equal(p.mode, 'gmroll');
    assert.equal(p.meta.label, 'Melee');
    assert.equal(p.meta.actorName, 'Ana');
    // the built meta wins over extraMeta for the fields the card depends on
    assert.equal(p.meta.kind, 'check');
    assert.equal(p.meta.mode, 'pool');
    assert.equal(p.meta.system, 'loom-demo');
  } finally {
    delete globalThis.window;
  }
});

test('rollCheck falls back to public for an unknown visibility and trims the label', async () => {
  const calls = [];
  globalThis.window = { Loom: { dispatchRoll: (p) => calls.push(p) } };
  try {
    await rollCheck(d20Cfg, { mode: 'everyone', label: `  ${'x'.repeat(200)}  ` });
    assert.equal(calls[0].mode, 'public');
    assert.equal(calls[0].meta.label.length, 80);
    assert.equal(calls[0].actorId, undefined);
  } finally {
    delete globalThis.window;
  }
});

test('rollCheck reports a thrown dispatch error instead of throwing', async () => {
  globalThis.window = {
    Loom: {
      dispatchRoll() {
        throw new Error('no session');
      },
    },
  };
  try {
    const r = await rollCheck(d20Cfg, { attrValue: 1 });
    assert.deepEqual(r, { ok: false, error: 'no session' });
  } finally {
    delete globalThis.window;
  }
});
