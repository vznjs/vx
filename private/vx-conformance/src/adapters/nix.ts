// Nix: each task a derivation in a default.nix at the workspace root, run
// by `nix-build` (src/adapters/nix-run.ts). Its declared inputs are the
// derivation's sources, matched in Nix at each evaluation; its `dependsOn`
// are derivation inputs; its env names are read with `builtins.getEnv`. Its
// declared outputs go to `$out`, and the run copies them back into the tree:
// the Nix store is the cache, and an unchanged derivation is not rebuilt.
// Omitted inputs are the project's git-tracked files, as a flake sees them.
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Adapter } from '../adapter.ts'
import { projectDir, type TaskReport, type WorkspaceSpec } from '../spec.ts'

const RUN = path.join(import.meta.dir, 'nix-run.ts')

/** Where the run leaves nix-build's own output, for `report`: in the case's home. */
export const LAST = '.home/nix-last.json'

/** A Nix string literal. */
function nixStr(s: string): string {
  return `"${s
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('${', '\\${')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')}"`
}

function nixValue(v: unknown): string {
  if (typeof v === 'string') return nixStr(v)
  if (typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `[ ${v.map(nixValue).join(' ')} ]`
  return `{ ${Object.entries(v as Record<string, unknown>)
    .map(([k, x]) => `${nixStr(k)} = ${nixValue(x)};`)
    .join(' ')} }`
}

// A literal as POSIX extended and JS regexes both read it: in a bracket, or `\^`, `\\`.
const escapeRe = (s: string) => s.replace(/[.+*?()|[\]{}$]/g, '[$&]').replace(/[\\^]/g, '\\$&')

/** One of these regexes as JavaScript reads it: `[]]` is a literal `]` to POSIX, an empty class then `]` to JS. */
export const jsRegExp = (re: string): RegExp => new RegExp(`^(?:${re.replaceAll('[]]', '\\]')})$`)

/** A glob's body as a POSIX extended regex: `**` any depth, `*` and `?` within a segment, `[...]`, `{a,b}`. */
function globBody(g: string): string {
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!
    if (c === '*') {
      if (g[i + 1] === '*') {
        const atStart = i === 0 || g[i - 1] === '/'
        i++
        if (atStart && g[i + 1] === '/') {
          re += '(.*/)?'
          i++
        } else re += '.*'
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '[' && g.indexOf(']', i + 2) !== -1) {
      const end = g.indexOf(']', i + 2)
      const cls = g.slice(i + 1, end)
      re += `[${cls.startsWith('!') ? `^${cls.slice(1)}` : cls}]`
      i = end
    } else if (c === '{') {
      let depth = 0
      let end = -1
      const parts: string[] = []
      let from = i + 1
      for (let j = i; j < g.length; j++) {
        if (g[j] === '[' && g.indexOf(']', j + 2) !== -1) j = g.indexOf(']', j + 2)
        else if (g[j] === '{') depth++
        else if (g[j] === '}' && --depth === 0) {
          end = j
          break
        } else if (g[j] === ',' && depth === 1) {
          parts.push(g.slice(from, j))
          from = j + 1
        }
      }
      if (end === -1) {
        re += '\\{'
        continue
      }
      parts.push(g.slice(from, end))
      re += `(${parts.map((part) => globBody(part.replace(/^(\.\/)+/, ''))).join('|')})`
      i = end
    } else if (c === '\\' && i + 1 < g.length) re += escapeRe(g[++i]!)
    else re += escapeRe(c)
  }
  return re
}

/**
 * Workspace-root-relative regexes for `globs` under `dir`: a file matches
 * one, or sits in a directory that does. `!` globs go to the exclusions.
 */
export function globRegexes(dir: string, globs: string[]): { inc: string[]; exc: string[] } {
  const prefix = dir === '.' ? '' : `${escapeRe(dir)}/`
  const re = (g: string) =>
    `${prefix}${globBody(g.replace(/^(\.\/)+/, '').replace(/\/+$/, ''))}(/.*)?`
  return {
    inc: globs.filter((g) => !g.startsWith('!')).map(re),
    exc: globs.filter((g) => g.startsWith('!')).map((g) => re(g.slice(1))),
  }
}

/**
 * `^task`: the task in each workspace dependency, and through a dependency
 * that lacks it, in that one's own; a project naming itself is no edge.
 */
function caret(ws: WorkspaceSpec, from: string, task: string): string[] {
  const declared = (p: string) => ws.projects[p]?.tasks?.[task] !== undefined
  if (!Object.keys(ws.projects).some(declared))
    return (ws.projects[from]?.deps ?? []).map((d) => `${d}#${task}`)
  const out: string[] = []
  const seen = new Set([from])
  const visit = (p: string) => {
    for (const d of ws.projects[p]?.deps ?? []) {
      if (seen.has(d)) continue
      seen.add(d)
      if (declared(d)) out.push(`${d}#${task}`)
      else visit(d)
    }
  }
  visit(from)
  return out
}

/** The task data the Nix side turns into derivations. */
function specs(ws: WorkspaceSpec) {
  const out: Record<string, unknown> = {}
  for (const [name, p] of Object.entries(ws.projects)) {
    const dir = projectDir(name, p)
    for (const [t, spec] of Object.entries(p.tasks ?? {})) {
      // A name nothing declares stays in: Nix refuses the missing attribute.
      const deps = (spec.dependsOn ?? []).flatMap((d) =>
        d.startsWith('^') ? caret(ws, name, d.slice(1)) : [d.includes('#') ? d : `${name}#${d}`],
      )
      const own = spec.inputs
        ? { tracked: false, ...globRegexes(dir, spec.inputs) }
        : { tracked: true, ...globRegexes(dir, ['**']) }
      const sel = [
        own,
        ...(spec.rootInputs ? [{ tracked: false, ...globRegexes('.', spec.rootInputs) }] : []),
      ]
      const outs = [globRegexes(dir, spec.outputs ?? []), globRegexes('.', spec.rootOutputs ?? [])]
      out[`${name}#${t}`] = {
        name: `${name}-${t}`.replace(/[^A-Za-z0-9+._?=-]/g, '_').replace(/^\./, '_'),
        dir,
        command: '',
        deps,
        sel,
        env: spec.env ?? [],
        cache: spec.cache !== false,
        outDefault: spec.outputs === undefined ? '1' : '',
        outRe: outs.flatMap((o) => o.inc),
        outEx: outs.flatMap((o) => o.exc),
      }
    }
  }
  return out
}

// The builder: the workspace mirrored under the build directory (the
// task's sources, its dependencies' outputs), the command run in the
// project's directory, then the files its declared outputs match copied to
// `$out`. `.ran` and `.home` are the harness's marks and scratch: links to
// the real workspace's, whose path the run leaves where no derivation reads
// it as an input.
const BUILDER = `set -e
top=$NIX_BUILD_TOP/ws
mkdir -p "$top"
root=$(cat /tmp/vx-conformance-nix/root)
ln -s "$root/.ran" "$top/.ran"
ln -s "$root/.home" "$top/.home"
tab=$(printf '\\t')
printf '%s\\n' "$deps" | while IFS= read -r d; do
  [ -n "$d" ] || continue
  cp -RP "$d/." "$top/"
done
printf '%s\\n' "$srcs" | while IFS="$tab" read -r p rel; do
  [ -n "$p" ] || continue
  mkdir -p "$top/$(dirname "$rel")"
  rm -rf "$top/$rel"
  cp -P "$p" "$top/$rel"
done
find "$top" -path "$top/.home" -prune -o -path "$top/.ran" -prune -o ! -type l -exec chmod u+w {} +
files() {
  find . \\( -path ./.home -o -path ./.ran \\) -prune -o \\( -type f -o -type l \\) -print | sed 's|^\\./||'
}
# What each file holds before the command: with no outputs declared, what it writes is the output.
cd "$top"
snap() {
  files | while IFS= read -r f; do
    if [ -L "$f" ]; then printf 'link %s\\t%s\\n' "$(readlink "$f")" "$f"; else printf '%s\\t%s\\n' "$(cksum < "$f")" "$f"; fi
  done | sort
}
[ -z "$outDefault" ] || snap > "$NIX_BUILD_TOP/before"
cd "$top/$dir"
sh -c "$command"
mkdir -p "$out"
cd "$top"
: > "$NIX_BUILD_TOP/outs"
if [ -n "$outDefault" ]; then
  snap | comm -13 "$NIX_BUILD_TOP/before" - | cut -f2- >> "$NIX_BUILD_TOP/outs"
fi
if [ -n "$outRe" ]; then
  printf '%s\\n' "$outRe" > "$NIX_BUILD_TOP/out.re"
  printf '%s\\n' "$outEx" | sed '/^$/d' > "$NIX_BUILD_TOP/out.ex"
  { files; find . \\( -path ./.home \\) -prune -o -type d -empty -print | sed 's|^\\./||'; } \\
    | grep -E -x -f "$NIX_BUILD_TOP/out.re" | { if [ -s "$NIX_BUILD_TOP/out.ex" ]; then grep -v -E -x -f "$NIX_BUILD_TOP/out.ex"; else cat; fi; } >> "$NIX_BUILD_TOP/outs" || true
fi
while IFS= read -r f; do
  mkdir -p "$out/$(dirname "$f")"
  if [ -d "$f" ] && [ ! -L "$f" ]; then mkdir -p "$out/$f"; else cp -P "$f" "$out/$f"; fi
done < "$NIX_BUILD_TOP/outs"
`

const LIB = `
  r = builtins.fromJSON run;
  root = ./.;
  # Never a source: version control, installs, and the harness's marks and scratch.
  skip = dir: name: name == ".git" || name == "node_modules"
    || (dir == "" && builtins.elem name [ ".home" ".ran" ".left" ".stop-watch" ]);
  walk = base: dir:
    let entries = builtins.readDir (if dir == "" then base else base + "/\${dir}"); in
    builtins.concatLists (map (name:
      let rel = if dir == "" then name else "\${dir}/\${name}"; in
      if skip dir name then [ ]
      else if entries.\${name} == "directory" then walk base rel
      else [ rel ]) (builtins.attrNames entries));
  files = walk root "";
  # What git tracks, as a flake sees the tree: tracked files, as they are on disk.
  tracked = builtins.filter (rel: builtins.pathExists (root + "/\${rel}")) (walk (builtins.fetchGit root).outPath "");
  any = res: rel: builtins.any (re: builtins.match re rel != null) res;
  pick = s: builtins.filter (rel: any s.inc rel && !(any s.exc rel)) (if s.tracked then tracked else files);
  # A file is copied alone; a link as a link, from its directory filtered to it, as builtins.path follows the path it is given.
  source = rel:
    let p = root + "/\${rel}"; in {
      name = rel;
      value = if builtins.readFileType p == "symlink"
        then "\${builtins.path { path = dirOf p; name = "src"; filter = q: _: q == toString p; }}/\${baseNameOf rel}"
        else builtins.path { path = p; name = "src"; };
    };
  quote = a: "'" + builtins.replaceStrings [ "'" ] [ "'\\\\''" ] a + "'";
  closure = ds: map (x: x.drv) (builtins.genericClosure {
    startSet = map (d: { key = d.id; drv = d; }) ds;
    operator = x: map (d: { key = d.id; drv = d; }) x.drv.deps;
  });
  # A task no named project declares stays in, as \`-A\` names it: Nix refuses the missing attribute.
  requested = builtins.concatMap (t:
    let ids = map (p: "\${p}#\${t}") (r.projects or projects);
        declared = builtins.filter (id: builtins.hasAttr id specs) ids;
    in if declared == [ ] then [ (builtins.head ids) ] else declared) r.tasks;
  mk = id: s:
    let
      deps = map (d: builtins.getAttr d tasks) s.deps;
      srcs = builtins.listToAttrs (map source (builtins.concatMap pick s.sel));
      env = builtins.filter (e: e.value != "") (map (n: { name = n; value = builtins.getEnv n; }) s.env);
      drv = derivation ({
        inherit (s) name dir outDefault;
        system = builtins.currentSystem;
        builder = "/bin/sh";
        args = [ "-c" builder ];
        PATH = builtins.getEnv "PATH";
        command = s.command + (if builtins.elem id requested
          then builtins.concatStringsSep "" (map (a: " " + quote a) (r.args or [ ])) else "");
        srcs = builtins.concatStringsSep "\\n" (builtins.attrValues (builtins.mapAttrs (rel: p: "\${p}\\t\${rel}") srcs));
        deps = builtins.concatStringsSep "\\n" (map (d: d.outPath) (closure deps));
        outRe = builtins.concatStringsSep "\\n" s.outRe;
        outEx = builtins.concatStringsSep "\\n" s.outEx;
      } // builtins.listToAttrs env // (if s.cache then { } else { nonce = r.nonce; }));
    in drv // { inherit id deps; outRe = s.outRe; outEx = s.outEx; };
  tasks = builtins.mapAttrs mk specs;
  selected = map (id: builtins.getAttr id tasks) requested;
`

function nixFile(ws: WorkspaceSpec, command: (project: string, task: string) => string): string {
  const s = specs(ws) as Record<string, { command: string }>
  for (const id of Object.keys(s)) {
    const at = id.lastIndexOf('#')
    s[id]!.command = command(id.slice(0, at), id.slice(at + 1))
  }
  return `# Written by the conformance suite's Nix adapter from the case's workspace.
{ run ? "{}" }:
let
  specs = ${nixValue(s)};
  projects = ${nixValue(Object.keys(ws.projects))};
  builder = ${nixStr(BUILDER)};
${LIB}in {
  inherit selected;
  # What the run restores: each task the build reaches, its output and what its outputs match.
  info = map (d: { inherit (d) id outRe outEx; drv = d.drvPath; out = d.outPath; }) (closure selected);
}
`
}

export const nix: Adapter = {
  name: 'nix',
  bins: [],
  version: async () => {
    const out = await Bun.$`nix --version`.text()
    return out.trim().split(' ').at(-1)!
  },
  lacks: [
    // nix-build builds the attributes it is named: no git change selects
    // them, no pattern, tag, directory or walk picks them, and what a
    // derivation needs is always built first.
    'affected',
    'filter',
    'select-walk',
    'select-dir',
    'select-tag',
    'task-pattern',
    // A derivation is a build: never a long-running process, never
    // retried, with no time limit of its own.
    'persistent',
    'ready',
    'timeout',
    'retries',
    // Evaluation reads files and variables, never a command's output.
    'runtime-inputs',
    // A variable reaches a build only as an attribute, which keys it.
    'pass-through-env',
    // A dependency's output path is the dependant's input: it always keys it.
    'dependency-inputs-off',
    // `--keep-going` builds what does not depend on a failure, never what does.
    'continue',
    // A valid output is never built again: `--check` compares, it saves nothing.
    'force',
    // Building writes the store; nothing reads it without writing.
    'read-only-cache',
    // The builds here run unsandboxed (no build users in the case's store),
    // so nothing keeps a command from what it never declared.
    'sandbox',
    // nix-build has no watch mode.
    'watch',
  ],
  env: { NO_COLOR: '1' },
  async configure(dir, ws, command) {
    await writeFile(path.join(dir, 'default.nix'), nixFile(ws, command))
    return []
  },
  run: (task, projects, opts = {}) => [
    process.execPath,
    RUN,
    JSON.stringify({
      tasks: [task, ...(opts.also ?? [])],
      ...(projects ? { projects } : {}),
      ...(opts.args ? { args: opts.args } : {}),
      ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
      ...(opts.dry ? { dry: true } : {}),
    }),
  ],
  affected: () => {
    throw new Error('nix has no affected selection')
  },
  // nix-build lists the derivations it will build before it builds them:
  // a task of the run that is not listed was already in the store.
  report: async (root) => {
    const last = await Bun.file(path.join(root, LAST)).json()
    return reportOf(last)
  },
}

export function reportOf(last: {
  drvs: Record<string, string>
  log: string
}): Record<string, TaskReport> {
  const built = new Set(
    [...last.log.matchAll(/will be built:\n((?:\s+\/\S+\.drv\n?)+)/g)].flatMap((m) =>
      m[1]!
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  )
  return Object.fromEntries(
    Object.entries(last.drvs).map(([id, drv]) => [id, { cache: built.has(drv) ? 'miss' : 'hit' }]),
  )
}
