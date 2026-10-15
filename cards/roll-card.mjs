// Chat roll card of the demo sandbox.
//
// Layout:
//   renderCard(cfg, roll, esc, extra) -> html   pure, no engine access, tested in plain Node
//   createConfigCache(...)                      sync config snapshot refreshed in the background
//   registerRollCard(options)                   thin installer: renderRollCard wrap + config refresh
//
// Every string that reaches the HTML goes through the escaper passed by the wrap (falling back to
// lib/helpers.mjs esc). Config text and roll meta are untrusted: they are read as plain data, sliced
// to fixed limits before escaping, and never placed in the markup as raw HTML.

import { esc as helperEsc } from '../lib/helpers.mjs';
import { defaultConfig, loadConfig as loadFreshConfig, onConfigSaved as onSavedConfig } from '../lib/config.mjs';
import { interpret } from '../lib/dice.mjs';
import { resolveAttackDamage } from '../lib/attacks.mjs';

/** The roll meta marker that identifies rolls made by this system. */
export const CARD_SYSTEM_ID = 'loom-demo';

/** Same default as lib/config.mjs; used when the config has no usable accent. */
export const CARD_DEFAULT_ACCENT = '#7c5cff';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;
const TOKEN_RE = /\{(actor|label|result)\}/g;
const DEFAULT_HEADER = '{actor}: {label}';

const LIMIT = Object.freeze({
  header: 80,
  label: 80,
  text: 200,
  formula: 120,
  unit: 40,
  target: 20,
  chips: 100,
  refreshMs: 2000,
});

/** Reads a string or finite number as bounded text. Anything else becomes ''. Never throws. */
function textOf(value, max) {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value).slice(0, max) : '';
  if (typeof value !== 'string') return '';
  return value.slice(0, max).replace(CONTROL_RE, ' ');
}

/** Integer view of a number, or the fallback when the value is not a finite number. */
function numberOf(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function signedText(n) {
  return n < 0 ? `-${-n}` : `+${n}`;
}

/** Escaper used for every output string. Uses the wrap's esc, falls back to the shared helper. */
function makeEscaper(esc) {
  return (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    if (typeof esc === 'function') {
      try {
        const out = esc(text);
        if (typeof out === 'string') return out;
      } catch {
        // Fall through to the shared escaper.
      }
    }
    return helperEsc(text);
  };
}

/** Localizer that never returns an empty string or the bare key. */
function makeT(fn) {
  return (key, fallback) => {
    if (typeof fn !== 'function') return fallback;
    try {
      const value = fn(key, fallback);
      return typeof value === 'string' && value.trim() !== '' ? value : fallback;
    } catch {
      return fallback;
    }
  };
}

/** Card settings with every field validated or defaulted. Accepts any input. */
function cardView(cfg, t) {
  const card = plainObject(plainObject(cfg).card);
  const d20 = plainObject(plainObject(plainObject(cfg).dice).d20);
  const labelOr = (value, fallback) => textOf(value, LIMIT.unit).trim() || fallback;
  const headerText = typeof card.header === 'string' ? textOf(card.header, LIMIT.header).trim() : '';
  return {
    style: card.style === 'compact' ? 'compact' : 'detailed',
    showFormula: card.showFormula !== false,
    showDice: card.showDice !== false,
    accent: typeof card.accent === 'string' && HEX_RE.test(card.accent) ? card.accent : CARD_DEFAULT_ACCENT,
    header: headerText || DEFAULT_HEADER,
    successLabel: labelOr(card.successLabel, t('sandbox.card.successes', 'successes')),
    critLabel: labelOr(card.critLabel, t('sandbox.card.critical', 'Critical')),
    fumbleLabel: labelOr(card.fumbleLabel, t('sandbox.card.fumble', 'Fumble')),
    targetLabel: labelOr(d20.targetLabel, t('sandbox.card.target', 'Target')).slice(0, LIMIT.target),
  };
}

/** Header: tokens are replaced by RAW values, then the whole string is escaped once. */
function renderTitle(template, values, fallback, e) {
  const substituted = template.replace(TOKEN_RE, (_, key) => values[key] ?? '');
  // Empty tokens can leave separators behind (for example ": " with no actor or label).
  const text = substituted
    .slice(0, LIMIT.text)
    .replace(/^[\s:|·\-–—]+|[\s:|·\-–—]+$/g, '')
    .trim();
  return e(text || fallback);
}

function renderChips(view, isPool, card, e, t) {
  const shown = view.dice.slice(0, LIMIT.chips);
  const hidden = view.dice.length - shown.length;
  const chips = shown.map((die) => {
    const classes = ['ldm-card-die'];
    let hint = '';
    if (die.dropped) {
      classes.push('ldm-card-die-dropped');
      hint = t('sandbox.card.dieDropped', 'dropped');
    } else if (isPool) {
      if (die.hit) {
        classes.push('ldm-card-die-hit');
        hint = t('sandbox.card.dieHit', 'hit');
      } else if (die.value === 1) {
        classes.push('ldm-card-die-one');
        hint = t('sandbox.card.dieOne', 'rolled a 1');
      } else {
        classes.push('ldm-card-die-miss');
        hint = t('sandbox.card.dieMiss', 'miss');
      }
    } else if (view.natural !== undefined && die.value === view.natural) {
      if (view.crit) classes.push('ldm-card-die-crit');
      if (view.fumble) classes.push('ldm-card-die-fumble');
    }
    const titleAttr = hint ? ` title="${e(hint)}"` : '';
    return `<span class="${classes.join(' ')}"${titleAttr}>${e(numberOf(die.value, 0))}</span>`;
  }).join('');
  const more = hidden > 0 ? `<span class="ldm-card-more">+${hidden}</span>` : '';
  return `<div class="ldm-card-dice" aria-label="${e(t('sandbox.card.dice', 'Dice'))}">${chips}${more}</div>`;
}

/**
 * Damage card: a plain formula, neutral dice chips and the total. No hit/miss, crit/fumble,
 * pass/fail or target: those belong to checks only.
 */
function renderDamageCard(card, source, meta, e, t, effectiveDamage = null) {
  const total = effectiveDamage === null ? numberOf(source.total, 0) : effectiveDamage;
  const actorName = textOf(meta.actorName, LIMIT.label).trim();
  const label = textOf(meta.label, LIMIT.label).trim();
  const title = renderTitle(
    card.header,
    { actor: actorName, label, result: String(total) },
    label || t('sandbox.card.untitled', 'Roll'),
    e
  );

  const formula = textOf(source.formula, LIMIT.formula).trim();
  const formulaHtml = card.showFormula && formula ? `<code class="ldm-card-formula">${e(formula)}</code>` : '';

  // Every die of every dice term, as neutral chips (only the base chip class).
  const values = [];
  const terms = Array.isArray(source.terms) ? source.terms : [];
  for (const term of terms) {
    if (!term || term.kind !== 'dice' || !Array.isArray(term.rolls)) continue;
    for (const value of term.rolls) {
      if (Number.isFinite(value)) values.push(numberOf(value, 0));
    }
  }

  let chipsHtml = '';
  if (card.showDice && card.style === 'detailed' && values.length > 0) {
    const shown = values.slice(0, LIMIT.chips);
    const hidden = values.length - shown.length;
    const chips = shown.map((value) => `<span class="ldm-card-die">${e(value)}</span>`).join('');
    const more = hidden > 0 ? `<span class="ldm-card-more">+${hidden}</span>` : '';
    chipsHtml = `<div class="ldm-card-dice" aria-label="${e(t('sandbox.card.dice', 'Dice'))}">${chips}${more}</div>`;
  }

  return `<div class="ldm-card ldm-card-${card.style} ldm-card-damage" style="--ldm-card-accent:${e(card.accent)}" data-ldm-card="1">`
    + `<div class="ldm-card-main">`
    + `<div class="ldm-card-header"><span class="ldm-card-title">${title}</span>${formulaHtml}</div>`
    + chipsHtml
    + `<div class="ldm-card-result"><span class="ldm-card-total">${e(total)}</span>`
    + `<span class="ldm-card-unit">${e(t('sandbox.card.damage', 'Damage'))}</span></div>`
    + `</div>`
    + `</div>`;
}

/**
 * Renders the card HTML for one roll.
 *
 * @param {object} cfg      world config (validated upstream; sanitized again here)
 * @param {object} roll     server roll object: { formula, terms, total, mode, meta }
 * @param {Function} esc    the escaper passed by the wrap point
 * @param {{ t?: (key: string, fallback: string) => string }} [extra]
 * @returns {string} HTML, with every string escaped
 */
export function renderCard(cfg, roll, esc, extra = {}) {
  const e = makeEscaper(esc);
  const t = makeT(plainObject(extra).t);
  const card = cardView(cfg, t);
  const source = plainObject(roll);
  const meta = plainObject(source.meta);

  // Damage rolls (the second roll posted by the actor sheet) never use the check rendering.
  // A missing or unknown kind falls through to the check rendering below.
  if (meta.kind === 'damage') {
    if (meta.damagePool === true) {
      const view = interpret(cfg, roll);
      const successes = view.dice.length === 0 ? numberOf(view.total, 0) : numberOf(view.successes, 0);
      return renderDamageCard(card, source, meta, e, t, Math.max(0, numberOf(meta.base, 0) + successes));
    }
    return renderDamageCard(card, source, meta, e, t);
  }

  const view = interpret(cfg, roll);

  const isPool = view.mode === 'pool';
  const total = numberOf(view.total, 0);
  // A cs term yields total = successes; when no dice terms came back, total is the only count there is.
  const successes = view.dice.length === 0 ? total : numberOf(view.successes, 0);
  const resultValue = isPool ? successes : total;

  const actorName = textOf(meta.actorName, LIMIT.label).trim();
  const label = textOf(meta.label, LIMIT.label).trim();
  const title = renderTitle(
    card.header,
    { actor: actorName, label, result: String(resultValue) },
    label || t('sandbox.card.untitled', 'Roll'),
    e
  );

  const formula = textOf(source.formula, LIMIT.formula).trim();
  const formulaHtml = card.showFormula && formula ? `<code class="ldm-card-formula">${e(formula)}</code>` : '';

  const detailed = card.style === 'detailed';
  const wantsDice = card.showDice && detailed;

  const chipsHtml = wantsDice && view.dice.length > 0 ? renderChips(view, isPool, card, e, t) : '';

  let modHtml = '';
  if (wantsDice && !isPool && view.natural !== undefined) {
    modHtml = `<span class="ldm-card-mod">${e(t('sandbox.card.modifier', 'Mod'))} ${e(signedText(total - view.natural))}</span>`;
  }

  // Target: only in d20 mode and only when the roll carries a numeric target.
  const targetNumber = !isPool && typeof meta.target === 'number' && Number.isFinite(meta.target)
    ? Math.trunc(meta.target)
    : undefined;
  let targetHtml = '';
  if (targetNumber !== undefined) {
    targetHtml = `<span class="ldm-card-target">${e(card.targetLabel)} ${e(targetNumber)}</span>`;
  }

  const badges = [];
  const badge = (kind, text) => `<span class="ldm-card-badge ldm-card-badge-${kind}">${e(text)}</span>`;
  if (isPool) {
    if (view.glitch) badges.push(badge('glitch', t('sandbox.card.glitch', 'Glitch')));
  } else {
    if (view.crit) badges.push(badge('crit', card.critLabel));
    if (view.fumble) badges.push(badge('fumble', card.fumbleLabel));
    if (targetNumber !== undefined) {
      const pass = total >= targetNumber;
      badges.push(pass
        ? badge('pass', t('sandbox.card.pass', 'Pass'))
        : badge('fail', t('sandbox.card.fail', 'Fail')));
    }
  }

  const unitHtml = isPool ? `<span class="ldm-card-unit">${e(card.successLabel)}</span>` : '';
  const attack = resolveAttackDamage(source, view);
  const attackHtml = source.meta?.attack && attack
    ? `<div class="ldm-card-attack-result"><span>${e(attack.hit === true ? t('sandbox.card.hit', 'Hit') : attack.hit === false ? t('sandbox.card.miss', 'Miss') : t('sandbox.card.defenseNeeded', 'Defense needed'))}${attack.successes > numberOf(view.successes, 0) ? ` · ${e(t('sandbox.card.effectiveSuccesses', 'Effective successes'))}: ${e(attack.successes)}` : ''}</span>${attack.damage === null ? '' : `<strong>${e(t('sandbox.card.damage', 'Damage'))}: ${e(attack.damage)}</strong>`}</div>`
    : '';

  return `<div class="ldm-card ldm-card-${card.style} ldm-card-${isPool ? 'pool' : 'd20'}" style="--ldm-card-accent:${e(card.accent)}" data-ldm-card="1">`
    + `<div class="ldm-card-main">`
    + `<div class="ldm-card-header"><span class="ldm-card-title">${title}</span>${formulaHtml}</div>`
    + chipsHtml
    + `<div class="ldm-card-result"><span class="ldm-card-total">${e(resultValue)}</span>${unitHtml}${modHtml}${targetHtml}${badges.join('')}</div>`
    + attackHtml
    + `</div>`
    + `</div>`;
}

/** True for rolls made by this system (the roll meta is client data: only the marker is checked). */
export function isDemoRoll(roll) {
  if (roll === null || typeof roll !== 'object') return false;
  const meta = roll.meta;
  return meta !== null && typeof meta === 'object' && meta.system === CARD_SYSTEM_ID;
}

/**
 * Sync config snapshot. `current()` never waits. `touch()` starts a background refresh at most
 * once per refreshMs and never while one is in flight. `set()` stores a config the engine already
 * validated (save notifications).
 */
export function createConfigCache({
  loader = loadFreshConfig,
  now = () => Date.now(),
  refreshMs = LIMIT.refreshMs,
} = {}) {
  let snapshot = null;
  let inFlight = null;
  let startedAt = -Infinity;

  const refresh = () => {
    if (inFlight) return inFlight;
    startedAt = now();
    inFlight = Promise.resolve()
      .then(() => loader({ fresh: true }))
      .then((cfg) => {
        if (cfg && typeof cfg === 'object') snapshot = cfg;
      }, () => {
        // Keep the last good snapshot.
      })
      .then(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return {
    current() {
      return snapshot ?? defaultConfig();
    },
    touch() {
      if (!inFlight && now() - startedAt >= refreshMs) refresh();
    },
    refresh,
    set(cfg) {
      if (cfg && typeof cfg === 'object') snapshot = cfg;
    },
  };
}

/** Localizer from the engine, or undefined when the engine is not present. */
function engineLocalizer() {
  const localize = globalThis.window?.Loom?.i18n?.localize;
  if (typeof localize !== 'function') return undefined;
  // The engine returns the key itself when a translation is missing: treat that as a miss.
  return (key, fallback) => {
    const value = localize(key);
    return typeof value === 'string' && value !== key ? value : fallback;
  };
}

/**
 * Installs the renderRollCard wrap. Rolls that are not ours fall straight through to `wrapped`.
 * Options (all optional, used by tests): loadConfig, onConfigSaved, wraps.
 * @returns {{ ok: boolean, unwrap: (() => void) | null, unsubscribe: () => void, cache: object }}
 */
export function registerRollCard(options = {}) {
  const opts = plainObject(options);
  const cache = createConfigCache({
    loader: typeof opts.loadConfig === 'function' ? opts.loadConfig : loadFreshConfig,
  });
  const subscribe = typeof opts.onConfigSaved === 'function' ? opts.onConfigSaved : onSavedConfig;
  const wraps = opts.wraps !== undefined ? opts.wraps : globalThis.window?.Loom?.wraps;

  const unsubscribe = subscribe((cfg) => cache.set(cfg));
  cache.refresh();

  const point = wraps?.renderRollCard;
  if (!point || typeof point.wrap !== 'function') {
    return { ok: false, unwrap: null, unsubscribe, cache };
  }

  const unwrap = point.wrap((wrapped, roll, esc) => {
    if (!isDemoRoll(roll)) return wrapped(roll, esc);
    cache.touch();
    return renderCard(cache.current(), roll, esc, { t: engineLocalizer() });
  });
  return { ok: true, unwrap, unsubscribe, cache };
}
