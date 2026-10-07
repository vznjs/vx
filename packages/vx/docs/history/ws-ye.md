# Workstream YE — Nx/Turbo parity (2026-10-07)

- **YE-2.** `turbo ls --filter|--affected` and `nx show projects --affected [--with-target t]` had no vx form. `vx show` and `vx show <task>` take `--filter` and `--affected[=<ref>]`, selected as `vx run` selects; the base resolution moved to `affectedFilterFor` in select.ts for both. Rows: tests/show-select.test.ts › "narrows the project list", "lists the changed projects and their dependents, and a task among them", "refuses them beside one project".
