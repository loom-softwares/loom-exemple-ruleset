import { isPlainObject } from './helpers.mjs';

/** Source selectors shared by saves, attacks and casting checks. */
export function sanitizeSources(raw, cfg = {}) {
  if (!Array.isArray(raw)) return [];
  const attrs = new Map((cfg.attributes ?? []).map((a) => [a.key, a]));
  const skills = new Map((cfg.skills ?? []).map((s) => [s.key, s]));
  const seen = new Set();
  return raw.slice(0, 12).flatMap((source) => {
    if (!source || !['attr', 'skill'].includes(source.kind) || typeof source.key !== 'string') return [];
    const ref = source.kind === 'attr' ? attrs.get(source.key) : skills.get(source.key);
    if (!ref) {
      const value = source.kind === 'skill' ? 'rank' : (['score', 'modifier', 'configured'].includes(source.value) ? source.value : 'configured');
      const id = `${source.kind}:${source.key}:${value}`;
      if (seen.has(id)) return [];
      seen.add(id);
      return [{ kind: source.kind, key: source.key, value, removed: true }];
    }
    const value = source.kind === 'skill' ? 'rank' : (['score', 'modifier', 'configured'].includes(source.value) ? source.value : 'configured');
    const id = `${source.kind}:${source.key}:${value}`;
    if (seen.has(id)) return [];
    seen.add(id);
    return [{ kind: source.kind, key: source.key, value }];
  });
}

export function sumSources(sources, actorData = {}, cfg = {}, modifierFor = (value) => value) {
  const data = actorData?.systemData ?? actorData ?? {};
  const attrs = isPlainObject(data.attrs) ? data.attrs : isPlainObject(data.attributes) ? data.attributes : {};
  const skills = isPlainObject(data.skills) ? data.skills : {};
  let total = 0;
  for (const source of sanitizeSources(sources, cfg)) {
    if (source.removed) continue;
    if (source.kind === 'skill') {
      total += Number(skills[source.key] ?? 0) || 0;
    } else {
      const def = (cfg.attributes ?? []).find((a) => a.key === source.key || a.key?.toLowerCase() === source.key?.toLowerCase());
      let raw = attrs[source.key];
      if (raw === undefined && def) raw = attrs[def.key];
      const score = raw !== undefined && raw !== null && raw !== '' ? (Number(raw) || 0) : (def?.default ?? 0);
      total += source.value === 'score'
        ? score
        : source.value === 'modifier'
          ? (typeof modifierFor === 'function' && modifierFor.length >= 2 ? modifierFor(source.key, score) : Math.floor((score - 10) / 2))
          : def?.useD20Modifier ? modifierFor(source.key, score) : score;
    }
  }
  return total;
}

