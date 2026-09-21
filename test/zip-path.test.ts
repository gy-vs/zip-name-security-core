import { describe, expect, it } from 'vitest';
import {
  findZipNameCollisions,
  splitZipEntryName,
  validateZipEntryName,
  validateZipSymlinkTarget,
  zipEntryKind,
  zipEntryKindOf,
  zipNameCollisionKey,
} from '../src/index.js';

const FULLWIDTH_SOLIDUS = '／';
const DIVISION_SLASH = '∕';
const FULLWIDTH_A = 'Ａ';
const FULLWIDTH_B = 'Ｂ';
const NFC_CAFE = 'café.txt';
const NFD_CAFE = 'café.txt';

const ok = (raw: string) => {
  const result = validateZipEntryName(raw);
  if (!result.ok) throw new Error(`expected ok for ${JSON.stringify(raw)}, got ${result.reason}`);
  return result.name;
};
const rejected = (raw: string) => {
  const result = validateZipEntryName(raw);
  if (result.ok) throw new Error(`expected rejection for ${JSON.stringify(raw)}`);
  return result.reason;
};

describe('splitZipEntryName', () => {
  it('splits on forward slashes', () => {
    expect(splitZipEntryName('a/b/c')).toEqual(['a', 'b', 'c']);
  });
  it('splits on backslashes', () => {
    expect(splitZipEntryName('a\\b\\c')).toEqual(['a', 'b', 'c']);
  });
  it('splits on mixed separators and keeps empty components', () => {
    expect(splitZipEntryName('a//b\\')).toEqual(['a', '', 'b', '']);
  });
  it('does not URL-decode', () => {
    expect(splitZipEntryName('%2e%2e%2f')).toEqual(['%2e%2e%2f']);
  });
  it('does not treat Unicode lookalikes as separators', () => {
    const raw = `a${FULLWIDTH_SOLIDUS}b${DIVISION_SLASH}c`;
    expect(splitZipEntryName(raw)).toEqual([raw]);
  });
});

describe('validateZipEntryName', () => {
  it('accepts a plain relative name', () => {
    const name = ok('dir/sub/file.txt');
    expect(name.components).toEqual(['dir', 'sub', 'file.txt']);
    expect(name.safeName).toBe('dir/sub/file.txt');
    expect(name.rawName).toBe('dir/sub/file.txt');
    expect(name.isDirectory).toBe(false);
  });
  it('rewrites backslash separators in the safe name', () => {
    expect(ok('dir\\sub\\file.txt').safeName).toBe('dir/sub/file.txt');
    expect(ok('a/b\\c').components).toEqual(['a', 'b', 'c']);
  });
  it('marks directory entries and drops the trailing separator', () => {
    const name = ok('dir/sub/');
    expect(name.isDirectory).toBe(true);
    expect(name.safeName).toBe('dir/sub');
  });
  it('collapses empty components', () => {
    expect(ok('a//b///c').safeName).toBe('a/b/c');
  });
  it('collapses dot components', () => {
    expect(ok('./a/./b').safeName).toBe('a/b');
  });
  it('drops components made only of dots and spaces', () => {
    expect(ok('a/.../b').safeName).toBe('a/b');
    expect(ok('a/.. /b').safeName).toBe('a/b'); // Windows strips the space: '..'
  });
  it.each(['../x', 'a/../x', '..', 'a/b/..', '..\\x', 'a\\..\\b'])(
    'rejects parent component %j',
    (raw) => expect(rejected(raw)).toBe('parent'),
  );
  it.each(['/etc/passwd', '\\windows\\system32'])(
    'rejects absolute name %j',
    (raw) => expect(rejected(raw)).toBe('absolute'),
  );
  it.each(['//server/share/x', '\\\\server\\share', '//?/c:/boot.ini', '//./pipe/x'])(
    'rejects UNC name %j',
    (raw) => expect(rejected(raw)).toBe('unc'),
  );
  it.each(['c:/x', 'C:\\x', 'C:relative', 'c:'])(
    'rejects drive name %j',
    (raw) => expect(rejected(raw)).toBe('drive'),
  );
  it.each(['a\u0000b', '\u0000'])('rejects NUL in %j', (raw) =>
    expect(rejected(raw)).toBe('nul'),
  );
  it.each(['', '.', './.', '...'])('rejects name with no usable components %j', (raw) =>
    expect(rejected(raw)).toBe('empty'),
  );
  it('treats percent-encoded traversal as an inert literal name', () => {
    const name = ok('%2e%2e%2f');
    expect(name.components).toEqual(['%2e%2e%2f']);
    expect(name.safeName).toBe('%2e%2e%2f');
  });
  it('treats Unicode lookalike separators as ordinary characters', () => {
    const raw = `..${FULLWIDTH_SOLIDUS}..${FULLWIDTH_SOLIDUS}x`;
    const name = ok(raw);
    expect(name.components).toEqual([raw]);
    expect(name.safeName).toBe(raw);
  });
  it('keeps the raw name separate from the safe name', () => {
    const name = ok('a\\b//c');
    expect(name.rawName).toBe('a\\b//c');
    expect(name.safeName).toBe('a/b/c');
  });
  it('only ever returns safe relative components', () => {
    const accepted = [
      'dir/file.txt',
      'a\\b',
      '%2e%2e%2f',
      `..${FULLWIDTH_SOLIDUS}x`,
      'a//b/./c',
      `${FULLWIDTH_A}/${FULLWIDTH_B}.txt`,
    ];
    for (const raw of accepted) {
      const name = ok(raw);
      expect(name.safeName).not.toMatch(/^[\\/]/);
      expect(name.safeName).not.toContain('\u0000');
      expect(name.safeName).not.toContain('\\');
      for (const component of name.components) {
        expect(component).not.toBe('..');
        expect(component).not.toBe('');
        expect(component).not.toMatch(/[\\/]/);
      }
    }
  });
});

describe('validateZipSymlinkTarget', () => {
  it('accepts a relative target', () => {
    const result = validateZipSymlinkTarget('inner/target.txt');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.name.safeName).toBe('inner/target.txt');
  });
  it.each([
    ['/etc/passwd', 'absolute'],
    ['../../etc/shadow', 'parent'],
    ['c:/windows', 'drive'],
    ['//server/share', 'unc'],
  ])('rejects escaping target %j', (target, reason) => {
    const result = validateZipSymlinkTarget(target);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  });
});

describe('zipEntryKind', () => {
  const unix = (mode: number) => mode * 2 ** 16;
  it('detects symlinks from Unix mode bits', () => {
    expect(zipEntryKind(unix(0o120777), false)).toBe('symlink');
  });
  it('detects regular files and directories', () => {
    expect(zipEntryKind(unix(0o100644), false)).toBe('file');
    expect(zipEntryKind(unix(0o040755), true)).toBe('directory');
  });
  it('falls back to the name when no Unix mode is stored', () => {
    expect(zipEntryKind(0, true)).toBe('directory');
    expect(zipEntryKind(0, false)).toBe('file');
    expect(zipEntryKind(undefined, false)).toBe('file');
  });
  it('reports other Unix types as other', () => {
    expect(zipEntryKind(unix(0o010000), false)).toBe('other'); // fifo
  });
  it('classifies a whole entry', () => {
    expect(zipEntryKindOf({ name: 'link', externalAttributes: unix(0o120777) })).toBe('symlink');
    expect(zipEntryKindOf({ name: 'dir/' })).toBe('directory');
  });
});

describe('zipNameCollisionKey', () => {
  it('folds case', () => {
    expect(zipNameCollisionKey('Dir/File.TXT')).toBe('dir/file.txt');
  });
  it('folds Unicode normalization differences', () => {
    expect(zipNameCollisionKey(NFC_CAFE)).toBe(zipNameCollisionKey(NFD_CAFE));
  });
  it('folds compatibility characters', () => {
    expect(zipNameCollisionKey(`${FULLWIDTH_A}.txt`)).toBe('a.txt');
  });
  it('strips trailing dots and spaces per component', () => {
    expect(zipNameCollisionKey('a./b ')).toBe('a/b');
  });
});

describe('findZipNameCollisions', () => {
  it('flags case collisions with the original safe names', () => {
    const collisions = findZipNameCollisions(['Dir/File.txt', 'dir/file.txt', 'other.txt']);
    expect(collisions).toEqual([
      { key: 'dir/file.txt', safeNames: ['Dir/File.txt', 'dir/file.txt'] },
    ]);
  });
  it('flags Unicode normalization collisions', () => {
    const collisions = findZipNameCollisions([NFC_CAFE, NFD_CAFE]);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.safeNames).toEqual([NFC_CAFE, NFD_CAFE]);
  });
  it('flags lookalike separators that normalize to a real separator', () => {
    const collisions = findZipNameCollisions([`a${FULLWIDTH_SOLIDUS}b`, 'a/b']);
    expect(collisions).toHaveLength(1);
  });
  it('flags Windows trailing-dot collisions', () => {
    const collisions = findZipNameCollisions(['a.', 'a']);
    expect(collisions).toHaveLength(1);
  });
  it('returns nothing for distinct names', () => {
    expect(findZipNameCollisions(['a/b.txt', 'a/c.txt', 'd.txt'])).toEqual([]);
  });
});
