// What people said about vx, word for word: the quote, who said it and
// their role, nothing else. Real words about vx only, each a whole sentence
// picked so it keeps its meaning; a public one links to where it was said.

export interface Voice {
  quote: string
  who: string
  role?: string
  href?: string
}

const PR = 'https://github.com/vznjs/vx/pull/3286'
const shew = (quote: string, comment?: string): Voice => ({
  quote,
  who: 'Anthony Shew',
  role: 'Full-stack comedian, Turborepo at Vercel',
  href: comment ? `${PR}#issuecomment-${comment}` : PR,
})

const C = '6085989849'

// Said to us in Polish; translated.
const wrona = (quote: string): Voice => ({
  quote,
  who: 'Wojtek Wrona',
  role: 'Team Lead at Selleo',
})

// The order is the page's: the first half is the top row, the rest the
// bottom, each looping. Voices alternate so one person's quotes sit apart
// wherever the count allows (11 of 17 are Anthony's, so some pairs remain).
export const ALL_VOICES: Voice[] = [
  {
    quote:
      '[vx conformance] This is very impressive. Really great work here. I’ve always wanted to do something like this but have never really had the time.',
    who: 'Miles Johnson',
    role: 'Creator of moon',
    href: 'https://github.com/moonrepo/moon/issues/2818#issuecomment-7070128267',
  },
  shew('The benchmarks presented by this project are misleading.'),
  shew(
    'There’s a specific reason that none of the build systems that you’re comparing against don’t do what you’re doing: It doesn’t work.',
    C,
  ),
  {
    quote: 'holy cow… this is awesome! People need to be using VX',
    who: 'Tony Ward',
    role: 'Software Engineer at CrowdStrike',
  },
  shew(
    'Again, this is all completely fine for a young project made by someone without build systems knowledge.',
    C,
  ),
  shew(
    'Do you think that we all would be leaving such a performance boon on the table if it did work?',
    C,
  ),
  wrona('These comparisons are nice.'),
  shew('To say that vx is faster than other build tools because of this is dishonest.'),
  shew('Just because a benchmark is reproducible doesn’t make it useful.', C),
  {
    quote:
      'VX is an amazing breath of fresh air. Finally there is a holistic monorepo cache tool that includes all the features of NX and turborepo',
    who: 'Nathan Bernhardt',
    role: 'Software Engineer at CrowdStrike',
  },
  shew(
    'When I saw your post, I was excited because I thought you’d found some edge case in Turborepo so that I could make things faster. Then, I got disappointed when that turned out to not be the case since the benchmarking methodology was so flawed - which is fine!',
    C,
  ),
  shew(
    'We all use the same models and have seen this scheduling recommendation, but those of us with experience in build systems know that this algorithm is incorrect.',
    C,
  ),
  wrona(
    'I think if you hadn’t explained to me earlier what it’s about, I wouldn’t have understood it.',
  ),
  shew(
    'Obviously, you can’t count on a graph having uniform timing in a real world repository, so unblocking more tasks sooner is generally meaningless at scale.',
  ),
  shew(
    'If your users can configure their way out of that, that’s fine, but then its dishonest to claim the numbers that you are.',
    C,
  ),
  wrona('It looks better than last time.'),
  shew(
    'Build systems pushing each other is good for everyone. But now I’m disappointed because it seems your intent is to be dishonest.',
    C,
  ),
]
