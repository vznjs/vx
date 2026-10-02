import { shellQuote } from './nx-command.js'

/**
 * Every `.env`-shaped file under the probe's directory, name and bytes, in
 * a stable order. Git ignores them, so a glob over git's files keys none of
 * them; this is a superset of what a `.env` glob names, so an edit to one
 * misses and nothing else is lost (item 1032). node_modules and .git are
 * pruned. Each file ends on a `.`: core trims a probe's output, so a
 * newline added to the last file keyed nothing.
 */
export const DOTENV_PROBE =
  'find . \\( -name node_modules -o -name .git \\) -prune -o -type f \\( -name \'.env*\' -o -name \'*.env\' \\) -print | LC_ALL=C sort | while IFS= read -r f; do echo "$f"; cat -- "$f"; echo .; done'

/**
 * The same for a package whose `.env` globs all sit at its root (`.env*`,
 * create-turbo's default): the files named `.env…` or `…env` there, by the
 * shell's own globbing. `DOTENV_PROBE` is three processes and walks the
 * package; this is one shell, 1.2 ms against 3.3 (kitchen-sink's warm run
 * spent ~45 ms of ~145 in probes). `LC_ALL=C` keeps the glob order, and so
 * the key, the same on every machine.
 */
export const DOTENV_PROBE_TOP =
  'LC_ALL=C; export LC_ALL; for f in .env* .*.env *.env; do [ -f "$f" ] && { printf \'%s\\n\' "$f"; cat -- "$f"; echo .; }; done; :'

/**
 * The named root-relative files, name and bytes, run at the workspace root:
 * the inputs a turbo.json names by path that git ignores
 * (`config.local.json`), which Turbo hashes and a glob over git's files
 * keys nothing of. Core trims a probe's output, so each file ends on a `.`:
 * a trailing newline added to the last one is still an edit.
 */
export function ignoredFilesProbe(rels: readonly string[]): string {
  return `for f in ${rels.map(shellQuote).join(' ')}; do [ -f "$f" ] && { printf '%s\\n' "$f"; cat -- "$f"; echo .; }; done; :`
}

/** How every `dotenvGlobsProbe` line opens, and no other probe's. */
export const DOTENV_GLOBS_HEAD = 'LC_ALL=C; export LC_ALL; { '

/**
 * The files the root-relative `.env` globs name, name and bytes, run at the
 * workspace root: Turbo hashes exactly these, and `DOTENV_PROBE` over the
 * whole tree also keyed `hosting/docker/.env.example`, which trigger.dev's
 * `apps/*\/.env`-shaped globs never reach. Turbo's `*` matches a leading
 * dot and the shell's does not, so a segment that opens on `*` is spelled
 * again for hidden names. `<dir>/**\/<name>` (create-turbo's
 * `**\/.env.*local`) is a `find -name`, which matches a leading dot and
 * skips `node_modules` as Turbo does. Null for a glob the shell would read
 * otherwise (`**` elsewhere, a class, a brace, a quote): the caller keeps
 * the walk.
 */
export function dotenvGlobsProbe(globs: readonly string[]): string | null {
  const safe = (seg: string): boolean =>
    /^[A-Za-z0-9._@+*-]+$/.test(seg) && !seg.includes('**') && seg !== '.' && seg !== '..'
  const words = new Set<string>()
  const finds: string[] = []
  for (const glob of globs) {
    const segs = glob.split('/')
    const deep = segs.indexOf('**')
    if (deep !== -1) {
      const dir = segs.slice(0, deep)
      const name = segs.slice(deep + 1)
      if (name.length !== 1 || !safe(name[0]!) || dir.some((d) => !safe(d) || d.includes('*')))
        return null
      finds.push(
        `find ${dir.length === 0 ? '.' : dir.join('/')} \\( -name node_modules -o -name .git \\) -prune -o -type f -name '${name[0]}' -print`,
      )
      continue
    }
    let alts = ['']
    for (const seg of segs) {
      if (!safe(seg)) return null
      const forms =
        seg === '*' ? ['*', '.[!.]*', '..?*'] : seg.startsWith('*') ? [seg, `.${seg}`] : [seg]
      alts = alts.flatMap((a) => forms.map((f) => (a === '' ? f : `${a}/${f}`)))
      if (alts.length > 64) return null
    }
    for (const a of alts) words.add(a)
  }
  const list = [
    ...(words.size === 0
      ? []
      : [`for f in ${[...words].join(' ')}; do [ -f "$f" ] && printf '%s\\n' "$f"; done`]),
    ...finds.map((f) => `${f} 2>/dev/null | sed 's|^\\./||'`),
  ]
  return `${DOTENV_GLOBS_HEAD}${list.join('; ')}; } | sort -u | while IFS= read -r f; do printf '%s\\n' "$f"; cat -- "$f"; echo .; done`
}
