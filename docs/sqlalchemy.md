# SQLAlchemy adapter

Generates [SQLAlchemy 2.0](https://docs.sqlalchemy.org/en/20/) declarative models (`Mapped[...]`,
`mapped_column`, `relationship`) from a Prisma schema, as one `models.py`. It was added as a
second adapter to check that the core IR is target-neutral: it needed no change to `src/core`.

```sh
prismax generate --adapter sqlalchemy --schema prisma/schema.prisma --out app/db
```

```python
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from app.db.models import Base, User

engine = create_engine("postgresql+psycopg://...")
with Session(engine) as session:
    users = session.scalars(select(User).where(User.email.like("%@example.com"))).all()
```

## How it works

`src/adapters/sqlalchemy/index.ts` renders, in order:

1. Imports, added only as needed, then `class Base(DeclarativeBase)`.
2. **Enums**: `class Status(str, enum.Enum)` with the stored (`@map`) values as member values.
   Columns use `sa.Enum(Status, name="<@@map name>", values_callable=_enum_values)`, so the
   database holds the values Prisma writes, not the Python member names.
3. **Association tables** for implicit many-to-many relations. `<relation>_table = sa.Table("_<Relation>", Base.metadata, ...)`
   has columns `A` and `B` with cascading named foreign keys, a primary key (PostgreSQL) or
   `UniqueConstraint("A", "B")` (other databases), and `sa.Index` on `B`. These match the tables
   Prisma Migrate creates.
4. **Model classes**:
   - `__tablename__` and `__table_args__`, which hold a composite `PrimaryKeyConstraint`,
     `UniqueConstraint`/`Index` (MySQL `@@fulltext` becomes `mysql_prefix="FULLTEXT"`), composite
     `ForeignKeyConstraint` and `{"schema": ...}`. All constraint names follow Prisma's names.
   - One `Mapped[...] = mapped_column(...)` per column in declaration order. Attribute names
     are snake_case, and the column name is passed explicitly when it differs. Single-column
     foreign keys use `sa.ForeignKey(..., ondelete=, onupdate=, name=)` with Prisma's effective
     referential actions.
   - One `relationship()` per relation field, with `back_populates`. `foreign_keys` is always
     set, so several relations between the same models work. Self-relations add
     `remote_side`, and self many-to-many relations add explicit `primaryjoin`/`secondaryjoin`.
   - Models without `@id` use a unique constraint as the mapper primary key
     (`__mapper_args__ = {"primary_key": [...]}`).

**Defaults**

| Prisma | SQLAlchemy |
| --- | --- |
| `autoincrement()` | `autoincrement=True` |
| `now()` | `server_default=sa.func.now()` |
| `@updatedAt` | `default=sa.func.now(), onupdate=sa.func.now()` |
| `dbgenerated("expr")` | `server_default=sa.text("expr")` (`sa.FetchedValue()` without an argument) |
| `uuid()` | `default=lambda: str(uuid.uuid4())` |
| literals | `server_default=...` (`sa.true()`/`sa.false()`, `sa.text("42")`, enum values, strings) |
| `cuid()`, `nanoid()`, `ulid()`, `uuid(7)`, list defaults | not rendered (`DEFAULT_SKIPPED`) |

**Identifiers.** Python keywords and names the module uses (`sa`, `metadata`, `registry`,
`Mapped`, ...) get a `_` suffix (`class` becomes `class_`); the column keeps its real name.

### Type mapping

| Prisma | PostgreSQL | MySQL | SQLite / generic | Python |
| --- | --- | --- | --- | --- |
| `String` | `sa.Text()` | `sa.String(191)` | `sa.Text()` | `str` |
| `Boolean` | `sa.Boolean()` | `sa.Boolean()` | `sa.Boolean()` | `bool` |
| `Int` / `BigInt` | `sa.Integer()` / `sa.BigInteger()` | same | same | `int` |
| `Float` | `sa.Double()` | `sa.Double()` | `sa.Double()` | `float` |
| `Decimal` | `sa.Numeric(65, 30)` | `sa.Numeric(65, 30)` | `sa.Numeric()` | `decimal.Decimal` |
| `DateTime` | `postgresql.TIMESTAMP(precision=3)` | `mysql.DATETIME(fsp=3)` | `sa.DateTime()` | `datetime.datetime` |
| `Json` | `postgresql.JSONB()` | `sa.JSON()` | `sa.JSON()` | `Any` |
| `Bytes` | `sa.LargeBinary()` | `mysql.LONGBLOB()` | `sa.LargeBinary()` | `bytes` |
| `String[]` etc. | `postgresql.ARRAY(...)` | `sa.JSON()` (warning) | `sa.JSON()` (warning) | `list[...]` |

PostgreSQL and MySQL native types (`@db.VarChar(n)`, `@db.Uuid`, `@db.Timestamptz(6)`,
`@db.Inet`, `@db.UnsignedInt`, `@db.Year`, ...) map to the matching SQLAlchemy or dialect types;
see `src/adapters/sqlalchemy/types.ts`. Unknown native types fall back to the scalar default with
a `NATIVE_TYPE_FALLBACK` warning. CockroachDB uses the PostgreSQL mapping. SQL Server and schemas
without a datasource use generic types (`GENERIC_DIALECT` info).

### Diagnostics

| Code | Severity | Meaning |
| --- | --- | --- |
| `UNSUPPORTED_PROVIDER` | error | MongoDB; nothing generated |
| `NO_PRIMARY_KEY` | error | No `@id` and no usable `@unique`; the model is skipped |
| `UNSUPPORTED_FIELD` | warning | `Unsupported("...")` column omitted |
| `NATIVE_TYPE_FALLBACK` | warning | Native type without a mapping (e.g. `@db.Xml`); the scalar default is used |
| `SCALAR_LIST` | warning | Scalar list outside PostgreSQL, mapped to `sa.JSON()` |
| `DEFAULT_SKIPPED` | warning | A client-side default without a Python equivalent |
| `CONSTRAINT_SKIPPED` | warning | A constraint uses an omitted column |
| `RELATIONSHIP_SKIPPED` | warning | A relation uses an omitted foreign-key column |
| `ASSOCIATION_TABLE_SKIPPED` | warning | A many-to-many side has no usable key |
| `PRIMARY_KEY_FROM_UNIQUE` | info | No `@id`; a unique constraint is the mapper primary key |
| `GENERIC_DIALECT` | info | No dialect-specific mapping for the provider |

## Enabling and disabling

- **Enable:** `prismax generate --adapter sqlalchemy ...`, or in code:
  ```ts
  import { generate } from 'prisma-x';
  import { sqlalchemyAdapter } from 'prisma-x/adapters/sqlalchemy';
  const result = generate(source, sqlalchemyAdapter);
  ```
  The generated module needs `sqlalchemy>=2.0` and a driver for your database.
- **Disable:** don't pass `--adapter sqlalchemy`. The adapter is never loaded unless imported.

## Testing

```sh
pnpm vitest run test/adapters/sqlalchemy.test.ts
```

`test/adapters/sqlalchemy.test.ts` generates code for every `test/fixtures/*.prisma`, the same
fixtures as Diesel, and compares it with
`test/adapters/__snapshots__/sqlalchemy/<fixture>/{models.py,diagnostics.txt}`. It also checks:

- both adapters consume the same IR without modifying it
- association tables
- enums
- composite keys and foreign keys
- self-relations
- unique-only models
- identifier escaping
- defaults
- scalar lists
- provider handling

To check the generated Python by hand:

```sh
python3 -m py_compile test/adapters/__snapshots__/sqlalchemy/*/models.py
python3 -c "import sys; sys.path.insert(0, 'test/adapters/__snapshots__/sqlalchemy/blog'); import models, sqlalchemy.orm as o; o.configure_mappers()"
```

The second command needs SQLAlchemy 2 installed. It runs the mapper configuration, which
resolves relationships, foreign keys and joins.

## Limitations

- The test suite compares snapshots but does not import them with SQLAlchemy (the repository
  installs no Python packages). The snapshots were syntax-checked, but `configure_mappers()` has
  not been run against them yet. Run the check above when changing the adapter.
- Custom names of single-column primary keys (`@id(map: "...")`) are lost: SQLAlchemy names
  inline primary keys itself. Composite keys keep their names.
- SQLite `DateTime`: Prisma stores Unix milliseconds, while `sa.DateTime()` expects ISO text.
  Use a custom type if you share a SQLite database with Prisma.
- `cuid()`, `nanoid()`, `ulid()` and `uuid(7)` have no standard-library equivalent and are not
  rendered; set those values in your code.
- Index details (sort order, length, type) and custom foreign-key names are not available (see
  [core-ir.md](core-ir.md#limitations)).
- MongoDB is not supported.
