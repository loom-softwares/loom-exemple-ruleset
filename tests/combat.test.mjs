// Tests for the combat pieces (combat/*.mjs). Run with: node --test tests/combat.test.mjs
// Plain Node: no window, no DOM. Engine objects (LoomHooks, api, ChatMessage) are faked where needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeInitiative, formatInitiativeSummary, registerCombatInitiative, INITIATIVE_MIN, INITIATIVE_MAX } from '../combat/initiative.mjs';
import {
  formatCombatLabel,
  resourceNumbers,
  readCombatantRecord,
  cleanText,
  registerCombatLabels,
  clearLabelCache,
  LABEL_MAX,
} from '../combat/labels.mjs';
import {
  renderCombatPanel,
  nextPollDelay,
  createPoller,
  barPercent,
  safeColor,
  ownershipLevel,
  isOwnCast,
  createCombatPanelClass,
  registerCombatPanel,
  POLL_BASE_MS,
} from '../combat/tracker-window.mjs';
import { registerCombat } from '../combat/index.mjs';
import { defaultConfig } from '../lib/config.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sequence of values from rng; cycles when exhausted. */
function fixed(...values) {
  let i = 0;
  return () => values[i++ % values.length];
}

/** Deterministic mulberry32 stream. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Config with a given initiative section and dice mode (d20 or pool). */
function cfgFor({ mode = 'roll', attr = 'grace', bonus = 0, dice = 'd20', pool } = {}) {
  const cfg = defaultConfig();
  cfg.combat = { initiative: { mode, attr, bonus } };
  cfg.dice.mode = dice;
  if (pool) cfg.dice.pool = { ...cfg.dice.pool, ...pool };
  return cfg;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function inRange(n) {
  return Number.isInteger(n) && n >= INITIATIVE_MIN && n <= INITIATIVE_MAX;
}

// ---------------------------------------------------------------------------
// computeInitiative
// ---------------------------------------------------------------------------

test('roll mode (d20): one die plus attribute plus bonus', () => {
  const cfg = cfgFor({ mode: 'roll', attr: 'grace', bonus: 1 });
  const actor = { attrs: { grace: 4 } };
  assert.equal(computeInitiative(cfg, actor, fixed(0)), 6); // die 1 + 4 + 1
  assert.equal(computeInitiative(cfg, actor, fixed(0.999)), 25); // die 20 + 4 + 1
});

test('initiative applies a selected derived d20 modifier', () => {
  const cfg = cfgFor({ mode: 'roll', attr: 'grace' });
  cfg.attributes[1].useD20Modifier = true;
  cfg.attributes[1].max = 20;
  const actor = { attrs: { grace: 16 } };
  assert.equal(computeInitiative(cfg, actor, fixed(0)), 4, 'natural 1 plus the derived +3 modifier');
  cfg.combat.initiative.mode = 'attribute';
  assert.equal(computeInitiative(cfg, actor, fixed(0)), 3, 'attribute-only initiative uses the same modifier');
});

test('roll mode with no attribute counts the attribute as 0', () => {
  const cfg = cfgFor({ mode: 'roll', attr: '', bonus: 2 });
  assert.equal(computeInitiative(cfg, { attrs: { grace: 9 } }, fixed(0.5)), 13); // die 11 + 2
});

test('roll mode clamps at both ends of -20..100', () => {
  const high = cfgFor({ mode: 'roll', attr: 'grace', bonus: 99 });
  assert.equal(computeInitiative(high, { attrs: { grace: 10 } }, fixed(0.999)), INITIATIVE_MAX);
  const low = cfgFor({ mode: 'roll', attr: 'grace', bonus: -99 });
  assert.equal(computeInitiative(low, { attrs: { grace: 0 } }, fixed(0)), INITIATIVE_MIN);
});

test('pool mode: successes of a pool sized by attribute plus bonus', () => {
  const cfg = cfgFor({ mode: 'roll', attr: 'grace', bonus: 0, dice: 'pool' });
  // grace 3 gives 3 dice; faces 6 (0.9 -> 6, 0.7 -> 5, 0.1 -> 1); successMin 5 counts two hits.
  assert.equal(computeInitiative(cfg, { attrs: { grace: 3 } }, fixed(0.9, 0.7, 0.1)), 2);
});

test('pool mode: pool size is attribute plus bonus, at least one die', () => {
  const cfg = cfgFor({ mode: 'roll', attr: '', bonus: 0, dice: 'pool' });
  assert.equal(computeInitiative(cfg, {}, fixed(0.9)), 1); // one die, a hit
  assert.equal(computeInitiative(cfg, {}, fixed(0.1)), 0); // one die, a miss
  const five = cfgFor({ mode: 'roll', attr: '', bonus: 5, dice: 'pool' });
  assert.equal(computeInitiative(five, {}, fixed(0.95)), 5); // five dice, all hits
});

test('attribute mode: attribute plus bonus, no roll', () => {
  const cfg = cfgFor({ mode: 'attribute', attr: 'grace', bonus: -1 });
  const noRoll = () => {
    throw new Error('rng must not be used in attribute mode');
  };
  assert.equal(computeInitiative(cfg, { attrs: { grace: 4 } }, noRoll), 3);
});

test('fixed mode: bonus only, no roll and no attribute', () => {
  const cfg = cfgFor({ mode: 'fixed', attr: 'grace', bonus: 7 });
  const noRoll = () => {
    throw new Error('rng must not be used in fixed mode');
  };
  assert.equal(computeInitiative(cfg, { attrs: { grace: 10 } }, noRoll), 7);
});

test('fixed and attribute modes clamp too', () => {
  assert.equal(computeInitiative(cfgFor({ mode: 'fixed', bonus: -99 }), {}, Math.random), -20);
  assert.equal(computeInitiative(cfgFor({ mode: 'fixed', bonus: 99 }), {}, Math.random), 99);
  const top = cfgFor({ mode: 'attribute', attr: 'grace', bonus: 99 });
  assert.equal(computeInitiative(top, { attrs: { grace: 10 } }, Math.random), INITIATIVE_MAX);
});

test('unknown mode falls back to the roll mode', () => {
  const cfg = cfgFor({ mode: 'bogus', attr: 'grace', bonus: 0 });
  assert.equal(computeInitiative(cfg, { attrs: { grace: 2 } }, fixed(0)), 3);
});

test('a NaN or out-of-range random source never leaves the die range', () => {
  const cfg = cfgFor({ mode: 'roll', attr: '', bonus: 0 });
  assert.equal(computeInitiative(cfg, {}, () => NaN), 1);
  assert.equal(computeInitiative(cfg, {}, () => 1), 20);
  assert.equal(computeInitiative(cfg, {}, () => -4), 1);
});

test('missing attribute values resolve to the config default', () => {
  const cfg = cfgFor({ mode: 'attribute', attr: 'grace', bonus: 0 });
  assert.equal(computeInitiative(cfg, {}, Math.random), 2); // grace default is 2
});

test('seeded sweep: every mode gives integers inside -20..100', () => {
  const rng = seeded(20261013);
  const modes = [
    cfgFor({ mode: 'roll', attr: 'grace', bonus: 3 }),
    cfgFor({ mode: 'roll', attr: 'grace', bonus: 3, dice: 'pool', pool: { maxDice: 8 } }),
    cfgFor({ mode: 'attribute', attr: 'wits', bonus: -50 }),
    cfgFor({ mode: 'fixed', bonus: 90 }),
  ];
  for (let i = 0; i < 2000; i += 1) {
    const cfg = modes[i % modes.length];
    const actor = { attrs: { grace: (i * 7) % 11, wits: (i * 3) % 11 } };
    const total = computeInitiative(cfg, actor, rng);
    assert.ok(inRange(total), `out of range: ${total}`);
  }
});

test('computeInitiative never throws on malformed config', () => {
  assert.ok(inRange(computeInitiative(null, null, Math.random)));
  assert.ok(inRange(computeInitiative({ combat: 'x' }, 'bad', Math.random)));
});

test('summary line: highest first, hostile names reduced to plain text', () => {
  const line = formatInitiativeSummary([
    { name: 'Ana', total: 9 },
    { name: '<img src=x onerror=alert(1)>Goblin', total: 14 },
  ]);
  assert.equal(line, 'Initiative: img src=x onerror=alert(1) Goblin 14 · Ana 9');
  assert.ok(!/[<>]/.test(line));
});

test('registerCombatInitiative fills totals through ctx.pending and posts one summary', async () => {
  const handlers = {};
  const posted = [];
  const fakeWindow = {
    Loom: {
      LoomHooks: { on: (name, cb) => { handlers[name] = cb; } },
      api: {
        get: async (path) => {
          if (path === '/cast/c1') return { id: 'c1', name: 'Ana', isLinked: false, systemData: { attrs: { grace: 4 } } };
          if (path === '/cast/bad!') return null;
          throw new Error('404');
        },
      },
      ChatMessage: { create: (data) => posted.push(data) },
    },
  };
  globalThis.window = fakeWindow;
  try {
    assert.equal(registerCombatInitiative({ loadConfig: async () => cfgFor({ mode: 'attribute', attr: 'grace' }) }), true);
    const ctx = { castIds: ['c1', 'missing', 'bad!', '__proto__'], initiatives: {}, health: {}, rolls: {}, pending: [] };
    handlers.combatInitiative(ctx);
    await Promise.all(ctx.pending);
    assert.deepEqual(ctx.initiatives, { c1: 4 });
    assert.equal(posted.length, 1);
    assert.match(posted[0].content, /^Initiative: Ana 4$/);
  } finally {
    delete globalThis.window;
  }
});

test('registerCombatInitiative returns false without an engine', () => {
  assert.equal(registerCombatInitiative({ loadConfig: async () => defaultConfig() }), false);
});

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

test('label: default preset shows health and mana with their values', () => {
  const label = formatCombatLabel(defaultConfig(), { res: { hp: { value: 12, max: null }, mp: { value: 5, max: null } } });
  assert.equal(label, 'Health 12/20 · Mana 5/10');
});

test('label: missing resources count as full', () => {
  assert.equal(formatCombatLabel(defaultConfig(), {}), 'Health 20/20 · Mana 10/10');
  assert.equal(formatCombatLabel(defaultConfig(), undefined), 'Health 20/20 · Mana 10/10');
});

test('label: NaN, Infinity and strings are handled without leaking NaN', () => {
  const nan = formatCombatLabel(defaultConfig(), { res: { hp: { value: NaN }, mp: { value: 'abc' } } });
  assert.equal(nan, 'Health 20/20 · Mana 10/10');
  assert.ok(!nan.includes('NaN'));
  const inf = formatCombatLabel(defaultConfig(), { res: { hp: { value: Infinity } } });
  assert.ok(inf.startsWith('Health 20/20'));
  const text = formatCombatLabel(defaultConfig(), { res: { hp: { value: '7' } } });
  assert.ok(text.startsWith('Health 7/20'));
});

test('label: huge and negative values are clamped to 0..max', () => {
  const huge = formatCombatLabel(defaultConfig(), { res: { hp: { value: 1e300 }, mp: { value: -5 } } });
  assert.equal(huge, 'Health 20/20 · Mana 0/10');
  const hugeMax = resourceNumbers({ key: 'hp', max: 20 }, { res: { hp: { value: 3, max: 1e12 } } });
  assert.deepEqual(hugeMax, { value: 3, max: 999 });
});

test('label: a bad entry max falls back to the config max', () => {
  assert.deepEqual(resourceNumbers({ key: 'hp', max: 20 }, { res: { hp: { value: 4, max: 'abc' } } }), { value: 4, max: 20 });
  assert.deepEqual(resourceNumbers({ key: 'hp', max: 20 }, { res: { hp: { value: 4, max: null } } }), { value: 4, max: 20 });
});

test('label: only resources with showInCombat appear', () => {
  const cfg = defaultConfig();
  cfg.resources = [{ key: 'grit', label: 'Grit', max: 4, showInCombat: false }];
  assert.equal(formatCombatLabel(cfg, { res: { grit: { value: 1 } } }), '');
  assert.equal(formatCombatLabel(null, {}), '');
  assert.equal(formatCombatLabel(undefined, undefined), '');
});

test('label: hostile labels become plain text, without angle brackets or control characters', () => {
  const cfg = {
    resources: [{ key: 'hp', label: '<img src=x onerror=alert(1)>Hea\u0000lth', max: 20, showInCombat: true }],
  };
  const label = formatCombatLabel(cfg, { res: { hp: { value: 3 } } });
  assert.ok(!/[<>\u0000]/.test(label));
  assert.ok(label.endsWith('3/20'));
  assert.ok(label.length <= LABEL_MAX);
});

test('label: long labels are capped at 60 characters with an ellipsis', () => {
  const cfg = {
    resources: ['a', 'b', 'c', 'd', 'e'].map((k) => ({
      key: k,
      label: `${k.repeat(40)}`,
      max: 9,
      showInCombat: true,
    })),
  };
  const label = formatCombatLabel(cfg, {});
  assert.equal(label.length, LABEL_MAX);
  assert.ok(label.endsWith('…'));
});

test('cleanText caps and cleans', () => {
  assert.equal(cleanText('  a \n\t b  ', 10), 'a b');
  assert.equal(cleanText(42, 10), '');
  assert.equal(cleanText('x'.repeat(100), 10).length, 10);
});

test('readCombatantRecord: linked casts read the actor, unlinked casts read the cast', async () => {
  const calls = [];
  const api = {
    get: async (path) => {
      calls.push(path);
      if (path === '/cast/linked') return { id: 'linked', name: 'Ana', isLinked: true, actorId: 'act1', systemData: { res: { hp: { value: 1 } } } };
      if (path === '/cast/npc') return { id: 'npc', name: 'Goblin', isLinked: false, actorId: 'act2', systemData: { res: { hp: { value: 9 } } } };
      if (path === '/actors/act1') return { id: 'act1', systemData: { res: { hp: { value: 7 } } } };
      throw new Error('404');
    },
  };
  const linked = await readCombatantRecord('linked', api);
  assert.equal(linked.systemData.res.hp.value, 7);
  assert.equal(linked.missingActor, false);
  const npc = await readCombatantRecord('npc', api);
  assert.equal(npc.systemData.res.hp.value, 9);
  assert.ok(!calls.includes('/actors/act2'));
});

test('readCombatantRecord: a missing actor is reported, not thrown', async () => {
  const api = {
    get: async (path) => {
      if (path === '/cast/c') return { id: 'c', name: 'Ana', isLinked: true, actorId: 'gone', systemData: {} };
      throw new Error('404');
    },
  };
  const record = await readCombatantRecord('c', api);
  assert.equal(record.missingActor, true);
  assert.deepEqual(record.systemData, {});
});

test('readCombatantRecord: unsafe ids never reach the api', async () => {
  let called = false;
  const api = { get: async () => { called = true; return null; } };
  assert.equal(await readCombatantRecord('../etc', api), null);
  assert.equal(await readCombatantRecord('x"><script>', api), null);
  assert.equal(called, false);
});

test('registerCombatLabels: answers from cache and announces changed badges', async () => {
  clearLabelCache();
  const handlers = {};
  const announced = [];
  const fakeWindow = {
    Loom: {
      LoomHooks: {
        on: (name, cb) => { handlers[name] = cb; },
        callAll: (name, payload) => announced.push([name, payload]),
      },
      api: {
        get: async (path) => {
          if (path === '/cast/c1') return { id: 'c1', name: 'Ana', isLinked: false, systemData: { res: { hp: { value: 4 } } } };
          throw new Error('404');
        },
      },
    },
  };
  globalThis.window = fakeWindow;
  try {
    assert.equal(registerCombatLabels({ loadConfig: async () => defaultConfig() }), true);
    const first = { combatant: { id: 'c1' }, label: '' };
    handlers.combatantLabel(first);
    assert.equal(first.label, ''); // nothing cached yet
    await flush();
    await flush();
    const second = { combatant: { id: 'c1' }, label: '' };
    handlers.combatantLabel(second);
    assert.equal(second.label, 'Health 4/20 · Mana 10/10');
    assert.deepEqual(announced, [['combatantLabelsChanged', { castId: 'c1' }]]);
    // An unsafe id never touches the badge and never triggers a fetch.
    const unsafe = { combatant: { id: 'bad"id' }, label: 'keep' };
    handlers.combatantLabel(unsafe);
    assert.equal(unsafe.label, 'keep');
  } finally {
    delete globalThis.window;
  }
});

// ---------------------------------------------------------------------------
// Panel rendering
// ---------------------------------------------------------------------------

function combatOf(combatants, extra = {}) {
  return { id: 'combat-1', round: 2, currentTurn: 0, isActive: true, combatants, ...extra };
}

/** The <li> row that carries data-cast-id, from its opening tag to its closing tag. */
function rowFor(html, castId) {
  const idAt = html.indexOf(`data-cast-id="${castId}"`);
  if (idAt < 0) return '';
  const start = html.lastIndexOf('<li', idAt);
  const end = html.indexOf('</li>', idAt);
  return html.slice(start, end);
}

test('panel: empty state with no combat', () => {
  const html = renderCombatPanel({ status: 'ready', combat: null, config: defaultConfig() });
  assert.ok(html.includes('ldm-combat-empty'));
  assert.ok(!html.includes('<ol'));
  assert.ok(html.includes('No active combat.'));
});

test('panel: loading state before the first poll', () => {
  const html = renderCombatPanel({});
  assert.ok(html.includes('Loading...'));
});

test('panel: combat without combatants', () => {
  const html = renderCombatPanel({ status: 'ready', combat: combatOf([]), config: defaultConfig() });
  assert.ok(html.includes('No combatants yet.'));
  assert.ok(!html.includes('<ol'));
});

test('panel: missing actors and unreadable casts show a note, not a crash', () => {
  const combat = combatOf([{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Bo' }]);
  const records = Object.create(null);
  records.a = null;
  records.b = { cast: { id: 'b' }, systemData: {}, missingActor: true };
  const html = renderCombatPanel({ status: 'ready', combat, config: defaultConfig(), records });
  assert.ok(html.includes('No data'));
  assert.ok(html.includes('Actor not found'));
});

test('panel: hostile names and ids are escaped', () => {
  const hostile = '<script>alert(1)</script>"><img src=x onerror=alert(2)>';
  const combat = combatOf([{ id: 'x"><script>', name: hostile, initiative: 9 }]);
  const html = renderCombatPanel({ status: 'ready', combat, config: defaultConfig(), records: Object.create(null) });
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('x"><script>'));
  assert.ok(html.includes('&quot;'), 'quotes in names are escaped');
});

test('panel: hostile resource colors never reach the style attribute', () => {
  const cfg = defaultConfig();
  cfg.resources = [{ key: 'hp', label: 'Health', max: 20, color: 'red;background:url(x)', showInCombat: true }];
  const records = Object.create(null);
  records.a = { cast: { id: 'a' }, systemData: { res: { hp: { value: 5 } } } };
  const html = renderCombatPanel({
    status: 'ready',
    combat: combatOf([{ id: 'a', name: 'Ana' }]),
    config: cfg,
    records,
  });
  assert.ok(!html.includes('url(x)'));
  assert.ok(html.includes('background:#6b7280'));
  assert.equal(safeColor('#c0392b'), '#c0392b');
  assert.equal(safeColor('#abc'), '#6b7280');
});

test('bars: widths clamp to 0..100 and never leak NaN', () => {
  assert.equal(barPercent(999, 20), 100);
  assert.equal(barPercent(-5, 20), 0);
  assert.equal(barPercent(5, 20), 25);
  assert.equal(barPercent(NaN, 20), 0);
  assert.equal(barPercent(5, 0), 0);
  assert.equal(barPercent(Infinity, 20), 0);

  const cfg = defaultConfig();
  const records = Object.create(null);
  records.a = { cast: { id: 'a' }, systemData: { res: { hp: { value: 9999 }, mp: { value: -40 } } } };
  const html = renderCombatPanel({ status: 'ready', combat: combatOf([{ id: 'a', name: 'Ana' }]), config: cfg, records });
  assert.ok(html.includes('width:100%'));
  assert.ok(html.includes('width:0%'));
  assert.ok(!html.includes('NaN'));
});

test('ownership: JSON text and objects, default level, and the owner threshold', () => {
  assert.equal(ownershipLevel({ u1: 3 }, 'u1'), 3);
  assert.equal(ownershipLevel('{"u1":3}', 'u1'), 3);
  assert.equal(ownershipLevel('{not json', 'u1'), 0);
  assert.equal(ownershipLevel({ default: 3 }, 'anyone'), 3);
  assert.equal(ownershipLevel({ u1: 2 }, 'u1'), 2);
  assert.equal(isOwnCast({ ownership: { u1: 3 } }, 'u1'), true);
  assert.equal(isOwnCast({ ownership: { u1: 2 } }, 'u1'), false);
  assert.equal(isOwnCast({ ownership: { u1: 3 } }, null), false);
  assert.equal(isOwnCast(null, 'u1'), false);
});

test('panel: own combatants are highlighted and only those', () => {
  const records = Object.create(null);
  records.a = { cast: { id: 'a', ownership: { u1: 3 } }, systemData: {} };
  records.b = { cast: { id: 'b', ownership: { u2: 3 } }, systemData: {} };
  const html = renderCombatPanel({
    status: 'ready',
    combat: combatOf([{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Bo' }]),
    config: defaultConfig(),
    records,
    userId: 'u1',
  });
  assert.ok(rowFor(html, 'a').includes('ldm-combat-own'));
  assert.ok(!rowFor(html, 'b').includes('ldm-combat-own'));
  assert.equal((html.match(/ldm-combat-own/g) || []).length, 1);
});

test('panel: the turn marker follows the stored currentTurn index', () => {
  const records = Object.create(null);
  records.a = { cast: { id: 'a' }, systemData: {} };
  records.b = { cast: { id: 'b' }, systemData: {} };
  const html = renderCombatPanel({
    status: 'ready',
    combat: combatOf([{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Bo' }], { currentTurn: 1 }),
    config: defaultConfig(),
    records,
  });
  assert.ok(!rowFor(html, 'a').includes('ldm-combat-current'));
  assert.ok(rowFor(html, 'b').includes('ldm-combat-current'));
  assert.ok(html.includes('Current turn: Bo'));
});

test('panel: GM controls only for the GM', () => {
  const combat = combatOf([{ id: 'a', name: 'Ana' }]);
  const player = renderCombatPanel({ status: 'ready', combat, config: defaultConfig(), isGM: false });
  assert.ok(!player.includes('data-action="combat-next"'));
  assert.ok(!player.includes('data-action="combat-res"'));
  const gm = renderCombatPanel({ status: 'ready', combat, config: defaultConfig(), isGM: true, records: Object.create(null) });
  assert.ok(gm.includes('data-action="combat-next"'));
  assert.ok(gm.includes('data-action="combat-prev"'));
  assert.ok(gm.includes('data-action="combat-end"'));
});

test('panel: rows show the initiative value or a waiting note', () => {
  const html = renderCombatPanel({
    status: 'ready',
    combat: combatOf([{ id: 'a', name: 'Ana', initiative: 14 }, { id: 'b', name: 'Bo', initiative: null }]),
    config: defaultConfig(),
    records: Object.create(null),
  });
  assert.ok(html.includes('Initiative: 14'));
  assert.ok(html.includes('Initiative: Waiting'));
});

test('panel: an error state is shown with a generic message only', () => {
  const html = renderCombatPanel({ status: 'error', combat: null, config: null });
  assert.ok(html.includes('Could not load the combat. Retrying.'));
});

test('panel: round and turn fall back to safe numbers', () => {
  const html = renderCombatPanel({
    status: 'ready',
    combat: combatOf([{ id: 'a', name: 'Ana' }], { round: 'x', currentTurn: 1e12 }),
    config: defaultConfig(),
    records: Object.create(null),
  });
  assert.ok(html.includes('Round 1'));
  assert.ok(!html.includes('Current turn'));
});

test('panel: a window class builds on any BaseWindow and opens with safe defaults', async () => {
  class FakeBase {
    constructor(options) {
      this.options = options;
      this.element = null;
    }
  }
  const Cls = createCombatPanelClass(FakeBase);
  const win = new Cls({});
  assert.equal(win.options.id, 'loom-demo-combat-panel');
  assert.ok(win.bodyTemplate().includes('Loading...'));
  // Without an engine, actions do nothing and do not throw.
  await win.onAction('combat-next', null, {});
  await win.onAction('combat-res', null, { dataset: { castId: 'a' } });
  win.onClose();
});

test('registerCombatPanel is false without BaseWindow', () => {
  assert.equal(registerCombatPanel(), false);
});

test('registerCombat never throws and reports each step', () => {
  const result = registerCombat();
  assert.deepEqual(Object.keys(result).sort(), ['initiative', 'labels', 'panel']);
  assert.equal(result.panel, false);
});

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

function fakeClock() {
  const timers = [];
  return {
    timers,
    schedule(fn, ms) {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    cancel(t) {
      const i = timers.indexOf(t);
      if (i >= 0) timers.splice(i, 1);
    },
  };
}

/** Fires the oldest scheduled timer, the way the browser removes it from the queue. */
function fire(clock) {
  const t = clock.timers.shift();
  t.fn();
}

test('nextPollDelay: base on success, doubles per failure, capped', () => {
  assert.equal(nextPollDelay({ failures: 0 }), POLL_BASE_MS);
  assert.equal(nextPollDelay({ failures: 1 }), 6000);
  assert.equal(nextPollDelay({ failures: 2 }), 12000);
  assert.equal(nextPollDelay({ failures: 3 }), 24000);
  assert.equal(nextPollDelay({ failures: 4 }), 30000);
  assert.equal(nextPollDelay({ failures: 500 }), 30000);
  assert.equal(nextPollDelay({ failures: NaN }), POLL_BASE_MS);
  assert.equal(nextPollDelay(), POLL_BASE_MS);
});

test('poller: never overlaps requests and runs once more after a wake during a poll', async () => {
  const clock = fakeClock();
  let calls = 0;
  let finish;
  const task = () => {
    calls += 1;
    return new Promise((resolve) => { finish = resolve; });
  };
  const poller = createPoller({ task, schedule: clock.schedule, cancel: clock.cancel });
  poller.start();
  assert.equal(calls, 1);
  poller.wake();
  assert.equal(calls, 1, 'no second request while one is in flight');
  finish();
  await flush();
  assert.equal(clock.timers.length, 1);
  assert.equal(clock.timers[0].ms, 0, 'the wake that arrived during the poll runs right away');
  fire(clock);
  assert.equal(calls, 2);
  finish();
  await flush();
  poller.stop();
});

test('poller: backs off after errors and recovers on success', async () => {
  const clock = fakeClock();
  let fail = true;
  const task = async () => {
    if (fail) throw new Error('offline');
  };
  const poller = createPoller({ task, schedule: clock.schedule, cancel: clock.cancel });
  poller.start();
  await flush();
  assert.equal(clock.timers[0].ms, 6000);
  fire(clock);
  await flush();
  assert.equal(clock.timers[0].ms, 12000);
  fail = false;
  fire(clock);
  await flush();
  assert.equal(clock.timers[0].ms, POLL_BASE_MS);
  poller.stop();
});

test('poller: a hidden tab stops polling until it is shown again', async () => {
  const clock = fakeClock();
  let hidden = false;
  let calls = 0;
  const task = async () => { calls += 1; };
  const poller = createPoller({ task, isHidden: () => hidden, schedule: clock.schedule, cancel: clock.cancel });
  poller.start();
  await flush();
  assert.equal(calls, 1);
  hidden = true;
  fire(clock);
  await flush();
  assert.equal(calls, 1, 'no request while hidden');
  assert.equal(clock.timers.length, 0, 'no timer while hidden');
  hidden = false;
  poller.wake();
  await flush();
  assert.equal(calls, 2);
  poller.stop();
});

test('poller: stop clears the timer and ignores a poll still in flight', async () => {
  const clock = fakeClock();
  let finish;
  let calls = 0;
  const poller = createPoller({
    task: () => { calls += 1; return new Promise((r) => { finish = r; }); },
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  poller.start();
  poller.stop();
  finish();
  await flush();
  assert.equal(clock.timers.length, 0);
  poller.wake();
  assert.equal(calls, 1, 'a stopped poller does not restart on wake');
});

// ---------------------------------------------------------------------------
// Resource reads: budget, cadence, fairness, 429 (fake clock and fake api)
// ---------------------------------------------------------------------------

import {
  createResourceSweeper,
  isRateLimited,
  rateLimitWaitMs,
  getSharedSweeper,
  RECORD_CADENCE_MS,
  REFRESH_CAP,
  REQUEST_CONCURRENCY,
} from '../combat/labels.mjs';
import { pollOnce } from '../combat/tracker-window.mjs';

/** Fake clock: timers fire in due order when advance() moves time forward. */
function fakeTime() {
  let current = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => current,
    schedule(fn, ms) {
      seq += 1;
      timers.set(seq, { at: current + ms, id: seq, fn });
      return seq;
    },
    cancel(id) {
      timers.delete(id);
    },
    async advance(ms) {
      const until = current + ms;
      await flush();
      for (;;) {
        let next = null;
        for (const tm of timers.values()) {
          if (tm.at <= until && (!next || tm.at < next.at || (tm.at === next.at && tm.id < next.id))) next = tm;
        }
        if (!next) break;
        timers.delete(next.id);
        current = next.at;
        next.fn();
        await flush();
      }
      current = until;
      await flush();
    },
  };
}

/** Fake engine api: a combat row with `count` combatants, and cast/actor reads. Every call is logged. */
function fakeCombatApi({ count, clock, linked = false }) {
  const requests = [];
  const combatants = [];
  for (let i = 0; i < count; i += 1) {
    combatants.push({ id: `c${i}`, name: `N${i}`, hp: 10, maxHp: 10, initiative: count - i });
  }
  const api = {
    requests,
    combatants,
    hook: null,
    async get(path) {
      requests.push({ t: clock.now(), path });
      if (api.hook) api.hook(path);
      if (path.startsWith('/combat/')) {
        return { id: 'cb1', round: 1, currentTurn: 0, combatants: combatants.map((c) => ({ ...c })) };
      }
      if (path.startsWith('/cast/')) {
        const id = path.slice('/cast/'.length);
        const n = Number(id.slice(1));
        return {
          id,
          name: `N${n}`,
          isLinked: linked,
          actorId: linked ? `a${n}` : null,
          ownership: {},
          systemData: { res: { hp: { value: 10 } } },
        };
      }
      if (path.startsWith('/actors/')) {
        return { id: path.slice('/actors/'.length), systemData: { res: { hp: { value: 10 } } } };
      }
      throw new Error(`unexpected ${path}`);
    },
  };
  return api;
}

/** A poll task like the panel's: one combat row plus at most one due resource pass; a 429 rethrows. */
function pollTaskFor(api, sweeper) {
  return async () => {
    const result = await pollOnce({ api, worldId: 'w1', sweeper });
    if (result.error) throw result.error;
  };
}

function sweeperFor(api, clock, extra = {}) {
  return createResourceSweeper({ api: () => api, loadConfig: async () => defaultConfig(), now: clock.now, ...extra });
}

function castReads(api, from = 0) {
  return api.requests.filter((r) => r.path.startsWith('/cast/') && r.t >= from);
}

function pollerFor(api, sweeper, clock) {
  return createPoller({
    task: pollTaskFor(api, sweeper),
    schedule: clock.schedule,
    cancel: clock.cancel,
    now: clock.now,
    cooldownFor: rateLimitWaitMs,
  });
}

test('budget: 40 combatants (unlinked) stay near 100 requests per minute in steady state', async () => {
  const clock = fakeTime();
  const api = fakeCombatApi({ count: 40, clock });
  const poller = pollerFor(api, sweeperFor(api, clock), clock);
  poller.start();
  await clock.advance(60000); // cold start: the first reads of all 40 take a few ticks
  api.requests.length = 0;
  await clock.advance(60000);
  const perMinute = api.requests.length;
  poller.stop();
  // 20 combat-row polls a minute, plus 12 reads on each 9 s pass (about 6.7 passes a minute).
  assert.ok(perMinute <= 110, `expected about 100 requests per minute, measured ${perMinute}`);
  assert.ok(perMinute >= 90, `the cap should be in use, measured ${perMinute}`);
});

test('budget: 8 combatants (unlinked) need about 73 requests per minute', async () => {
  const clock = fakeTime();
  const api = fakeCombatApi({ count: 8, clock });
  const poller = pollerFor(api, sweeperFor(api, clock), clock);
  poller.start();
  await clock.advance(60000);
  api.requests.length = 0;
  await clock.advance(60000);
  const perMinute = api.requests.length;
  poller.stop();
  assert.ok(perMinute <= 80, `measured ${perMinute}`);
});

test('cadence and fairness: 40 combatants, each read at most once per 9 s and within ceil(N/12) passes', async () => {
  const clock = fakeTime();
  const count = 40;
  const api = fakeCombatApi({ count, clock });
  const poller = pollerFor(api, sweeperFor(api, clock), clock);
  poller.start();
  await clock.advance(60000); // warm up
  api.requests.length = 0;
  await clock.advance(120000);
  poller.stop();
  const passes = Math.ceil(count / REFRESH_CAP);
  const byId = new Map();
  for (const r of castReads(api)) {
    const id = r.path.slice('/cast/'.length);
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(r.t);
  }
  assert.equal(byId.size, count, 'every combatant is read in the window');
  for (const [id, times] of byId) {
    for (let i = 1; i < times.length; i += 1) {
      const gap = times[i] - times[i - 1];
      assert.ok(gap >= RECORD_CADENCE_MS, `${id} was read ${gap} ms after its previous read`);
      assert.ok(gap <= passes * RECORD_CADENCE_MS, `${id} waited ${gap} ms, more than ${passes} passes`);
    }
  }
});

test('round robin: a small combat is read in full on every pass', async () => {
  const clock = fakeTime();
  const api = fakeCombatApi({ count: 5, clock });
  const poller = pollerFor(api, sweeperFor(api, clock), clock);
  poller.start();
  await clock.advance(30000);
  poller.stop();
  // Passes at 0, 9, 18 and 27 s, five combatants each.
  assert.equal(castReads(api).length, 5 * 4);
});

test('changed hp reads that combatant on the next 3 s poll, not on its round-robin slot', async () => {
  const clock = fakeTime();
  const api = fakeCombatApi({ count: 40, clock });
  const poller = pollerFor(api, sweeperFor(api, clock), clock);
  poller.start();
  await clock.advance(60000);
  const mark = clock.now();
  api.combatants[33].hp = 3;
  await clock.advance(3000);
  poller.stop();
  const reads = castReads(api, mark).filter((r) => r.path === '/cast/c33');
  assert.equal(reads.length, 1, 'read once');
  assert.ok(reads[0].t - mark <= 3000, `read at +${reads[0].t - mark} ms`);
});

test('a combatant with no cached data is priority: read by the next poll', async () => {
  const clock = fakeTime();
  const api = fakeCombatApi({ count: 2, clock });
  const sweeper = sweeperFor(api, clock);
  await pollOnce({ api, worldId: 'w1', sweeper });
  assert.ok(sweeper.get('c0') && sweeper.get('c1'));
  assert.equal(sweeper.prioritySize, 0);
});

test('a 429 stops polling for 30 s: no request, no wake, then resumes at the end of the wait', async () => {
  const clock = fakeTime();
  const api = fakeCombatApi({ count: 3, clock });
  let t429 = null;
  api.hook = (path) => {
    if (t429 === null && path === '/cast/c0' && clock.now() >= 9000) {
      t429 = clock.now();
      throw Object.assign(new Error('Too Many Requests'), { status: 429 });
    }
  };
  const poller = pollerFor(api, sweeperFor(api, clock), clock);
  poller.start();
  await clock.advance(6000);
  api.combatants[0].hp = 1; // a priority read of c0 at the 9 s tick, which gets the 429
  await clock.advance(3000);
  assert.equal(t429, 9000, 'the 429 came from the 9 s tick');
  const quiet = api.requests.length;
  await clock.advance(29000); // up to 38 s
  assert.equal(api.requests.length, quiet, 'no request during the 30 s wait');
  poller.wake();
  assert.equal(api.requests.length, quiet, 'wake() cannot break the wait');
  await clock.advance(1000); // 39 s: the wait is over
  const after = api.requests.filter((r) => r.t >= t429 + 30000);
  assert.ok(after.length > 0, 'polling resumes after the wait');
  assert.equal(after[0].t, t429 + 30000);
  poller.stop();
});

test('a 429 honors an explicit retryAfter (seconds) instead of 30 s', async () => {
  const clock = fakeTime();
  const api = fakeCombatApi({ count: 1, clock });
  let t429 = null;
  api.hook = (path) => {
    if (t429 === null && path === '/cast/c0' && clock.now() >= 3000) {
      t429 = clock.now();
      throw Object.assign(new Error('Too Many Requests'), { status: 429, retryAfter: 12 });
    }
  };
  const poller = pollerFor(api, sweeperFor(api, clock), clock);
  poller.start();
  api.combatants[0].hp = 2;
  await clock.advance(3000);
  assert.equal(t429, 3000);
  await clock.advance(11000);
  const during = api.requests.filter((r) => r.t > t429 && r.t < t429 + 12000);
  assert.equal(during.length, 0, 'nothing for 12 s');
  await clock.advance(1000);
  assert.ok(api.requests.some((r) => r.t === t429 + 12000), 'resumes at 12 s');
  poller.stop();
});

test('rateLimitWaitMs: 30 s by default, Retry-After in seconds when given, capped, 0 for other errors', () => {
  assert.equal(isRateLimited({ status: 429 }), true);
  assert.equal(isRateLimited({ status: 500 }), false);
  assert.equal(isRateLimited(null), false);
  assert.equal(rateLimitWaitMs({ status: 429 }), 30000);
  assert.equal(rateLimitWaitMs({ status: 429, retryAfter: 12 }), 12000);
  assert.equal(rateLimitWaitMs({ status: 429, retryAfter: '7' }), 7000);
  assert.equal(rateLimitWaitMs({ status: 429, retryAfter: 'Wed, 21 Oct 2026' }), 30000);
  assert.equal(rateLimitWaitMs({ status: 429, retryAfterMs: 5000 }), 5000);
  assert.equal(rateLimitWaitMs({ status: 429, retryAfter: 99999 }), 600000);
  assert.equal(rateLimitWaitMs({ status: 500 }), 0);
  assert.equal(rateLimitWaitMs(new Error('offline')), 0);
});

test('concurrency: at most 4 combatant reads are in flight at once', async () => {
  const clock = fakeTime();
  let inFlight = 0;
  let peak = 0;
  const api = {
    async get(path) {
      if (path.startsWith('/combat/')) {
        return { id: 'cb1', combatants: Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, hp: 1, maxHp: 1 })) };
      }
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return { id: path.slice('/cast/'.length), isLinked: false, systemData: {} };
    },
  };
  const sweeper = sweeperFor(api, clock);
  await pollOnce({ api, worldId: 'w1', sweeper });
  assert.equal(REQUEST_CONCURRENCY, 4);
  assert.ok(peak <= 4, `peak ${peak}`);
  assert.ok(peak >= 2, `reads should overlap, peak ${peak}`);
  assert.ok(sweeper.get('c11'), 'the last combatant was read too');
});

test('shared cache: one sweeper instance for the panel and the badges, reset by clearLabelCache', () => {
  clearLabelCache();
  const first = getSharedSweeper();
  assert.equal(getSharedSweeper(), first);
  clearLabelCache();
  assert.notEqual(getSharedSweeper(), first);
});
