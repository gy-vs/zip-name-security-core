/**
 * Platform-independent validation of ZIP entry names (Zip Slip defense).
 *
 * Parsing follows ZIP semantics (APPNOTE 4.4.17.1: '/' is the path
 * separator). '\' is additionally treated as a separator, defensively,
 * because Windows extractors honor it. Nothing else is a separator:
 *
 * - Names are NEVER URL-decoded. '%2e%2e%2f' is inert literal text.
 * - Unicode lookalikes (U+2215 DIVISION SLASH, U+FF0F FULLWIDTH SOLIDUS,
 *   U+2044 FRACTION SLASH, U+FF3C FULLWIDTH REVERSE SOLIDUS, ...) are
 *   ordinary filename characters, never component boundaries.
 *
 * The policy rejects: absolute paths, UNC paths, drive letters, parent
 * components, NUL bytes and (by default) symlink entries. Dot components
 * and empty components (duplicate separators) are normalized away.
 *
 * The validated output (SafeEntryPath) is kept separate from the raw
 * archive name, which is preserved untouched. This module is pure: it
 * performs no file I/O and never writes to disk. Callers join the
 * returned components onto their extraction root themselves.
 */

/** Unix file-type bits (st_mode & S_IFMT), as stored in ZIP external attributes. */
export const S_IFMT = 0o170000;
export const S_IFLNK = 0o120000;

/** True when Unix mode bits describe a symbolic link. */
export function isSymlinkMode(mode: number): boolean {
  return (mode & S_IFMT) === S_IFLNK;
}

/**
 * ZIP stores the Unix st_mode in the high 16 bits of the external
 * attributes field (when the "made by" OS is Unix). Extract it.
 */
export function unixModeFromExternalAttributes(externalAttributes: number): number {
  return (externalAttributes >>> 16) & 0xffff;
}

export type EntryNameError =
  | 'empty-name'
  | 'nul-byte'
  | 'symlink-entry'
  | 'absolute-path'
  | 'unc-path'
  | 'drive-letter'
  | 'parent-component';

/** A validated entry name. `rawName` is never modified; the safe form lives in `components`/`portablePath`. */
export interface SafeEntryPath {
  /** Entry name exactly as stored in the archive. Untouched. */
  readonly rawName: string;
  /** Validated relative components: no separators, no NUL, no ''/'.'/'..', no drive prefix. */
  readonly components: readonly string[];
  /** `components` joined with '/' — a portable relative path. */
  readonly portablePath: string;
  /** True when the raw name ends with '/' (the ZIP directory marker). */
  readonly isDirectory: boolean;
}

export type EntryNameResult =
  | { readonly ok: true; readonly value: SafeEntryPath }
  | { readonly ok: false; readonly error: EntryNameError; readonly rawName: string };

export interface ValidateEntryNameOptions {
  /**
   * Unix mode bits for the entry (see unixModeFromExternalAttributes).
   * When provided and the entry is a symlink, validation fails with
   * 'symlink-entry' unless `allowSymlinks` is set — a symlink's target
   * is attacker-controlled and can point anywhere.
   */
  readonly unixMode?: number;
  /** Permit symlink entries (default false). */
  readonly allowSymlinks?: boolean;
}

const SEPARATOR = /[/\\]/;
const DRIVE_PREFIX = /^[A-Za-z]:/;

function fail(error: EntryNameError, rawName: string): EntryNameResult {
  return { ok: false, error, rawName };
}

/**
 * Validate a raw ZIP entry name and, on success, return its safe relative
 * components. Pure function; the input string is never mutated or decoded.
 */
export function validateEntryName(rawName: string, options: ValidateEntryNameOptions = {}): EntryNameResult {
  if (rawName.length === 0) return fail('empty-name', rawName);
  if (rawName.includes('\0')) return fail('nul-byte', rawName);
  if (options.unixMode !== undefined && isSymlinkMode(options.unixMode) && !options.allowSymlinks) {
    return fail('symlink-entry', rawName);
  }

  // Leading separators: one is a rooted (absolute) path, two or more is
  // a UNC / POSIX-double-slash path. Both are rejected outright.
  let leading = 0;
  while (leading < rawName.length && (rawName[leading] === '/' || rawName[leading] === '\\')) leading++;
  if (leading >= 2) return fail('unc-path', rawName);
  if (leading === 1) return fail('absolute-path', rawName);

  const rawComponents = rawName.split(SEPARATOR);

  // A drive letter only has meaning as the first component: 'C:\x',
  // 'C:/x' (absolute) and 'C:x' (drive-relative) are all rejected.
  if (DRIVE_PREFIX.test(rawComponents[0]!)) return fail('drive-letter', rawName);

  const components: string[] = [];
  for (const component of rawComponents) {
    if (component === '..') return fail('parent-component', rawName);
    if (component === '' || component === '.') continue; // duplicate separators, no-op dots
    components.push(component);
  }
  if (components.length === 0) return fail('empty-name', rawName);

  return {
    ok: true,
    value: {
      rawName,
      components,
      portablePath: components.join('/'),
      isDirectory: rawName.endsWith('/'),
    },
  };
}

/** Validate a ZIP entry record (any object with `name` and optional `unixMode`). */
export function validateEntry(
  entry: { readonly name: string; readonly unixMode?: number },
  options: ValidateEntryNameOptions = {},
): EntryNameResult {
  return validateEntryName(entry.name, { ...options, unixMode: entry.unixMode ?? options.unixMode });
}

export interface NameCollision {
  /** The entry already registered under the normalized key. */
  readonly existing: SafeEntryPath;
  /** The entry that collides with it. */
  readonly incoming: SafeEntryPath;
}

export interface CollisionDetectorOptions {
  /**
   * Fold case when comparing (default true). Matches extraction on
   * Windows and macOS, where 'README.md' and 'readme.md' are one file.
   */
  readonly caseInsensitive?: boolean;
  /**
   * Unicode normalization applied before comparison (default 'NFC').
   * Catches composed vs. decomposed duplicates ('café' vs 'café').
   * Deliberately not a compatibility form: lookalike characters such as
   * U+2215 must not fold into real separators.
   */
  readonly normalization?: 'NFC' | 'none';
}

/**
 * Detects collisions between validated entry names after normalization
 * (Unicode NFC + case folding by default). Feed it every SafeEntryPath
 * of an archive before extracting any of them.
 */
export class CollisionDetector {
  readonly #caseInsensitive: boolean;
  readonly #normalization: 'NFC' | 'none';
  readonly #seen = new Map<string, SafeEntryPath>();

  constructor(options: CollisionDetectorOptions = {}) {
    this.#caseInsensitive = options.caseInsensitive ?? true;
    this.#normalization = options.normalization ?? 'NFC';
  }

  get size(): number {
    return this.#seen.size;
  }

  /** Non-mutating lookup: the registered path this one would collide with, if any. */
  find(path: SafeEntryPath): SafeEntryPath | undefined {
    return this.#seen.get(this.#key(path.components));
  }

  /** Register a path; returns collision details, or null when the name is fresh. */
  register(path: SafeEntryPath): NameCollision | null {
    const key = this.#key(path.components);
    const existing = this.#seen.get(key);
    if (existing !== undefined) return { existing, incoming: path };
    this.#seen.set(key, path);
    return null;
  }

  #key(components: readonly string[]): string {
    // Validated components can never contain NUL, so NUL is an
    // unambiguous joiner — 'a/b' (two components) can never merge
    // with a single component that happens to contain a slash-like
    // character.
    return components.map((component) => this.#normalize(component)).join('\0');
  }

  #normalize(component: string): string {
    let out = this.#normalization === 'NFC' ? component.normalize('NFC') : component;
    if (this.#caseInsensitive) out = out.toLowerCase();
    return out;
  }
}
