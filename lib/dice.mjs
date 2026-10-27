/**
 * Dice logic for the demo sandbox.
 *
 * Everything here is a pure function (plain Node, no imports, no window access)
 * except rollCheck, which is the only place that touches window.Loom.dispatchRoll.
 *
 * Server grammar these formulas must satisfy (verified against
 * server/applications/dice/roll-formula.ts, roll-parts.ts and roller.ts):
 *   NdF, integer literals, binary + and -, unary -, parentheses.
 * Whitespace is ignored by the server. Modifiers (kh/kl/dh/dl/r/ro/x) and
 * success counters (cs/cf) are only used by buildCheck; buildExtra rejects them.
 * The `c` suffix after a success threshold is parsed and ignored by the engine:
 * it does NOT add two successes for a natural maximum.
 */

const SYSTEM_ID = 'loom-demo';
const VISIBILITY_MODES = ['public', 'gmroll', 'blindroll', 'selfroll'];

/** Hard caps so a malicious config or extra formula cannot make the server roll too much. */
export const DICE_LIMITS = Object.freeze({
  maxExtraLength: 100, // characters of an extra damage formula (after trimming)
  maxDice: 100, // total dice in one extra formula, and max dice in a pool
  minFaces: 2,
  maxFaces: 1000,
  maxLiteral: 1000, // any integer literal in an extra formula
  maxModifier: 1000, // |attr + skill + bonus| before it becomes part of a formula
});

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clampInt(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function d20Settings(cfg) {
  const d = cfg?.dice?.d20 ?? {};
  const sides = clampInt(toInt(d.sides, 20), 2, 100);
  return {
    sides,
    critMin: clampInt(toInt(d.critMin, sides), 1, sides),
    fumbleMax: clampInt(toInt(d.fumbleMax, 1), 1, sides),
  };
}

function poolSettings(cfg) {
  const p = cfg?.dice?.pool ?? {};
  const faces = clampInt(toInt(p.faces, 6), 2, 100);
  return {
    faces,
    successMin: clampInt(toInt(p.successMin, 5), 2, faces),
    maxDice: clampInt(toInt(p.maxDice, 20), 1, DICE_LIMITS.maxDice),
    glitchOnOnes: p.glitchOnOnes === true,
  };
}

function activeMode(cfg) {
  return cfg?.dice?.mode === 'pool' ? 'pool' : 'd20';
}

/** Formats a signed integer as a formula suffix: 5 -> "+5", -3 -> "-3", 0 -> "+0". */
function signed(n) {
  return n < 0 ? `-${-n}` : `+${n}`;
}

/**
 * Builds the roll formula and meta for an ability/skill check.
 *
 * d20 mode:  1d{sides}+N, 2d{sides}kh1+N (adv), 2d{sides}kl1+N (dis), N = attr+skill+bonus.
 * pool mode: nd{faces}cs>={successMin}, n = clamp(attr+skill+bonus, 1, maxDice),
 *            advantage adds one die, disadvantage removes one; always clamped to 1..maxDice.
 *
 * @returns {{ formula: string, meta: object }} meta is passed along with the roll; the
 *          caller adds label/actorName/target.
 */
export function buildCheck(cfg, opts = {}) {
  const advantage = opts.advantage === 'adv' || opts.advantage === 'dis' ? opts.advantage : 'none';
  const sum = clampInt(
    toInt(opts.attrValue) + toInt(opts.skillValue) + toInt(opts.bonus),
    -DICE_LIMITS.maxModifier,
    DICE_LIMITS.maxModifier
  );

  if (activeMode(cfg) === 'pool') {
    const p = poolSettings(cfg);
    let n = clampInt(sum, 1, p.maxDice);
    if (advantage === 'adv') n = clampInt(n + 1, 1, p.maxDice);
    if (advantage === 'dis') n = clampInt(n - 1, 1, p.maxDice);
    return {
      formula: `${n}d${p.faces}cs>=${p.successMin}`,
      meta: {
        system: SYSTEM_ID,
        kind: 'check',
        mode: 'pool',
        faces: p.faces,
        successMin: p.successMin,
        glitchOnOnes: p.glitchOnOnes,
      },
    };
  }

  const d = d20Settings(cfg);
  let base = `1d${d.sides}`;
  if (advantage === 'adv') base = `2d${d.sides}kh1`;
  if (advantage === 'dis') base = `2d${d.sides}kl1`;
  return {
    formula: `${base}${signed(sum)}`,
    meta: {
      system: SYSTEM_ID,
      kind: 'check',
      mode: 'd20',
      sides: d.sides,
      critMin: d.critMin,
      fumbleMax: d.fumbleMax,
    },
  };
}

/**
 * Validates an extra damage formula (for example an item's damage field) against the
 * server grammar and the caps in DICE_LIMITS. Only accepts NdF, integer literals,
 * binary + and -, unary -, and parentheses. Anything else (modifiers, @variables,
 * functions, fate dice, leading +, empty groups) is rejected.
 *
 * @returns {{ ok: true, formula: string } | { ok: false, formula: '', error: string }}
 *          formula is the normalized form (whitespace removed, lowercase d).
 */
export function buildExtra(formula) {
  const fail = (error) => ({ ok: false, formula: '', error });

  if (typeof formula !== 'string') return fail('not-a-string');
  const trimmed = formula.trim();
  if (trimmed.length === 0) return fail('empty');
  if (trimmed.length > DICE_LIMITS.maxExtraLength) return fail('too-long');
  if (!/^[0-9dD+\-()\s]+$/.test(trimmed)) return fail('invalid-characters');

  // Same normalization as the server: whitespace is removed before parsing.
  const s = trimmed.replace(/\s+/g, '').toLowerCase();

  const tokens = [];
  const tokenRe = /\d*d\d+|\d+|[()+-]/y;
  let pos = 0;
  while (pos < s.length) {
    tokenRe.lastIndex = pos;
    const m = tokenRe.exec(s);
    if (!m) return fail('invalid-token');
    tokens.push(m[0]);
    pos = tokenRe.lastIndex;
  }

  let i = 0;
  let diceTotal = 0;
  let error = null;

  const isDice = (t) => /^\d*d\d+$/.test(t);
  const isNumber = (t) => /^\d+$/.test(t);

  // expr := factor (('+'|'-') factor)*
  // factor := '-' factor | NUMBER | DICE | '(' expr ')'
  // (mirrors parseExpression/parseFactor in roll-formula.ts; '+' is not a unary prefix there)
  function parseExpr() {
    parseFactor();
    while (!error && (tokens[i] === '+' || tokens[i] === '-')) {
      i++;
      parseFactor();
    }
  }

  function parseFactor() {
    if (error) return;
    const t = tokens[i];
    if (t === undefined) return setError('unexpected-end');
    if (t === '-') {
      i++;
      return parseFactor();
    }
    if (t === '(') {
      i++;
      parseExpr();
      if (error) return;
      if (tokens[i] !== ')') return setError('unbalanced-parentheses');
      i++;
      return;
    }
    if (isNumber(t)) {
      i++;
      if (Number(t) > DICE_LIMITS.maxLiteral) return setError('literal-too-large');
      return;
    }
    if (isDice(t)) {
      i++;
      const [countStr, facesStr] = t.split('d');
      const count = countStr === '' ? 1 : Number(countStr);
      const faces = Number(facesStr);
      if (count < 1) return setError('zero-dice');
      if (faces < DICE_LIMITS.minFaces || faces > DICE_LIMITS.maxFaces) return setError('faces-out-of-range');
      diceTotal += count;
      if (diceTotal > DICE_LIMITS.maxDice) return setError('too-many-dice');
      return;
    }
    return setError('unexpected-token');
  }

  function setError(reason) {
    if (!error) error = reason;
  }

  parseExpr();
  if (!error && i !== tokens.length) error = 'unexpected-token';
  if (error) return fail(error);
  return { ok: true, formula: s };
}

/**
 * Reads a server roll object and returns what the card and the sheet need.
 *
 * Mode, thresholds and the glitch rule come from roll.meta when present (the roll was
 * made with those values), otherwise from cfg. Missing or malformed fields never throw.
 *
 * Pool glitch rule (glitchOnOnes): a roll is a glitch when MORE than half of the
 * active (not dropped) dice show 1, i.e. ones * 2 > active count.
 *
 * @returns {{ mode, total, successes?, natural?, crit?, fumble?, glitch?, dice: Array<{value, hit?, dropped}> }}
 */
export function interpret(cfg, roll) {
  const meta = roll && typeof roll.meta === 'object' && roll.meta !== null ? roll.meta : {};
  const terms = roll && Array.isArray(roll.terms) ? roll.terms : [];
  const total = roll && Number.isFinite(roll.total) ? roll.total : 0;
  const mode = meta.mode === 'pool' || meta.mode === 'd20' ? meta.mode : activeMode(cfg);

  const diceTerms = terms.filter((t) => t && t.kind === 'dice' && Array.isArray(t.rolls));
  const dice = [];
  for (const term of diceTerms) {
    term.rolls.forEach((value, idx) => {
      if (!Number.isFinite(value)) return;
      dice.push({ value, dropped: term.dropped?.[idx] === true });
    });
  }
  const active = dice.filter((d) => !d.dropped);

  if (mode === 'pool') {
    const p = poolSettings(cfg);
    const successMin = Number.isInteger(meta.successMin) ? meta.successMin : p.successMin;
    const glitchOn = typeof meta.glitchOnOnes === 'boolean' ? meta.glitchOnOnes : p.glitchOnOnes;

    for (const die of dice) {
      die.hit = !die.dropped && die.value >= successMin;
    }
    const hits = dice.filter((d) => d.hit).length;
    const termSuccesses = diceTerms.some((t) => Number.isFinite(t.successes))
      ? diceTerms.reduce((sum, t) => sum + (Number.isFinite(t.successes) ? t.successes : 0), 0)
      : hits;
    const ones = active.filter((d) => d.value === 1).length;

    return {
      mode: 'pool',
      total,
      successes: termSuccesses,
      glitch: glitchOn && active.length > 0 && ones * 2 > active.length,
      dice,
    };
  }

  const d = d20Settings(cfg);
  const critMin = Number.isInteger(meta.critMin) ? meta.critMin : d.critMin;
  const fumbleMax = Number.isInteger(meta.fumbleMax) ? meta.fumbleMax : d.fumbleMax;
  // The natural result is the single kept die (adv/dis keep one of two).
  const natural = active.length === 1 ? active[0].value : undefined;

  return {
    mode: 'd20',
    total,
    natural,
    crit: natural !== undefined && natural >= critMin,
    fumble: natural !== undefined && natural <= fumbleMax,
    dice,
  };
}

/** Short English description of the active dice system (the editor and the card localize around it). */
export function describe(cfg) {
  if (activeMode(cfg) === 'pool') {
    const p = poolSettings(cfg);
    const glitch = p.glitchOnOnes ? ' Glitch when more than half of the dice show 1.' : '';
    return `Dice pool: up to ${p.maxDice} d${p.faces}. Each die showing ${p.successMin} or more is a success; the total is the number of successes.${glitch}`;
  }
  const d = d20Settings(cfg);
  return `Single check: 1d${d.sides} plus modifiers. Critical on ${d.critMin} or more, fumble on ${d.fumbleMax} or less. Advantage keeps the higher of two dice, disadvantage the lower.`;
}

/**
 * Rolls a check through the server. The ONLY function here that touches `window`.
 * Returns { ok: false } when there is no window or no dispatchRoll (plain Node, tests).
 *
 * @param {object} cfg
 * @param {{ actorId?: string, label?: string, attrValue?: number, skillValue?: number,
 *           bonus?: number, advantage?: 'none'|'adv'|'dis', mode?: string,
 *           extraMeta?: object }} opts
 *   extraMeta (for example actorName, target) is merged first; the check meta and label win.
 */
export async function rollCheck(cfg, opts = {}) {
  const loom = globalThis.window?.Loom;
  if (!loom || typeof loom.dispatchRoll !== 'function') {
    return { ok: false, error: 'no-dispatch' };
  }

  const built = buildCheck(cfg, opts);
  const extra = opts.extraMeta && typeof opts.extraMeta === 'object' ? opts.extraMeta : {};
  const label = typeof opts.label === 'string' ? opts.label.trim().slice(0, 80) : '';
  const mode = VISIBILITY_MODES.includes(opts.mode) ? opts.mode : 'public';
  const meta = { ...extra, ...built.meta, label };
  if (typeof opts.target === 'number' && Number.isFinite(opts.target)) {
    meta.target = Math.trunc(opts.target);
  }

  const payload = { formula: built.formula, mode, meta };
  if (opts.actorId) payload.actorId = opts.actorId;

  try {
    await loom.dispatchRoll(payload);
    return { ok: true, formula: built.formula };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}
