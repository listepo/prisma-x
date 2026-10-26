# Adapters

An adapter turns the [core IR](core-ir.md) into source files for one target. Two adapters are
built in:

| Name | Entry point | Output | Docs |
| --- | --- | --- | --- |
| `diesel` | `prisma-x/adapters/diesel` (`dieselAdapter`) | `schema.rs`, `models.rs` | [diesel.md](diesel.md) |
| `sqlalchemy` | `prisma-x/adapters/sqlalchemy` (`sqlalchemyAdapter`) | `models.py` | [sqlalchemy.md](sqlalchemy.md) |

## How it works

```ts
import { generate, formatDiagnostic } from 'prisma-x';
import { dieselAdapter } from 'prisma-x/adapters/diesel';

const result = generate(source, dieselAdapter, { provider: 'postgresql' });
if (!result.ok) throw result.error;                 // invalid schema: SchemaError
for (const d of result.value.diagnostics) console.warn(formatDiagnostic(d));
for (const file of result.value.files) console.log(file.path, file.contents);
```

The contract (`src/core/adapter.ts`):

- `generate(ir, options)` is a pure function. It returns files (`{ path, contents }`, with
  relative `/`-separated paths) and diagnostics. It must not throw for anything a valid schema
  can contain, and it must not mutate the IR.
- Anything the target cannot express becomes a **diagnostic**, not an exception:
  - `error`: part of the requested output is missing, such as an unsupported provider or a
    skipped model. The CLI exits with 1.
  - `warning`: the output was produced without something from the schema, such as an omitted
    column or relation helper.
  - `info`: a note about a mapping choice.

  Each diagnostic has a stable `code` and, where it applies, the `model` and `field`.
- `options.provider` overrides the schema's datasource provider (useful for schemas without a
  datasource). Adapters can extend `AdapterOptions` with their own options.
- Output is deterministic: the same IR always gives byte-identical files.
- Adapters own all target knowledge: type mapping, identifier rules, reserved words, naming
  conventions. The core has none. A test enforces that core modules never import adapters.
- Ignored parts (`isIgnored` on models, fields and relations) exist in the database but not in
  Prisma Client. Adapters keep them in whatever describes the database (a table definition,
  constraints) and leave them out of whatever mirrors the client (mapped classes, structs,
  relation helpers). What they emit or skip is reported with a diagnostic. See
  [sqlalchemy.md](sqlalchemy.md#how-it-works) and [diesel.md](diesel.md#how-it-works).

`src/adapters/shared.ts` holds small helpers that several adapters use: unique identifier
claiming, documentation lines and the `@generated` header.

## Writing an adapter

1. Create `src/adapters/<name>/index.ts` exporting `export const <name>Adapter: Adapter = { name, generate }`.
2. Register it in `src/adapters/index.ts` so the CLI can use it (`--adapter <name>`).
3. Add a subpath export to `package.json`.
4. Add `test/adapters/<name>.test.ts`. Loop over `test/fixtures/*.prisma` with
   `toMatchFileSnapshot`, as the existing adapter tests do, and add edge-case assertions.
5. Document it in `docs/<name>.md`.

The SQLAlchemy adapter was added this way with no change to `src/core`, which shows the IR is
target-neutral.

## Enabling and disabling

Adapters are opt-in. Nothing runs unless you call `adapter.generate` (directly or through
`generate`), or pass `--adapter` to the CLI. Importing the root entry point does not load any
adapter; import `prisma-x/adapters/<name>` for the one you need. To disable an adapter in the CLI,
remove it from `src/adapters/index.ts`.

## Testing

```sh
pnpm vitest run test/adapters             # snapshot and edge-case tests for all adapters
pnpm vitest run test/adapters -u          # accept changed snapshots after reviewing the diff
```

Snapshots live in `test/adapters/__snapshots__/<adapter>/<fixture>/`. Each holds the generated
files and a `diagnostics.txt`. Two scripts check generated code with the real target toolchain:
`pnpm compile-check` (Diesel, `cargo check`) and `pnpm check:sqlalchemy` (imports, mapper
configuration and DDL with SQLAlchemy).

## Limitations

- Adapters see only the IR. Anything the IR does not carry is unavailable to every adapter (see
  [core-ir.md](core-ir.md#limitations)).
- Adapters only generate code; neither one generates migrations.
