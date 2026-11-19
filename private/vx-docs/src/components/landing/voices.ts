// What people said about vx, word for word: the quote, who said it and
// their role, nothing else. Real, public words about vx only, each a whole
// sentence picked so it keeps its meaning; each links to where it was said.

export interface Voice {
  quote: string
  who: string
  role: string
  href: string
}

const PR = 'https://github.com/vznjs/vx/pull/3286'
const shew = (quote: string, comment?: string): Voice => ({
  quote,
  who: 'Anthony Shew',
  role: 'Full-stack comedian, Turborepo at Vercel',
  href: comment ? `${PR}#issuecomment-${comment}` : PR,
})

const B = '6082220886'
const C = '6085989849'

export const ALL_VOICES: Voice[] = [
  shew('The benchmarks presented by this project are misleading.'),
  shew(
    'There’s a specific reason that none of the build systems that you’re comparing against don’t do what you’re doing: It doesn’t work.',
    C,
  ),
  shew(
    'Again, this is all completely fine for a young project made by someone without build systems knowledge.',
    C,
  ),
  shew(
    'Do you think that we all would be leaving such a performance boon on the table if it did work?',
    C,
  ),
  shew('To say that vx is faster than other build tools because of this is dishonest.'),
  shew(
    'I obviously don’t know if you did that on purpose or Claude chose to do it, but this is, of course, not something that someone who is interested in being forthcoming would do.',
    C,
  ),
  shew('Just because a benchmark is reproducible doesn’t make it useful.', C),
  shew(
    'When I saw your post, I was excited because I thought you’d found some edge case in Turborepo so that I could make things faster.',
    C,
  ),
  shew('But now I’m disappointed because it seems your intent is to be dishonest.', C),
  shew(
    'We all use the same models and have seen this scheduling recommendation, but those of us with experience in build systems know that this algorithm is incorrect.',
    C,
  ),
  shew('why would you stand by statements that are literally and provably incorrect?', B),
  shew(
    'Obviously, you can’t count on a graph having uniform timing in a real world repository, so unblocking more tasks sooner is generally meaningless at scale.',
  ),
  shew(
    'If your users can configure their way out of that, that’s fine, but then its dishonest to claim the numbers that you are.',
    C,
  ),
  shew('Build systems pushing each other is good for everyone.', C),
]
