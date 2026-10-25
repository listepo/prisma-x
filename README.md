# prisma-x

A demo TypeScript pipeline that parses [Prisma](https://www.prisma.io/) schemas into a typed AST,
built on the official Rust engine compiled to WebAssembly
([`@prisma/prisma-schema-wasm`](https://www.npmjs.com/package/@prisma/prisma-schema-wasm),
pinned to `8.1.0-2.59be4fda12412a79eeb9c2ae727b6aa723593323`).

```ts
import { parseSchema } from 'prisma-x';

const result = parseSchema(source);
if (result.ok) {
  for (const model of result.value.models) console.log(model.name);
} else {
  console.error(result.error.code, result.error.spans);
}
```

## Plan / roadmap

- [x] Typed wrapper over the wasm engine: `parseSchema`, `validate`, `getDmmf`
- [x] Discriminated-union results and a `SchemaError` class with codes and source spans
- [x] Typed AST (datasources, models, fields, enums, relations) derived from the DMMF
- [x] Edge-case test suite asserting real engine behavior
- [ ] Multi-file schemas (`prismaSchema` as `[path, content][]`)
- [ ] Generators and composite types (MongoDB) in the AST
- [ ] `format` support and a CLI (`prisma-x check schema.prisma`)
- [ ] Worker-thread offloading for very large schemas
- [ ] Browser build (wasm-bindgen `web` target)

## Architecture

```
src/index.ts          public API: functions, SchemaError, AST/DMMF types
src/parser.ts         pipeline: input check -> lint -> validate -> extract -> Result
src/ast.ts            AST types + DMMF datamodel -> AST mapping (relations derived here)
src/dmmf.ts           own typings of the DMMF JSON contract
src/errors.ts         SchemaError, Diagnostic, SourceSpan
src/spans.ts          offset -> line/column mapping
src/internal/wasm.ts  the only module that touches the wasm package (lazy load, panic capture)
```

The wasm package and its types never cross the public boundary. `src/index.ts` exports only
this library's own functions and types; a test enforces that. See [docs/parser.md](docs/parser.md)
for the details.

## Install

Requires Node.js 20+ and pnpm.

```sh
pnpm install
```

## Run

```sh
pnpm build          # emits dist/
node --input-type=module -e "import { parseSchema } from './dist/index.js'; console.log(JSON.stringify(parseSchema('model A {\n  id Int @id\n}\n'), null, 2))"
```

## Test

```sh
pnpm typecheck      # tsc --noEmit (strict)
pnpm test           # vitest run
```

## Limitations

- Demo-quality and private; not published to npm.
- Node.js only: the wasm package is the wasm-bindgen `nodejs` target (CommonJS, synchronous load).
- Single-file schemas only. Diagnostics always report `fileName: "schema.prisma"`.
- The AST is derived from the DMMF, so it only contains what the DMMF contains. There are no
  comments, no attribute positions, and no `Unsupported(...)` fields, which the engine omits.
- `getDmmf` returns the full DMMF, which is large: about 35 MB of JSON for 500 models.
  `parseSchema` uses the much smaller datamodel-only call.
- Engine bug in the pinned build: `getDmmf` panics on a model name whose *first* character is
  non-ASCII (e.g. `Ünï`). It is reported as `ENGINE_PANIC`; `parseSchema` and `validate` are not affected.
- All calls are synchronous and run on the calling thread.
