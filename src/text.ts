export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;

  let count = 0;
  let index = 0;
  const len = needle.length;

  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count++;
    index += len;
  }

  return count;
}

export function findOccurrence(text: string, search: string, occurrence = 1): number {
  if (occurrence < 1) throw new Error('"occurrence" must be >= 1.');

  let index = 0;
  const len = search.length;

  for (let seen = 0; ;) {
    const found = text.indexOf(search, index);
    if (found === -1) return -1;
    seen++;
    if (seen === occurrence) return found;
    index = found + len;
  }
}

export function nextNonWhitespace(text: string, start: number): string {
  for (let i = start; i < text.length; i++) {
    if (!/\s/.test(text[i])) return text[i];
  }

  return "";
}

export function lineRangeToIndexes(
  text: string,
  startLine: number,
  endLine: number
): { start: number; end: number } {
  const lines = text.split("\n");

  if (startLine > lines.length) {
    throw new Error(`startLine ${startLine} exceeds file length (${lines.length} lines).`);
  }

  const safeEnd = Math.min(endLine, lines.length);

  let start = 0;
  for (let i = 1; i < startLine; i++) {
    start += lines[i - 1].length + 1;
  }

  let end = start;
  for (let i = startLine; i <= safeEnd; i++) {
    end += lines[i - 1].length;
    if (i < lines.length) end += 1;
  }

  return { start, end };
}

export function findWithAnchor(text: string, search: string, anchor: string): number {
  const anchorIdx = text.indexOf(anchor);
  if (anchorIdx === -1) return -1;

  const after = text.slice(anchorIdx);
  const afterIdx = after.indexOf(search);
  if (afterIdx !== -1) return anchorIdx + afterIdx;

  return text.slice(0, anchorIdx).lastIndexOf(search);
}
