import * as vscode from "vscode";
import * as cp from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OperationType =
  | "replace"
  | "replace_all"
  | "replace_block"
  | "insert_before"
  | "insert_after"
  | "delete"
  | "create_file"
  | "delete_file"
  | "replace_file";

interface EditOperation {
  type: OperationType;
  file: string;
  search?: string;
  replace?: string;
  text?: string;
  content?: string;
  anchor?: string;
  occurrence?: number;
  startLine?: number;
  endLine?: number;
  allowMissing?: boolean;
}

interface OperationsPayload {
  operations: EditOperation[];
}

interface FileChange {
  file: string;
  before: string | null;
  after: string | null;
  operations: EditOperation[];
}

interface ApplyResult {
  changes: FileChange[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALLOWED_TYPES = new Set<OperationType>([
  "replace",
  "replace_all",
  "replace_block",
  "insert_before",
  "insert_after",
  "delete",
  "create_file",
  "delete_file",
  "replace_file",
]);

const NEEDS_REPLACE = new Set<OperationType>(["replace", "replace_all", "replace_block"]);
const NEEDS_SEARCH = new Set<OperationType>([
  "replace", "replace_all", "replace_block",
  "insert_before", "insert_after", "delete",
]);
const NEEDS_TEXT = new Set<OperationType>(["insert_before", "insert_after"]);
const NEEDS_CONTENT = new Set<OperationType>(["create_file", "replace_file"]);

const MAX_INPUT_MB = 5;
const WARN_INPUT_MB = 1;
const TEMP_DIR_PREFIX = "ai-json-preview-";

// ---------------------------------------------------------------------------
// Git utilities
// ---------------------------------------------------------------------------

function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn("git", args, { cwd, shell: false, windowsHide: true });

    const chunks: { out: Buffer[]; err: Buffer[] } = { out: [], err: [] };

    child.stdout.on("data", (d: Buffer) => chunks.out.push(d));
    child.stderr.on("data", (d: Buffer) => chunks.err.push(d));
    child.on("error", reject);
    child.on("close", code => {
      const stdout = Buffer.concat(chunks.out).toString("utf8");
      const stderr = Buffer.concat(chunks.err).toString("utf8");
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(Object.assign(new Error(stderr || stdout || `git exited ${code}`), { stdout, stderr }));
      }
    });
  });
}

async function getRepoRoot(): Promise<string> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error("No workspace folder open. Please open a project first.");

  const result = await runGit(["rev-parse", "--show-toplevel"], folder.uri.fsPath);
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// ---------------------------------------------------------------------------
// JSON cleaning & parsing
// ---------------------------------------------------------------------------

/**
 * Strips markdown fences and extracts the outermost JSON object.
 * Keeps this function conservative: deeper repairs happen only if JSON.parse fails.
 */
function cleanJsonInput(input: string): string {
  let text = normalizeNewlines(input).trim();

  // Strip markdown code fences (e.g. ```json ... ```)
  text = text.replace(/^```(?:json|javascript|js|ts|typescript)?\s*/i, "").replace(/\s*```\s*$/i, "");

  // Normalize “smart quotes” that LLMs sometimes produce around JSON keys/values.
  text = text
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");

  // Extract from first { to last }. This intentionally stays simple because
  // LLM replies often contain prose before/after the JSON object.
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }

  return removeTrailingCommasOutsideStrings(text).trim();
}

function removeTrailingCommasOutsideStrings(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) j++;
      if (input[j] === "}" || input[j] === "]") continue;
    }

    out += ch;
  }

  return out;
}

function parseJsonWithRepair(input: string): unknown {
  const cleaned = cleanJsonInput(input);

  try {
    return JSON.parse(cleaned);
  } catch (firstError: any) {
    const repaired = repairJsonStrings(cleaned);
    try {
      return JSON.parse(repaired);
    } catch (secondError: any) {
      throw new Error(
        `Invalid JSON: ${firstError.message}\n` +
        `Auto-repair also failed: ${secondError.message}\n\n` +
        `Tip: the most reliable format is JSON with code blocks escaped as strings, ` +
        `or use line-based operations (startLine/endLine) for large code replacements.`
      );
    }
  }
}

/**
 * Best-effort repair for the most common LLM JSON breakage:
 * unescaped quotes and raw newlines inside string values, for example:
 *   "replace": "const msg = "hello";"
 *
 * It is intentionally used only after normal JSON.parse fails.
 */
function repairJsonStrings(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }

    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }

    // Raw line breaks are illegal inside JSON strings.
    if (ch === "\n") {
      out += "\\n";
      continue;
    }

    if (ch === '"') {
      const next = nextNonWhitespace(input, i + 1);

      // A quote closes a JSON string only when the next meaningful character
      // is a structural JSON delimiter. Otherwise it is probably a quote from
      // code/text that the LLM forgot to escape.
      if (next === ":" || next === "," || next === "}" || next === "]" || next === "") {
        inString = false;
        out += ch;
      } else {
        out += '\\"';
      }
      continue;
    }

    out += ch;
  }

  return removeTrailingCommasOutsideStrings(out);
}

function nextNonWhitespace(text: string, start: number): string {
  for (let i = start; i < text.length; i++) {
    if (!/\s/.test(text[i])) return text[i];
  }
  return "";
}

function parsePayload(input: string): OperationsPayload {
  const data = parseJsonWithRepair(input);

  if (!data || typeof data !== "object" || !Array.isArray((data as any).operations)) {
    throw new Error('Invalid payload. Expected: { "operations": [...] }');
  }

  return data as OperationsPayload;
}

function formatJsonInput(input: string): string {
  const data = parseJsonWithRepair(input);
  return JSON.stringify(data, null, 2);
}

// ---------------------------------------------------------------------------
// Path & operation validation
// ---------------------------------------------------------------------------

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

  // Normalize and check for traversal
  const normalized = path.normalize(file).replace(/\\/g, "/");
  if (normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
    throw new Error(`Path traversal blocked: ${file}`);
  }

  // Block .git modifications
  if (normalized === ".git" || normalized.startsWith(".git/")) {
    throw new Error(`.git modification blocked: ${file}`);
  }
}

function validateOperation(op: EditOperation): void {
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

  if (op.startLine !== undefined) {
    if (!Number.isInteger(op.startLine) || op.startLine < 1) {
      throw new Error(`Invalid startLine (${op.startLine}) in ${op.file}. Must be integer >= 1.`);
    }
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

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

function groupByFile(operations: EditOperation[]): Map<string, EditOperation[]> {
  const map = new Map<string, EditOperation[]>();

  for (const op of operations) {
    validateOperation(op);
    const list = map.get(op.file);
    if (list) {
      list.push(op);
    } else {
      map.set(op.file, [op]);
    }
  }

  return map;
}

// ---------------------------------------------------------------------------
// Text search helpers
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countOccurrences(haystack: string, needle: string): number {
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

function findOccurrence(text: string, search: string, occurrence = 1): number {
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

function lineRangeToIndexes(
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

/**
 * Finds `search` near `anchor`, preferring after the anchor, then before it.
 */
function findWithAnchor(text: string, search: string, anchor: string): number {
  const anchorIdx = text.indexOf(anchor);
  if (anchorIdx === -1) return -1;

  const after = text.slice(anchorIdx);
  const afterIdx = after.indexOf(search);
  if (afterIdx !== -1) return anchorIdx + afterIdx;

  return text.slice(0, anchorIdx).lastIndexOf(search);
}

// ---------------------------------------------------------------------------
// Core text transformation
// ---------------------------------------------------------------------------

function applyTextOperation(current: string, op: EditOperation, warnings: string[]): string {
  // File-level operations
  if (op.type === "replace_file" || op.type === "create_file") {
    return normalizeNewlines(op.content ?? "");
  }
  if (op.type === "delete_file") {
    return current;
  }

  // Line-range operations
  if (op.startLine !== undefined) {
    const endLine = op.endLine ?? op.startLine;
    const { start, end } = lineRangeToIndexes(current, op.startLine, endLine);
    const norm = (s: string) => normalizeNewlines(s);

    switch (op.type) {
      case "replace":
      case "replace_block":
        return current.slice(0, start) + norm(op.replace ?? "") + current.slice(end);
      case "delete":
        return current.slice(0, start) + current.slice(end);
      case "insert_before":
        return current.slice(0, start) + norm(op.text ?? "") + "\n" + current.slice(start);
      case "insert_after":
        return current.slice(0, end) + "\n" + norm(op.text ?? "") + current.slice(end);
    }
  }

  // Search-based operations
  const search = normalizeNewlines(op.search ?? "");
  if (!search) throw new Error(`"${op.type}" in ${op.file} has an empty "search" field.`);

  const replace = normalizeNewlines(op.replace ?? "");
  const insertText = normalizeNewlines(op.text ?? "");

  if (op.type === "replace_all") {
    const total = countOccurrences(current, search);
    if (total === 0) {
      if (op.allowMissing) {
        warnings.push(`${op.file}: replace_all — search text not found (skipped).`);
        return current;
      }
      throw new Error(`replace_all: search text not found in ${op.file}.`);
    }
    warnings.push(`${op.file}: replace_all changed ${total} occurrence(s).`);
    return current.replace(new RegExp(escapeRegExp(search), "g"), replace);
  }

  // Resolve position
  let index: number;
  if (op.anchor) {
    index = findWithAnchor(current, search, op.anchor);
    if (index === -1 && !op.allowMissing) {
      throw new Error(
        `Search text not found near anchor in ${op.file}.\nAnchor: ${op.anchor.slice(0, 200)}\nSearch: ${search.slice(0, 200)}`
      );
    }
  } else {
    index = findOccurrence(current, search, op.occurrence ?? 1);

    if (index !== -1 && !op.occurrence) {
      const total = countOccurrences(current, search);
      if (total > 1) {
        throw new Error(
          `${op.file}: search text appears ${total} times. Add "occurrence", "anchor", or line numbers to disambiguate.`
        );
      }
    }
  }

  if (index === -1) {
    if (op.allowMissing) {
      warnings.push(`${op.file}: skipped missing optional search ("${search.slice(0, 80)}…").`);
      return current;
    }
    throw new Error(
      `Search text not found in ${op.file}.\nSearch: ${search.slice(0, 300)}`
    );
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
  }

  return current;
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

async function readFileIfExists(absPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(absPath, "utf8");
    return normalizeNewlines(raw);
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

async function ensureDir(absFile: string): Promise<void> {
  await fs.mkdir(path.dirname(absFile), { recursive: true });
}

// ---------------------------------------------------------------------------
// Build & apply changes
// ---------------------------------------------------------------------------

async function buildChanges(repo: string, payload: OperationsPayload): Promise<ApplyResult> {
  const warnings: string[] = [];
  const groups = groupByFile(payload.operations);
  const changes: FileChange[] = [];

  await Promise.all(
    Array.from(groups.entries()).map(async ([file, operations]) => {
      const abs = path.join(repo, file);
      const before = await readFileIfExists(abs);
      let current = before ?? "";

      for (const op of operations) {
        if (op.type === "create_file" && before !== null) {
          throw new Error(
            `"${file}" already exists. Use "replace_file" to overwrite, or "delete_file" first.`
          );
        }
        if (
          op.type !== "create_file" &&
          op.type !== "replace_file" &&
          op.type !== "delete_file" &&
          before === null
        ) {
          throw new Error(`"${file}" does not exist. Cannot apply "${op.type}".`);
        }

        current = applyTextOperation(current, op, warnings);
      }

      const willDelete = operations.some(op => op.type === "delete_file");
      changes.push({ file, before, after: willDelete ? null : current, operations });
    })
  );

  const order = Array.from(groups.keys());
  changes.sort((a, b) => order.indexOf(a.file) - order.indexOf(b.file));

  return { changes, warnings };
}

async function applyChanges(repo: string, result: ApplyResult): Promise<void> {
  await Promise.all(
    result.changes.map(async change => {
      const abs = path.join(repo, change.file);
      if (change.after === null) {
        await fs.rm(abs, { force: true });
      } else {
        await ensureDir(abs);
        await fs.writeFile(abs, change.after, "utf8");
      }
    })
  );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

async function formatChangedFiles(repo: string, result: ApplyResult): Promise<void> {
  for (const change of result.changes) {
    if (change.after === null) continue;

    const uri = vscode.Uri.file(path.join(repo, change.file));
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
      await vscode.commands.executeCommand("editor.action.formatDocument");
      await doc.save();
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    } catch {
      // Best-effort.
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function summarize(result: ApplyResult): string {
  const lines: string[] = [`Files affected: ${result.changes.length}`, ""];

  for (const change of result.changes) {
    const ops = change.operations.map(op => op.type).join(", ");
    if (change.before === null) {
      lines.push(`  CREATE  ${change.file}  [${ops}]`);
    } else if (change.after === null) {
      lines.push(`  DELETE  ${change.file}  [${ops}]`);
    } else {
      const before = change.before.split("\n").length;
      const after = change.after!.split("\n").length;
      const delta = after - before;
      const sign = delta >= 0 ? `+${delta}` : `${delta}`;
      lines.push(`  MODIFY  ${change.file}  [${ops}]  ${before} -> ${after} lines (${sign})`);
    }
  }

  if (result.warnings.length) {
    lines.push("", "Warnings:");
    for (const w of result.warnings) lines.push(`  WARNING  ${w}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Diff preview
// ---------------------------------------------------------------------------

async function writeTempFile(dir: string, name: string, content: string): Promise<vscode.Uri> {
  const safeName = name.replace(/[/\\:*?"<>|]/g, "__");
  const file = path.join(dir, safeName);
  await ensureDir(file);
  await fs.writeFile(file, content, "utf8");
  return vscode.Uri.file(file);
}

async function previewChanges(result: ApplyResult): Promise<void> {
  if (result.changes.length === 0) throw new Error("No changes to preview.");

  const items = result.changes.map(change => ({
    label: change.file,
    description:
      change.before === null ? "CREATE" : change.after === null ? "DELETE" : "MODIFY",
    detail: change.operations.map(op => op.type).join(", "),
    change,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Select a file to preview diff",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), TEMP_DIR_PREFIX));

  const [beforeUri, afterUri] = await Promise.all([
    writeTempFile(dir, `before__${picked.change.file}`, picked.change.before ?? ""),
    writeTempFile(dir, `after__${picked.change.file}`, picked.change.after ?? ""),
  ]);

  await vscode.commands.executeCommand(
    "vscode.diff",
    beforeUri,
    afterUri,
    `Preview: ${picked.change.file}`,
    { preview: false }
  );
}

// ---------------------------------------------------------------------------
// Webview HTML
// ---------------------------------------------------------------------------

function getHtml(nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
<style nonce="${nonce}">
:root {
  color-scheme: dark light;
}

*, *::before, *::after {
  box-sizing: border-box;
}

body {
  min-height: 100vh;
  padding: 0;
  margin: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background:
    radial-gradient(circle at top left, rgba(62, 138, 204, 0.16), transparent 34rem),
    radial-gradient(circle at bottom right, rgba(120, 80, 220, 0.10), transparent 28rem),
    var(--vscode-editor-background);
}

.shell {
  width: min(1180px, calc(100vw - 32px));
  margin: 0 auto;
  padding: 24px 0 20px;
}

.hero {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: end;
  gap: 18px;
  margin-bottom: 16px;
}

.kicker {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  padding: 4px 10px;
  margin-bottom: 10px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 999px;
  color: var(--vscode-descriptionForeground);
  background: color-mix(in srgb, var(--vscode-editor-background) 72%, var(--vscode-button-background));
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

h2 {
  margin: 0;
  font-size: 24px;
  line-height: 1.15;
  letter-spacing: -0.02em;
}

.hint {
  max-width: 760px;
  margin: 9px 0 0;
  color: var(--vscode-descriptionForeground);
  line-height: 1.55;
  font-size: 12.5px;
}

.card {
  overflow: hidden;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 16px;
  background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-sideBar-background));
  box-shadow: 0 18px 46px rgba(0, 0, 0, 0.22);
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
  background: color-mix(in srgb, var(--vscode-editor-background) 72%, var(--vscode-sideBar-background));
}

.button-group {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

button {
  appearance: none;
  min-height: 32px;
  padding: 7px 14px;
  cursor: pointer;
  border-radius: 10px;
  border: 1px solid var(--vscode-button-border, transparent);
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  font-size: 12px;
  font-weight: 650;
  font-family: inherit;
  transition: transform 0.12s ease, opacity 0.12s ease, border-color 0.12s ease;
}

button:hover {
  opacity: 0.92;
  transform: translateY(-1px);
}

button:active {
  transform: translateY(0);
}

button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

button.secondary {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}

button.ghost {
  color: var(--vscode-foreground);
  background: transparent;
  border-color: var(--vscode-panel-border);
}

button.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

button.danger {
  color: var(--vscode-button-foreground);
  background: color-mix(in srgb, var(--vscode-inputValidation-errorBackground, #5a1d1d) 55%, var(--vscode-button-background));
  border-color: var(--vscode-inputValidation-errorBorder, #be1100);
}

.editor-wrap {
  position: relative;
  padding: 14px;
}

textarea {
  width: 100%;
  height: 56vh;
  min-height: 260px;
  resize: vertical;
  display: block;
  font-family: var(--vscode-editor-font-family);
  font-size: 13px;
  line-height: 1.55;
  padding: 16px;
  background: color-mix(in srgb, var(--vscode-input-background) 90%, transparent);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 14px;
  outline: none;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
}

textarea:focus {
  border-color: var(--vscode-focusBorder);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--vscode-focusBorder) 28%, transparent);
}

.status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 8px;
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
}

#stats {
  min-height: 16px;
}

.output-panel {
  border-top: 1px solid var(--vscode-panel-border);
  padding: 13px 14px 14px;
  background: color-mix(in srgb, var(--vscode-editor-background) 76%, var(--vscode-panel-background));
}

.output-label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.075em;
  margin-bottom: 8px;
}

pre#output {
  white-space: pre-wrap;
  word-break: break-word;
  padding: 13px 14px;
  background: var(--vscode-terminal-background, var(--vscode-editor-background));
  border: 1px solid var(--vscode-panel-border);
  border-radius: 12px;
  max-height: 28vh;
  overflow: auto;
  font-family: var(--vscode-editor-font-family);
  font-size: 12px;
  line-height: 1.5;
  margin: 0;
}

pre#output.error {
  color: var(--vscode-errorForeground, #f48771);
  border-color: var(--vscode-inputValidation-errorBorder, #be1100);
}

pre#output.success {
  color: var(--vscode-terminal-ansiGreen, #89d185);
}

@media (max-width: 760px) {
  .shell {
    width: calc(100vw - 20px);
    padding-top: 14px;
  }

  .hero,
  .toolbar {
    grid-template-columns: 1fr;
  }

  .toolbar {
    align-items: stretch;
  }

  .button-group,
  button {
    width: 100%;
  }
}
</style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <div>
        <div class="kicker">JSON operations</div>
        <h2>Code Patch Parser</h2>
        <p class="hint">
          Paste a JSON operations payload, format it, inspect the planned file changes, preview a diff, then apply safely.
          Supported operations: replace, replace_all, replace_block, insert_before, insert_after, delete, create_file, delete_file, replace_file.
        </p>
      </div>
    </section>

    <section class="card">
      <div class="toolbar">
        <div class="button-group">
          <button id="load" class="secondary">Load file</button>
          <button id="format" class="secondary">Format JSON</button>
          <button id="analyze" class="primary">Analyze</button>
          <button id="preview" class="primary">Preview</button>
          <button id="apply" class="danger">Apply</button>
        </div>
        <div class="button-group">
          <button id="clean" class="ghost">Clean</button>
        </div>
      </div>

      <div class="editor-wrap">
        <textarea id="input" spellcheck="false" placeholder='{ "operations": [] }'></textarea>
        <div class="status-row">
          <div id="stats"></div>
          <div>UTF-8 JSON payload</div>
        </div>
      </div>

      <div class="output-panel">
        <div class="output-label">
          <span>Output</span>
          <span id="output-state">Idle</span>
        </div>
        <pre id="output">Ready.</pre>
      </div>
    </section>
  </main>

<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const input = document.getElementById("input");
  const output = document.getElementById("output");
  const stats = document.getElementById("stats");
  const outputState = document.getElementById("output-state");

  function setStatus(msg, type) {
    output.textContent = msg;
    output.className = type || "";
    outputState.textContent = type === "success" ? "Success" : type === "error" ? "Error" : "Idle";
  }

  function setStats() {
    const chars = input.value.length;
    const kb = (new TextEncoder().encode(input.value).byteLength / 1024).toFixed(1);
    stats.textContent = chars > 0 ? chars.toLocaleString() + " chars · " + kb + " KB" : "Empty";
  }

  function persist() {
    vscode.setState({ input: input.value });
  }

  function send(type) {
    vscode.postMessage({ type, input: input.value });
  }

  input.addEventListener("input", () => {
    setStats();
    persist();
  });

  document.getElementById("load").onclick = () => send("load");
  document.getElementById("format").onclick = () => send("format");
  document.getElementById("analyze").onclick = () => send("analyze");
  document.getElementById("preview").onclick = () => send("preview");
  document.getElementById("apply").onclick = () => send("apply");

  document.getElementById("clean").onclick = () => {
    input.value = "";
    setStatus("Cleaned.", "");
    setStats();
    persist();
  };

  window.addEventListener("message", event => {
    const { input: newInput, message, status } = event.data;
    if (newInput !== undefined) {
      input.value = newInput;
      setStats();
      persist();
    }
    if (message !== undefined) {
      setStatus(message, status || "");
    }
  });

  const state = vscode.getState();
  if (state?.input) {
    input.value = state.input;
  }
  setStats();
})();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Nonce helper for CSP
// ---------------------------------------------------------------------------

function generateNonce(): string {
  const crypto = require("crypto") as typeof import("crypto");
  return crypto.randomBytes(16).toString("base64");
}

// ---------------------------------------------------------------------------
// Extension entry points
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand("aiCodeParser.open", () => {
    const panel = vscode.window.createWebviewPanel(
      "aiCodeParser",
      "Code Patch Parser",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      }
    );

    const nonce = generateNonce();
    panel.webview.html = getHtml(nonce);

    panel.webview.onDidReceiveMessage(async (msg: { type: string; input?: string }) => {
      try {
        if (msg.type === "load") {
          const selected = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { "JSON / Text": ["json", "txt"], "All files": ["*"] },
          });
          if (!selected?.[0]) return;

          const raw = await fs.readFile(selected[0].fsPath, "utf8");
          panel.webview.postMessage({
            input: cleanJsonInput(raw),
            message: `Loaded: ${selected[0].fsPath}`,
            status: "success",
          });
          return;
        }

        const raw = msg.input ?? "";
        const mb = Buffer.byteLength(raw, "utf8") / 1024 / 1024;

        if (mb > MAX_INPUT_MB) {
          panel.webview.postMessage({
            message: `Input too large (${mb.toFixed(2)} MB). Maximum is ${MAX_INPUT_MB} MB.`,
            status: "error",
          });
          return;
        }

        if (msg.type === "format") {
          const formatted = formatJsonInput(raw);
          panel.webview.postMessage({
            input: formatted,
            message: "JSON formatted.",
            status: "success",
          });
          return;
        }

        if (mb > WARN_INPUT_MB) {
          const answer = await vscode.window.showWarningMessage(
            `Large JSON input: ${mb.toFixed(2)} MB. Continue?`,
            { modal: true },
            "Continue"
          );
          if (answer !== "Continue") {
            panel.webview.postMessage({ message: "Cancelled.", status: "" });
            return;
          }
        }

        await vscode.workspace.saveAll(false);

        const repo = await getRepoRoot();
        const payload = parsePayload(raw);

        if (payload.operations.length === 0) {
          panel.webview.postMessage({
            message: "No operations found in JSON.",
            status: "",
          });
          return;
        }

        const result = await buildChanges(repo, payload);

        if (msg.type === "analyze") {
          panel.webview.postMessage({
            message: [`Repo: ${repo}`, "", summarize(result)].join("\n"),
            status: "",
          });
          return;
        }

        if (msg.type === "preview") {
          await previewChanges(result);
          panel.webview.postMessage({
            message: ["Preview opened.", "", summarize(result)].join("\n"),
            status: "success",
          });
          return;
        }

        if (msg.type === "apply") {
          const answer = await vscode.window.showWarningMessage(
            `Apply ${payload.operations.length} operation(s) to ${result.changes.length} file(s)?`,
            { modal: true },
            "Apply"
          );
          if (answer !== "Apply") {
            panel.webview.postMessage({ message: "Cancelled.", status: "" });
            return;
          }

          await applyChanges(repo, result);
          await formatChangedFiles(repo, result);

          panel.webview.postMessage({
            message: ["Applied successfully.", "", summarize(result)].join("\n"),
            status: "success",
          });
        }
      } catch (e: any) {
        panel.webview.postMessage({
          message: `${e.message ?? String(e)}`,
          status: "error",
        });
      }
    }, undefined, context.subscriptions);
  });

  context.subscriptions.push(disposable);
}

export function deactivate(): void { }
