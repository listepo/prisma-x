# CLI

`prismax` generates code from a Prisma schema with one of the [adapters](adapters.md).

```
prismax generate --adapter <diesel|sqlalchemy> --schema <file> --out <dir> [options]

Options:
  --adapter <name>     output target
  --schema <file>      Prisma schema file
  --out <dir>          output directory (created if missing)
  --provider <name>    override the datasource provider (postgresql, mysql, sqlite, ...)
  --dry-run            print the generated files to stdout instead of writing them
  -h, --help           show this help
```

Examples:

```sh
prismax generate --adapter diesel --schema prisma/schema.prisma --out src/db
prismax generate --adapter sqlalchemy --schema prisma/schema.prisma --out app/db
prismax generate --adapter diesel --schema schema.prisma --provider sqlite --dry-run
```

## How it works

`src/cli.ts` parses arguments with `node:util` `parseArgs` (strict: unknown options are errors),
reads the schema and calls `generate(source, adapter, { provider })`, which parses the schema,
builds the IR and runs the adapter.

- **Streams.** Generated files (with `--dry-run`, as `==> path <==` sections) and `wrote <path>`
  lines go to stdout. Everything else goes to stderr:
  - schema errors, as `schema.prisma:line:column: error: message`
  - schema warnings, in the same format
  - adapter diagnostics, as `severity[CODE] Model.field: message`
- **Exit codes:**

  | Code | When |
  | --- | --- |
  | 0 | Files generated. Warnings and info diagnostics do not change the exit code |
  | 1 | Invalid schema, unreadable schema, a write failure, or any adapter `error` diagnostic (e.g. unsupported provider, skipped model) |
  | 2 | Usage error: unknown command, option or adapter, or a missing required option |

  On a schema error nothing is written. On adapter errors the files that could be generated are
  still written, so you can inspect them.
- **Files** are written under `--out` and existing files are overwritten. Paths that would
  escape the output directory are refused.
- `runCli(args, io)` is exported for in-process use and tests. It takes `{ stdout, stderr, cwd }`
  and returns the exit code instead of exiting.

## Enabling and disabling

The package declares `"bin": { "prismax": "./dist/cli.js" }`.

```sh
pnpm build
node dist/cli.js generate --adapter diesel --schema schema.prisma --out out   # from this repository
pnpm link --global && prismax --help                                          # as a command
```

The CLI is separate from the library: importing `prisma-x` never runs it. It only runs when
`dist/cli.js` is the entry script. To disable an adapter in the CLI, remove it from
`src/adapters/index.ts`.

## Testing

```sh
pnpm vitest run test/cli.test.ts
```

`test/cli.test.ts` runs `runCli` in-process against temporary directories. It covers help, usage
errors (exit 2), writing files, `--dry-run`, schema errors with positions (exit 1), unreadable
schemas, diagnostics on stderr, adapter errors (exit 1) and `--provider`.

## Limitations

- Single-file schemas only; `prisma/schema` folders (multi-file schemas) are not supported.
- No `--watch`, no config file. Generator blocks in the schema are ignored, so the CLI is not
  run by `prisma generate`.
- Stale files from a previous run are not deleted.
