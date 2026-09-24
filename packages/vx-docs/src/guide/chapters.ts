// The Guide's order, written by hand from the table in
// packages/vx/docs/design/site-redo-2026-09.md. Everything that numbers a
// chapter reads this list: the sidebar (astro.config.mjs), the chapter header
// and the Next card (components/starlight/), and tests/guide.test.ts, which
// holds it to the design's order and to each chapter's frontmatter.
//
// A `problem` is the problem the chapter opens with, in one sentence.
// Backticks mark code, as in Markdown; the header renders them as <code>.

export interface Chapter {
  /** The page under `guide/`, and the name of its `.mdx` file. */
  slug: string
  chapter: number
  title: string
  problem: string
}

export const CHAPTERS: readonly Chapter[] = [
  {
    slug: 'why',
    chapter: 1,
    title: 'Why orchestrate?',
    problem: 'Four packages, one `build` script each; you write a shell loop.',
  },
  {
    slug: 'tasks',
    chapter: 2,
    title: 'Tasks',
    problem: 'The loop runs "scripts"; what exactly is one unit of work?',
  },
  {
    slug: 'dependencies',
    chapter: 3,
    title: 'Dependencies',
    problem: '`app#build` ran before `ui#build` and failed.',
  },
  {
    slug: 'concurrency',
    chapter: 4,
    title: 'Concurrency',
    problem: 'The graph is right but the run takes as long as the loop.',
  },
  {
    slug: 'caching',
    chapter: 5,
    title: 'Caching',
    problem: 'You changed one line in `app`; `utils` rebuilt anyway.',
  },
  {
    slug: 'trust',
    chapter: 6,
    title: 'Can you trust a hit?',
    problem: 'A hit replayed an old output and the run was green.',
  },
  {
    slug: 'affected',
    chapter: 7,
    title: 'Only what changed',
    problem: 'CI builds all four packages for a README edit.',
  },
  {
    slug: 'many-machines',
    chapter: 8,
    title: 'Many machines',
    problem: 'Your laptop and CI build the same thing twice.',
  },
  {
    slug: 'inside-vx',
    chapter: 9,
    title: 'How vx is built',
    problem:
      'You now know the ideas; how does one tool hold them without growing a branch for every vendor?',
  },
  {
    slug: 'try-it',
    chapter: 10,
    title: 'Try it',
    problem: 'Reading about a planner is not the same as watching one decide.',
  },
]

/** Where the last chapter's Next card goes: out of the Guide, into the Docs. */
export const AFTER_GUIDE = {
  href: 'quickstart/',
  title: 'Quickstart',
  problem: 'The four packages were a toy. Put vx on your own repo.',
} as const

interface NextCard {
  /** Under the site's base. */
  href: string
  kicker: string
  title: string
  problem: string
}

/** The chapter a page id (`guide/<slug>`) is, and what its Next card names. */
export function chapterPage(id: string): { chapter: Chapter; next: NextCard } | undefined {
  const at = CHAPTERS.findIndex((c) => `guide/${c.slug}` === id)
  if (at < 0) return undefined
  const following = CHAPTERS[at + 1]
  const next: NextCard =
    following === undefined
      ? { ...AFTER_GUIDE, kicker: 'Next: the Docs' }
      : {
          href: `guide/${following.slug}/`,
          kicker: `Next: chapter ${following.chapter}`,
          title: following.title,
          problem: following.problem,
        }
  return { chapter: CHAPTERS[at]!, next }
}

/** A problem sentence as HTML: escaped, with its backtick spans as <code>. */
export function problemHtml(problem: string): string {
  const escaped = problem.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return escaped.replace(/`([^`]+)`/g, '<code>$1</code>')
}
