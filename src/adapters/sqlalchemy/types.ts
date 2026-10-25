/** Prisma scalar/native types -> SQLAlchemy 2.0 column types and Python types, per dialect. */
import type { IrNativeType, ScalarType } from '../../core/ir.js';

export type Dialect = 'postgresql' | 'mysql' | 'sqlite' | 'generic';

export interface PyType {
  /** Column type expression, e.g. `sa.String(255)`. */
  readonly sa: string;
  /** Python type used in `Mapped[...]`. */
  readonly py: string;
}

export interface TypeMapping {
  readonly type: PyType;
  /** Set when a native type has no mapping and the scalar default is used instead. */
  readonly fallbackReason?: string;
}

const PY: Readonly<Record<ScalarType, string>> = {
  String: 'str',
  Boolean: 'bool',
  Int: 'int',
  BigInt: 'int',
  Float: 'float',
  Decimal: 'decimal.Decimal',
  DateTime: 'datetime.datetime',
  Json: 'Any',
  Bytes: 'bytes',
};

function defaultType(dialect: Dialect, type: ScalarType): string {
  switch (type) {
    case 'String':
      return dialect === 'mysql' ? 'sa.String(191)' : 'sa.Text()';
    case 'Boolean':
      return 'sa.Boolean()';
    case 'Int':
      return 'sa.Integer()';
    case 'BigInt':
      return 'sa.BigInteger()';
    case 'Float':
      return 'sa.Double()';
    case 'Decimal':
      return dialect === 'postgresql' || dialect === 'mysql' ? 'sa.Numeric(65, 30)' : 'sa.Numeric()';
    case 'DateTime':
      if (dialect === 'postgresql') return 'postgresql.TIMESTAMP(precision=3)';
      if (dialect === 'mysql') return 'mysql.DATETIME(fsp=3)';
      return 'sa.DateTime()';
    case 'Json':
      return dialect === 'postgresql' ? 'postgresql.JSONB()' : 'sa.JSON()';
    case 'Bytes':
      return dialect === 'mysql' ? 'mysql.LONGBLOB()' : 'sa.LargeBinary()';
  }
}

type NativeRule = (args: readonly string[]) => { sa: string; py?: string };

const sized =
  (ctor: string): NativeRule =>
  (args) => ({ sa: `${ctor}(${args.join(', ')})` });
const fixed =
  (expr: string, py?: string): NativeRule =>
  () => (py === undefined ? { sa: expr } : { sa: expr, py });
const precision =
  (ctor: string, keyword: string, extra = ''): NativeRule =>
  (args) => ({ sa: `${ctor}(${[extra, args[0] === undefined ? '' : `${keyword}=${args[0]}`].filter(Boolean).join(', ')})` });

const POSTGRES_NATIVE: Readonly<Record<string, NativeRule>> = {
  Text: fixed('sa.Text()'),
  VarChar: sized('sa.String'),
  Char: sized('sa.CHAR'),
  Citext: fixed('postgresql.CITEXT()'),
  Uuid: fixed('sa.Uuid(as_uuid=False)'),
  Inet: fixed('postgresql.INET()'),
  Cidr: fixed('postgresql.CIDR()'),
  Bit: sized('postgresql.BIT'),
  VarBit: (args) => ({ sa: `postgresql.BIT(${[...args, 'varying=True'].join(', ')})` }),
  Boolean: fixed('sa.Boolean()'),
  Bool: fixed('sa.Boolean()'),
  SmallInt: fixed('sa.SmallInteger()'),
  Int2: fixed('sa.SmallInteger()'),
  Integer: fixed('sa.Integer()'),
  Int4: fixed('sa.Integer()'),
  BigInt: fixed('sa.BigInteger()'),
  Int8: fixed('sa.BigInteger()'),
  Oid: fixed('postgresql.OID()'),
  Real: fixed('sa.REAL()'),
  Float4: fixed('sa.REAL()'),
  DoublePrecision: fixed('sa.Double()'),
  Float8: fixed('sa.Double()'),
  Decimal: sized('sa.Numeric'),
  Money: fixed('postgresql.MONEY()', 'str'),
  Timestamp: precision('postgresql.TIMESTAMP', 'precision'),
  Timestamptz: precision('postgresql.TIMESTAMP', 'precision', 'timezone=True'),
  Date: fixed('sa.Date()', 'datetime.date'),
  Time: precision('postgresql.TIME', 'precision'),
  Timetz: precision('postgresql.TIME', 'precision', 'timezone=True'),
  Json: fixed('sa.JSON()'),
  JsonB: fixed('postgresql.JSONB()'),
  ByteA: fixed('sa.LargeBinary()'),
  Bytes: fixed('sa.LargeBinary()'),
  String: fixed('sa.Text()'),
};

const MYSQL_NATIVE: Readonly<Record<string, NativeRule>> = {
  VarChar: sized('sa.String'),
  Char: sized('sa.CHAR'),
  TinyText: fixed('mysql.TINYTEXT()'),
  Text: fixed('sa.Text()'),
  MediumText: fixed('mysql.MEDIUMTEXT()'),
  LongText: fixed('mysql.LONGTEXT()'),
  Bit: sized('mysql.BIT'),
  TinyInt: fixed('mysql.TINYINT()'),
  UnsignedTinyInt: fixed('mysql.TINYINT(unsigned=True)'),
  SmallInt: fixed('sa.SmallInteger()'),
  UnsignedSmallInt: fixed('mysql.SMALLINT(unsigned=True)'),
  MediumInt: fixed('mysql.MEDIUMINT()'),
  UnsignedMediumInt: fixed('mysql.MEDIUMINT(unsigned=True)'),
  Int: fixed('sa.Integer()'),
  UnsignedInt: fixed('mysql.INTEGER(unsigned=True)'),
  BigInt: fixed('sa.BigInteger()'),
  UnsignedBigInt: fixed('mysql.BIGINT(unsigned=True)'),
  Year: fixed('mysql.YEAR()'),
  Float: fixed('sa.Float()'),
  Double: fixed('sa.Double()'),
  Decimal: sized('sa.Numeric'),
  DateTime: precision('mysql.DATETIME', 'fsp'),
  Timestamp: precision('mysql.TIMESTAMP', 'fsp'),
  Date: fixed('sa.Date()', 'datetime.date'),
  Time: precision('mysql.TIME', 'fsp'),
  Json: fixed('sa.JSON()'),
  Binary: sized('sa.BINARY'),
  VarBinary: sized('sa.VARBINARY'),
  TinyBlob: fixed('mysql.TINYBLOB()'),
  Blob: fixed('sa.BLOB()'),
  MediumBlob: fixed('mysql.MEDIUMBLOB()'),
  LongBlob: fixed('mysql.LONGBLOB()'),
};

const NATIVE: Readonly<Record<Dialect, Readonly<Record<string, NativeRule>>>> = {
  postgresql: POSTGRES_NATIVE,
  mysql: MYSQL_NATIVE,
  sqlite: {},
  generic: {},
};

/** Time-only native types map to `datetime.time`. */
const TIME_TYPES = new Set(['Time', 'Timetz']);

function render(native: IrNativeType): string {
  return `@db.${native.name}${native.args.length > 0 ? `(${native.args.join(', ')})` : ''}`;
}

/** Maps a non-list scalar column type. Unknown native types fall back to the scalar default. */
export function mapScalarType(dialect: Dialect, type: ScalarType, native: IrNativeType | null): TypeMapping {
  const py = PY[type];
  if (native === null) return { type: { sa: defaultType(dialect, type), py } };
  if (type === 'Boolean') return { type: { sa: 'sa.Boolean()', py } };
  const rule = NATIVE[dialect][native.name];
  if (rule === undefined) {
    return {
      type: { sa: defaultType(dialect, type), py },
      fallbackReason: `native type ${render(native)} is not mapped for SQLAlchemy`,
    };
  }
  const mapped = rule(native.args);
  return { type: { sa: mapped.sa, py: mapped.py ?? (TIME_TYPES.has(native.name) ? 'datetime.time' : py) } };
}
