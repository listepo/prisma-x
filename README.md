# prisma-x

[![pipeline](https://github.com/pyrlyn/prismax/actions/workflows/pipeline.yml/badge.svg)](https://github.com/pyrlyn/prismax/actions/workflows/pipeline.yml)
[![npm](https://img.shields.io/npm/v/prisma-x)](https://www.npmjs.com/package/prisma-x)

Generates ORM code for other ecosystems from [Prisma](https://www.prisma.io/) schemas:
[Diesel](https://diesel.rs) (Rust) and [SQLAlchemy 2.0](https://www.sqlalchemy.org/) (Python).
Schemas are parsed by the official Rust engine compiled to WebAssembly
([`@prisma/prisma-schema-wasm`](https://www.npmjs.com/package/@prisma/prisma-schema-wasm),
pinned to `8.1.0-2.59be4fda12412a79eeb9c2ae727b6aa723593323`), so validation matches Prisma.

```sh
prismax generate --adapter diesel --schema prisma/schema.prisma --out src/db        # schema.rs, models.rs
prismax generate --adapter sqlalchemy --schema prisma/schema.prisma --out app/db    # models.py
```

As a library:

```ts
import { generate, parseSchema, buildIr, formatDiagnostic } from 'prisma-x';
import { dieselAdapter } from 'prisma-x/adapters/diesel';

const result = generate(source, dieselAdapter);
if (result.ok) {
  for (const file of result.value.files) console.log(file.path);
  for (const d of result.value.diagnostics) console.warn(formatDiagnostic(d));
} else {
  console.error(result.error.code, result.error.spans);
}

const ast = parseSchema(source); // typed AST, or a SchemaError with source spans
```

## Architecture

```
schema.prisma -> parser (wasm wrapper) -> AST -> core: buildIr -> neutral IR -> adapter -> files + diagnostics
```

```
src/index.ts             public API: parser functions, SchemaError, AST/DMMF types, core
src/parser.ts            pipeline: input check -> lint -> validate -> extract -> Result
src/ast.ts               AST types + datamodel -> AST mapping (relations derived here)
src/source-scan.ts       tolerant scanner for model/view blocks of the schema text
src/source-recovery.ts   rebuilds what the engine omits: @@ignore models, @ignore and Unsupported fields, FK names
src/internal/wasm.ts     the only module that touches the wasm package
src/core/                neutral IR (ir.ts), AST -> IR (build.ts), Adapter contract (adapter.ts), names
src/adapters/diesel/     Diesel 2 adapter      (entry point prisma-x/adapters/diesel)
src/adapters/sqlalchemy/ SQLAlchemy 2.0 adapter (entry point prisma-x/adapters/sqlalchemy)
src/generate.ts          parse -> IR -> adapter in one call
src/cli.ts               the prismax command
scripts/                 Prisma reference test fetcher, Diesel compile check, SQLAlchemy check (Python)
```

- The core resolves Prisma's semantics: database names, default constraint names, effective
  referential actions, implicit many-to-many join tables and client-side versus database defaults.
  It knows nothing about any target.
- Adapters map the IR to their target. They report what they cannot express as diagnostics
  instead of throwing.
- The wasm package never crosses the public boundary; tests enforce this and the core/adapter
  separation.

Docs:

- [parser](docs/parser.md)
- [core IR](docs/core-ir.md)
- [adapters](docs/adapters.md)
- [Diesel](docs/diesel.md)
- [SQLAlchemy](docs/sqlalchemy.md)
- [CLI](docs/cli.md)
- [reference tests](docs/reference-tests.md)

## Install

From npm (once published; see [docs/publishing.md](docs/publishing.md)):

```sh
npm install prisma-x        # library
npx -p prisma-x prismax --help   # CLI
```

From source:

Requires Node.js 20+ and pnpm. Python 3.9+ is used for the optional scripts, and Rust/cargo for
the optional Diesel compile check.

```sh
pnpm install
pnpm build
node dist/cli.js --help
```

## Test

```sh
pnpm typecheck       # tsc --noEmit (strict)
pnpm test            # vitest: parser, AST, core, adapters (file snapshots), CLI, reference cases
pnpm test:py         # pytest for scripts/ (no network)
pnpm compile-check   # optional: cargo check the generated Diesel code (skips without cargo)
pnpm check:sqlalchemy  # optional: import, configure and create the generated SQLAlchemy models
                       # (skips without SQLAlchemy 2)
```

## CI and publishing

CI is a thin caller of the shared [pyrlyn/ci](https://github.com/pyrlyn/ci) workflow
(`.github/workflows/pipeline.yml`, configured in `.github/infra.yml`). Releases publish to npm
with provenance via `.github/workflows/publish.yml`. Details: [docs/publishing.md](docs/publishing.md).

## Roadmap

- [x] Typed wrapper over the wasm engine: `parseSchema`, `validate`, `getDmmf`, `SchemaError`
- [x] Typed AST with indexes, `@map`, documentation and recovered `Unsupported(...)` fields
- [x] Custom foreign-key names (`@relation(map: ...)`), `@@ignore` models and `@ignore` fields,
      recovered from the schema text
- [x] Neutral core IR and `Adapter` interface
- [x] Diesel adapter (PostgreSQL, MySQL, SQLite), compile-checked with `cargo check`
- [x] SQLAlchemy 2.0 adapter, checked with real SQLAlchemy (`configure_mappers`, `create_all`)
- [x] `prismax generate` CLI
- [x] Behavioral tests ported from Prisma's validation suite
- [ ] Multi-file schemas
- [ ] Composite types (MongoDB), views
- [ ] Run as a Prisma generator (`generator x { provider = "prismax" }`)
- [ ] Browser build (wasm-bindgen `web` target)

## Limitations

- Private and not published to npm.
- Node.js only, synchronous. The wasm package is the wasm-bindgen `nodejs` target.
- Single-file schemas only. Diagnostics always report `fileName: "schema.prisma"`.
- Generated code covers the data model, not migrations. `relationMode = "prisma"` and index
  details beyond fields and names are not visible to adapters. See each adapter's doc for
  target-specific limitations (for example, Diesel's one `joinable!` per table pair, and SQLite
  `DateTime` storage).
- `@@ignore` models and `@ignore` fields are kept where the output describes the database and
  left out where it mirrors Prisma Client. A Diesel `table!` needs a primary key, so an ignored
  model without one is skipped there, with a warning.
- `getDmmf` returns the full DMMF, which is large (about 35 MB of JSON for 500 models).
  `parseSchema` uses the much smaller datamodel-only call.
- Engine bug in the pinned build: `getDmmf` panics on a model name whose *first* character is
  non-ASCII (e.g. `Ünï`). It is reported as `ENGINE_PANIC`; `parseSchema` and `validate` are not affected.
