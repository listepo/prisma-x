import { describe, expect, it } from 'vitest';
import { splitWords, toCamelCase, toPascalCase, toSnakeCase } from '../../src/index.js';

describe('case conversion', () => {
  it.each([
    ['createdAt', ['created', 'At']],
    ['CreatedAt', ['Created', 'At']],
    ['created_at', ['created', 'at']],
    ['created-at', ['created', 'at']],
    ['HTTPServer', ['HTTP', 'Server']],
    ['userID', ['user', 'ID']],
    ['address2', ['address2']],
    ['v2Name', ['v2', 'Name']],
    ['_PostToTag', ['Post', 'To', 'Tag']],
    ['lööps', ['lööps']],
    ['ÜberModel', ['Über', 'Model']],
    ['', []],
  ])('splits %j into words', (input, words) => {
    expect(splitWords(input)).toEqual(words);
  });

  it.each([
    ['createdAt', 'created_at', 'createdAt', 'CreatedAt'],
    ['CreatedAt', 'created_at', 'createdAt', 'CreatedAt'],
    ['created_at', 'created_at', 'createdAt', 'CreatedAt'],
    ['HTTPLog', 'http_log', 'httpLog', 'HttpLog'],
    ['requestID', 'request_id', 'requestId', 'RequestId'],
    ['IN_PROGRESS', 'in_progress', 'inProgress', 'InProgress'],
    ['User', 'user', 'user', 'User'],
    ['lööps', 'lööps', 'lööps', 'Lööps'],
  ])('converts %j to snake %j, camel %j, pascal %j', (input, snake, camel, pascal) => {
    expect(toSnakeCase(input)).toBe(snake);
    expect(toCamelCase(input)).toBe(camel);
    expect(toPascalCase(input)).toBe(pascal);
  });

  it('is idempotent', () => {
    // Single-letter words ('a_b_c' -> 'ABC') cannot round-trip and are left out.
    for (const name of ['postToTag', 'HTTPServer', 'created_at', 'userId']) {
      expect(toSnakeCase(toSnakeCase(name))).toBe(toSnakeCase(name));
      expect(toPascalCase(toPascalCase(name))).toBe(toPascalCase(name));
      expect(toCamelCase(toCamelCase(name))).toBe(toCamelCase(name));
    }
  });
});
