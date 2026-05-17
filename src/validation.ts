import * as path from "path";
import { ALLOWED_TYPES, NEEDS_CONTENT, NEEDS_REPLACE, NEEDS_SEARCH, NEEDS_TEXT } from "./constants";
import { EditOperation } from "./model";

export function validateOperation(op: EditOperation): void {
  if (!op || typeof op !== "object") {
    throw new Error("Each operation must be an object.");
  }

  validatePath(op.file);

  if (!ALLOWED_TYPES.has(op.type)) {
    throw new Error(`Unsupported operation type: "${op.type}" in ${op.file}`);
  }

  if (NEEDS_REPLACE.has(op.type) && typeof op.replace !== "string") {
    throw new Error(`"${op.type}" requires a "replace" string in ${op.file}.`);
  }

  const hasSearch = typeof op.search === "string";
  const hasLineRange = typeof op.startLine === "number";

  if (NEEDS_SEARCH.has(op.type) && !hasSearch && !hasLineRange) {
    throw new Error(`"${op.type}" requires "search" or a line range (startLine/endLine) in ${op.file}.`);
  }

  if (NEEDS_TEXT.has(op.type) && typeof op.text !== "string") {
    throw new Error(`"${op.type}" requires a "text" string in ${op.file}.`);
  }

  if (NEEDS_CONTENT.has(op.type) && typeof op.content !== "string") {
    throw new Error(`"${op.type}" requires a "content" string in ${op.file}.`);
  }

  if (op.startLine !== undefined && (!Number.isInteger(op.startLine) || op.startLine < 1)) {
    throw new Error(`Invalid startLine (${op.startLine}) in ${op.file}. Must be integer >= 1.`);
  }

  if (op.endLine !== undefined) {
    if (!Number.isInteger(op.endLine) || op.endLine < 1) {
      throw new Error(`Invalid endLine (${op.endLine}) in ${op.file}. Must be integer >= 1.`);
    }
    if (op.startLine !== undefined && op.endLine < op.startLine) {
      throw new Error(`endLine (${op.endLine}) < startLine (${op.startLine}) in ${op.file}.`);
    }
  }

  if (op.occurrence !== undefined && (!Number.isInteger(op.occurrence) || op.occurrence < 1)) {
    throw new Error(`"occurrence" must be an integer >= 1 in ${op.file}.`);
  }
}

export function resolveRepoPath(repo: string, file: string): string {
  validatePath(file);

  const repoRoot = path.resolve(repo);
  const target = path.resolve(repoRoot, file);
  const relative = path.relative(repoRoot, target);

  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes repository root: ${file}`);
  }

  return target;
}

function validatePath(file: string): void {
  if (!file || typeof file !== "string") {
    throw new Error("Operation has an invalid (empty or non-string) file path.");
  }

  if (file.includes("\0")) {
    throw new Error(`Null byte in path: ${file}`);
  }

  if (path.isAbsolute(file)) {
    throw new Error(`Absolute paths are not allowed: ${file}`);
  }

  const normalized = path.normalize(file).replace(/\\/g, "/");
  if (normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
    throw new Error(`Path traversal blocked: ${file}`);
  }

  if (normalized === ".git" || normalized.startsWith(".git/")) {
    throw new Error(`.git modification blocked: ${file}`);
  }
}
