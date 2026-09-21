# ZIP archive core

TypeScript library for archive records and entries.

Run `npm install`, then `npm test` and `npm run build`.

## Safe entry names (`src/safe-path.ts`)

Zip Slip defense for entry names, split into two pure steps: parse the raw
name into components per ZIP semantics, then apply a platform-independent
security policy. The module performs **no file I/O** — it only returns
validated relative components; callers join them onto their extraction root.

```ts
import { validateEntryName, CollisionDetector } from 'zip-name-security-core';

const result = validateEntryName(entry.name, { unixMode });
if (!result.ok) throw new Error(`rejected ${result.rawName}: ${result.error}`);
const { components, portablePath, rawName } = result.value;
// rawName is preserved untouched; only components/portablePath are safe.

const collisions = new CollisionDetector();
for (const path of validatedPaths) {
  const hit = collisions.register(path);
  if (hit) throw new Error(`${hit.incoming.rawName} collides with ${hit.existing.rawName}`);
}
```

### Parsing rules

- `/` is the ZIP separator (APPNOTE 4.4.17.1); `\` is also treated as a
  separator because Windows extractors honor it.
- Names are **never URL-decoded**: `%2e%2e%2f` is inert literal text.
- Unicode lookalikes (U+2215, U+FF0F, U+2044, U+FF3C, …) are ordinary
  filename characters, never separators.
- Empty components (`a//b`) and dot components (`a/./b`) are normalized away;
  a trailing `/` marks a directory (`isDirectory`).

### Rejections (`EntryNameError`)

| Error              | Rejected input examples                        |
| ------------------ | ---------------------------------------------- |
| `empty-name`       | `''`, `'.'`, `'./'`                            |
| `nul-byte`         | `'a\0b'`                                       |
| `symlink-entry`    | entries whose Unix mode is `S_IFLNK` (default) |
| `absolute-path`    | `'/etc/passwd'`, `'\windows'`                  |
| `unc-path`         | `'\\server\share'`, `'//server/share'`         |
| `drive-letter`     | `'C:\x'`, `'C:/x'`, `'C:x'`                    |
| `parent-component` | `'..'`, `'../x'`, `'a/../../b'`                |

### Collision detection

`CollisionDetector` compares names after Unicode NFC + case folding
(matching Windows/macOS extraction), so `café.txt` vs `café.txt`,
`README.md` vs `readme.md`, and `a/b` vs `a//b` are flagged before anything
is written. NFC is deliberately not a compatibility form, so lookalike
characters never fold into real separators. Both behaviors are configurable
(`caseInsensitive`, `normalization`).
