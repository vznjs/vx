// Shared TS-literal emission helper for the migrate mappers. Lives in its own
// leaf module so both migrate.ts (the config emitter) and migrate-turbo.ts (the
// preset renderer) can escape strings identically without a dependency cycle
// (migrate.ts already imports the turbo/nx mappers, so a back-import of a value
// from migrate.ts would close a runtime cycle).

/**
 * Escape an arbitrary string into a single-quoted TS literal. Escapes
 * backslash + quote AND raw newlines/CR — a value with an embedded newline
 * (legal JSON, e.g. a script `"echo a\necho b"`, or a glob with a `'`) would
 * otherwise splice into a single-quoted literal as an unterminated / malformed
 * string that fails to load (generated files must round-trip through the
 * loader).
 */
export function quote(s: string): string {
  return `'${s
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')}'`
}
