import { expect } from 'vitest';
import type { ParseResult, SchemaError } from '../src/index.js';

export const datasource = 'datasource db {\n  provider = "postgresql"\n}\n';

export function expectOk<T>(result: ParseResult<T>): T {
  if (!result.ok) {
    expect.fail(`expected success, got ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

export function expectError<T>(result: ParseResult<T>): SchemaError {
  if (result.ok) expect.fail('expected failure, got success');
  return result.error;
}
