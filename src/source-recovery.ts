/**
 * Rebuilds datamodel (DMMF) entries from the scanned source, for what the
 * engine leaves out: `@@ignore` models, `@ignore` and `Unsupported(...)`
 * fields, and `@relation(map: ...)` foreign-key names.
 *
 * The output follows the engine's conventions (field flags, default values,
 * default relation names, index order), so recovered entries go through the
 * same DMMF -> AST mapping as the engine's own. Tests compare the two on
 * schemas where the engine reports everything.
 */
import type { DmmfField, DmmfFieldDefault, DmmfIndex, DmmfModel, JsonValue } from './dmmf.js';
import { scanSchema, type ScanArgument, type ScanAttribute, type ScanField, type ScanModel, type ScanValue } from './source-scan.js';

const SCALARS = new Set(['String', 'Boolean', 'Int', 'BigInt', 'Float', 'Decimal', 'DateTime', 'Json', 'Bytes']);

export interface RecoveredModel {
  readonly model: DmmfModel;
  /** The model's ids, uniques and indexes, in engine order. */
  readonly indexes: readonly DmmfIndex[];
  /** `@@ignore`. */
  readonly isIgnored: boolean;
  /** Names of fields with `@ignore`. */
  readonly ignoredFields: ReadonlySet<string>;
  /** `@relation(map: ...)` per relation field name. */
  readonly foreignKeyNames: ReadonlyMap<string, string>;
}

function attribute(attributes: readonly ScanAttribute[], name: string): ScanAttribute | undefined {
  return attributes.find((a) => a.name === name);
}

/** The named argument, or the positional one at `position`. */
function argument(attr: ScanAttribute | undefined, name: string, position = -1): ScanValue | undefined {
  if (attr === undefined) return undefined;
  const named = attr.args.find((a) => a.name === name);
  if (named !== undefined) return named.value;
  return position < 0 ? undefined : attr.args.filter((a) => a.name === null)[position]?.value;
}

function stringArg(attr: ScanAttribute | undefined, name: string, position = -1): string | undefined {
  const value = argument(attr, name, position);
  return value?.kind === 'string' ? value.value : undefined;
}

function constantArg(attr: ScanAttribute | undefined, name: string): string | undefined {
  const value = argument(attr, name);
  return value?.kind === 'constant' ? value.value : undefined;
}

/** Field names of a `[a, b(sort: Desc)]` list. */
function fieldList(value: ScanValue | undefined): string[] {
  if (value?.kind !== 'array') return [];
  return value.items.flatMap((item) => (item.kind === 'constant' ? [item.value] : item.kind === 'call' ? [item.name] : []));
}

/** Arguments of default functions and list items, as the engine renders them. */
function toJson(value: ScanValue): JsonValue {
  switch (value.kind) {
    case 'string':
    case 'constant':
      return value.value;
    case 'number':
      return Number(value.text);
    case 'array':
      return value.items.map(toJson);
    case 'call':
      return value.name;
  }
}

function literal(value: ScanValue, type: string): JsonValue {
  switch (value.kind) {
    case 'number':
      return type === 'BigInt' ? value.text : Number(value.text);
    case 'string':
      // The engine normalizes DateTime literals to RFC 3339 with an explicit offset.
      return type === 'DateTime' ? value.value.replace(/Z$/u, '+00:00') : value.value;
    case 'constant':
      if (type === 'Boolean' && (value.value === 'true' || value.value === 'false')) return value.value === 'true';
      return value.value;
    case 'array':
      return value.items.map((item) => literal(item, type));
    case 'call':
      return value.name;
  }
}

/** Versions the engine fills in for `uuid()` and `cuid()` without arguments. */
const DEFAULT_VERSIONS: Readonly<Record<string, number>> = { uuid: 4, cuid: 1 };

function toDefault(field: ScanField): DmmfFieldDefault | undefined {
  const value = argument(attribute(field.attributes, 'default'), 'value', 0);
  if (value === undefined) return undefined;
  if (value.kind === 'call') {
    const args = value.args.filter((a: ScanArgument) => a.name === null).map((a) => toJson(a.value));
    const version = DEFAULT_VERSIONS[value.name];
    return { name: value.name, args: args.length === 0 && version !== undefined ? [version] : args };
  }
  return literal(value, field.type) as DmmfFieldDefault;
}

interface Context {
  readonly enums: ReadonlySet<string>;
  readonly types: ReadonlySet<string>;
  readonly models: ReadonlySet<string>;
  /** Prefix of native type attributes: the datasource name and a dot. */
  readonly native: string;
}

function toField(field: ScanField, model: ScanModel, foreignKeys: ReadonlySet<string>, context: Context): DmmfField | null {
  const attrs = field.attributes;
  const blockFields = (name: string) =>
    model.attributes.filter((a) => a.name === name).map((a) => fieldList(argument(a, 'fields', 0)));
  const isSingle = (lists: string[][]) => lists.some((list) => list.length === 1 && list[0] === field.name);
  const kind = field.unsupportedType !== null
    ? 'unsupported'
    : SCALARS.has(field.type)
      ? 'scalar'
      : context.enums.has(field.type)
        ? 'enum'
        : context.models.has(field.type) || context.types.has(field.type)
          ? 'object'
          : null;
  if (kind === null) return null;
  const map = stringArg(attribute(attrs, 'map'), 'name', 0);
  const native = attrs.find((a) => a.name.startsWith(context.native));
  const fallback = toDefault(field);
  const base: DmmfField = {
    name: field.name,
    ...(map === undefined ? {} : { dbName: map }),
    kind,
    isList: field.isList,
    isRequired: field.isList || !field.isOptional,
    isUnique: attribute(attrs, 'unique') !== undefined || isSingle(blockFields('unique')),
    isId: attribute(attrs, 'id') !== undefined || isSingle(blockFields('id')),
    isReadOnly: foreignKeys.has(field.name),
    hasDefaultValue: fallback !== undefined,
    type: field.unsupportedType ?? field.type,
    nativeType:
      native === undefined
        ? null
        : [native.name.slice(context.native.length), native.args.map((a) => (a.value.kind === 'number' ? a.value.text : String(toJson(a.value))))],
    ...(fallback === undefined || kind === 'object' ? {} : { default: fallback }),
    isGenerated: false,
    isUpdatedAt: attribute(attrs, 'updatedAt') !== undefined,
    ...(field.documentation === null ? {} : { documentation: field.documentation }),
  };
  if (kind !== 'object' || !context.models.has(field.type)) return base;
  const relation = attribute(attrs, 'relation');
  const onDelete = constantArg(relation, 'onDelete');
  const onUpdate = constantArg(relation, 'onUpdate');
  return {
    ...base,
    relationName: stringArg(relation, 'name', 0) ?? [model.name, field.type].sort().join('To'),
    relationFromFields: fieldList(argument(relation, 'fields')),
    relationToFields: fieldList(argument(relation, 'references')),
    ...(onDelete === undefined ? {} : { relationOnDelete: onDelete }),
    ...(onUpdate === undefined ? {} : { relationOnUpdate: onUpdate }),
  };
}

function index(model: string, type: string, isDefinedOnField: boolean, fields: readonly string[], name?: string, dbName?: string): DmmfIndex {
  return {
    model,
    type,
    isDefinedOnField,
    ...(name === undefined ? {} : { name }),
    ...(dbName === undefined ? {} : { dbName }),
    fields: fields.map((f) => ({ name: f })),
  };
}

/** Ids, uniques and indexes in the engine's order: id, field uniques, @@index, @@unique, @@fulltext. */
function indexesOf(model: ScanModel): DmmfIndex[] {
  const indexes: DmmfIndex[] = [];
  const block = (name: string) => model.attributes.filter((a) => a.name === name);
  const fieldsOf = (a: ScanAttribute) => fieldList(argument(a, 'fields', 0));
  const [blockId] = block('id');
  const fieldId = model.fields.find((f) => attribute(f.attributes, 'id') !== undefined);
  if (blockId !== undefined) {
    indexes.push(index(model.name, 'id', false, fieldsOf(blockId), stringArg(blockId, 'name'), stringArg(blockId, 'map')));
  } else if (fieldId !== undefined) {
    indexes.push(index(model.name, 'id', true, [fieldId.name], undefined, stringArg(attribute(fieldId.attributes, 'id'), 'map')));
  }
  for (const field of model.fields) {
    const unique = attribute(field.attributes, 'unique');
    if (unique !== undefined) indexes.push(index(model.name, 'unique', true, [field.name], undefined, stringArg(unique, 'map')));
  }
  for (const a of block('index')) {
    indexes.push(index(model.name, 'normal', false, fieldsOf(a), undefined, stringArg(a, 'map') ?? stringArg(a, 'name')));
  }
  for (const a of block('unique')) {
    indexes.push(index(model.name, 'unique', false, fieldsOf(a), stringArg(a, 'name'), stringArg(a, 'map')));
  }
  for (const a of block('fulltext')) {
    indexes.push(index(model.name, 'fulltext', false, fieldsOf(a), undefined, stringArg(a, 'map') ?? stringArg(a, 'name')));
  }
  return indexes;
}

function recoverModel(model: ScanModel, context: Context): RecoveredModel {
  const relations = model.fields.map((f) => attribute(f.attributes, 'relation'));
  const foreignKeys = new Set(relations.flatMap((r) => fieldList(argument(r, 'fields'))));
  const fields = model.fields.flatMap((f) => toField(f, model, foreignKeys, context) ?? []);
  const blockAttr = (name: string) => attribute(model.attributes, name);
  const id = blockAttr('id');
  const uniques = model.attributes.filter((a) => a.name === 'unique');
  const foreignKeyNames = new Map<string, string>();
  model.fields.forEach((f, i) => {
    const map = stringArg(relations[i], 'map');
    if (map !== undefined) foreignKeyNames.set(f.name, map);
  });
  return {
    model: {
      name: model.name,
      dbName: stringArg(blockAttr('map'), 'name', 0) ?? null,
      schema: stringArg(blockAttr('schema'), 'name', 0) ?? null,
      fields,
      primaryKey: id === undefined ? null : { name: stringArg(id, 'name') ?? null, fields: fieldList(argument(id, 'fields', 0)) },
      uniqueFields: uniques.map((u) => fieldList(argument(u, 'fields', 0))),
      uniqueIndexes: uniques.map((u) => ({ name: stringArg(u, 'name') ?? null, fields: fieldList(argument(u, 'fields', 0)) })),
      isGenerated: false,
      ...(model.documentation === null ? {} : { documentation: model.documentation }),
    },
    indexes: indexesOf(model),
    isIgnored: blockAttr('ignore') !== undefined,
    ignoredFields: new Set(model.fields.filter((f) => attribute(f.attributes, 'ignore') !== undefined).map((f) => f.name)),
    foreignKeyNames,
  };
}

/**
 * Recovers every `model` and `view` of the source, in declaration order.
 * `enums` and `types` (composite types) are names the engine never drops.
 */
export function recoverModels(source: string, enums: Iterable<string>, types: Iterable<string> = []): RecoveredModel[] {
  const { datasource, models } = scanSchema(source);
  const context: Context = {
    enums: new Set(enums),
    types: new Set(types),
    models: new Set(models.map((m) => m.name)),
    native: `${datasource ?? 'db'}.`,
  };
  return models.map((m) => recoverModel(m, context));
}
