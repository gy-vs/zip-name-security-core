# ZIP archive core

TypeScript library for archive records and entries.

Run `npm install`, then `npm test` and `npm run build`.

## Entry name validation

`validateZipEntryName(rawName)` parses a raw ZIP entry name into components
(both `/` and `\` separate) and applies a platform-independent policy: it
rejects NUL, absolute paths, UNC roots, DOS drive prefixes and `..`
components, and drops empty and dot components. Names are never URL-decoded
and Unicode lookalikes are never treated as separators. The result keeps
`rawName` next to a `safeName` built only from the accepted components; the
API is pure and never writes to disk.

`validateZipSymlinkTarget` applies the same policy to symlink targets,
`zipEntryKind` reads Unix mode bits from `externalAttributes`, and
`findZipNameCollisions` flags safe names that collide after Unicode
normalization and case folding.
