# prismax development plan

## 1. Current state
- Demo TypeScript wrapper over `@prisma/prisma-schema-wasm` (commit `d0e2605` on `main`, pushed to github.com/listepo/prismax).
- Typecheck clean, 42/42 tests passing.
- Public API: `parseSchema`, `validate`, `getDmmf`. Each returns either a result or a typed `SchemaError`. Wasm is internal (`src/internal/wasm.ts`) and never exported.
- `scripts/copy_prisma_tests.py` fetches Prisma test suites into `tests-reference/` (excluded from build and test runner).

## 2. Goal
Convert a Prisma schema into ORM code for other ecosystems. The core is target-agnostic; output targets are pluggable adapters (adapter pattern, not "providers").

## 3. Architecture
```
schema.prisma -> parser (wasm wrapper) -> AST/DMMF -> core -> neutral model IR -> adapter -> target code
```
- **Core**: builds a neutral intermediate representation (IR): models, fields/properties, types, names (with case conversion), ids, unique/index, relations, enums, defaults, attributes. No target-specific knowledge.
- **Adapter interface**: takes the IR and emits files (e.g. `{ path, contents }[]`) plus diagnostics for unsupported features. Adapters own type mapping and naming conventions of their target.
- **Adapters**: Diesel (first), later SQLAlchemy or others, without changes to the core.

## 4. Milestones
1. Define the IR types and the `Adapter` interface; core mapping from DMMF/AST to IR; IR unit tests.
2. Diesel adapter: `schema.rs` (`table!`, `joinable!`, `allow_tables_to_appear_in_same_query!`), model structs (`Queryable`, `Insertable`, `Selectable`, `Identifiable`, `Associations`), enums, type mapping per database (Postgres, MySQL, SQLite).
3. Diesel adapter tests: snapshot tests per fixture schema, plus edge cases (composite ids, self-relations, many-to-many, enums, `@map`/`@@map`, unsupported types reported as diagnostics). Optionally compile-check generated Rust in CI.
4. Reference tests: use `scripts/copy_prisma_tests.py` to refresh language-independent Prisma suites (schema fixtures, snapshots) into `tests-reference/`; port selected cases as behavioral tests for the parser.
5. CLI (`prismax generate --adapter diesel`), docs per feature (how it works, enable/disable, test, limitations).
6. Second adapter (SQLAlchemy) to validate the abstraction.

## 5. Out of scope
- Build performance work (slow builds, extra artifacts) is a separate task, scheduled for Oct 26, 10:00 Kyiv time, and not part of this plan.

## 6. Known limitations
- `get_dmmf` panics on model names starting with a non-ASCII character (engine bug; surfaced as `ENGINE_PANIC`).
- `Unsupported(...)` fields are dropped by the engine.
- TypeScript only for now.
