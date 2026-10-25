# Parser

## How it works

Every public function goes through the same pipeline (`src/parser.ts`):

1. **Input check.** A non-string input becomes an `INVALID_INPUT` failure; nothing throws.
2. **Lint.** `lint` returns structured diagnostics (`start`/`end` offsets, message,
   `is_warning`). Offsets are UTF-16 code units, which was verified against multi-byte input, so
   they index JS strings directly. `src/spans.ts` adds 1-based line/column positions.
3. **Validate.** `validate` throws a JSON payload `{ error_code, message }` on invalid schemas.
   It becomes `SchemaError { code: 'VALIDATION_FAILED', engineCode: 'P1012', spans }`, where the
   spans are the lint errors. Messages are requested with `noColor` and stripped of ANSI codes.
4. **Extract** (only for valid schemas):
   - `parseSchema` calls `get_datamodel` (models/enums only) and `get_config` (datasources), then
     maps them to the typed AST in `src/ast.ts`. Relations are derived by pairing relation fields
     on `relationName` plus the model pair. The side that owns the foreign key comes first.
   - `getDmmf` calls `get_dmmf` and returns the full document: a typed `datamodel`, with
     `schema` and `mappings` as untyped JSON.

Successes carry lint warnings (`result.warnings`), e.g. for renamed preview features.

### The wasm boundary

`src/internal/wasm.ts` is the only module that imports `@prisma/prisma-schema-wasm`:

- It loads the module **lazily** with `createRequire` on the first call, so importing the
  library costs nothing.
- It installs `globalThis.PRISMA_WASM_PANIC_REGISTRY`. The engine's panic hook writes the panic
  message there, and without it a panic turns into an unrelated `TypeError`. If a registry already
  exists (for example Prisma's own), it is chained, not replaced.
- It classifies failures: a `WebAssembly.RuntimeError` trap is an `ENGINE_PANIC`, and anything
  else is an engine error payload. The module stays usable after a panic (covered by a test).

`src/index.ts` never re-exports anything from the wasm package. The DMMF types in `src/dmmf.ts`
are this library's own typings of the JSON contract.

### Result and error types

```ts
type ParseResult<T> =
  | { ok: true; value: T; warnings: readonly Diagnostic[] }
  | { ok: false; error: SchemaError };

class SchemaError extends Error {
  code: 'INVALID_INPUT' | 'VALIDATION_FAILED' | 'ENGINE_PANIC' | 'MALFORMED_OUTPUT';
  engineCode: string | undefined; // e.g. "P1012"
  spans: readonly Diagnostic[];   // { fileName, start, end, startPosition, endPosition, severity, message }
}
```

## Enabling and disabling

The parser is a plain library with no global side effects at import time, so it is opt-in.

- **Enable:** import and call it.
  ```ts
  import { parseSchema, validate, getDmmf } from 'prisma-x';
  ```
  The wasm module (about 3 MB) is instantiated on the first call to any of these functions.
- **Disable / opt out:** don't call it. If no function is called, the wasm module is never loaded.
  To switch it off at runtime, gate the call site with your own flag:
  ```ts
  const ast = process.env.PRISMA_X_PARSER === 'off' ? null : parseSchema(source);
  ```
  Because results are values rather than exceptions, a disabled path and a failed parse can be
  handled the same way by callers.

## Testing

```sh
pnpm test                         # all suites
pnpm vitest run test/parser.test.ts
pnpm vitest                       # watch mode
```

Suites:

- `test/parser.test.ts`: validation and edge cases. Covers an empty schema, syntax errors,
  unknown types, duplicate models, a missing datasource (valid), invalid relations, unknown
  providers, the removed `url` property, warnings, Unicode identifiers/strings and span offsets,
  the `getDmmf` Unicode panic, and 500-model inputs.
- `test/ast.test.ts`: AST mapping (field kinds, defaults, native types, keys, the four relation
  shapes, same-named relations across model pairs).
- `test/public-api.test.ts`: the public surface exports no wasm functions or types.
- `test/lazy-load.test.ts`: the wasm module loads only on first use.

Expectations come from running the engine, not from guessing. When you bump the wasm
version, run the suite and update the assertions that changed.

## Limitations

- Node.js only, synchronous, single-threaded. A 500-model `getDmmf` takes about 0.4 s;
  `parseSchema` takes about 0.07 s.
- Single-file schemas only; `fileName` is always `schema.prisma`.
- The AST holds what the DMMF holds. There are no comments or attribute positions, and
  `Unsupported(...)` fields are omitted by the engine. Generators and composite types are not mapped.
- `getDmmf` panics (`ENGINE_PANIC`) on model names that start with a non-ASCII character. This
  is a bug in the pinned engine build; `parseSchema` uses `get_datamodel`, which is unaffected.
- Errors that only `get_config` reports (after validation passed) carry no spans.
