// Leaf module so orchestrator/cli can read the version without
// importing the public façade (index.ts imports the orchestrator —
// that edge must stay one-directional).
export const VERSION = '0.0.0'
