# config

```ts
async function loadConfig(path: string): Promise<ProjectConfig>
interface ProjectConfig {}
```

Given a path to a config file, dynamic-import it and return the default export.

That's the whole module. No file discovery, no extension iteration, no validation, no schema. The caller picks the path; this module loads it.
