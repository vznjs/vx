// A `with { type: 'file' }` import of a file SRT vendors: Bun hands back its path.
declare module '@anthropic-ai/sandbox-runtime/vendor/seccomp/*' {
  const path: string
  export default path
}
