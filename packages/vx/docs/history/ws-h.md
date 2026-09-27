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
