# Stream H — the 1.0 contract (plan-2026-09-27): merged items, one entry per PR

## H-1: pin the config schema's full surface (roadmap 3.1)

`tests/contract-config-schema.test.ts` generates the schema's surface from
the validator itself: an unknown key injected at every object node of a
valid seed reads each level's `allowed:` list, and every field is probed
with 32 values (each JSON type, the numeric edges, the glob and env-name
shapes the refusals name); a record's entry names are probed with the seven
task-name shapes. Every outcome (acceptance or exact refusal text) is
compared with the committed `tests/contract/config-schema.json`. Each
level's field list is also held to its exported interface in
`src/config.ts` by the type checker (`Keys<T>`), so a field the interface
declares and the validator refuses, or the reverse, fails. Differential: a
new `exec` field, a reworded refusal and a dropped check each fail the
record row; removing a key from a `Keys<T>` literal fails the type check.
A field the validator names but refuses every value of (`sandbox.ignore.pty`
and `.gitConfig`) is probed unseeded and must accept nothing.

## H-2: pin the plugin API and the façade's shapes (roadmap 3.2)

`tests/contract-package-api.test.ts` and its reader
`tests/helpers/api-surface.ts` pin the SHAPE of everything `src/index.ts`
exports, where the boundary test pinned only the names. The reader
resolves each export through `export {…} from`, `import {…} from` and
`export *` (per file, so the two `RunResult`s and two `Plugin`s resolve
to their own declarations), and follows every capitalised identifier a
declaration names to its declaration: 177 declarations, the non-exported
`BaseContext` among them. Comments are stripped by a scanner that keeps
strings and template literals, a function is cut at its body, a class
keeps its public members (a field's initializer dropped). Constants add
their runtime values. The record is `tests/contract/package-api.txt`; a
second row holds `VxPlugin`'s members to `PLUGIN_HOOKS`. Differential: a
member added to `TaskExecutor`, a type changed in the non-exported
`BaseContext`, and a hook added to `VxPlugin` alone each fail; a reworded
comment passes (control).

## H-3: a removed config field is refused naming its replacement

`versioning-1.0.md` § Deprecation promised that a removed field's refusal
names the replacement and the version that removed it; nothing did.
`exec.resources` (removed in 0.0.19 with the reservations, item 157) was
refused as `unknown field "resources"`, a message that sends a reader to
the history. `REMOVED_FIELDS` in `config-schema.ts` maps a level's field
set to its removed fields; `assertKnownFields` consults it before calling a
key unknown. The version came from the release tags: v0.0.18's
`config.ts` declares `resources?: ResourcesConfig`, v0.0.19's does not.
`tests/contract-removed-fields.test.ts` holds the message word for word
(red with the lookup disabled), a control that a never-known field is
still unknown, and every entry's shape; `schema.md`'s error table gains
the row, provoked in `schema-doc-drift.test.ts`. The warning of step 1 is
not built: no field is deprecated, and the doc says so. Written in stream
D's file because the plan assigned the mechanism to H; the change is the
table and one lookup.

## H-4: state exactly what 1.0 freezes, held to the code (roadmap 3.1, 3.2)

`versioning-1.0.md` named the frozen surfaces but not what is in them. §
What 1.0 freezes, exactly lists every config level and its fields (two
tables), the levels keyed by an author's name, the thirteen hooks in
pipeline order, the telemetry record kinds and schema version, and the
plugin types by name. `tests/contract-versioning-doc.test.ts` holds each
list both ways to its source: the levels to `config-schema.json` (itself
held to the validator), the hooks to `PLUGIN_HOOKS`, the kinds to
`TelemetryRecord` as the source declares it, the version to
`TELEMETRY_SCHEMA_VERSION`, and each named type to the façade's surface.
Differential: a field dropped from a table, a renamed hook, a wrong
version, a dropped kind, a dropped keyed level and an unexported type name
each fail their row. The contract table's "Defined by" column named
`src/config.ts` for the plugin API, where `VxPlugin` is not; it now names
the files and each surface's record.

## Leads for other streams

- **D / B:** `exec.sandbox.ignore.localBinding` accepts ANY value (the
  probe table records `null`, `-1`, `{}` and every other probe as `ok`):
  the ignore loop in `validateSandbox` checks neither it nor the booleans'
  type, and `sandbox-runtime.ts` (`r.ignore`) forwards only `read`,
  `write`, `systemInfo` and `network`, so `ignore.localBinding`,
  `ignore.unixSockets` and `ignore.machLookup` load and are silently
  dropped. Refuse them at load (`localBinding` is a flag like `pty`), or
  forward the two name lists.
- **D:** `dependsOn` accepts `['']` and `['!x']` at load; whether the graph
  refuses each with the task named is unchecked.
- **F:** `@vzn/vx-reapi#test`'s "a call a proxy cuts in transit" rows
  (added by F-1) fail under a full local gate: RST_STREAM(INTERNAL_ERROR)
  "… is retried" twice (2164 and 2171 ms, "the collector hung up") and
  RST_STREAM(CANCEL) "… is not retried" once, in 3 of 5 gates on
  2026-09-27 (Bun 1.4.2, 4 workers), while the task passes run alone.
  Load-dependent; CI has been green.
