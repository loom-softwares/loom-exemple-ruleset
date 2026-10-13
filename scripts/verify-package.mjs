// Verifies a built Loom package zip against its manifest: the archive must contain every file
// the manifest references, and none of the repository-internal files.
//
// Usage: node scripts/verify-package.mjs <package.zip> <manifest-path>
//
// Ported from the srd5e ruleset's scripts/verify-package.mjs. The checks are pure functions
// (readZipEntries, findProblems, verifyArchive) so tests can exercise them without the CLI.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Repository-internal directories: none of their entries may ship in the package. */
const FORBIDDEN_DIRS =
  /^(?:\.git|\.github|\.agents|\.dev|\.planning|\.codex|\.vite|node_modules|tests|i18n|scripts)(?:\/|$)/;
/** Repository-internal files at the package root. */
const FORBIDDEN_FILES = new Set([
  '.gitignore',
  '.gitattributes',
  'package.json',
  'package-lock.json',
  'release-notes.md',
  'release-manifest.json',
]);
/** A package never contains another package. */
const FORBIDDEN_ARCHIVE = /\.zip$/i;

/** Reads the central directory of a zip archive and returns the normalized entry names. */
export function readZipEntries(bytes) {
  const minimumOffset = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP end-of-central-directory record is missing.');

  const count = bytes.readUInt16LE(eocd + 10);
  const centralDirectoryOffset = bytes.readUInt32LE(eocd + 16);
  if (count === 0xffff || centralDirectoryOffset === 0xffffffff) {
    throw new Error('ZIP64 packages are not supported by this verifier.');
  }

  const entries = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Invalid central-directory entry at index ${index}.`);
    }
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.push(name.replace(/^(?:\.\/)+/, '').replace(/\/$/, ''));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Compares the archive entries with the manifest.
 * Returns the internal entries that leaked into the package and the referenced files that are
 * missing. `compendiums` is optional: the demo ships none.
 */
export function findProblems(entries, manifest, manifestPath) {
  const set = entries instanceof Set ? entries : new Set(entries);
  const leaked = [...set].filter(
    (entry) => FORBIDDEN_DIRS.test(entry) || FORBIDDEN_FILES.has(entry) || FORBIDDEN_ARCHIVE.test(entry),
  );
  const required = [
    manifestPath,
    manifest.client,
    ...(manifest.styles ?? []),
    ...(manifest.languages ?? []).map((language) => language.path),
    ...(manifest.compendiums ?? []),
  ];
  // A missing `client` is reported as the literal "undefined" so the failure is visible.
  const missing = required.filter((entry) => typeof entry !== 'string' || !set.has(entry)).map(String);
  return { leaked, missing, required };
}

/** Pure check used by the CLI and the tests: archive bytes + parsed manifest in, problems out. */
export function verifyArchive(bytes, manifest, manifestPath) {
  const entries = new Set(readZipEntries(bytes));
  const problems = findProblems(entries, manifest, manifestPath);
  return { entries, ...problems };
}

async function main(argv) {
  if (!argv[2] || !argv[3]) {
    console.error('Usage: node scripts/verify-package.mjs <package.zip> <manifest-path>');
    process.exit(2);
  }
  const archivePath = path.resolve(argv[2]);
  const manifestPath = argv[3];
  const [archiveBytes, manifestText] = await Promise.all([
    readFile(archivePath),
    readFile(path.resolve(root, manifestPath), 'utf8'),
  ]);
  const { entries, leaked, missing, required } = verifyArchive(
    archiveBytes,
    JSON.parse(manifestText),
    manifestPath,
  );

  if (leaked.length || missing.length) {
    console.error(JSON.stringify({ leaked, missing }, null, 2));
    process.exit(1);
  }

  console.log(
    `Package verified: ${entries.size} entries; internal files excluded; all ${required.length - 1} manifest references included.`,
  );
}

// Run the CLI only when this file is the entry point (the tests import the helpers above).
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(process.argv);
}
