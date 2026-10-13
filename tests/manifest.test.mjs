// Structural checks on the package: manifest, languages, code conventions and wording.
// No engine is needed: everything is read from disk and scanned as text.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', '.dev', '.agents', 'node_modules']);
const BINARY = /\.(png|jpe?g|webp|gif|ico|zip|pdf|woff2?|ttf|otf|mp3|ogg|wav|mp4|webm)$/i;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

/** Source modules shipped with the package (every .mjs outside tests). */
function sourceModules() {
  return walk(ROOT).filter((f) => f.endsWith('.mjs') && !rel(f).startsWith('tests/'));
}

/** Text files that ship with the package, for the wording check. */
function textFiles() {
  return walk(ROOT).filter((f) => {
    const r = rel(f);
    return !BINARY.test(r) && !r.startsWith('tests/') && r !== 'CHANGELOG.md';
  });
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function readJsonFile(file) {
  return JSON.parse(readText(file).replace(/^﻿/, ''));
}

const manifestPath = path.join(ROOT, 'ruleset.json');
const manifest = readJsonFile(manifestPath);

describe('ruleset.json', () => {
  test('is UTF-8 without a byte order mark and parses', () => {
    const bytes = fs.readFileSync(manifestPath);
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'ruleset.json must not start with a BOM');
    assert.equal(typeof manifest, 'object');
  });

  test('every styles path exists', () => {
    assert.ok(Array.isArray(manifest.styles) && manifest.styles.length > 0);
    for (const style of manifest.styles) {
      assert.ok(fs.existsSync(path.join(ROOT, style)), `missing style file: ${style}`);
    }
  });

  test('every sandbox stylesheet is declared', () => {
    const declared = new Set(manifest.styles);
    for (const name of fs.readdirSync(path.join(ROOT, 'styles'))) {
      if (/^sandbox-.*\.css$/.test(name)) {
        assert.ok(declared.has(`styles/${name}`), `styles/${name} is not listed in ruleset.json`);
      }
    }
  });

  test('every languages path exists', () => {
    assert.ok(Array.isArray(manifest.languages) && manifest.languages.length > 0);
    for (const lang of manifest.languages) {
      assert.ok(fs.existsSync(path.join(ROOT, lang.path)), `missing language file: ${lang.path}`);
    }
  });

  test('actor and item types are the expected lists', () => {
    assert.deepEqual(manifest.actorTypes, ['hero', 'villain', 'beast']);
    assert.deepEqual(manifest.itemTypes, ['gear', 'ability', 'spell', 'weapon', 'armor', 'potion', 'scroll']);
  });

  test('version is semver and the entry point is main.mjs', () => {
    assert.match(manifest.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    assert.equal(manifest.client, 'main.mjs');
    assert.ok(fs.existsSync(path.join(ROOT, 'main.mjs')));
  });

  test('no dead settings remain in the manifest', () => {
    assert.equal(manifest.settings, undefined, 'settings are registered from code (lib/config.mjs)');
  });
});

describe('language files', () => {
  const langFiles = ['lang/en.json', 'lang/pt-BR.json'];

  test('are UTF-8 without a BOM', () => {
    for (const file of langFiles) {
      const bytes = fs.readFileSync(path.join(ROOT, file));
      assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${file} must not start with a BOM`);
    }
  });

  test('have identical key sets', () => {
    const en = Object.keys(readJsonFile(path.join(ROOT, 'lang/en.json'))).sort();
    const pt = Object.keys(readJsonFile(path.join(ROOT, 'lang/pt-BR.json'))).sort();
    const onlyEn = en.filter((k) => !pt.includes(k));
    const onlyPt = pt.filter((k) => !en.includes(k));
    assert.deepEqual({ onlyEn, onlyPt }, { onlyEn: [], onlyPt: [] });
  });

  test('have no empty text values', () => {
    for (const file of langFiles) {
      const table = readJsonFile(path.join(ROOT, file));
      for (const [key, value] of Object.entries(table)) {
        if (typeof value === 'string') assert.ok(value.trim() !== '', `${file}: empty value for ${key}`);
      }
    }
  });

  test('match the merged output of the i18n fragments (run npm run lang)', () => {
    const fragments = fs.readdirSync(path.join(ROOT, 'i18n'));
    const en = readJsonFile(path.join(ROOT, 'lang/en.json'));
    const pt = readJsonFile(path.join(ROOT, 'lang/pt-BR.json'));
    for (const name of fragments) {
      const table = name.endsWith('.pt-BR.json') ? pt : name.endsWith('.en.json') ? en : null;
      if (!table) continue;
      const data = readJsonFile(path.join(ROOT, 'i18n', name));
      for (const [key, value] of Object.entries(data)) {
        assert.equal(table[key], value, `${name}: "${key}" is not in the merged language file`);
      }
    }
  });
});

describe('code conventions', () => {
  const modules = sourceModules();

  test('every sandbox.* key used in code exists in lang/en.json', () => {
    const en = readJsonFile(path.join(ROOT, 'lang/en.json'));
    const used = new Map();
    const literal = /(['"`])(sandbox\.[a-zA-Z0-9_.-]+)\1/g;
    const call = /\b(?:t|localize)\(\s*(['"`])([^'"`]+)\1/g;
    for (const file of modules) {
      const source = readText(file);
      for (const match of source.matchAll(literal)) used.set(match[2], rel(file));
      for (const match of source.matchAll(call)) {
        if (match[2].startsWith('sandbox.')) used.set(match[2], rel(file));
      }
    }
    assert.ok(used.size > 0, 'expected sandbox keys in the code');
    const missing = [...used].filter(([key]) => !(key in en)).map(([key, file]) => `${key} (${file})`);
    assert.deepEqual(missing, []);
  });

  test('no Hooks named import from the SDK (the export is LoomHooks)', () => {
    const importFromSdk = /import\s*\{([^}]*)\}\s*from\s*['"]\/_loom\/sdk\/index\.js['"]/g;
    const offenders = [];
    for (const file of modules) {
      for (const match of readText(file).matchAll(importFromSdk)) {
        const names = match[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean);
        if (names.includes('Hooks')) offenders.push(rel(file));
      }
    }
    assert.deepEqual(offenders, []);
  });

  test('no window.Loom.cast, .windows or .combat (they do not exist in the engine)', () => {
    const dead = /\bLoom\??\.(cast|windows|combat)\b/;
    const offenders = modules.filter((file) => dead.test(readText(file))).map(rel);
    assert.deepEqual(offenders, []);
  });

  test('no dead system hooks are defined', () => {
    const dead = /\b(validateData|rollInitiative|getItemDefaultData|getItemSheetSchema)\s*[(:]/;
    const offenders = modules.filter((file) => rel(file) === 'main.mjs' && dead.test(readText(file))).map(rel);
    assert.deepEqual(offenders, []);
  });

  test('main.mjs stays small (under 200 lines)', () => {
    const lines = readText(path.join(ROOT, 'main.mjs')).split('\n').length;
    assert.ok(lines < 200, `main.mjs has ${lines} lines`);
  });
});

describe('wording', () => {
  test('no other product or brand names in shipped files', () => {
    const forbidden = /foundry|dnd5e|wod5e|pathfinder|roll20/i;
    const offenders = [];
    for (const file of textFiles()) {
      readText(file)
        .split('\n')
        .forEach((line, index) => {
          if (forbidden.test(line)) offenders.push(`${rel(file)}:${index + 1}`);
        });
    }
    assert.deepEqual(offenders, []);
  });
});
