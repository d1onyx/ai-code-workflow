import { EditOperation } from "./model";
import {
  countOccurrences,
  escapeRegExp,
  findOccurrence,
  findWithAnchor,
  lineRangeToIndexes,
  normalizeNewlines,
} from "./text";

export function applyTextOperation(current: string, op: EditOperation, warnings: string[]): string {
  if (op.type === "replace_file" || op.type === "create_file") {
    return normalizeNewlines(op.content ?? "");
  }
  if (op.type === "delete_file") {
    return current;
  }

  if (op.startLine !== undefined) {
    return applyLineRangeOperation(current, op);
  }

  return applySearchOperation(current, op, warnings);
}

function applyLineRangeOperation(current: string, op: EditOperation): string {
  const endLine = op.endLine ?? op.startLine!;
  const { start, end } = lineRangeToIndexes(current, op.startLine!, endLine);

  switch (op.type) {
    case "replace":
    case "replace_block":
      return current.slice(0, start) + normalizeNewlines(op.replace ?? "") + current.slice(end);
    case "delete":
      return current.slice(0, start) + current.slice(end);
    case "insert_before":
      return current.slice(0, start) + normalizeNewlines(op.text ?? "") + "\n" + current.slice(start);
    case "insert_after":
      return current.slice(0, end) + "\n" + normalizeNewlines(op.text ?? "") + current.slice(end);
    default:
      return current;
  }
}

function applySearchOperation(current: string, op: EditOperation, warnings: string[]): string {
  const search = normalizeNewlines(op.search ?? "");
  if (!search) throw new Error(`"${op.type}" in ${op.file} has an empty "search" field.`);

  const replace = normalizeNewlines(op.replace ?? "");
  const insertText = normalizeNewlines(op.text ?? "");

  if (op.type === "replace_all") {
    return replaceAll(current, op, search, replace, warnings);
  }

  const index = resolveSearchIndex(current, op, search);

  if (index === -1) {
    if (op.allowMissing) {
      warnings.push(`${op.file}: skipped missing optional search ("${search.slice(0, 80)}...").`);
      return current;
    }
    throw new Error(`Search text not found in ${op.file}.\nSearch: ${search.slice(0, 300)}`);
  }

  const before = current.slice(0, index);
  const after = current.slice(index + search.length);

  switch (op.type) {
    case "replace":
    case "replace_block":
      return before + replace + after;
    case "delete":
      return before + after;
    case "insert_before":
      return before + insertText + "\n" + current.slice(index);
    case "insert_after":
      return current.slice(0, index + search.length) + "\n" + insertText + after;
    default:
      return current;
  }
}

function replaceAll(
  current: string,
  op: EditOperation,
  search: string,
  replace: string,
  warnings: string[]
): string {
  const total = countOccurrences(current, search);

  if (total === 0) {
    if (op.allowMissing) {
      warnings.push(`${op.file}: replace_all - search text not found (skipped).`);
      return current;
    }
    throw new Error(`replace_all: search text not found in ${op.file}.`);
  }

  warnings.push(`${op.file}: replace_all changed ${total} occurrence(s).`);
  return current.replace(new RegExp(escapeRegExp(search), "g"), replace);
}

function resolveSearchIndex(current: string, op: EditOperation, search: string): number {
  if (op.anchor) {
    const index = findWithAnchor(current, search, op.anchor);
    if (index === -1 && !op.allowMissing) {
      throw new Error(
        `Search text not found near anchor in ${op.file}.\n` +
        `Anchor: ${op.anchor.slice(0, 200)}\n` +
        `Search: ${search.slice(0, 200)}`
      );
    }
    return index;
  }

  const index = findOccurrence(current, search, op.occurrence ?? 1);

  if (index !== -1 && !op.occurrence) {
    const total = countOccurrences(current, search);
    if (total > 1) {
      throw new Error(
        `${op.file}: search text appears ${total} times. Add "occurrence", "anchor", or line numbers to disambiguate.`
      );
    }
  }

  return index;
}
