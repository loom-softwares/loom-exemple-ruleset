// Merges the per-module i18n fragments into the two language files the engine loads.
//
//   i18n/*.en.json     -> lang/en.json
//   i18n/*.pt-BR.json  -> lang/pt-BR.json
//
// Rules:
// - Flat keys. Each fragment is { "sandbox.<module>.<name>": "text" }.
// - Idempotent: running it twice writes nothing the second time.
// - Never deletes a key that is already in the language file (legacy keys stay).
// - Fails loudly, writing nothing, when a key gets two different texts: between two fragments,
//   or between a fragment and the value already in the language file. Reconcile by hand.
// - Keys are written sorted, UTF-8 without BOM, two-space JSON and a final newline.
//
// Usage: npm run lang   (or: node scripts/merge-lang.mjs)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Each target: the fragment suffix it collects and the language file it writes. */
export const TARGETS = Object.freeze([
  { suffix: '.en.json', lang: 'lang/en.json' },
  { suffix: '.pt-BR.json', lang: 'lang/pt-BR.json' },
]);

/**
 * Pure merge. `existing` is the parsed language file, `fragments` is an array of
 * `{ source, data }` in the order they should be read (source is a label for messages).
 * Returns `{ table, added }` or throws one Error that lists every conflict.
 */
export function mergeTables(existing, fragments) {
  const table = { ...existing };
  const origin = new Map(Object.keys(existing).map((key) => [key, 'the language file']));
  const problems = [];
  const added = [];

  for (const { source, data } of fragments) {
    for (const [key, value] of Object.entries(data)) {
      if (typeof value !== 'string' || value.trim() === '') {
        problems.push(`"${key}" in ${source}: the value must be a non-empty string`);
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(table, key)) {
        table[key] = value;
        origin.set(key, source);
        added.push(key);
        continue;
      }
      if (table[key] !== value) {
        problems.push(
          `"${key}" has different text in ${origin.get(key)} and ${source}: ` +
            `${JSON.stringify(table[key])} vs ${JSON.stringify(value)}`,
        );
      }
    }
  }

  if (problems.length) {
    throw new Error(`merge-lang: ${problems.length} conflict(s), nothing written:\n  - ${problems.join('\n  - ')}`);
  }
  return { table: sortKeys(table), added };
}

function sortKeys(table) {
  const sorted = {};
  for (const key of Object.keys(table).sort()) sorted[key] = table[key];
  return sorted;
}

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  return JSON.parse(raw);
}

/**
 * Merges every fragment into its language file under `root`. Returns a per-file summary.
 * Writes a language file only when its content changes.
 */
export function mergeLang(root = ROOT) {
  const fragmentDir = path.join(root, 'i18n');
  const names = fs.existsSync(fragmentDir) ? fs.readdirSync(fragmentDir).sort() : [];
  const summary = [];

  for (const target of TARGETS) {
    const fragments = names
      .filter((name) => name.endsWith(target.suffix))
      .map((name) => ({ source: `i18n/${name}`, data: readJson(path.join(fragmentDir, name)) }));

    const langPath = path.join(root, target.lang);
    const existing = fs.existsSync(langPath) ? readJson(langPath) : {};
    const { table, added } = mergeTables(existing, fragments);

    const text = JSON.stringify(table, null, 2) + '\n';
    const before = fs.existsSync(langPath) ? fs.readFileSync(langPath, 'utf8') : null;
    const changed = before !== text;
    if (changed) fs.writeFileSync(langPath, text, { encoding: 'utf8' });
    summary.push({ file: target.lang, fragments: fragments.length, added: added.length, changed });
  }
  return summary;
}

// Runs only when executed directly (npm run lang), not when imported by tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    for (const row of mergeLang()) {
      console.log(`${row.file}: ${row.fragments} fragment(s), ${row.added} new key(s), ${row.changed ? 'written' : 'unchanged'}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
