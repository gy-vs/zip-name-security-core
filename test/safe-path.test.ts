import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CollisionDetector,
  isSymlinkMode,
  unixModeFromExternalAttributes,
  validateEntry,
  validateEntryName,
  type SafeEntryPath,
} from '../src/index.js';

function ok(rawName: string, options?: Parameters<typeof validateEntryName>[1]): SafeEntryPath {
  const result = validateEntryName(rawName, options);
  if (!result.ok) throw new Error(`expected ok, got ${result.error} for ${JSON.stringify(rawName)}`);
  return result.value;
}

function rejected(rawName: string, options?: Parameters<typeof validateEntryName>[1]) {
  const result = validateEntryName(rawName, options);
  if (result.ok) throw new Error(`expected rejection, got ok for ${JSON.stringify(rawName)}`);
  return result.error;
}

describe('component parsing (ZIP semantics)', () => {
  it('splits on forward slashes', () => {
    const path = ok('dir/sub/file.txt');
    expect(path.components).toEqual(['dir', 'sub', 'file.txt']);
    expect(path.portablePath).toBe('dir/sub/file.txt');
    expect(path.isDirectory).toBe(false);
  });

  it('treats backslashes as separators too', () => {
    const path = ok('dir\\sub\\file.txt');
    expect(path.components).toEqual(['dir', 'sub', 'file.txt']);
    expect(path.portablePath).toBe('dir/sub/file.txt');
  });

  it('handles mixed separators', () => {
    expect(ok('dir/sub\\file.txt').components).toEqual(['dir', 'sub', 'file.txt']);
  });

  it('collapses empty components from duplicate separators', () => {
    expect(ok('a//b\\\\c').components).toEqual(['a', 'b', 'c']);
    expect(ok('a//b\\\\c').portablePath).toBe('a/b/c');
  });

  it('drops dot components', () => {
    expect(ok('a/./b/./c').components).toEqual(['a', 'b', 'c']);
    expect(ok('./a').components).toEqual(['a']);
    expect(ok('a/.').components).toEqual(['a']);
  });

  it('marks directory entries (trailing slash) but keeps components clean', () => {
    const path = ok('a/b/');
    expect(path.isDirectory).toBe(true);
    expect(path.components).toEqual(['a', 'b']);
    expect(path.portablePath).toBe('a/b');
  });

  it('keeps the raw name untouched, separate from the safe output', () => {
    const raw = 'a//./b.txt';
    const path = ok(raw);
    expect(path.rawName).toBe(raw);
    expect(path.portablePath).toBe('a/b.txt');
  });

  it('rejects names that normalize to nothing', () => {
    expect(rejected('')).toBe('empty-name');
    expect(rejected('.')).toBe('empty-name');
    expect(rejected('./')).toBe('empty-name');
    expect(rejected('.\\.')).toBe('empty-name');
  });
});

describe('absolute paths, UNC and drives', () => {
  it('rejects rooted paths', () => {
    expect(rejected('/etc/passwd')).toBe('absolute-path');
    expect(rejected('\\windows\\system32')).toBe('absolute-path');
  });

  it('rejects UNC paths (both separator styles)', () => {
    expect(rejected('\\\\server\\share\\file')).toBe('unc-path');
    expect(rejected('//server/share/file')).toBe('unc-path');
    expect(rejected('\\\\?\\C:\\Windows')).toBe('unc-path');
    expect(rejected('/\\mixed')).toBe('unc-path');
  });

  it('rejects drive letters: absolute, relative and bare', () => {
    expect(rejected('C:\\Windows\\system32')).toBe('drive-letter');
    expect(rejected('C:/Windows/system32')).toBe('drive-letter');
    expect(rejected('C:file.txt')).toBe('drive-letter');
    expect(rejected('c:')).toBe('drive-letter');
    expect(rejected('z:\\')).toBe('drive-letter');
  });

  it('does not mistake ordinary colons for drives', () => {
    expect(ok('file:name.txt').components).toEqual(['file:name.txt']);
    expect(ok('dir/file:name.txt').components).toEqual(['dir', 'file:name.txt']);
  });
});

describe('parent components', () => {
  it.each(['../x', '..\\x', 'a/../x', 'a/b/../../..', '..', '..\\..\\win', 'a/..'])(
    'rejects %j',
    (name) => expect(rejected(name)).toBe('parent-component'),
  );

  it('allows dot-like names that are not exactly ".."', () => {
    expect(ok('.../x').components).toEqual(['...', 'x']);
    expect(ok('a/..b/c').components).toEqual(['a', '..b', 'c']);
  });
});

describe('NUL bytes', () => {
  it.each(['a\0b', '\0', 'a/b\0/c', 'a/\0'])('rejects %j', (name) =>
    expect(rejected(name)).toBe('nul-byte'),
  );
});

describe('no URL decoding', () => {
  it('treats percent-encoded traversal as inert literal text', () => {
    const path = ok('%2e%2e%2f');
    expect(path.components).toEqual(['%2e%2e%2f']);
  });

  it('does not decode %2f into a separator', () => {
    expect(ok('a%2fb').components).toEqual(['a%2fb']);
    expect(ok('..%2f..%2fetc%2fpasswd').components).toEqual(['..%2f..%2fetc%2fpasswd']);
  });

  it('does not decode %5c into a backslash separator', () => {
    expect(ok('..%5c..%5cwin').components).toEqual(['..%5c..%5cwin']);
  });
});

describe('Unicode lookalikes are not separators', () => {
  it.each([
    ['a∕b', 'a∕b'], // U+2215 DIVISION SLASH
    ['a／b', 'a／b'], // U+FF0F FULLWIDTH SOLIDUS
    ['a⁄b', 'a⁄b'], // U+2044 FRACTION SLASH
    ['a＼b', 'a＼b'], // U+FF3C FULLWIDTH REVERSE SOLIDUS
    ['a﹨b', 'a﹨b'], // U+FE68 SMALL REVERSE SOLIDUS
  ])('keeps %j as a single component', (name, component) => {
    const path = ok(name);
    expect(path.components).toEqual([component]);
  });

  it('does not turn lookalike-joined ".." into traversal', () => {
    // With a real separator this would be '../../etc'; with U+2215 it is one inert component.
    expect(ok('..∕..∕etc').components).toEqual(['..∕..∕etc']);
  });
});

describe('symlink entries', () => {
  const SYMLINK = 0o120777;
  const REGULAR = 0o100644;
  const DIRECTORY = 0o040755;

  it('detects symlink mode bits', () => {
    expect(isSymlinkMode(SYMLINK)).toBe(true);
    expect(isSymlinkMode(REGULAR)).toBe(false);
    expect(isSymlinkMode(DIRECTORY)).toBe(false);
  });

  it('extracts the mode from ZIP external attributes (high 16 bits)', () => {
    expect(unixModeFromExternalAttributes((SYMLINK << 16) | 0x01ff)).toBe(SYMLINK);
    expect(unixModeFromExternalAttributes((REGULAR << 16) | 0x81a4 & 0xffff)).toBe(REGULAR);
  });

  it('rejects symlink entries by default', () => {
    expect(rejected('link', { unixMode: SYMLINK })).toBe('symlink-entry');
  });

  it('accepts symlinks only when explicitly allowed', () => {
    expect(ok('link', { unixMode: SYMLINK, allowSymlinks: true }).components).toEqual(['link']);
  });

  it('accepts regular files and directories', () => {
    expect(ok('f.txt', { unixMode: REGULAR }).components).toEqual(['f.txt']);
    expect(ok('d/', { unixMode: DIRECTORY }).isDirectory).toBe(true);
  });

  it('validateEntry reads name and unixMode from an entry record', () => {
    expect(validateEntry({ name: 'link', unixMode: SYMLINK }).ok).toBe(false);
    const result = validateEntry({ name: 'a/b.txt', unixMode: REGULAR });
    expect(result.ok && result.value.portablePath).toBe('a/b.txt');
  });
});

describe('CollisionDetector', () => {
  it('flags exact duplicates', () => {
    const detector = new CollisionDetector();
    expect(detector.register(ok('a/b.txt'))).toBeNull();
    const collision = detector.register(ok('a/b.txt'));
    expect(collision?.existing.rawName).toBe('a/b.txt');
    expect(collision?.incoming.rawName).toBe('a/b.txt');
  });

  it('flags case-only differences (Windows/macOS extraction)', () => {
    const detector = new CollisionDetector();
    expect(detector.register(ok('Dir/README.md'))).toBeNull();
    const collision = detector.register(ok('dir/readme.MD'));
    expect(collision?.existing.rawName).toBe('Dir/README.md');
  });

  it('flags Unicode normalization duplicates (composed vs decomposed)', () => {
    const composed = 'caf\u00e9.txt'; // U+00E9 precomposed
    const decomposed = 'cafe\u0301.txt'; // 'e' + U+0301 combining acute
    expect(composed).not.toBe(decomposed);
    expect(composed.normalize('NFC')).toBe(decomposed.normalize('NFC'));
    const detector = new CollisionDetector();
    expect(detector.register(ok(composed))).toBeNull();
    const collision = detector.register(ok(decomposed));
    expect(collision?.existing.rawName).toBe(composed);
    expect(collision?.incoming.rawName).toBe(decomposed);
  });

  it('flags names that differ only by duplicate separators or dot components', () => {
    const detector = new CollisionDetector();
    expect(detector.register(ok('a/b.txt'))).toBeNull();
    expect(detector.register(ok('a//b.txt'))).not.toBeNull();
    expect(detector.register(ok('a/./b.txt'))).not.toBeNull();
  });

  it('does not merge lookalike characters with real separators', () => {
    const detector = new CollisionDetector();
    expect(detector.register(ok('a/b.txt'))).toBeNull(); // two components
    expect(detector.register(ok('a∕b.txt'))).toBeNull(); // one component, U+2215
    expect(detector.size).toBe(2);
  });

  it('accepts distinct names', () => {
    const detector = new CollisionDetector();
    expect(detector.register(ok('a/b.txt'))).toBeNull();
    expect(detector.register(ok('a/b2.txt'))).toBeNull();
    expect(detector.register(ok('a/b.txt.bak'))).toBeNull();
  });

  it('can be made case-sensitive', () => {
    const detector = new CollisionDetector({ caseInsensitive: false });
    expect(detector.register(ok('README.md'))).toBeNull();
    expect(detector.register(ok('readme.md'))).toBeNull();
  });

  it('can skip Unicode normalization', () => {
    const detector = new CollisionDetector({ normalization: 'none' });
    expect(detector.register(ok('caf\u00e9.txt'))).toBeNull(); // precomposed
    expect(detector.register(ok('cafe\u0301.txt'))).toBeNull(); // decomposed: distinct without NFC
  });

  it('find() is non-mutating', () => {
    const detector = new CollisionDetector();
    const path = ok('a.txt');
    expect(detector.find(path)).toBeUndefined();
    detector.register(path);
    expect(detector.find(ok('A.TXT'))?.rawName).toBe('a.txt');
    expect(detector.size).toBe(1);
  });
});

describe('API guarantees', () => {
  it('only ever returns clean relative components', () => {
    const inputs = [
      'a/b/c.txt', 'dir\\sub\\f', 'a//b', './a/./b', 'a/', '%2e%2e%2f', 'a∕b',
      'file:name.txt', '...', '..b/c', 'café.txt', 'a b/c d.txt',
    ];
    for (const input of inputs) {
      const path = ok(input);
      for (const component of path.components) {
        expect(component).not.toMatch(/[/\\]/);
        expect(component).not.toMatch(/^(|\.\.?)$/); // never '', '.', '..'
        expect(component).not.toContain('\0');
      }
      expect(path.portablePath.startsWith('/')).toBe(false);
      expect(path.portablePath).not.toMatch(/^[A-Za-z]:/);
    }
  });

  it('rejects every classic traversal payload', () => {
    const payloads = [
      '../..', '/etc/passwd', '\\windows', '\\\\srv//shares', 'C:/x', 'C:\\x', 'C:x',
      'a/../../b', '..\\..\\win', '//unc/path', '\0', 'a/\0b', '', '.', './',
    ];
    for (const payload of payloads) {
      expect(validateEntryName(payload).ok, JSON.stringify(payload)).toBe(false);
    }
  });

  it('performs no file I/O — the module never touches node:fs', () => {
    const source = readFileSync(new URL('../src/safe-path.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from\s+['"](node:)?fs['"]/);
    expect(source).not.toMatch(/require\(['"](node:)?fs['"]\)/);
  });
});
