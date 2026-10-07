# Workstream XP — cross-platform (2026-10-07)

- **XP-40.** turbo() escapes a brace in a package dir it writes into a glob (climbed inputs, root dependency trees): `r{x,y}` matched `rx`, `ry`, never itself. Rows: "a climbed glob escapes the package dir it keeps…", "key every task on a dependency whose dir name holds a brace".
