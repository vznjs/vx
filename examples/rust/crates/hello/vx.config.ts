import { defineProject } from '@vzn/vx/config'

const inputs = { files: ['src/**', 'Cargo.toml', 'Cargo.lock'] }

export default defineProject({
  // Without it the project is named by its path, crates/hello.
  name: 'hello',
  tasks: {
    build: {
      exec: { command: 'cargo build --release --locked' },
      inputs,
      outputs: { files: ['target/release/hello'] },
      cache: true,
    },
    test: {
      exec: { command: 'cargo test --locked' },
      inputs,
      outputs: { files: [] },
      cache: true,
    },
    lint: {
      exec: { command: 'cargo clippy --locked -- -D warnings' },
      inputs,
      outputs: { files: [] },
      cache: true,
    },
  },
})
