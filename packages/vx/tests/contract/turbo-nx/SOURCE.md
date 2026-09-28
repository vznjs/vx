# Vendored upstream schemas

Byte-for-byte copies, read by `tests/turbo-nx-support.test.ts` to list
every key a Turbo or Nx user can write. Refresh by replacing a file with
the same path from a newer release, updating its row here, then
classifying each new key in `tests/contract/turbo-nx-support.json`.

| File                  | Package        | Version | Path in the package           |
| --------------------- | -------------- | ------- | ----------------------------- |
| `turbo-schema.json`   | `@turbo/types` | 2.11.5  | `schemas/schema.json`         |
| `nx-schema.json`      | `nx`           | 23.2.1  | `schemas/nx-schema.json`      |
| `project-schema.json` | `nx`           | 23.2.1  | `schemas/project-schema.json` |

Tarballs: `https://registry.npmjs.org/@turbo/types/-/types-2.11.5.tgz`,
`https://registry.npmjs.org/nx/-/nx-23.2.1.tgz`.
