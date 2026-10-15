import { deepClone } from './helpers.mjs';

const int = (v, fallback = 0) => Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : fallback;
const own = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/** Pure cast planner. Returns one systemData patch so resource and slot costs share one PUT. */
export function planCast(item, actorData, cfg, castLevelKey = '') {
  const data = own(item?.data);
  const cast = own(data.casting);
  const method = cast.method === 'inherit' || !cast.method ? cfg?.magic?.defaultMethod : cast.method;
  const sys = own(actorData);
  const magic = deepClone(own(sys.magic));
  const fail = (reason) => ({ ok: false, reason, patch: null, method });
  const done = () => ({ ok: true, reason: null, method, patch: { magic } });
  if (!cfg?.magic?.enabled || !cfg.magic.methods.includes(method)) return fail('method-disabled');
  if (method === 'free' || method === 'check') return done();
  if (method === 'resource') {
    const resourceKey = cast.resourceKey || data.cost?.res;
    const amount = Math.max(0, int(Object.prototype.hasOwnProperty.call(cast, 'cost') ? cast.cost : data.cost?.amount));
    if (!resourceKey && amount === 0) return done();
    const definition = cfg.resources.find((row) => row.key === resourceKey);
    if (!definition) return fail('resource-missing');
    const resources = deepClone(own(sys.res));
    const stored = own(resources[resourceKey]);
    const value = Math.max(0, int(stored.value, definition.max));
    if (value < amount) return fail('insufficient-resource');
    resources[resourceKey] = { ...stored, value: value - amount };
    return { ...done(), patch: { magic, res: resources } };
  }
  const minimumLevel = cfg.magic.levels.find((row) => row.key === cast.levelKey);
  const selectedLevelKey = method === 'spontaneous' && castLevelKey ? castLevelKey : cast.levelKey;
  const level = cfg.magic.levels.find((row) => row.key === selectedLevelKey);
  if ((method === 'spontaneous' || method === 'prepared') && !level) return fail('level-missing');
  if (method === 'spontaneous' && minimumLevel && level.rank < minimumLevel.rank) return fail('level-too-low');
  if (method === 'spontaneous') {
    const slots = deepClone(own(magic.slots));
    const slot = own(slots[level.key]);
    const value = Math.max(0, int(slot.value));
    if (value <= 0 && !level.free) return fail('no-slots');
    if (!level.free) slots[level.key] = { ...slot, value: value - 1, max: Math.max(0, int(slot.max, level.capacityDefault)) };
    magic.slots = slots;
    return done();
  }
  if (method === 'prepared') {
    const prepared = deepClone(own(magic.prepared));
    const entry = own(prepared[item.id]);
    if (!entry || entry.levelKey !== level.key || int(entry.value) <= 0) return fail('not-prepared');
    prepared[item.id] = { ...entry, value: int(entry.value) - 1 };
    magic.prepared = prepared;
    return done();
  }
  if (method === 'uses') {
    const uses = deepClone(own(magic.uses));
    const entry = own(uses[item.id]);
    const max = Math.max(0, int(cast.usesMax, int(entry.max)));
    const value = Math.max(0, int(entry.value, max));
    if (value <= 0) return fail('no-uses');
    uses[item.id] = { value: value - 1, max };
    magic.uses = uses;
    return done();
  }
  return fail('method-disabled');
}

/** Spend capacity to prepare one owned spell; capacity and preparation change in one patch. */
export function planPrepare(item, actorData, cfg, count = 1, levelKey = '') {
  const level = cfg?.magic?.levels?.find((row) => row.key === levelKey);
  const amount = Math.max(0, int(count));
  if (!level || !item?.id || amount < 1) return { ok: false, reason: 'level-missing', patch: null };
  const magic = deepClone(own(actorData?.magic));
  const slots = own(magic.slots);
  const slot = own(slots[level.key]);
  const prepared = own(magic.prepared);
  const already = Object.values(prepared).filter((entry) => entry?.levelKey === level.key).reduce((sum, entry) => sum + Math.max(0, int(entry.max)), 0);
  const available = Math.max(0, int(slot.max, level.capacityDefault));
  const existing = own(prepared[item.id]);
  const delta = amount - Math.max(0, int(existing.max));
  if (already + delta > available) return { ok: false, reason: 'capacity', patch: null };
  prepared[item.id] = { levelKey: level.key, max: amount, value: Math.min(amount, Math.max(0, int(existing.value, amount))) };
  magic.prepared = prepared;
  return { ok: true, reason: null, patch: { magic } };
}

export function planRecovery(actorData, cfg, kind = 'longRest') {
  if (!['manual', 'shortRest', 'longRest'].includes(kind)) return { ok: false, patch: null };
  const magic = deepClone(own(actorData?.magic));
  if ((kind === 'manual' && cfg.magic.recovery !== 'manual') || (kind === 'shortRest' && cfg.magic.recovery !== 'shortRest') || (kind === 'longRest' && cfg.magic.recovery !== 'longRest')) return { ok: false, patch: null };
  for (const level of cfg.magic.levels) {
    const slot = own(magic.slots?.[level.key]);
    magic.slots ??= {};
    magic.slots[level.key] = { ...slot, value: Math.max(0, int(slot.max, level.capacityDefault)), max: Math.max(0, int(slot.max, level.capacityDefault)) };
  }
  for (const [id, entry] of Object.entries(own(magic.prepared))) magic.prepared[id] = { ...entry, value: Math.max(0, int(entry.max)) };
  for (const [id, entry] of Object.entries(own(magic.uses))) magic.uses[id] = { ...entry, value: Math.max(0, int(entry.max)) };
  return { ok: true, patch: { magic } };
}
