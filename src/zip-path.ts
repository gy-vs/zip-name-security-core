/**
 * ZIP entry name validation ("Zip Slip" defense).
 *
 * Parsing follows ZIP semantics (APPNOTE 4.4.17): a name is raw text and
 * '/' separates components. '\' is treated as a separator too, because
 * Windows APIs and several unzip implementations do. Names are never
 * URL-decoded and never Unicode-normalized before parsing: '%2e%2e%2f' is
 * a literal file name and U+FF0F '／' is an ordinary character, not a
 * separator. Unicode normalization is used only for collision keys, never
 * for parsing and never for output names.
 *
 * Everything here is pure: validators return safe relative components and
 * never touch the file system. Callers join `safeName` under their own
 * extraction root.
 */

export type ZipNameRejection =
  | 'nul' // U+0000 anywhere in the raw name
  | 'absolute' // one leading separator: /etc/passwd, \windows\system32
  | 'unc' // two leading separators: //host/share, \\host\share, //?/c:/x
  | 'drive' // DOS drive prefix: c:, c:/x, c:\x, c:relative
  | 'parent' // a '..' component
  | 'empty'; // nothing left once empty and dot components are dropped

export interface SafeZipName {
  /** Original entry name, exactly as stored in the archive. */
  readonly rawName: string;
  /** Safe relative components, verbatim text, in archive order. */
  readonly components: readonly string[];
  /** `components` joined with '/': relative, no NUL, no '..', no separators inside components. */
  readonly safeName: string;
  /** True when the raw name ends in a separator (ZIP directory marker). */
  readonly isDirectory: boolean;
}

export type ZipNameResult =
  | { readonly ok: true; readonly name: SafeZipName }
  | { readonly ok: false; readonly reason: ZipNameRejection; readonly rawName: string };

const LEADING_SEPARATOR = /^[\\/]/;
const TWO_LEADING_SEPARATORS = /^[\\/][\\/]/;
const TRAILING_SEPARATOR = /[\\/]$/;
const DRIVE_PREFIX = /^[A-Za-z]:/;
const TRAILING_DOTS_AND_SPACES = /[. ]+$/;

/**
 * Splits a raw entry name into raw components on '/' and '\'.
 * No decoding, no normalization; empty components are preserved.
 */
export function splitZipEntryName(rawName: string): string[] {
  return rawName.split(/[\\/]/);
}

/**
 * Validates a raw ZIP entry name against a platform-independent policy:
 * no NUL, no absolute or UNC root, no drive prefix, no '..' component.
 * Empty components ('a//b'), '.' and components made only of dots and
 * spaces ('...', '.. ') are dropped — Windows strips trailing dots and
 * spaces, so those are empty or current-dir-like there. Kept components
 * are emitted verbatim; the safe name is built only from them.
 */
export function validateZipEntryName(rawName: string): ZipNameResult {
  const fail = (reason: ZipNameRejection): ZipNameResult => ({ ok: false, reason, rawName });

  if (rawName.includes('\0')) return fail('nul');
  if (LEADING_SEPARATOR.test(rawName)) {
    return fail(TWO_LEADING_SEPARATORS.test(rawName) ? 'unc' : 'absolute');
  }
  if (DRIVE_PREFIX.test(rawName)) return fail('drive');

  const components: string[] = [];
  for (const component of splitZipEntryName(rawName)) {
    if (component === '..') return fail('parent');
    if (component.replace(TRAILING_DOTS_AND_SPACES, '') === '') continue;
    components.push(component);
  }
  if (components.length === 0) return fail('empty');

  return {
    ok: true,
    name: {
      rawName,
      components,
      safeName: components.join('/'),
      isDirectory: TRAILING_SEPARATOR.test(rawName),
    },
  };
}

/**
 * Applies the entry-name policy to a symlink target. A link whose target
 * is absolute or climbs out of its directory escapes the extraction root
 * when followed, so the same rules apply.
 */
export function validateZipSymlinkTarget(target: string): ZipNameResult {
  return validateZipEntryName(target);
}

// Unix file type bits, stored in the high 16 bits of externalAttributes
// when the archive was created on Unix (APPNOTE 4.4.15).
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

export type ZipEntryKind = 'file' | 'directory' | 'symlink' | 'other';

export function zipEntryKind(
  externalAttributes: number | undefined,
  nameIsDirectory: boolean,
): ZipEntryKind {
  const mode = ((externalAttributes ?? 0) >>> 16) & S_IFMT;
  switch (mode) {
    case S_IFREG:
      return 'file';
    case S_IFDIR:
      return 'directory';
    case S_IFLNK:
      return 'symlink';
    case 0: // no Unix mode stored: fall back to the directory marker
      return nameIsDirectory ? 'directory' : 'file';
    default:
      return 'other';
  }
}

export function zipEntryKindOf(entry: {
  name: string;
  externalAttributes?: number;
}): ZipEntryKind {
  return zipEntryKind(entry.externalAttributes, TRAILING_SEPARATOR.test(entry.name));
}

/**
 * Key used to detect names that collide on real filesystems: NFKC folds
 * compatibility characters (fullwidth 'Ａ' → 'A'), lowercasing folds case
 * (case-insensitive volumes), and trailing dots/spaces are dropped per
 * component (Windows strips them). Conservative on purpose — used ONLY
 * for collision detection, never to parse or to build output names.
 */
export function zipNameCollisionKey(safeName: string): string {
  return safeName
    .split('/')
    .map((component) =>
      component.normalize('NFKC').replace(TRAILING_DOTS_AND_SPACES, '').toLowerCase(),
    )
    .join('/');
}

export interface ZipNameCollision {
  readonly key: string;
  readonly safeNames: readonly string[];
}

/** Groups safe names that normalize to the same on-disk key. */
export function findZipNameCollisions(safeNames: Iterable<string>): ZipNameCollision[] {
  const byKey = new Map<string, string[]>();
  for (const safeName of safeNames) {
    const key = zipNameCollisionKey(safeName);
    const group = byKey.get(key);
    if (group) group.push(safeName);
    else byKey.set(key, [safeName]);
  }
  return [...byKey.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([key, safeNames]) => ({ key, safeNames }));
}
