/**
 * Case conversion for identifiers. Target-neutral: adapters decide which case
 * their language uses and how to escape reserved words.
 */

// An uppercase run not followed by lowercase (acronyms such as "HTTP" in
// "HTTPServer"), a capitalized or lowercase word, or a bare number. Digits
// stick to the preceding word ("address2", "v2"). Unicode letters count.
const WORD = /\p{Lu}+(?![\p{Ll}\p{Lo}\p{Lm}])\p{N}*|\p{Lu}?[\p{Ll}\p{Lo}\p{Lm}]+\p{N}*|\p{N}+/gu;

/** Splits an identifier in any common case style into its words. */
export function splitWords(name: string): string[] {
  return name.match(WORD) ?? [];
}

function capitalize(word: string): string {
  const lower = word.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** `createdAt`, `CreatedAt`, `created-at` -> `created_at`. */
export function toSnakeCase(name: string): string {
  return splitWords(name)
    .map((w) => w.toLowerCase())
    .join('_');
}

/** `created_at`, `CreatedAt` -> `createdAt`; acronyms become `userId`. */
export function toCamelCase(name: string): string {
  const [first = '', ...rest] = splitWords(name);
  return first.toLowerCase() + rest.map(capitalize).join('');
}

/** `created_at`, `createdAt` -> `CreatedAt`. */
export function toPascalCase(name: string): string {
  return splitWords(name).map(capitalize).join('');
}
