// Turbo's own env (its `DEFAULT_ENV_VARS` and builtin pass-through) joins
// every mapped task's globals. A row about what turbo.json says leaves
// those names out; "Turbo's builtin env" in turbo-map-sweep.test.ts holds them.
import { TURBO_BUILTIN_PASS_THROUGH, TURBO_DEFAULT_ENV } from '../../src/turbo/turbo-reads.js'

/** `names` without Turbo's own, a builtin wildcard's matches too. */
export const notTurbos = <T>(names: readonly T[]): T[] =>
  names.filter(
    (n) =>
      typeof n !== 'string' ||
      (!TURBO_DEFAULT_ENV.includes(n) &&
        !TURBO_BUILTIN_PASS_THROUGH.some((e) =>
          e.endsWith('*') ? n.startsWith(e.slice(0, -1)) : n === e,
        )),
  )

/** A splice that inlines the globals, Turbo's own names left out. */
export const ownSplice = (_kind: string, values: readonly string[]): string[] => notTurbos(values)

/** The note a written migration carries for Turbo's builtin wildcard families. */
export const BUILTIN_FAMILIES_NOTE =
  'Turbo passes every XDG_DATA_*, COREPACK_*, VSCODE_*, DOCKER_*, BUILDKIT_*, COMPOSE_*, ' +
  'JB_IDE_*, TURBO_*, VERCEL_*, NEXT_*, GITHUB_*, RUNNER_*, __NIXOS_*, NIX_* variable to each ' +
  'task; the configs pass its literal names only — add the ones a task reads to ' +
  'exec.env.passThrough'

/**
 * The preset's Turbo-own lists, as written: Turbo's DEFAULT_ENV_VARS and
 * the literal BUILTIN_PASS_THROUGH_ENV names a shell can hold, copied from
 * crates/turborepo-env, not from the mapper's table.
 */
export const WRITTEN_DEFAULTS = "'VERCEL_ANALYTICS_ID', 'VERCEL_TARGET_ENV'"
export const WRITTEN_BUILTINS =
  "'HOME', 'USER', 'TZ', 'LANG', 'SHELL', 'PWD', 'XDG_RUNTIME_DIR', 'XAUTHORITY', " +
  "'DBUS_SESSION_BUS_ADDRESS', 'CI', 'NODE_OPTIONS', 'LD_LIBRARY_PATH', " +
  "'DYLD_FALLBACK_LIBRARY_PATH', 'LIBPATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'COLORTERM', " +
  "'FORCE_COLOR', 'NO_COLOR', 'TERM', 'TERM_PROGRAM', 'DISPLAY', 'TMP', 'TEMP', 'WINDIR', " +
  "'ProgramFiles', 'ELECTRON_RUN_AS_NODE', 'JB_INTERPRETER', " +
  "'_JETBRAINS_TEST_RUNNER_RUN_SCOPE_TYPE', 'VERCEL', 'USE_OUTPUT_FOR_EDGE_FUNCTIONS', " +
  "'NOW_BUILDER', 'VC_MICROFRONTENDS_CONFIG_FILE_NAME', 'APPDATA', 'LOCALAPPDATA', 'PATH', " +
  "'PROGRAMDATA', 'SYSTEMROOT', 'SYSTEMDRIVE', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', " +
  "'PNPM_HOME', 'pnpm_config_verify_deps_before_run', 'NPM_CONFIG_STORE_DIR', 'COMSPEC', " +
  "'PATHEXT'"
