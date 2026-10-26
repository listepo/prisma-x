# Diesel adapter

Generates [Diesel 2](https://diesel.rs) code from a Prisma schema: `schema.rs` with the table
definitions and `models.rs` with structs and enums. Supports PostgreSQL (and CockroachDB, through
the PostgreSQL backend), MySQL and SQLite.

```sh
prismax generate --adapter diesel --schema prisma/schema.prisma --out src/db
```

```rust
// src/db/mod.rs
pub mod schema;
pub mod models;
```

## How it works

`src/adapters/diesel/index.ts` plans tables, then renders two files.

**`schema.rs`**

- `pub mod sql_types` declares one `SqlType` struct per enum used by a table:
  `#[diesel(postgres_type(name = "..."))]` on PostgreSQL and `#[diesel(mysql_type(name = "Enum"))]`
  on MySQL. SQLite stores enums as `Text`.
- `diesel::table!` for each model. The table ident is the snake_case model name, and the column
  idents are the snake_case field names. `#[sql_name = "..."]` keeps the real name whenever it
  differs (from `@@map`/`@map` or case conversion). The primary key is `@id`/`@@id`. Optional
  fields become `Nullable<...>` and lists become `Array<...>`. `@@schema` becomes a `schema.table`
  prefix.
- `diesel::joinable!` for each single-column foreign key that references the primary key.
- `diesel::allow_tables_to_appear_in_same_query!` with all tables (when there are two or more).

**`models.rs`**

- One struct per table deriving `Queryable, Selectable, Identifiable, Insertable` (plus
  `Associations` with `#[diesel(belongs_to(Parent, foreign_key = ...))]` when it has foreign keys),
  `Debug, Clone, PartialEq`. It also gets `#[diesel(check_for_backend(...))]`, so field/column type
  mismatches are compile errors. Fields follow the column order.
- `New<Model>`: an `Insertable` struct, emitted when the table has database defaults. It leaves
  out `autoincrement()` columns and makes columns with database defaults optional (`None`
  inserts `DEFAULT`).
- One Rust enum per Prisma enum, with `db_value()`/`from_db_value()` and `ToSql`/`FromSql` impls
  for the backend. The stored values are the `@map` names.
- The header lists the Diesel features and crates that the generated types need.

**Implicit many-to-many** relations become a join table `table!` (`_<Relation>` via `sql_name`)
with columns `a` and `b` (`sql_name` `A`/`B`), primary key `(a, b)`, `joinable!` to both sides,
and a struct that `belongs_to` both models.

**Ignored parts.** Prisma Client leaves out `@@ignore` models and `@ignore` fields, but they exist
in the database. `schema.rs` describes the database, so it keeps them. `models.rs` mirrors the
client, so it leaves them out:

| Prisma | `schema.rs` | `models.rs` |
| --- | --- | --- |
| `@@ignore` model with a key | `table!`, `joinable!` | No struct; no `belongs_to` to it; no struct for a join table that relates it (`IGNORED_MODEL` info) |
| `@@ignore` model without `@id`/`@unique` | Skipped: `table!` needs a primary key (`IGNORED_MODEL_SKIPPED` warning) | Nothing |
| `@ignore` scalar field | Column | Left out of the struct and `New<Model>`; the struct doc says to select with `<Struct>::as_select()` |
| `@ignore` relation field | Unchanged | Unchanged: Diesel has no relation fields, and `belongs_to` stays while both structs exist |

Foreign-key constraint names (`@relation(map: ...)`) are not used: Diesel does not model
constraints.

**Identifiers.** Rust keywords get a `_` suffix (`type` becomes `type_`). A column may not share
its table's name or the items that `table!` generates (`table`, `columns`, `star`, `all_columns`,
`dsl`), so such columns get a `_` suffix too (`orders.order` becomes `order_`). Name collisions
after case conversion are resolved the same way. Enum names that clash with Diesel SQL types
(`Text`, `Date`, ...) get a `_` suffix.

### Type mapping

| Prisma | PostgreSQL | MySQL | SQLite | Rust |
| --- | --- | --- | --- | --- |
| `String` | `Text` | `Varchar` | `Text` | `String` |
| `Boolean` | `Bool` | `Bool` | `Bool` | `bool` |
| `Int` | `Int4` | `Integer` | `Integer` | `i32` |
| `BigInt` | `Int8` | `BigInt` | `BigInt` | `i64` |
| `Float` | `Float8` | `Double` | `Double` | `f64` |
| `Decimal` | `Numeric` | `Numeric` | `Double` (warning) | `bigdecimal::BigDecimal` (`f64` on SQLite) |
| `DateTime` | `Timestamp` | `Datetime` | `Timestamp` | `chrono::NaiveDateTime` |
| `Json` | `Jsonb` | `Json` | `Text` (info) | `serde_json::Value` (`String` on SQLite) |
| `Bytes` | `Bytea` | `Blob` | `Binary` | `Vec<u8>` |
| enum | custom `SqlType` | custom `SqlType` | `Text` | generated enum |

Native types are honored, for example:

- PostgreSQL: `@db.Uuid` becomes `Uuid`/`uuid::Uuid`, `@db.Timestamptz` becomes
  `Timestamptz`/`chrono::DateTime<chrono::Utc>`, `@db.SmallInt` becomes `Int2`/`i16`,
  `@db.Money` becomes `Money`/`PgMoney`, and `@db.Date`/`@db.Time` map to the chrono types.
- MySQL: unsigned integers become `Unsigned<...>`/`u*`, and `@db.TinyInt` becomes `TinyInt`/`i8`.

See `src/adapters/diesel/types.ts` for the full table.

### Diagnostics

| Code | Severity | Meaning |
| --- | --- | --- |
| `MISSING_PROVIDER` | error | No datasource and no `--provider`; nothing generated |
| `UNSUPPORTED_PROVIDER` | error | Not PostgreSQL, CockroachDB, MySQL or SQLite (e.g. MongoDB, SQL Server) |
| `KEY_COLUMN_OMITTED` | error | A primary key column has no Diesel type; the model is skipped |
| `NO_PRIMARY_KEY` | error | No `@id` and no usable `@unique`; the model is skipped |
| `UNSUPPORTED_FIELD` | warning | `Unsupported("...")` column omitted |
| `UNSUPPORTED_TYPE` | warning | Native type without a Diesel type (`@db.Inet`, `@db.Xml`, `@db.Bit`, `@db.Year`, ...); column omitted |
| `TYPE_APPROXIMATED` | warning/info | SQLite `Decimal` becomes `Double` (warning); SQLite `Json` becomes `Text` (info) |
| `RELATION_HELPERS_SKIPPED` | warning | Composite foreign key, or one that does not reference the primary key: no `joinable!`/`belongs_to` |
| `JOINABLE_SKIPPED` | info/warning | Self-relation (info), or the table pair already has a `joinable!` (warning) |
| `BELONGS_TO_SKIPPED` | warning | The struct already `belongs_to` that parent type |
| `JOIN_TABLE_SKIPPED` | warning | A many-to-many side refers to a skipped model |
| `TOO_MANY_COLUMNS` | warning | More than 32 columns: enable Diesel's `64-column-tables`/`128-column-tables` feature |
| `PRIMARY_KEY_FROM_UNIQUE` | info | No `@id`; a unique constraint is used as the Diesel primary key |
| `IGNORED_MODEL` | info | `@@ignore` model: `table!` only, no struct |
| `IGNORED_MODEL_SKIPPED` | warning | `@@ignore` model without a usable key; no `table!` |
| `SQLITE_DATETIME` | info | See limitations |
| `COCKROACHDB_AS_POSTGRES` | info | CockroachDB is generated with the PostgreSQL backend |

## Enabling and disabling

- **Enable:** `prismax generate --adapter diesel ...`, or in code:
  ```ts
  import { generate } from 'prisma-x';
  import { dieselAdapter } from 'prisma-x/adapters/diesel';
  const result = generate(source, dieselAdapter, { provider: 'postgresql' });
  ```
- In the Rust crate, enable the Diesel backend feature and the features listed in the
  `models.rs` header, for example:
  ```toml
  diesel = { version = "2.2", features = ["postgres", "chrono", "serde_json", "uuid", "numeric"] }
  chrono = "0.4"
  serde_json = "1"
  uuid = "1"
  bigdecimal = "0.4"
  ```
- **Disable:** don't pass `--adapter diesel`. The adapter is never loaded unless it is imported.
  To leave out individual models, there is no per-model switch; remove them from the schema you
  generate from.

## Testing

```sh
pnpm vitest run test/adapters/diesel.test.ts      # snapshots + edge cases
pnpm compile-check                                # optional: cargo check the generated code
```

- `test/adapters/diesel.test.ts` generates code for every `test/fixtures/*.prisma` and compares
  it with `test/adapters/__snapshots__/diesel/<fixture>/{schema.rs,models.rs,diagnostics.txt}`.
  It also checks composite ids, self-relations, many-to-many, enums per backend, type mapping per
  backend, `@map`/`@@map` and identifier escaping, unsupported types reported as diagnostics,
  skipped models, ignored models and columns, provider handling and determinism.
- `scripts/compile_check_diesel.py` (`pnpm compile-check`) builds the CLI. It then generates
  every fixture into a temporary Cargo project per backend, with Diesel and the needed features,
  and runs `cargo check`.
  - It exits 0 with a message when `cargo` is not installed.
  - It honors `CARGO_TARGET_DIR` (set it to reuse the build cache between runs).
  - `--workdir DIR` keeps the projects for inspection.
  - The MySQL client library is not needed: unless `MYSQLCLIENT_LIB_DIR` is set, the script
    points `mysqlclient-sys` at an empty directory, because `cargo check` never links.

  The first run downloads and compiles Diesel and takes a few minutes.

## Limitations

- **One `joinable!` per table pair.** Diesel allows a single `joinable!` between two tables. With
  several relations between the same pair, only the first gets one; join the others with
  explicit `ON` clauses. Self-relations get no `joinable!`; use `diesel::alias!`.
- **One `belongs_to` per parent type.** Later relations to the same parent are skipped.
- Relation helpers are only generated for single-column foreign keys that reference the primary
  key.
- **SQLite `DateTime`.** Prisma stores `DateTime` on SQLite as Unix milliseconds (integers).
  Diesel's `Timestamp` expects text, so rows written by Prisma may not deserialize. Map those
  columns by hand if you share a SQLite database with Prisma.
- MySQL enums use one `Enum` SQL type per Rust enum; the values are not checked by Diesel.
- No `diesel::sql_types` mapping for `@db.Inet`/`@db.Cidr` (Diesel's `network-address` feature
  is not used), `@db.Xml`, `@db.Bit`, `@db.VarBit`, `@db.Timetz` or `@db.Year`. These columns are
  omitted with a warning, and a model is skipped if such a column is part of its primary key.
- Defaults are not represented in `schema.rs` (Diesel has no notion of them). Client-side defaults
  (`uuid()`, `cuid()`, ...) must be filled in by your code.
- Indexes and unique constraints are not represented (Diesel does not model them); use
  migrations for DDL.
- A struct without its `@ignore` columns does not match `table.load::<Struct>()`, which selects
  every column. Select with `Struct::as_select()`. Inserting it leaves the ignored columns to
  their database default.
- `relationMode = "prisma"` is not visible (see [core-ir.md](core-ir.md#limitations)).
