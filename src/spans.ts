import type { Position, SourceSpan } from './errors.js';

/**
 * Builds spans with line/column positions for one source string.
 *
 * The engine's lint offsets are already UTF-16 code units (verified against
 * multi-byte input), so they index JS strings directly.
 */
export function createSpanMapper(source: string): (fileName: string, start: number, end: number) => SourceSpan {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }

  const toPosition = (offset: number): Position => {
    // Last line start <= offset.
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - (lineStarts[lo] ?? 0) + 1 };
  };

  return (fileName, start, end) => ({
    fileName,
    start,
    end,
    startPosition: toPosition(start),
    endPosition: toPosition(end),
  });
}
