import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc } from '../lib/helpers.mjs';
import { defaultConfig } from '../lib/config.mjs';
import {
  renderCard,
  registerRollCard,
  createConfigCache,
  isDemoRoll,
  CARD_DEFAULT_ACCENT,
} from '../cards/roll-card.mjs';

// ---------- fixtures ----------

function d20Cfg(card = {}, d20 = {}) {
  return {
    version: 1,
    name: 'T',
    dice: { mode: 'd20', d20: { sides: 20, critMin: 20, fumbleMax: 1, targetLabel: 'DC', ...d20 }, pool: { faces: 6, successMin: 5, maxDice: 20, glitchOnOnes: false } },
    card: { style: 'detailed', showFormula: true, showDice: true, accent: '#7c5cff', header: '{actor}: {label}', successLabel: 'successes', critLabel: 'Critical', fumbleLabel: 'Fumble', ...card },
  };
}

function poolCfg(card = {}, pool = {}) {
  return {
    version: 1,
    name: 'T',
    dice: { mode: 'pool', d20: { sides: 20, critMin: 20, fumbleMax: 1, targetLabel: 'DC' }, pool: { faces: 6, successMin: 5, maxDice: 20, glitchOnOnes: false, ...pool } },
    card: { style: 'detailed', showFormula: true, showDice: true, accent: '#7c5cff', header: '{actor}: {label}', successLabel: 'successes', critLabel: 'Critical', fumbleLabel: 'Fumble', ...card },
  };
}

function d20Roll({ natural = 10, modifier = 5, total, formula = '1d20+5', meta = {}, dropped, rolls } = {}) {
  const values = rolls ?? [natural];
  return {
    formula,
    mode: 'public',
    total: total ?? values.filter((_, i) => !dropped?.[i])[0] + modifier,
    terms: [
      { kind: 'dice', count: values.length, faces: 20, rolls: values, dropped: dropped ?? values.map(() => false) },
      { kind: 'modifier', value: modifier },
    ],
    meta: { system: 'loom-demo', kind: 'check', mode: 'd20', sides: 20, critMin: 20, fumbleMax: 1, label: 'Strike', actorName: 'Ayla', ...meta },
  };
}

function poolRoll({ rolls, dropped, successes, total, formula = '6d6cs>=5', meta = {} }) {
  return {
    formula,
    mode: 'public',
    total: total ?? successes ?? 0,
    terms: [{ kind: 'dice', count: rolls.length, faces: 6, rolls, dropped: dropped ?? rolls.map(() => false), successes }],
    meta: { system: 'loom-demo', kind: 'check', mode: 'pool', faces: 6, successMin: 5, glitchOnOnes: false, label: 'Read', actorName: 'Ayla', ...meta },
  };
}

const render = (cfg, roll, extra) => renderCard(cfg, roll, esc, extra);
const count = (html, needle) => html.split(needle).length - 1;
/** Number of die chips (not the container, which is ldm-card-dice). */
const chipCount = (html) => (html.match(/class="ldm-card-die(?: [^"]*)?"/g) || []).length;

// ---------- d20 mode ----------

test('d20 normal roll shows formula, natural die, modifier, total and no badges', () => {
  const html = render(d20Cfg(), d20Roll({ natural: 9, modifier: 5, total: 14 }));
  assert.match(html, /class="ldm-card-title">Ayla: Strike</);
  assert.match(html, /<code class="ldm-card-formula">1d20\+5<\/code>/);
  assert.match(html, /class="ldm-card-die">9</);
  assert.match(html, /<span class="ldm-card-mod">Mod \+5<\/span>/);
  assert.match(html, /<span class="ldm-card-total">14<\/span>/);
  assert.doesNotMatch(html, /ldm-card-badge/);
});

test('d20 natural maximum shows the critical badge and crit outline', () => {
  const html = render(d20Cfg(), d20Roll({ natural: 20, modifier: 2, total: 22 }));
  assert.match(html, /ldm-card-badge ldm-card-badge-crit">Critical</);
  assert.match(html, /ldm-card-die ldm-card-die-crit/);
  assert.doesNotMatch(html, /ldm-card-badge-fumble/);
});

test('d20 natural one shows the fumble badge', () => {
  const html = render(d20Cfg(), d20Roll({ natural: 1, modifier: 3, total: 4 }));
  assert.match(html, /ldm-card-badge ldm-card-badge-fumble">Fumble</);
  assert.match(html, /ldm-card-die-fumble/);
  assert.doesNotMatch(html, /ldm-card-badge-crit/);
});

test('d20 advantage shows both dice with the dropped one struck through', () => {
  const roll = {
    formula: '2d20kh1+3',
    mode: 'public',
    total: 20,
    terms: [
      { kind: 'dice', count: 2, faces: 20, rolls: [4, 17], dropped: [true, false] },
      { kind: 'modifier', value: 3 },
    ],
    meta: { system: 'loom-demo', kind: 'check', mode: 'd20', sides: 20, critMin: 20, fumbleMax: 1, label: 'Adv' },
  };
  const html = render(d20Cfg(), roll);
  assert.equal(count(html, 'ldm-card-die-dropped'), 1);
  assert.match(html, /class="ldm-card-die ldm-card-die-dropped"[^>]*>4</);
  assert.match(html, /<span class="ldm-card-mod">Mod \+3<\/span>/);
  assert.match(html, /<span class="ldm-card-total">20<\/span>/);
});

test('d20 disadvantage keeps the lower die and the natural value drives crit/fumble', () => {
  const roll = {
    formula: '2d20kl1+0',
    mode: 'public',
    total: 1,
    terms: [{ kind: 'dice', count: 2, faces: 20, rolls: [1, 18], dropped: [false, true] }],
    meta: { system: 'loom-demo', kind: 'check', mode: 'd20', sides: 20, critMin: 20, fumbleMax: 1 },
  };
  const html = render(d20Cfg(), roll);
  assert.match(html, /ldm-card-badge-fumble/);
  assert.match(html, /<span class="ldm-card-mod">Mod \+0<\/span>/);
});

test('d20 target: pass when total meets the target, labelled with targetLabel', () => {
  const html = render(d20Cfg(), d20Roll({ natural: 10, modifier: 5, total: 15, meta: { target: 15 } }));
  assert.match(html, /<span class="ldm-card-target">DC 15<\/span>/);
  assert.match(html, /ldm-card-badge-pass">Pass</);
  assert.doesNotMatch(html, /ldm-card-badge-fail/);
});

test('d20 target: fail when total is below the target', () => {
  const html = render(d20Cfg({}, { targetLabel: 'Hit' }), d20Roll({ natural: 10, modifier: 5, total: 14, meta: { target: 15 } }));
  assert.match(html, /<span class="ldm-card-target">Hit 15<\/span>/);
  assert.match(html, /ldm-card-badge-fail">Fail</);
});

test('d20 without a numeric target shows no pass/fail', () => {
  const html = render(d20Cfg(), d20Roll({ meta: { target: '15' } }));
  assert.doesNotMatch(html, /ldm-card-target/);
  assert.doesNotMatch(html, /ldm-card-badge-(pass|fail)/);
});

// ---------- pool mode ----------

test('pool shows hits, ones, misses and dropped dice with the success count', () => {
  const roll = poolRoll({ rolls: [6, 5, 1, 3, 2, 6], dropped: [false, false, false, false, false, true], successes: 2 });
  const html = render(poolCfg(), roll);
  assert.equal(count(html, 'ldm-card-die-hit'), 2);
  assert.equal(count(html, 'ldm-card-die-one'), 1);
  assert.equal(count(html, 'ldm-card-die-miss'), 2);
  assert.equal(count(html, 'ldm-card-die-dropped'), 1);
  assert.match(html, /<span class="ldm-card-total">2<\/span><span class="ldm-card-unit">successes<\/span>/);
  assert.doesNotMatch(html, /ldm-card-badge/);
});

test('pool with no dice terms counts the total as successes', () => {
  const roll = { formula: '3d6cs>=5', mode: 'public', total: 3, terms: [], meta: { system: 'loom-demo', mode: 'pool', successMin: 5 } };
  const html = render(poolCfg(), roll);
  assert.match(html, /<span class="ldm-card-total">3<\/span>/);
});

test('pool glitch badge when more than half of the active dice show one', () => {
  const roll = poolRoll({ rolls: [1, 1, 1, 6], successes: 1, meta: { glitchOnOnes: true } });
  assert.match(render(poolCfg(), roll), /ldm-card-badge-glitch">Glitch</);
});

test('pool no glitch when ones are not a majority or glitch is off', () => {
  const notMajority = poolRoll({ rolls: [1, 6, 6, 3], successes: 2, meta: { glitchOnOnes: true } });
  assert.doesNotMatch(render(poolCfg(), notMajority), /ldm-card-badge-glitch/);
  const off = poolRoll({ rolls: [1, 1, 1, 6], successes: 1, meta: { glitchOnOnes: false } });
  assert.doesNotMatch(render(poolCfg(), off), /ldm-card-badge-glitch/);
});

test('pool ignores meta.target (target is a d20 concept)', () => {
  const roll = poolRoll({ rolls: [6], successes: 1, meta: { target: 9 } });
  const html = render(poolCfg(), roll);
  assert.doesNotMatch(html, /ldm-card-target/);
  assert.doesNotMatch(html, /ldm-card-badge-(pass|fail)/);
});

// ---------- layout options ----------

test('compact style hides dice, modifier and the target row details but keeps total and badges', () => {
  const html = render(d20Cfg({ style: 'compact' }), d20Roll({ natural: 20, modifier: 1, total: 21, meta: { target: 30 } }));
  assert.match(html, /ldm-card-compact/);
  assert.doesNotMatch(html, /ldm-card-dice/);
  assert.doesNotMatch(html, /ldm-card-mod/);
  assert.match(html, /<span class="ldm-card-total">21<\/span>/);
  assert.match(html, /ldm-card-badge-crit/);
});

test('detailed style includes the dice row', () => {
  const html = render(d20Cfg({ style: 'detailed' }), d20Roll({ natural: 12 }));
  assert.match(html, /class="ldm-card-dice"/);
});

test('showDice false hides dice chips and modifier but keeps the total and crit badge', () => {
  const html = render(d20Cfg({ showDice: false }), d20Roll({ natural: 20, modifier: 4, total: 24 }));
  assert.doesNotMatch(html, /ldm-card-dice/);
  assert.doesNotMatch(html, /ldm-card-mod/);
  assert.match(html, /<span class="ldm-card-total">24<\/span>/);
  assert.match(html, /ldm-card-badge-crit/);
});

test('showDice false also hides pool chips', () => {
  const html = render(poolCfg({ showDice: false }), poolRoll({ rolls: [6, 5], successes: 2 }));
  assert.doesNotMatch(html, /ldm-card-dice/);
  assert.match(html, /<span class="ldm-card-total">2<\/span>/);
});

test('showFormula false hides the formula', () => {
  const html = render(d20Cfg({ showFormula: false }), d20Roll({ formula: '1d20+5' }));
  assert.doesNotMatch(html, /ldm-card-formula/);
});

test('custom crit and fumble labels from the config are used', () => {
  const html = render(d20Cfg({ critLabel: 'Nat 20', fumbleLabel: 'Botch' }), d20Roll({ natural: 20, modifier: 0, total: 20 }));
  assert.match(html, />Nat 20</);
  const fumble = render(d20Cfg({ critLabel: 'Nat 20', fumbleLabel: 'Botch' }), d20Roll({ natural: 1, modifier: 0, total: 1 }));
  assert.match(fumble, />Botch</);
});

// ---------- header tokens ----------

test('header substitutes actor, label and result', () => {
  const html = render(d20Cfg({ header: '{actor} rolls {label}: {result}' }), d20Roll({ natural: 10, modifier: 5, total: 15 }));
  assert.match(html, /class="ldm-card-title">Ayla rolls Strike: 15</);
});

test('header only substitutes the three tokens and leaves other braces as text', () => {
  const html = render(d20Cfg({ header: '{actor} {other}' }), d20Roll());
  assert.match(html, /class="ldm-card-title">Ayla \{other\}</);
});

test('header token values are not re-scanned for tokens', () => {
  const roll = d20Roll({ meta: { label: '{actor}', actorName: 'Ayla' } });
  const html = render(d20Cfg({ header: '[{label}]' }), roll);
  assert.match(html, /class="ldm-card-title">\[\{actor\}\]</);
});

test('header falls back to the label when the template renders empty', () => {
  const html = render(d20Cfg({ header: '{actor}' }), d20Roll({ meta: { actorName: '' } }));
  assert.match(html, /class="ldm-card-title">Strike</);
});

test('header falls back to a localized "Roll" when there is no label either', () => {
  const html = render(d20Cfg({ header: '{actor}' }), d20Roll({ meta: { actorName: '', label: '' } }));
  assert.match(html, /class="ldm-card-title">Roll</);
});

test('header with unusable config falls back to the default template', () => {
  const html = render({ ...d20Cfg(), card: { header: 42 } }, d20Roll({ meta: { actorName: 'Ayla', label: 'Hit' } }));
  assert.match(html, /class="ldm-card-title">Ayla: Hit</);
});

// ---------- accent ----------

test('accent accepts strict #rrggbb in either case', () => {
  assert.match(render(d20Cfg({ accent: '#A1b2C3' }), d20Roll()), /--ldm-card-accent:#A1b2C3/);
});

test('accent that is not strict #rrggbb falls back to the default', () => {
  const bad = [
    'red',
    '#fff',
    '#7c5cf',
    '#7c5cff;background:url(http://x)',
    '#7c5cff"onmouseover="alert(1)',
    'url(javascript:alert(1))',
    '#7c5cff</style><img src=x onerror=alert(1)>',
    '',
    42,
    null,
    { toString() { throw new Error('boom'); } },
  ];
  for (const accent of bad) {
    const html = render(d20Cfg({ accent }), d20Roll());
    assert.ok(html.includes(`--ldm-card-accent:${CARD_DEFAULT_ACCENT}"`), `accent of type ${typeof accent} should fall back`);
    assert.doesNotMatch(html, /onmouseover|javascript:|<img|<\/style>/);
  }
});

// ---------- hostile input ----------

test('hostile config text is escaped in header and labels', () => {
  const cfg = d20Cfg({
    header: '<img src=x onerror=alert(1)> {label}',
    successLabel: '"><script>alert(1)</script>',
    critLabel: "<b onclick='x'>crit</b>",
    fumbleLabel: '"><svg onload=alert(1)>',
  }, { targetLabel: '<i>DC</i>' });
  const crit = render(cfg, d20Roll({ natural: 20, modifier: 0, total: 20, meta: { target: 5 } }));
  const fail = render(cfg, d20Roll({ natural: 1, modifier: 0, total: 1, meta: { target: 5 } }));
  for (const html of [crit, fail]) {
    // Escaped text may still contain attribute-looking words; the markup must not.
    assert.doesNotMatch(html, /<img|<script|<svg|<b[ >]|<i>/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  }
  assert.match(crit, /&lt;b onclick=&#39;x&#39;&gt;crit&lt;\/b&gt;/);
});

test('hostile roll meta is escaped (label, actor, formula)', () => {
  const roll = d20Roll({
    formula: '<svg onload=alert(1)>',
    meta: { label: '<img src=x onerror=alert(1)>', actorName: '"><script>x</script>' },
  });
  const html = render(d20Cfg(), roll);
  assert.doesNotMatch(html, /<img|<svg|<script/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(html, /&lt;svg onload=alert\(1\)&gt;/);
});

test('huge strings are cut to fixed limits before rendering', () => {
  const huge = 'A'.repeat(200000);
  const roll = d20Roll({ formula: huge, meta: { label: huge, actorName: huge } });
  const html = render(d20Cfg({ header: huge, successLabel: huge }), roll);
  assert.ok(html.length < 4000, `card is ${html.length} chars`);
});

test('a roll with missing fields still renders a card', () => {
  const html = render(d20Cfg(), { total: 7 });
  assert.match(html, /<span class="ldm-card-total">7<\/span>/);
  assert.match(html, /class="ldm-card-title">Roll</);
  assert.doesNotMatch(html, /ldm-card-dice/);
});

test('a roll without terms or meta renders its total', () => {
  const html = render(d20Cfg(), { formula: '1d20', total: 9 });
  assert.match(html, /<span class="ldm-card-total">9<\/span>/);
  assert.doesNotMatch(html, /ldm-card-badge/);
});

test('null and non-object rolls render an empty total instead of throwing', () => {
  for (const roll of [null, undefined, 'x', 12, []]) {
    const html = render(d20Cfg(), roll);
    assert.match(html, /<span class="ldm-card-total">0<\/span>/);
  }
});

test('non-numeric and non-finite dice values are skipped, total is clamped to a number', () => {
  const roll = {
    formula: '2d20',
    total: '<b>99</b>',
    terms: [{ kind: 'dice', count: 3, faces: 20, rolls: [NaN, '<i>', 8], dropped: [false, false, false] }],
    meta: { system: 'loom-demo', mode: 'd20' },
  };
  const html = render(d20Cfg(), roll);
  assert.doesNotMatch(html, /<b>|<i>/);
  assert.match(html, /<span class="ldm-card-total">0<\/span>/);
  assert.equal(chipCount(html), 1);
});

test('a huge dice list is capped with a "+N" marker', () => {
  const rolls = Array.from({ length: 150 }, () => 3);
  const html = render(poolCfg(), poolRoll({ rolls, successes: 0 }));
  assert.equal(chipCount(html), 100);
  assert.match(html, /<span class="ldm-card-more">\+50<\/span>/);
});

test('custom escaper is used for output strings', () => {
  const calls = [];
  const spy = (s) => {
    calls.push(s);
    return esc(s);
  };
  const html = renderCard(d20Cfg(), d20Roll({ meta: { label: 'Probe' } }), spy);
  assert.ok(calls.includes('Ayla: Probe'), 'the title is escaped through the wrap escaper');
  assert.ok(calls.includes('1d20+5'), 'the formula is escaped through the wrap escaper');
  assert.match(html, /Ayla: Probe/);
});

test('a throwing escaper falls back to the shared escaper', () => {
  const broken = () => {
    throw new Error('boom');
  };
  const html = renderCard(d20Cfg(), d20Roll({ meta: { label: '<img onerror=x>' } }), broken);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img onerror=x&gt;/);
});

test('an escaper returning a non-string falls back to the shared escaper', () => {
  const html = renderCard(d20Cfg(), d20Roll({ meta: { label: '<i>' } }), () => 42);
  assert.doesNotMatch(html, /<i>/);
  assert.match(html, /&lt;i&gt;/);
});

test('localizer is used for built-in words and ignores empty answers', () => {
  const t = (key, fallback) => (key === 'sandbox.card.untitled' ? 'Rolagem' : key === 'sandbox.card.pass' ? '' : fallback);
  const html = renderCard(d20Cfg({ header: '{label}' }), d20Roll({ meta: { label: '', actorName: '' }, natural: 1, modifier: 0, total: 1 }), esc, { t });
  assert.match(html, /class="ldm-card-title">Rolagem</);
  assert.match(html, /ldm-card-badge-fumble">Fumble</);
});

test('the card never has a root background or border (only the inner panel)', () => {
  const html = render(d20Cfg(), d20Roll());
  assert.match(html, /^<div class="ldm-card [^"]*" style="--ldm-card-accent:#7c5cff" data-ldm-card="1"><div class="ldm-card-main">/);
});

// ---------- roll marker ----------

test('isDemoRoll only accepts the system marker in meta', () => {
  assert.equal(isDemoRoll({ meta: { system: 'loom-demo' } }), true);
  assert.equal(isDemoRoll({ meta: { system: 'dnd5e' } }), false);
  assert.equal(isDemoRoll({}), false);
  assert.equal(isDemoRoll({ meta: 'loom-demo' }), false);
  assert.equal(isDemoRoll(null), false);
  assert.equal(isDemoRoll('loom-demo'), false);
});

// ---------- config cache ----------

test('createConfigCache serves the default before a load and the loaded value after', async () => {
  const loaded = { ...d20Cfg({ accent: '#112233' }) };
  const cache = createConfigCache({ loader: async () => loaded });
  assert.equal(cache.current().card.accent, defaultConfig().card.accent);
  cache.refresh();
  await new Promise((r) => setImmediate(r));
  assert.equal(cache.current().card.accent, '#112233');
});

test('createConfigCache refreshes at most once per interval and never while a refresh is in flight', async () => {
  let clock = 0;
  let calls = 0;
  let release;
  const loader = () => {
    calls += 1;
    return new Promise((resolve) => {
      release = () => resolve(d20Cfg());
    });
  };
  const cache = createConfigCache({ loader, now: () => clock, refreshMs: 2000 });
  cache.refresh(); // starts at clock 0
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
  clock = 1000;
  cache.touch();
  assert.equal(calls, 1, 'touch must not start a second load while one is in flight');
  release();
  await new Promise((r) => setImmediate(r));
  clock = 1500;
  cache.touch();
  assert.equal(calls, 1, 'inside the interval after a refresh there is no new load');
  clock = 1999;
  cache.touch();
  assert.equal(calls, 1);
  clock = 2000;
  cache.touch();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2, 'at the interval a background refresh starts');
});

test('createConfigCache keeps the last good snapshot when the loader rejects', async () => {
  const cache = createConfigCache({ loader: async () => { throw new Error('network'); } });
  cache.set(d20Cfg({ accent: '#abcdef' }));
  cache.refresh();
  await new Promise((r) => setImmediate(r));
  assert.equal(cache.current().card.accent, '#abcdef');
});

test('createConfigCache.set ignores non-object values', () => {
  const cache = createConfigCache({ loader: async () => null });
  cache.set('nope');
  cache.set(null);
  assert.equal(cache.current().card.accent, defaultConfig().card.accent);
});

// ---------- wrap installer ----------

function fakeWraps() {
  const point = {
    fn: null,
    wrap(wrapper) {
      this.fn = wrapper;
      return () => {
        this.fn = null;
      };
    },
  };
  return { renderRollCard: point };
}

test('registerRollCard routes non-demo rolls to the wrapped renderer', () => {
  const wraps = fakeWraps();
  const { ok } = registerRollCard({
    wraps,
    loadConfig: async () => d20Cfg(),
    onConfigSaved: () => () => {},
  });
  assert.equal(ok, true);
  const seen = [];
  const wrapped = (roll, escFn) => {
    seen.push([roll, escFn]);
    return '<core/>';
  };
  const foreign = { meta: { system: 'dnd5e' }, total: 3, terms: [] };
  assert.equal(wraps.renderRollCard.fn(wrapped, foreign, esc), '<core/>');
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], foreign);
});

test('registerRollCard renders the card for demo rolls and never calls the wrapped renderer', () => {
  const wraps = fakeWraps();
  registerRollCard({ wraps, loadConfig: async () => d20Cfg(), onConfigSaved: () => () => {} });
  const wrapped = () => {
    throw new Error('must not be called');
  };
  const html = wraps.renderRollCard.fn(wrapped, d20Roll({ natural: 20, modifier: 0, total: 20 }), esc);
  assert.match(html, /ldm-card-badge-crit/);
});

test('registerRollCard uses the default config synchronously and picks up a saved config', async () => {
  const wraps = fakeWraps();
  let saveListener = null;
  const saved = d20Cfg({ accent: '#00ff88', header: 'Saved {label}' });
  registerRollCard({
    wraps,
    loadConfig: async () => saved,
    onConfigSaved: (cb) => {
      saveListener = cb;
      return () => {};
    },
  });
  const roll = d20Roll();
  const first = wraps.renderRollCard.fn(() => '', roll, esc);
  assert.match(first, /--ldm-card-accent:#7c5cff/, 'first render uses the default config');
  await new Promise((r) => setImmediate(r));
  const second = wraps.renderRollCard.fn(() => '', roll, esc);
  assert.match(second, /--ldm-card-accent:#00ff88/, 'render after the background load uses the loaded config');
  saveListener(d20Cfg({ accent: '#123456', header: 'Changed' }));
  const third = wraps.renderRollCard.fn(() => '', roll, esc);
  assert.match(third, /--ldm-card-accent:#123456/);
  assert.match(third, /class="ldm-card-title">Changed</);
});

test('registerRollCard tolerates a failing loader and reports not-installed without a wrap point', async () => {
  const result = registerRollCard({
    wraps: {},
    loadConfig: async () => {
      throw new Error('boom');
    },
    onConfigSaved: () => () => {},
  });
  assert.equal(result.ok, false);
  const withWraps = registerRollCard({
    wraps: fakeWraps(),
    loadConfig: async () => {
      throw new Error('boom');
    },
    onConfigSaved: () => () => {},
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(withWraps.ok, true);
});

// ---------- damage rolls (meta.kind === 'damage') ----------

function damageRoll({ rolls = [5], modifier = 2, total, formula = '1d8+2', terms, meta = {} } = {}) {
  const sum = rolls.reduce((a, b) => a + b, 0);
  return {
    formula,
    mode: 'public',
    total: total ?? sum + modifier,
    terms: terms ?? [
      { kind: 'dice', count: rolls.length, faces: 8, rolls, dropped: rolls.map(() => false) },
      { kind: 'modifier', value: modifier },
    ],
    meta: { system: 'loom-demo', kind: 'damage', label: 'Longsword', actorName: 'Ayla', ...meta },
  };
}

test('damage 1d8+2 renders title, formula, one neutral chip and the total with the Damage label', () => {
  const html = render(d20Cfg(), damageRoll({ rolls: [5], modifier: 2, total: 7 }));
  assert.match(html, /class="ldm-card-title">Ayla: Longsword</);
  assert.match(html, /<code class="ldm-card-formula">1d8\+2<\/code>/);
  assert.equal(chipCount(html), 1);
  assert.match(html, /<span class="ldm-card-die">5<\/span>/);
  assert.match(html, /<span class="ldm-card-total">7<\/span><span class="ldm-card-unit">Damage<\/span>/);
  assert.match(html, /ldm-card-damage/);
});

test('damage card never shows pass/fail, glitch, crit, fumble, target or mod, even with check-like meta', () => {
  const roll = damageRoll({
    rolls: [20, 1, 1],
    modifier: 0,
    total: 22,
    formula: '3d6',
    terms: undefined,
    meta: { mode: 'pool', target: 10, critMin: 20, fumbleMax: 1, successMin: 5, glitchOnOnes: true, faces: 6 },
  });
  const html = render(d20Cfg(), roll);
  assert.doesNotMatch(html, /ldm-card-badge/);
  assert.doesNotMatch(html, /ldm-card-target/);
  assert.doesNotMatch(html, /ldm-card-mod/);
  assert.doesNotMatch(html, /ldm-card-die-/);
  assert.doesNotMatch(html, /Pass|Fail|Glitch|Critical|Fumble|successes/);
  assert.match(html, /<span class="ldm-card-total">22<\/span>/);
});

test('damage with multiple dice terms shows every die as a chip and the summed total', () => {
  const roll = damageRoll({
    formula: '2d6+1d4+3',
    total: 15,
    terms: [
      { kind: 'dice', count: 2, faces: 6, rolls: [6, 2], dropped: [false, false] },
      { kind: 'dice', count: 1, faces: 4, rolls: [4], dropped: [false] },
      { kind: 'modifier', value: 3 },
    ],
  });
  const html = render(d20Cfg(), roll);
  assert.equal(chipCount(html), 3);
  assert.match(html, /<span class="ldm-card-die">6<\/span><span class="ldm-card-die">2<\/span><span class="ldm-card-die">4<\/span>/);
  assert.match(html, /<span class="ldm-card-total">15<\/span>/);
  assert.match(html, /<code class="ldm-card-formula">2d6\+1d4\+3<\/code>/);
});

test('damage with a negative total shows the minus sign', () => {
  const roll = damageRoll({ rolls: [2], modifier: -5, total: -3, formula: '1d4-5' });
  const html = render(d20Cfg(), roll);
  assert.match(html, /<span class="ldm-card-total">-3<\/span>/);
  assert.match(html, /<code class="ldm-card-formula">1d4-5<\/code>/);
});

test('damage compact hides the dice chips but keeps the formula, title and total', () => {
  const roll = damageRoll({ rolls: [5, 3], modifier: 2, total: 10, formula: '2d8+2' });
  const compact = render(d20Cfg({ style: 'compact' }), roll);
  assert.match(compact, /class="ldm-card ldm-card-compact ldm-card-damage"/);
  assert.equal(chipCount(compact), 0);
  assert.doesNotMatch(compact, /ldm-card-dice"/);
  assert.match(compact, /<code class="ldm-card-formula">2d8\+2<\/code>/);
  assert.match(compact, /<span class="ldm-card-total">10<\/span>/);
  const detailed = render(d20Cfg({ style: 'detailed' }), roll);
  assert.equal(chipCount(detailed), 2);
  assert.match(detailed, /ldm-card-dice/);
});

test('damage with showDice false hides the chips and keeps the formula and total', () => {
  const html = render(d20Cfg({ showDice: false }), damageRoll({ rolls: [5], modifier: 2, total: 7 }));
  assert.equal(chipCount(html), 0);
  assert.doesNotMatch(html, /ldm-card-dice"/);
  assert.match(html, /<code class="ldm-card-formula">1d8\+2<\/code>/);
  assert.match(html, /<span class="ldm-card-total">7<\/span>/);
});

test('damage with showFormula false hides the formula', () => {
  const html = render(d20Cfg({ showFormula: false }), damageRoll({ rolls: [5], modifier: 2, total: 7 }));
  assert.doesNotMatch(html, /ldm-card-formula/);
});

test('damage escapes hostile label and actorName', () => {
  const html = render(
    d20Cfg(),
    damageRoll({ meta: { label: '<img src=x onerror=alert(1)>', actorName: '<b onmouseover="x">Ayla</b>' } })
  );
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<b /);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;b onmouseover=&quot;x&quot;&gt;Ayla&lt;\/b&gt;/);
});

test('damage uses the Damage label from the localizer', () => {
  const keys = [];
  const html = renderCard(d20Cfg(), damageRoll({ rolls: [5], modifier: 2, total: 7 }), esc, {
    t: (key, fallback) => {
      keys.push(key);
      return key === 'sandbox.card.damage' ? 'Dano' : fallback;
    },
  });
  assert.ok(keys.includes('sandbox.card.damage'));
  assert.match(html, /<span class="ldm-card-unit">Dano<\/span>/);
});

test('a separate damage pool shows the configured base plus real pool successes', () => {
  const roll = damageRoll({ rolls: [2, 6, 8, 1], modifier: 0, total: 2, formula: '4d10cs>=6', terms: [{ kind: 'dice', count: 4, faces: 10, rolls: [2, 6, 8, 1], dropped: [false, false, false, false] }], meta: { damagePool: true, base: 3 } });
  const html = renderCard(poolCfg({}, { faces: 10, successMin: 6 }), roll, esc);
  assert.match(html, /<code class="ldm-card-formula">4d10cs&gt;=6<\/code>/);
  assert.match(html, /<span class="ldm-card-total">5<\/span>/);
});

test('damage chips are capped with a +N marker', () => {
  const rolls = Array.from({ length: 150 }, () => 3);
  const html = render(d20Cfg(), damageRoll({ rolls, modifier: 0, total: 450, formula: '150d8' }));
  assert.equal(chipCount(html), 100);
  assert.match(html, /<span class="ldm-card-more">\+50<\/span>/);
});

test('an unknown meta.kind falls back to the check rendering', () => {
  const unknown = render(d20Cfg(), d20Roll({ natural: 9, modifier: 5, total: 14, meta: { kind: 'mystery' } }));
  const check = render(d20Cfg(), d20Roll({ natural: 9, modifier: 5, total: 14, meta: { kind: 'check' } }));
  assert.equal(unknown, check);
  assert.match(unknown, /ldm-card-mod/);
  assert.doesNotMatch(unknown, /ldm-card-damage/);
});

test('a check roll is unchanged: missing kind renders the same as kind check', () => {
  const missing = d20Roll({ natural: 20, modifier: 2, total: 22, meta: { kind: undefined } });
  delete missing.meta.kind;
  const explicit = d20Roll({ natural: 20, modifier: 2, total: 22 });
  assert.equal(render(d20Cfg(), missing), render(d20Cfg(), explicit));
  const html = render(d20Cfg(), explicit);
  assert.match(html, /ldm-card-badge ldm-card-badge-crit">Critical</);
  assert.match(html, /ldm-card-d20/);
  assert.doesNotMatch(html, /ldm-card-damage/);
});
