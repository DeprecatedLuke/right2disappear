# Development Rules

## Code Quality

- No `any` types unless absolutely necessary
- **No `private`/`protected`/`public` keyword on class fields or methods** — use ES native `#` private fields. The only exception is constructor parameter properties.
- **Never use `ReturnType<>`** — use the actual type name.
- Never use inline imports — always standard top-level imports.
- No incidental refactors or cleanup outside requested scope.

## Bun Conventions

This project uses Bun. Prefer Bun APIs over Node equivalents.

- `Bun.sleep(ms)` not `new Promise(r => setTimeout(r, ms))`
- `Bun.file()`/`Bun.write()` for file I/O
- **Namespace imports for node modules**: `import * as fs from "node:fs"`, `import * as path from "node:path"`, etc.

| Operation       | Use                        | Not                             |
| --------------- | -------------------------- | ------------------------------- |
| File read/write | `Bun.file()`, `Bun.write()`| `readFileSync`, `writeFileSync` |
| Sleep           | `Bun.sleep(ms)`            | `setTimeout` promise            |
| Binary lookup   | `Bun.which("x")`          | `spawnSync(["which", "x"])`    |
| Hashing         | `Bun.hash()`               | `node:crypto` (unless needed)  |

Sync `node:fs` is acceptable for one-shot startup operations (token extraction scanning many small files).

## Commands

| Command     | Description              |
| ----------- | ------------------------ |
| `bun check` | Biome check + TypeScript |
| `bun lint`  | Biome lint               |
| `bun fmt`   | Biome format             |
| `bun fix`   | Fix all (unsafe + fmt)   |

- Never commit unless user asks
- Never run dev/test unless user instructs
- Do NOT use `tsc` or `npx tsc` — always use `bun check`

## Style

- Keep answers short and concise
- No emojis in commits, issues, or code
- No fluff or filler text
