// A markdown page imported `with { type: 'text' }` is its text (docs-corpus.ts).
declare module '*.md' {
  const text: string
  export default text
}
