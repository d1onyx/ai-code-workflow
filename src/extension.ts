import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { applyChanges, buildChanges, summarize, writeTempFile } from "./changes";
import { MAX_INPUT_MB, TEMP_DIR_PREFIX, WARN_INPUT_MB } from "./constants";
import { getRepoRoot } from "./git";
import { cleanJsonInput, formatJsonInput, parsePayload } from "./jsonInput";
import { ApplyResult } from "./model";
import { resolveRepoPath } from "./validation";

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

async function formatChangedFiles(repo: string, result: ApplyResult): Promise<void> {
  for (const change of result.changes) {
    if (change.after === null) continue;

    const uri = vscode.Uri.file(resolveRepoPath(repo, change.file));
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
// Diff preview
// ---------------------------------------------------------------------------

async function writePreviewTempFile(dir: string, name: string, content: string): Promise<vscode.Uri> {
  return vscode.Uri.file(await writeTempFile(dir, name, content));
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
    writePreviewTempFile(dir, `before__${picked.change.file}`, picked.change.before ?? ""),
    writePreviewTempFile(dir, `after__${picked.change.file}`, picked.change.after ?? ""),
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
      } catch (error: unknown) {
        panel.webview.postMessage({
          message: getErrorMessage(error),
          status: "error",
        });
      }
    }, undefined, context.subscriptions);
  });

  context.subscriptions.push(disposable);
}

export function deactivate(): void { }

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

