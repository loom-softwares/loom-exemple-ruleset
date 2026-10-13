// Tests for scripts/verify-package.mjs. The archives are built here with a small stored-only
// zip writer, so the tests do not depend on the `zip` binary (which CI has, Windows does not).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyArchive, readZipEntries } from '../scripts/verify-package.mjs';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Builds a zip archive with every entry stored (no compression). `files` maps name -> text. */
function buildStoredZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

const MANIFEST = {
  name: 'loom-demo-system',
  client: 'main.mjs',
  styles: ['styles/system.css', 'styles/sandbox-sheet.css'],
  languages: [{ lang: 'en', path: 'lang/en.json' }],
};

/** A package with everything the manifest references and nothing internal. */
function goodFiles() {
  return {
    'ruleset.json': '{}',
    'main.mjs': 'export {};',
    'styles/system.css': 'body {}',
    'styles/sandbox-sheet.css': '.sheet {}',
    'lang/en.json': '{}',
    'README.md': '# demo',
    'LICENSE': 'MIT',
    'CHANGELOG.md': '# log',
  };
}

function verify(files, manifest = MANIFEST) {
  return verifyArchive(buildStoredZip(files), manifest, 'ruleset.json');
}

describe('verify-package', () => {
  test('a package with every referenced file and no internal files passes', () => {
    const result = verify(goodFiles());
    assert.deepEqual(result.leaked, []);
    assert.deepEqual(result.missing, []);
    assert.equal(result.entries.size, Object.keys(goodFiles()).length);
  });

  test('a missing client entry point fails', () => {
    const files = goodFiles();
    delete files['main.mjs'];
    const result = verify(files);
    assert.deepEqual(result.missing, ['main.mjs']);
  });

  test('a missing style fails', () => {
    const files = goodFiles();
    delete files['styles/sandbox-sheet.css'];
    const result = verify(files);
    assert.deepEqual(result.missing, ['styles/sandbox-sheet.css']);
  });

  test('a missing language file fails', () => {
    const files = goodFiles();
    delete files['lang/en.json'];
    assert.deepEqual(verify(files).missing, ['lang/en.json']);
  });

  test('an internal file inside the package fails', () => {
    const files = {
      ...goodFiles(),
      'tests/dice.test.mjs': '',
      'scripts/merge-lang.mjs': '',
      'i18n/x.en.json': '{}',
      'package.json': '{}',
      '.github/workflows/release.yml': '',
    };
    const { leaked } = verify(files);
    assert.deepEqual(leaked.sort(), [
      '.github/workflows/release.yml',
      'i18n/x.en.json',
      'package.json',
      'scripts/merge-lang.mjs',
      'tests/dice.test.mjs',
    ]);
  });

  test('a nested zip inside the package fails', () => {
    const result = verify({ ...goodFiles(), 'old.zip': 'PK' });
    assert.deepEqual(result.leaked, ['old.zip']);
  });

  test('entries written with a leading "./" are normalized before the checks', () => {
    const files = Object.fromEntries(Object.entries(goodFiles()).map(([name, text]) => [`./${name}`, text]));
    const result = verify(files);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.leaked, []);
  });

  test('the manifest may omit compendiums (the demo ships none)', () => {
    assert.equal(MANIFEST.compendiums, undefined);
    assert.deepEqual(verify(goodFiles()).missing, []);
  });

  test('a package that lists compendiums must contain them', () => {
    const manifest = { ...MANIFEST, compendiums: ['packs/spells.sqlite'] };
    assert.deepEqual(verify(goodFiles(), manifest).missing, ['packs/spells.sqlite']);
  });

  test('a file on disk round-trips through readZipEntries', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-package-'));
    try {
      const file = path.join(dir, 'demo.zip');
      fs.writeFileSync(file, buildStoredZip(goodFiles()));
      const entries = readZipEntries(fs.readFileSync(file));
      assert.deepEqual([...entries].sort(), Object.keys(goodFiles()).sort());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
