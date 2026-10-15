import type { DependencyRule } from '../config.js'
import { refusal } from '../util/index.js'
import { compileNameGlob } from './filter.js'
import type { PackageGraph } from './package-graph.js'

/**
 * `run.rules.dependencies`, held to each project's direct workspace
 * dependencies (`PackageGraph.directDeps`: the manifest's and the
 * cross-project `dependsOn` edges). A rule constrains the projects its
 * `from` selects: each dependency must match an `allow` selector when
 * `allow` is given, and no `deny` one. Every rule that selects a project
 * applies, so a deny beats any allow. Checked by `vx lock` only (owner,
 * 2026-10-13); every broken edge is named in one refusal.
 */
export function checkDependencyRules(
  rules: readonly DependencyRule[],
  projects: readonly string[],
  tags: ReadonlyMap<string, readonly string[]>,
  graph: PackageGraph,
): void {
  if (rules.length === 0) return
  const compiled = rules.map((r) => ({
    from: selector(r.from),
    allow: r.allow?.map(selector),
    deny: r.deny?.map(selector),
  }))
  const broken: string[] = []
  for (const name of projects) {
    const own = tags.get(name) ?? []
    for (const [i, rule] of compiled.entries()) {
      if (!rule.from(name, own)) continue
      for (const dep of graph.directDeps(name)) {
        const theirs = tags.get(dep) ?? []
        const denied = rule.deny?.some((s) => s(dep, theirs)) === true
        if (denied || (rule.allow !== undefined && !rule.allow.some((s) => s(dep, theirs))))
          broken.push(
            `${name} depends on ${dep}, which run.rules.dependencies[${i}] (from '${rules[i]!.from}') ${denied ? 'denies' : 'does not allow'}`,
          )
      }
    }
  }
  if (broken.length === 0) return
  const headline = `${broken.length === 1 ? '1 dependency breaks' : `${broken.length} dependencies break`} run.rules.dependencies`
  throw refusal(
    {
      headline,
      what: broken,
      fix: "drop the dependency, or change the project's tags or the rule",
    },
    {
      code: 'VX_E_DEPENDENCY_RULE',
      message: `${headline}:\n${broken.map((b) => `  ${b}`).join('\n')}\nDrop the dependency, or change the project's tags or the rule.`,
    },
  )
}

/** `tag:<glob>` matches a project carrying a matching tag; anything else, its name. */
function selector(s: string): (name: string, tags: readonly string[]) => boolean {
  if (s.startsWith('tag:')) {
    const re = compileNameGlob(s.slice(4))
    return (_, tags) => tags.some((t) => re.test(t))
  }
  const re = compileNameGlob(s)
  return (name) => re.test(name)
}
