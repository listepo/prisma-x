/** Prisma scalar/native types -> Diesel SQL types and Rust types, per backend. */
import type { IrNativeType, ScalarType } from '../../core/ir.js';

export type DieselBackend = 'pg' | 'mysql' | 'sqlite';

export interface DieselType {
  /** Diesel SQL type as written in `table!`, e.g. `Int4`. */
  readonly sql: string;
  readonly rust: string;
}

export type TypeMapping =
  | { readonly ok: true; readonly type: DieselType; readonly note?: { readonly severity: 'warning' | 'info'; readonly message: string } }
  | { readonly ok: false; readonly reason: string };

const t = (sql: string, rust: string): DieselType => ({ sql, rust });

const TEXT = t('Text', 'String');
const BOOL = t('Bool', 'bool');
const DECIMAL = t('Numeric', 'bigdecimal::BigDecimal');
const DATETIME = t('Timestamp', 'chrono::NaiveDateTime');
const DATE = t('Date', 'chrono::NaiveDate');
const TIME = t('Time', 'chrono::NaiveTime');
const JSON_VALUE = 'serde_json::Value';
const BYTES = 'Vec<u8>';

/** A native type Diesel cannot represent with its built-in types and default features. */
type Unsupported = string;

const DEFAULTS: Readonly<Record<DieselBackend, Readonly<Record<ScalarType, DieselType>>>> = {
  pg: {
    String: TEXT,
    Boolean: BOOL,
    Int: t('Int4', 'i32'),
    BigInt: t('Int8', 'i64'),
    Float: t('Float8', 'f64'),
    Decimal: DECIMAL,
    DateTime: DATETIME,
    Json: t('Jsonb', JSON_VALUE),
    Bytes: t('Bytea', BYTES),
  },
  mysql: {
    String: t('Varchar', 'String'),
    Boolean: BOOL,
    Int: t('Integer', 'i32'),
    BigInt: t('BigInt', 'i64'),
    Float: t('Double', 'f64'),
    Decimal: DECIMAL,
    DateTime: t('Datetime', 'chrono::NaiveDateTime'),
    Json: t('Json', JSON_VALUE),
    Bytes: t('Blob', BYTES),
  },
  sqlite: {
    String: TEXT,
    Boolean: BOOL,
    Int: t('Integer', 'i32'),
    BigInt: t('BigInt', 'i64'),
    Float: t('Double', 'f64'),
    // Placeholders: both get a note in mapScalarType.
    Decimal: t('Double', 'f64'),
    DateTime: DATETIME,
    Json: TEXT,
    Bytes: t('Binary', BYTES),
  },
};

const PG_NATIVE: Readonly<Record<string, DieselType | Unsupported>> = {
  Text: TEXT,
  VarChar: t('Varchar', 'String'),
  Char: t('Bpchar', 'String'),
  Citext: TEXT,
  Uuid: t('Uuid', 'uuid::Uuid'),
  Xml: 'xml has no Diesel type',
  Inet: "inet needs Diesel's network-address feature",
  Cidr: "cidr needs Diesel's network-address feature",
  Bit: 'bit has no Diesel type',
  VarBit: 'varbit has no Diesel type',
  Boolean: BOOL,
  Bool: BOOL,
  SmallInt: t('Int2', 'i16'),
  Int2: t('Int2', 'i16'),
  Integer: t('Int4', 'i32'),
  Int4: t('Int4', 'i32'),
  BigInt: t('Int8', 'i64'),
  Int8: t('Int8', 'i64'),
  Oid: t('Oid', 'u32'),
  Real: t('Float4', 'f32'),
  Float4: t('Float4', 'f32'),
  DoublePrecision: t('Float8', 'f64'),
  Float8: t('Float8', 'f64'),
  Decimal: DECIMAL,
  Money: t('Money', 'diesel::data_types::PgMoney'),
  Timestamp: DATETIME,
  Timestamptz: t('Timestamptz', 'chrono::DateTime<chrono::Utc>'),
  Date: DATE,
  Time: TIME,
  Timetz: 'timetz has no Diesel type',
  Json: t('Json', JSON_VALUE),
  JsonB: t('Jsonb', JSON_VALUE),
  ByteA: t('Bytea', BYTES),
  Bytes: t('Bytea', BYTES),
  String: TEXT,
};

const MYSQL_NATIVE: Readonly<Record<string, DieselType | Unsupported>> = {
  VarChar: t('Varchar', 'String'),
  Char: TEXT,
  TinyText: TEXT,
  Text: TEXT,
  MediumText: TEXT,
  LongText: TEXT,
  Bit: 'bit has no Diesel type',
  TinyInt: t('TinyInt', 'i8'),
  UnsignedTinyInt: t('Unsigned<TinyInt>', 'u8'),
  SmallInt: t('SmallInt', 'i16'),
  UnsignedSmallInt: t('Unsigned<SmallInt>', 'u16'),
  MediumInt: t('Integer', 'i32'),
  UnsignedMediumInt: t('Unsigned<Integer>', 'u32'),
  Int: t('Integer', 'i32'),
  UnsignedInt: t('Unsigned<Integer>', 'u32'),
  BigInt: t('BigInt', 'i64'),
  UnsignedBigInt: t('Unsigned<BigInt>', 'u64'),
  Year: 'year has no Diesel type',
  Float: t('Float', 'f32'),
  Double: t('Double', 'f64'),
  Decimal: DECIMAL,
  DateTime: t('Datetime', 'chrono::NaiveDateTime'),
  Timestamp: DATETIME,
  Date: DATE,
  Time: TIME,
  Json: t('Json', JSON_VALUE),
  Binary: t('Binary', BYTES),
  VarBinary: t('Binary', BYTES),
  TinyBlob: t('Blob', BYTES),
  Blob: t('Blob', BYTES),
  MediumBlob: t('Blob', BYTES),
  LongBlob: t('Blob', BYTES),
};

const NATIVE: Readonly<Record<DieselBackend, Readonly<Record<string, DieselType | Unsupported>>>> = {
  pg: PG_NATIVE,
  mysql: MYSQL_NATIVE,
  sqlite: {},
};

function render(native: IrNativeType): string {
  return `@db.${native.name}${native.args.length > 0 ? `(${native.args.join(', ')})` : ''}`;
}

/** Maps a non-list scalar column type. */
export function mapScalarType(backend: DieselBackend, type: ScalarType, native: IrNativeType | null): TypeMapping {
  if (native !== null && !(type === 'Boolean' && native.name === 'TinyInt')) {
    const mapped = NATIVE[backend][native.name];
    if (mapped === undefined) return { ok: false, reason: `native type ${render(native)} is not mapped for Diesel` };
    if (typeof mapped === 'string') return { ok: false, reason: `${render(native)}: ${mapped}` };
    return { ok: true, type: mapped };
  }
  const mapped = DEFAULTS[backend][type];
  if (backend === 'sqlite' && type === 'Decimal') {
    return {
      ok: true,
      type: mapped,
      note: { severity: 'warning', message: 'Decimal is mapped to Double/f64 on SQLite and may lose precision' },
    };
  }
  if (backend === 'sqlite' && type === 'Json') {
    return { ok: true, type: mapped, note: { severity: 'info', message: 'Json is stored as text on SQLite; mapped to Text/String' } };
  }
  return { ok: true, type: mapped };
}

/** Cargo features of `diesel` (and extra crates) needed by the Rust types in use. */
export function requiredFeatures(rustTypes: Iterable<string>): { features: string[]; crates: string[] } {
  const features = new Set<string>();
  const crates = new Set<string>();
  for (const rust of rustTypes) {
    for (const [prefix, feature] of [
      ['chrono::', 'chrono'],
      ['serde_json::', 'serde_json'],
      ['uuid::', 'uuid'],
      ['bigdecimal::', 'numeric'],
    ] as const) {
      if (rust.includes(prefix)) {
        features.add(feature);
        crates.add(prefix.slice(0, -2));
      }
    }
  }
  return { features: [...features].sort(), crates: [...crates].sort() };
}
