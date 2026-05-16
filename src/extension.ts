import * as vscode from "vscode";
import * as cp from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

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

type EditOperation = {
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
};

type OperationsPayload = {
  operations: EditOperation[];
};

type FileChange = {
  file: string;
  before: string | null;
  after: string | null;
  operations: EditOperation[];
};

type ApplyResult = {
  changes: FileChange[];
  warnings: string[];
};

type CmdResult = {
  stdout: string;
  stderr: string;
};

function runGit(args: string[], cwd: string): Promise<CmdResult> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn("git", args, {
      cwd,
      shell: false,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", d => (stdout += d.toString()));
    child.stderr.on("data", d => (stderr += d.toString()));
    child.on("error", reject);

    child.on("close", code => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          Object.assign(new Error(stderr || stdout || `git exited ${code}`), {
            stdout,
            stderr
          })
        );
      }
    });
  });
}

async function getRepoRoot(): Promise<string> {
  const folder = vscode.workspace.workspaceFolders?.[0];

  if (!folder) {
    throw new Error("Open a folder first.");
  }

  const result = await runGit(
    ["rev-parse", "--show-toplevel"],
    folder.uri.fsPath
  );

  return result.stdout.trim();
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function cleanJsonInput(input: string): string {
  let text = normalizeNewlines(input).trim();

  text = text.replace(/^```(?:json)?\s*/i, "");
  text = text.replace(/\n```$/i, "");

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }

  return text.trim();
}

function parsePayload(input: string): OperationsPayload {
  const cleaned = cleanJsonInput(input);
  const data = JSON.parse(cleaned);

  if (!data || !Array.isArray(data.operations)) {
    throw new Error("Invalid JSON. Expected: { \"operations\": [...] }");
  }

  return data as OperationsPayload;
}

function validatePath(file: string): void {
  if (!file || typeof file !== "string") {
    throw new Error("Operation has invalid file path.");
  }

  if (file.includes("\0")) {
    throw new Error(`Null byte path blocked: ${file}`);
  }

  if (path.isAbsolute(file)) {
    throw new Error(`Absolute path blocked: ${file}`);
  }

  const normalized = path.normalize(file);

  if (normalized.startsWith("..") || normalized.includes(`${path.sep}..${path.sep}`)) {
    throw new Error(`Path traversal blocked: ${file}`);
  }

  if (file === ".git" || file.startsWith(".git/")) {
    throw new Error(`.git modification blocked: ${file}`);
  }
}

function validateOperation(op: EditOperation): void {
  validatePath(op.file);

  const allowed: OperationType[] = [
    "replace",
    "replace_all",
    "replace_block",
    "insert_before",
    "insert_after",
    "delete",
    "create_file",
    "delete_file",
    "replace_file"
  ];

  if (!allowed.includes(op.type)) {
    throw new Error(`Unsupported operation type: ${op.type}`);
  }

  if (
    ["replace", "replace_all", "replace_block"].includes(op.type) &&
    typeof op.replace !== "string"
  ) {
    throw new Error(`${op.type} requires "replace".`);
  }

  if (
    ["replace", "replace_all", "replace_block", "insert_before", "insert_after", "delete"].includes(op.type) &&
    typeof op.search !== "string" &&
    typeof op.startLine !== "number"
  ) {
    throw new Error(`${op.type} requires "search" or line range.`);
  }

  if (
    ["insert_before", "insert_after"].includes(op.type) &&
    typeof op.text !== "string"
  ) {
    throw new Error(`${op.type} requires "text".`);
  }

  if (
    ["create_file", "replace_file"].includes(op.type) &&
    typeof op.content !== "string"
  ) {
    throw new Error(`${op.type} requires "content".`);
  }

  if (
    op.startLine !== undefined &&
    (!Number.isInteger(op.startLine) || op.startLine < 1)
  ) {
    throw new Error(`Invalid startLine in ${op.file}.`);
  }

  if (
    op.endLine !== undefined &&
    (!Number.isInteger(op.endLine) || op.endLine < 1)
  ) {
    throw new Error(`Invalid endLine in ${op.file}.`);
  }

  if (
    op.startLine !== undefined &&
    op.endLine !== undefined &&
    op.endLine < op.startLine
  ) {
    throw new Error(`endLine cannot be smaller than startLine in ${op.file}.`);
  }
}

function groupByFile(operations: EditOperation[]): Map<string, EditOperation[]> {
  const map = new Map<string, EditOperation[]>();

  for (const op of operations) {
    validateOperation(op);

    if (!map.has(op.file)) {
      map.set(op.file, []);
    }

    map.get(op.file)!.push(op);
  }

  return map;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;

  let count = 0;
  let index = 0;

  while (true) {
    const found = haystack.indexOf(needle, index);

    if (found === -1) break;

    count++;
    index = found + needle.length;
  }

  return count;
}

function findOccurrence(text: string, search: string, occurrence?: number): number {
  const wanted = occurrence ?? 1;

  if (wanted < 1) {
    throw new Error("occurrence must be >= 1.");
  }

  let index = 0;
  let seen = 0;

  while (true) {
    const found = text.indexOf(search, index);

    if (found === -1) {
      return -1;
    }

    seen++;

    if (seen === wanted) {
      return found;
    }

    index = found + search.length;
  }
}

function lineRangeToIndexes(
  text: string,
  startLine: number,
  endLine: number
): { start: number; end: number } {
  const lines = text.split("\n");

  if (startLine > lines.length) {
    throw new Error(`startLine ${startLine} is outside file.`);
  }

  const safeEndLine = Math.min(endLine, lines.length);

  let start = 0;

  for (let i = 1; i < startLine; i++) {
    start += lines[i - 1].length + 1;
  }

  let end = start;

  for (let i = startLine; i <= safeEndLine; i++) {
    end += lines[i - 1].length;

    if (i < lines.length) {
      end += 1;
    }
  }

  return { start, end };
}

function findWithAnchor(text: string, search: string, anchor?: string): number {
  if (!anchor) {
    return text.indexOf(search);
  }

  const anchorIndex = text.indexOf(anchor);

  if (anchorIndex === -1) {
    return -1;
  }

  const before = text.slice(0, anchorIndex);
  const after = text.slice(anchorIndex);

  const afterIndex = after.indexOf(search);

  if (afterIndex !== -1) {
    return anchorIndex + afterIndex;
  }

  const beforeIndex = before.lastIndexOf(search);

  if (beforeIndex !== -1) {
    return beforeIndex;
  }

  return -1;
}

function applyTextOperation(
  current: string,
  op: EditOperation,
  warnings: string[]
): string {
  if (op.type === "replace_file") {
    return normalizeNewlines(op.content ?? "");
  }

  if (op.type === "create_file") {
    return normalizeNewlines(op.content ?? "");
  }

  if (op.type === "delete_file") {
    return current;
  }

  if (op.startLine !== undefined) {
    const endLine = op.endLine ?? op.startLine;
    const range = lineRangeToIndexes(current, op.startLine, endLine);

    if (op.type === "replace" || op.type === "replace_block") {
      return current.slice(0, range.start) + normalizeNewlines(op.replace ?? "") + current.slice(range.end);
    }

    if (op.type === "delete") {
      return current.slice(0, range.start) + current.slice(range.end);
    }

    if (op.type === "insert_before") {
      return current.slice(0, range.start) + normalizeNewlines(op.text ?? "") + "\n" + current.slice(range.start);
    }

    if (op.type === "insert_after") {
      return current.slice(0, range.end) + "\n" + normalizeNewlines(op.text ?? "") + current.slice(range.end);
    }
  }

  const search = normalizeNewlines(op.search ?? "");

  if (!search) {
    throw new Error(`${op.type} in ${op.file} has empty search.`);
  }

  if (op.type === "replace_all") {
    const total = countOccurrences(current, search);

    if (total === 0) {
      if (op.allowMissing) return current;
      throw new Error(`Search text not found in ${op.file}.`);
    }

    warnings.push(`${op.file}: replace_all changed ${total} occurrence(s).`);

    return current.replace(
      new RegExp(escapeRegExp(search), "g"),
      normalizeNewlines(op.replace ?? "")
    );
  }

  let index = op.anchor
    ? findWithAnchor(current, search, op.anchor)
    : findOccurrence(current, search, op.occurrence);

  if (index === -1) {
    if (op.allowMissing) {
      warnings.push(`${op.file}: skipped missing optional search.`);
      return current;
    }

    throw new Error(
      [
        `Search text not found in ${op.file}.`,
        op.anchor ? `Anchor: ${op.anchor}` : "",
        op.search ? `Search: ${op.search.slice(0, 300)}` : ""
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  if (!op.occurrence && !op.anchor) {
    const total = countOccurrences(current, search);

    if (total > 1) {
      throw new Error(
        `${op.file}: search text appears ${total} times. Add "occurrence", "anchor", or line numbers.`
      );
    }
  }

  if (op.type === "replace" || op.type === "replace_block") {
    return (
      current.slice(0, index) +
      normalizeNewlines(op.replace ?? "") +
      current.slice(index + search.length)
    );
  }

  if (op.type === "delete") {
    return current.slice(0, index) + current.slice(index + search.length);
  }

  if (op.type === "insert_before") {
    return (
      current.slice(0, index) +
      normalizeNewlines(op.text ?? "") +
      "\n" +
      current.slice(index)
    );
  }

  if (op.type === "insert_after") {
    return (
      current.slice(0, index + search.length) +
      "\n" +
      normalizeNewlines(op.text ?? "") +
      current.slice(index + search.length)
    );
  }

  return current;
}

async function readFileIfExists(absPath: string): Promise<string | null> {
  try {
    return normalizeNewlines(await fs.readFile(absPath, "utf8"));
  } catch {
    return null;
  }
}

async function buildChanges(repo: string, payload: OperationsPayload): Promise<ApplyResult> {
  const warnings: string[] = [];
  const groups = groupByFile(payload.operations);
  const changes: FileChange[] = [];

  for (const [file, operations] of groups) {
    const abs = path.join(repo, file);
    const before = await readFileIfExists(abs);

    let current = before ?? "";

    for (const op of operations) {
      if (op.type === "create_file" && before !== null) {
        throw new Error(`${file} already exists. Use replace_file if you want to overwrite it.`);
      }

      if (op.type !== "create_file" && op.type !== "replace_file" && op.type !== "delete_file" && before === null) {
        throw new Error(`${file} does not exist.`);
      }

      current = applyTextOperation(current, op, warnings);
    }

    const hasDeleteFile = operations.some(op => op.type === "delete_file");

    changes.push({
      file,
      before,
      after: hasDeleteFile ? null : current,
      operations
    });
  }

  return { changes, warnings };
}

function summarize(result: ApplyResult): string {
  const lines: string[] = [];

  lines.push(`Files changed: ${result.changes.length}`);
  lines.push("");

  for (const change of result.changes) {
    const opNames = change.operations.map(op => op.type).join(", ");

    if (change.before === null && change.after !== null) {
      lines.push(`CREATE ${change.file} (${opNames})`);
    } else if (change.before !== null && change.after === null) {
      lines.push(`DELETE ${change.file} (${opNames})`);
    } else {
      const beforeLines = change.before?.split("\n").length ?? 0;
      const afterLines = change.after?.split("\n").length ?? 0;
      lines.push(`MODIFY ${change.file} (${opNames}) ${beforeLines} → ${afterLines} lines`);
    }
  }

  if (result.warnings.length) {
    lines.push("");
    lines.push("Warnings:");
    lines.push(...result.warnings.map(w => `- ${w}`));
  }

  return lines.join("\n");
}

async function writeTempFile(dir: string, name: string, content: string): Promise<vscode.Uri> {
  const safeName = name.replace(/[\\/]/g, "__");
  const file = path.join(dir, safeName);

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");

  return vscode.Uri.file(file);
}

async function previewChanges(result: ApplyResult): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-json-preview-"));

  for (const change of result.changes) {
    const beforeUri = await writeTempFile(
      dir,
      `before__${change.file}`,
      change.before ?? ""
    );

    const afterUri = await writeTempFile(
      dir,
      `after__${change.file}`,
      change.after ?? ""
    );

    await vscode.commands.executeCommand(
      "vscode.diff",
      beforeUri,
      afterUri,
      `AI Preview: ${change.file}`,
      { preview: false }
    );
  }
}

async function ensureDir(absFile: string): Promise<void> {
  await fs.mkdir(path.dirname(absFile), { recursive: true });
}

async function applyChanges(repo: string, result: ApplyResult): Promise<void> {
  for (const change of result.changes) {
    const abs = path.join(repo, change.file);

    if (change.after === null) {
      await fs.rm(abs, { force: true });
      continue;
    }

    await ensureDir(abs);
    await fs.writeFile(abs, change.after, "utf8");
  }
}

async function formatChangedFiles(repo: string, result: ApplyResult): Promise<void> {
  for (const change of result.changes) {
    if (change.after === null) continue;

    const abs = path.join(repo, change.file);
    const uri = vscode.Uri.file(abs);

    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, {
        preview: false,
        preserveFocus: true
      });

      await vscode.commands.executeCommand("editor.action.formatDocument");
      await doc.save();

      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      void editor;
    } catch {
      // Formatting is best-effort.
    }
  }
}

function getHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<style>
body {
  padding: 18px;
  font-family: var(--vscode-font-family);
  color: var(--vscode-foreground);
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.badge {
  padding: 4px 8px;
  border-radius: 999px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  font-size: 12px;
}

.hint {
  opacity: 0.82;
  margin: 10px 0 14px;
  line-height: 1.5;
}

.bar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

button {
  padding: 7px 12px;
  cursor: pointer;
  border-radius: 4px;
  border: 1px solid var(--vscode-button-border, transparent);
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

button.secondary {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}

textarea {
  width: 100%;
  height: 52vh;
  resize: vertical;
  box-sizing: border-box;
  font-family: var(--vscode-editor-font-family);
  font-size: 13px;
  line-height: 1.45;
  padding: 12px;
  background: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
  border: 1px solid var(--vscode-input-border);
}

pre {
  white-space: pre-wrap;
  padding: 12px;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  max-height: 28vh;
  overflow: auto;
}

.grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
}
</style>
</head>
<body>
  <div class="header">
    <h2>AI Code Parser</h2>
    <span class="badge">JSON Operations Mode</span>
  </div>

  <div class="hint">
    Paste JSON operations from AI. Supports replace, replace_all, replace_block, insert_before, insert_after, delete, create_file, delete_file, replace_file.
  </div>

  <div class="bar">
    <button id="load">Load JSON File</button>
    <button id="example" class="secondary">Insert Example</button>
    <button id="clean" class="secondary">Clean</button>
    <button id="analyze">Analyze</button>
    <button id="preview">Preview</button>
    <button id="apply">Apply</button>
    <button id="clear" class="secondary">Clear</button>
  </div>

  <div class="grid">
    <textarea id="input" spellcheck="false" placeholder='{ "operations": [] }'></textarea>
    <div>
      <h3>Output</h3>
      <pre id="output">Ready.</pre>
    </div>
  </div>

<script>
const vscode = acquireVsCodeApi();
const input = document.getElementById("input");
const output = document.getElementById("output");

function send(type) {
  vscode.postMessage({ type, input: input.value });
}

document.getElementById("load").onclick = () => send("load");
document.getElementById("clean").onclick = () => send("clean");
document.getElementById("analyze").onclick = () => send("analyze");
document.getElementById("preview").onclick = () => send("preview");
document.getElementById("apply").onclick = () => send("apply");

document.getElementById("clear").onclick = () => {
  input.value = "";
  output.textContent = "Cleared.";
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

  output.textContent = "Example inserted.";
};

window.addEventListener("message", event => {
  if (event.data.input !== undefined) input.value = event.data.input;
  if (event.data.message !== undefined) output.textContent = event.data.message;
});
</script>
</body>
</html>`;
}

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand("aiCodeParser.open", () => {
    const panel = vscode.window.createWebviewPanel(
      "aiCodeParser",
      "AI Code Parser",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    panel.webview.html = getHtml();

    panel.webview.onDidReceiveMessage(async msg => {
      try {
        if (msg.type === "load") {
          const selected = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: {
              "JSON files": ["json", "txt"],
              "All files": ["*"]
            }
          });

          if (!selected?.[0]) return;

          const raw = await fs.readFile(selected[0].fsPath, "utf8");
          const cleaned = cleanJsonInput(raw);

          panel.webview.postMessage({
            input: cleaned,
            message: `Loaded:\n${selected[0].fsPath}`
          });

          return;
        }

        const cleaned = cleanJsonInput(msg.input || "");

        if (msg.type === "clean") {
          panel.webview.postMessage({
            input: cleaned,
            message: "JSON cleaned."
          });

          return;
        }

        await vscode.workspace.saveAll(false);

        const repo = await getRepoRoot();
        const payload = parsePayload(cleaned);
        const result = await buildChanges(repo, payload);

        if (msg.type === "analyze") {
          panel.webview.postMessage({
            message: [`Repo: ${repo}`, "", summarize(result)].join("\n")
          });

          return;
        }

        if (msg.type === "preview") {
          await previewChanges(result);

          panel.webview.postMessage({
            message: ["Preview opened.", "", summarize(result)].join("\n")
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
            panel.webview.postMessage({ message: "Cancelled." });
            return;
          }

          await applyChanges(repo, result);
          await formatChangedFiles(repo, result);

          panel.webview.postMessage({
            message: ["Applied successfully.", "", summarize(result)].join("\n")
          });
        }
      } catch (e: any) {
        panel.webview.postMessage({
          message: e.message || String(e)
        });
      }
    });
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}