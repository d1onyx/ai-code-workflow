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
 * Also removes trailing commas that break JSON.parse.
 */
function cleanJsonInput(input: string): string {
  let text = normalizeNewlines(input).trim();

  // Strip markdown code fences (e.g. ```json ... ```)
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");

  // Extract from first { to last }
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }

  // Remove trailing commas before ] or } — common LLM mistake
  text = text.replace(/,\s*([}\]])/g, "$1");

  return text.trim();
}

function parsePayload(input: string): OperationsPayload {
  const cleaned = cleanJsonInput(input);

  let data: unknown;
  try {
    data = JSON.parse(cleaned);
  } catch (e: any) {
    throw new Error(`Invalid JSON: ${e.message}`);
  }

  if (!data || typeof data !== "object" || !Array.isArray((data as any).operations)) {
    throw new Error('Invalid payload. Expected: { "operations": [...] }');
  }

  return data as OperationsPayload;
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
      lines.push(`  ✚ CREATE  ${change.file}  [${ops}]`);
    } else if (change.after === null) {
      lines.push(`  ✖ DELETE  ${change.file}  [${ops}]`);
    } else {
      const before = change.before.split("\n").length;
      const after = change.after!.split("\n").length;
      const delta = after - before;
      const sign = delta >= 0 ? `+${delta}` : `${delta}`;
      lines.push(`  ✎ MODIFY  ${change.file}  [${ops}]  ${before} → ${after} lines (${sign})`);
    }
  }

  if (result.warnings.length) {
    lines.push("", "Warnings:");
    for (const w of result.warnings) lines.push(`  ⚠ ${w}`);
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
    `AI Preview: ${picked.change.file}`,
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
*, *::before, *::after { box-sizing: border-box; }

body {
  padding: 16px 20px;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  margin: 0;
}

.header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

h2 { margin: 0; font-size: 1.15em; }

.badge {
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

.hint {
  opacity: 0.75;
  margin: 6px 0 14px;
  line-height: 1.55;
  font-size: 12px;
}

.bar {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

button {
  padding: 6px 13px;
  cursor: pointer;
  border-radius: 4px;
  border: 1px solid var(--vscode-button-border, transparent);
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  font-size: 12px;
  font-family: inherit;
  transition: opacity 0.15s;
}
button:hover { opacity: 0.85; }
button:disabled { opacity: 0.4; cursor: not-allowed; }
button.secondary {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}
button.danger {
  background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
  color: var(--vscode-errorForeground, #f48771);
  border-color: var(--vscode-inputValidation-errorBorder, #be1100);
}

textarea {
  width: 100%;
  height: 50vh;
  min-height: 120px;
  resize: vertical;
  font-family: var(--vscode-editor-font-family);
  font-size: 13px;
  line-height: 1.45;
  padding: 10px 12px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 3px;
  outline: none;
}
textarea:focus { border-color: var(--vscode-focusBorder); }

.output-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  opacity: 0.6;
  margin: 10px 0 4px;
}

pre#output {
  white-space: pre-wrap;
  word-break: break-word;
  padding: 10px 12px;
  background: var(--vscode-terminal-background, var(--vscode-editor-background));
  border: 1px solid var(--vscode-panel-border);
  border-radius: 3px;
  max-height: 30vh;
  overflow: auto;
  font-family: var(--vscode-editor-font-family);
  font-size: 12px;
  margin: 0;
}

pre#output.error { color: var(--vscode-errorForeground, #f48771); }
pre#output.success { color: var(--vscode-terminal-ansiGreen, #89d185); }

#stats {
  font-size: 11px;
  opacity: 0.6;
  margin-top: 4px;
  min-height: 16px;
}
</style>
</head>
<body>
  <div class="header">
    <h2>AI Code Parser</h2>
    <span class="badge">JSON Operations Mode</span>
  </div>

  <div class="hint">
    Paste JSON operations from your AI. Supports: replace, replace_all, replace_block,
    insert_before, insert_after, delete, create_file, delete_file, replace_file.
  </div>

  <div class="bar">
    <button id="load">📂 Load File</button>
    <button id="example" class="secondary">💡 Example</button>
    <button id="clean" class="secondary">🧹 Clean JSON</button>
    <button id="analyze">🔍 Analyze</button>
    <button id="preview">👁 Preview</button>
    <button id="apply" class="danger">⚡ Apply</button>
    <button id="clear" class="secondary">✕ Clear</button>
  </div>

  <textarea id="input" spellcheck="false" placeholder='{ "operations": [] }'></textarea>
  <div id="stats"></div>

  <div class="output-label">Output</div>
  <pre id="output">Ready.</pre>

<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const input = document.getElementById("input");
  const output = document.getElementById("output");
  const stats = document.getElementById("stats");

  function setStatus(msg, type) {
    output.textContent = msg;
    output.className = type || "";
  }

  function setStats() {
    const chars = input.value.length;
    const kb = (new TextEncoder().encode(input.value).byteLength / 1024).toFixed(1);
    stats.textContent = chars > 0 ? chars.toLocaleString() + " chars \u00b7 " + kb + " KB" : "";
  }

  function send(type) {
    vscode.postMessage({ type, input: input.value });
  }

  input.addEventListener("input", setStats);

  document.getElementById("load").onclick = () => send("load");
  document.getElementById("clean").onclick = () => send("clean");
  document.getElementById("analyze").onclick = () => send("analyze");
  document.getElementById("preview").onclick = () => send("preview");
  document.getElementById("apply").onclick = () => send("apply");

  document.getElementById("clear").onclick = () => {
    input.value = "";
    setStatus("Cleared.", "");
    setStats();
  };

  document.getElementById("example").onclick = () => {
    input.value = JSON.stringify({
      operations: [
        {
          type: "replace",
          file: "some.txt",
          search: "hello from patch",
          replace: "hello world from JSON operation"
        },
        {
          type: "insert_after",
          file: "some.txt",
          search: "new appended line",
          text: "inserted by AI Code Parser"
        }
      ]
    }, null, 2);
    setStatus("Example inserted.", "");
    setStats();
  };

  window.addEventListener("message", event => {
    const { input: newInput, message, status } = event.data;
    if (newInput !== undefined) {
      input.value = newInput;
      setStats();
    }
    if (message !== undefined) {
      setStatus(message, status || "");
    }
  });

  const state = vscode.getState();
  if (state?.input) {
    input.value = state.input;
    setStats();
  }

  input.addEventListener("input", () => {
    vscode.setState({ input: input.value });
  });
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
      "AI Code Parser",
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
            message: `✔ Loaded: ${selected[0].fsPath}`,
            status: "success",
          });
          return;
        }

        const raw = msg.input ?? "";
        const mb = Buffer.byteLength(raw, "utf8") / 1024 / 1024;

        if (mb > MAX_INPUT_MB) {
          panel.webview.postMessage({
            message: `✖ Input too large (${mb.toFixed(2)} MB). Maximum is ${MAX_INPUT_MB} MB.`,
            status: "error",
          });
          return;
        }

        if (msg.type === "clean") {
          const cleaned = cleanJsonInput(raw);
          panel.webview.postMessage({
            input: cleaned,
            message: "✔ JSON cleaned.",
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
            message: "⚠ No operations found in JSON.",
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
            message: ["✔ Preview opened.", "", summarize(result)].join("\n"),
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
            message: ["✔ Applied successfully.", "", summarize(result)].join("\n"),
            status: "success",
          });
        }
      } catch (e: any) {
        panel.webview.postMessage({
          message: `✖ ${e.message ?? String(e)}`,
          status: "error",
        });
      }
    }, undefined, context.subscriptions);
  });

  context.subscriptions.push(disposable);
}

export function deactivate(): void { }
