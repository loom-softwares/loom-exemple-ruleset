import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, slug, clamp, uid, deepClone, isPlainObject } from '../lib/helpers.mjs';

test('esc escapes every HTML-significant character', () => {
  assert.equal(esc(`<img src="x" onerror='y'>&`), '&lt;img src=&quot;x&quot; onerror=&#39;y&#39;&gt;&amp;');
});

test('esc turns null, undefined and objects into safe text without throwing', () => {
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(42), '42');
  const hostile = { toString() { throw new Error('boom'); } };
  assert.equal(esc(hostile), '');
  assert.equal(esc(Object.create(null)), '');
});

test('slug produces config-key-safe identifiers', () => {
  assert.equal(slug('Hello World!'), 'hello_world');
  assert.equal(slug('123abc'), 'abc');
  assert.equal(slug('Ação Força'), 'acao_forca');
  assert.equal(slug('__proto__'), 'proto');
  assert.equal(slug(''), '');
  assert.equal(slug('!!!'), '');
  assert.equal(slug(null), '');
});

test('slug never exceeds 24 characters and never ends with an underscore', () => {
  const out = slug('a'.repeat(100) + ' b');
  assert.ok(out.length <= 24);
  assert.match(out, /^[a-z][a-z0-9_]*$/);
  assert.ok(!out.endsWith('_'));
  assert.match(slug('x'.repeat(23) + ' y'), /^[a-z][a-z0-9_]{0,23}$/);
});

test('clamp keeps numbers inside the bounds', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-3, 0, 10), 0);
  assert.equal(clamp(99, 0, 10), 10);
  assert.equal(clamp('7', 0, 5), 5);
  assert.equal(clamp(Number.NaN, 2, 9), 2);
  assert.equal(clamp(Number.POSITIVE_INFINITY, 0, 3), 3);
});

test('clamp swaps reversed bounds instead of returning an out-of-range value', () => {
  assert.equal(clamp(5, 10, 0), 5);
  assert.equal(clamp(-1, 10, 0), 0);
});

test('uid returns distinct, prefixed ids', () => {
  const ids = new Set();
  for (let i = 0; i < 1000; i++) ids.add(uid('card-'));
  assert.equal(ids.size, 1000);
  assert.ok([...ids].every((id) => id.startsWith('card-')));
  assert.ok(uid().length > 8);
});

test('isPlainObject accepts literals and null-prototype objects only', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject('x'), false);
  assert.equal(isPlainObject(new Date()), false);
  class Foo {}
  assert.equal(isPlainObject(new Foo()), false);
});

test('deepClone copies data and does not share references', () => {
  const src = { a: [1, { b: 2 }], c: { d: 'e' } };
  const copy = deepClone(src);
  assert.deepEqual(copy, src);
  copy.a[1].b = 99;
  assert.equal(src.a[1].b, 2);
});

test('deepClone keeps a __proto__ key as data and does not touch prototypes', () => {
  const src = JSON.parse('{"__proto__":{"polluted":true},"ok":1}');
  const copy = deepClone(src);
  assert.equal(Object.getPrototypeOf(copy), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.equal(copy.ok, 1);
  assert.deepEqual(Object.keys(copy).sort(), ['__proto__', 'ok']);
});

test('deepClone survives cycles and very deep nesting', () => {
  const cyclic = { name: 'loop' };
  cyclic.self = cyclic;
  const copy = deepClone(cyclic);
  assert.equal(copy.self, copy);

  let deep = { leaf: true };
  for (let i = 0; i < 200; i++) deep = { next: deep };
  assert.doesNotThrow(() => deepClone(deep));
});
