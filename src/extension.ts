import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { applyChanges, buildChanges, summarize, writeTempFile } from "./changes";
import { MAX_INPUT_MB, TEMP_DIR_PREFIX, WARN_INPUT_MB } from "./constants";
import { copyFilesToClipboard } from "./fileClipboard";
import { getRepoRoot } from "./git";
import { cleanJsonInput, formatJsonInput, parsePayload } from "./jsonInput";
import { ApplyResult } from "./model";
import {
  HandoffAsset,
  cleanupWorkflowTempDirs,
  getProviderUrl,
  makeHandoffAsset,
  prepareAiRequest,
  savePastedAsset,
  updateProjectContext,
} from "./workflow";
import { resolveRepoPath } from "./validation";

interface WebviewMessage {
  type: string;
  prompt?: string;
  patchInput?: string;
  preparedPrompt?: string;
  handoffDir?: string;
  provider?: string;
  assetDataUrl?: string;
  assetName?: string;
  assets?: HandoffAsset[];
  handoffFilePaths?: string[];
}

interface StatusMessage {
  area: "builder" | "patch";
  message: string;
  status?: "idle" | "running" | "success" | "error";
  append?: boolean;
}

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
      // Formatting is best-effort because some file types may not have a formatter.
    }
  }
}

async function writePreviewTempFile(dir: string, name: string, content: string): Promise<vscode.Uri> {
  return vscode.Uri.file(await writeTempFile(dir, name, content));
}

async function previewChanges(result: ApplyResult): Promise<void> {
  if (result.changes.length === 0) throw new Error("No changes to preview.");

  const items = result.changes.map(change => ({
    label: change.file,
    description: change.before === null ? "CREATE" : change.after === null ? "DELETE" : "MODIFY",
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
  --border: var(--vscode-panel-border);
  --muted: var(--vscode-descriptionForeground);
  --surface: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-sideBar-background));
  --surface-strong: color-mix(in srgb, var(--vscode-editor-background) 72%, var(--vscode-sideBar-background));
  --ok: var(--vscode-terminal-ansiGreen, #89d185);
  --bad: var(--vscode-errorForeground, #f48771);
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
  background: var(--vscode-editor-background);
}

button, textarea {
  font-family: inherit;
}

.app {
  width: min(1320px, calc(100vw - 56px));
  margin: 0 auto;
  padding: 22px 0 26px;
}

.topbar {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 18px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border);
}

.eyebrow {
  margin-bottom: 7px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
}

h1, h2, h3, p {
  margin: 0;
}

h1 {
  font-size: 24px;
  line-height: 1.2;
}

.subtitle {
  max-width: 760px;
  margin-top: 6px;
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.55;
}

.tabs {
  display: inline-grid;
  grid-template-columns: 1fr 1fr;
  min-width: 390px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-strong);
}

.tab {
  min-height: 34px;
  border-radius: 6px;
  border: 0;
  color: var(--muted);
  background: transparent;
}

.tab.active {
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
}

.workspace {
  display: none;
  grid-template-columns: minmax(0, 1.15fr) minmax(330px, 0.85fr);
  gap: 14px;
  margin-top: 14px;
}

.workspace.active {
  display: grid;
}

.panel {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  overflow: hidden;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 48px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-strong);
}

.panel-title {
  font-size: 13px;
  font-weight: 700;
}

.panel-note {
  color: var(--muted);
  font-size: 11.5px;
}

.panel-body {
  padding: 14px;
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

button {
  appearance: none;
  min-height: 32px;
  padding: 7px 12px;
  cursor: pointer;
  border-radius: 7px;
  border: 1px solid var(--vscode-button-border, transparent);
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  font-size: 12px;
  font-weight: 650;
}

button:hover {
  opacity: 0.92;
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
  border-color: var(--border);
}

button.danger {
  color: var(--vscode-button-foreground);
  background: color-mix(in srgb, var(--vscode-inputValidation-errorBackground, #5a1d1d) 58%, var(--vscode-button-background));
  border-color: var(--vscode-inputValidation-errorBorder, #be1100);
}

button.success-cta {
  color: var(--vscode-button-foreground);
  background: color-mix(in srgb, var(--ok) 42%, var(--vscode-button-background));
  border-color: color-mix(in srgb, var(--ok) 68%, var(--vscode-button-border, transparent));
}

label {
  display: block;
  margin-bottom: 8px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
}

textarea {
  display: block;
  width: 100%;
  min-height: 320px;
  resize: vertical;
  padding: 13px 14px;
  border: 1px solid var(--vscode-input-border, var(--border));
  border-radius: 8px;
  outline: none;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font-family: var(--vscode-editor-font-family);
  font-size: 13px;
  line-height: 1.55;
}

textarea:focus {
  border-color: var(--vscode-focusBorder);
}

select {
  width: 148px;
  min-height: 32px;
  padding: 6px 34px 6px 12px;
  border: 1px solid var(--vscode-dropdown-border, var(--border));
  border-radius: 7px;
  color: var(--vscode-dropdown-foreground);
  background: var(--vscode-dropdown-background);
}

.prompt-box {
  min-height: 255px;
}

.prepared-box {
  min-height: 150px;
  max-height: 260px;
}

.stats {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 24px;
  color: var(--muted);
  font-size: 11px;
}

#clean {
  margin-bottom: 3px;
  margin-top: 4px;
}

.status {
  min-height: 132px;
  margin: 0;
  padding: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--vscode-terminal-background, var(--vscode-editor-background));
  font-family: var(--vscode-editor-font-family);
  font-size: 12px;
  line-height: 1.5;
}

.status.success {
  color: var(--ok);
}

.status.error {
  color: var(--bad);
  border-color: var(--vscode-inputValidation-errorBorder, #be1100);
}

.status.running {
  color: var(--vscode-terminal-ansiYellow, #dcdcaa);
}

.files {
  display: grid;
  gap: 8px;
  margin-top: 12px;
}

.asset-drop {
  margin-top: 12px;
  padding: 12px;
  border: 1px dashed color-mix(in srgb, var(--border) 70%, var(--vscode-focusBorder));
  border-radius: 8px;
  background: color-mix(in srgb, var(--vscode-input-background) 88%, var(--vscode-editor-background));
}

.asset-drop strong {
  display: block;
  margin-bottom: 4px;
  font-size: 12px;
}

.asset-drop span {
  color: var(--muted);
  font-size: 11.5px;
  line-height: 1.45;
}

.file-row {
  display: grid;
  gap: 3px;
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--vscode-input-background);
}

.file-row b {
  font-size: 11px;
}

.file-row code {
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.handoff-actions {
  margin-top: 12px;
}

.handoff-actions.is-primary {
  margin-top: 0;
  margin-bottom: 14px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border);
}

.handoff-actions.is-primary button {
  min-width: 112px;
}

.hidden {
  display: none;
}

@media (max-width: 920px) {
  .topbar {
    align-items: stretch;
    flex-direction: column;
  }

  .tabs {
    min-width: 0;
    width: 100%;
  }

  .workspace.active {
    grid-template-columns: 1fr;
  }

  .app {
    width: calc(100vw - 28px);
  }
}
</style>
</head>
<body>
  <main class="app">
    <header class="topbar">
      <div>
        <div class="eyebrow">AI coding workflow</div>
        <h1>AI Code Workflow</h1>
        <p class="subtitle">Create one clean request package for ChatGPT, Claude, Gemini, Grok, or any other AI chat, then review and apply the JSON patch safely inside VS Code.</p>
      </div>
      <nav class="tabs" aria-label="Workflow steps">
        <button id="tab-builder" class="tab active" data-tab="builder">Create AI Request</button>
        <button id="tab-patch" class="tab" data-tab="patch">Review & Apply Patch</button>
      </nav>
    </header>

    <section id="workspace-builder" class="workspace active">
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Task for AI</h2>
            <p class="panel-note">Describe the change in plain language.</p>
          </div>
          <div class="actions">
            <button id="prepare-request">Prepare AI Request</button>
          </div>
        </div>
        <div class="panel-body">
          <label for="prompt">User prompt</label>
          <textarea id="prompt" class="prompt-box" spellcheck="false" placeholder="Add Markdown export support and update README."></textarea>
          <div class="stats">
            <span id="prompt-stats">Empty</span>
            <span>Prepare always refreshes Repomix first</span>
          </div>
          <div id="asset-drop" class="asset-drop" tabindex="0">
            <strong>Add screenshots and files</strong>
            <span>Paste screenshots with Ctrl+V, or add any local files. Everything listed here is copied into the next handoff package.</span>
          </div>
          <div class="actions handoff-actions">
            <button id="add-files" class="ghost">Add Files</button>
            <button id="clear-assets" class="ghost">Clear Added Files</button>
          </div>
          <div id="asset-list" class="files hidden"></div>
        </div>
      </section>

      <aside class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">AI handoff</h2>
            <p class="panel-note">One request file plus project context and optional attachments.</p>
          </div>
          <div class="actions">
            <select id="provider">
              <option value="chatgpt">ChatGPT</option>
              <option value="claude">Claude</option>
              <option value="gemini">Gemini</option>
              <option value="grok">Grok</option>
            </select>
            <button id="open-provider" class="secondary">Open AI Chat</button>
          </div>
        </div>
        <div class="panel-body">
          <div class="actions handoff-actions is-primary">
            <button id="copy-files" class="ghost" disabled>Copy Files</button>
            <button id="open-handoff" class="ghost" disabled>Open Folder</button>
            <button id="cleanup-temp" class="ghost">Clean Old</button>
          </div>

          <pre id="builder-output" class="status">Ready. Write a task and press Prepare AI Request. It will refresh Repomix, build the handoff folder, copy the prompt, and open the selected AI chat.</pre>

          <div id="handoff-files" class="files hidden">
            <div class="file-row"><b>AI request file</b><code id="prompt-file"></code></div>
            <div class="file-row"><b>Project context</b><code id="context-file"></code></div>
            <div id="prepared-assets"></div>
          </div>
        </div>
      </aside>
    </section>

    <section id="workspace-patch" class="workspace">
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">AI JSON response</h2>
            <p class="panel-note">Paste the JSON operations object returned by the AI model.</p>
          </div>
          <div class="actions">
            <button id="load" class="secondary">Load File</button>
            <button id="format" class="secondary">Format JSON</button>
            <button id="analyze">Analyze</button>
            <button id="preview">Preview</button>
            <button id="apply" class="success-cta">Apply Patch</button>
          </div>
        </div>
        <div class="panel-body">
          <label for="patch-input">AI patch payload</label>
          <textarea id="patch-input" spellcheck="false" placeholder='{ "operations": [] }'></textarea>
          <div class="stats">
            <span id="patch-stats">Empty</span>
            <button id="clean" class="ghost">Clear</button>
          </div>
        </div>
      </section>

      <aside class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Patch status</h2>
            <p class="panel-note">Analyze before applying changes.</p>
          </div>
        </div>
        <div class="panel-body">
          <pre id="patch-output" class="status">Ready for an AI JSON operations payload.</pre>
        </div>
      </aside>
    </section>
  </main>

<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const state = vscode.getState() || {};
  let preparedPrompt = state.preparedPrompt || "";
  let handoffDir = state.handoffDir || "";
  let handoffFilePaths = state.handoffFilePaths || [];
  let assets = state.assets || [];

  const tabs = document.querySelectorAll(".tab");
  const prompt = document.getElementById("prompt");
  const patchInput = document.getElementById("patch-input");
  const provider = document.getElementById("provider");
  const builderOutput = document.getElementById("builder-output");
  const patchOutput = document.getElementById("patch-output");
  const promptStats = document.getElementById("prompt-stats");
  const patchStats = document.getElementById("patch-stats");
  const copyFiles = document.getElementById("copy-files");
  const openHandoff = document.getElementById("open-handoff");
  const assetList = document.getElementById("asset-list");

  prompt.value = state.prompt || "";
  patchInput.value = state.patchInput || "";
  provider.value = state.provider || "chatgpt";

  function persist() {
    vscode.setState({
      prompt: prompt.value,
      patchInput: patchInput.value,
      preparedPrompt,
      handoffDir,
      handoffFilePaths,
      provider: provider.value,
      assets
    });
  }

  function setTab(tab) {
    tabs.forEach(button => button.classList.toggle("active", button.dataset.tab === tab));
    document.getElementById("workspace-builder").classList.toggle("active", tab === "builder");
    document.getElementById("workspace-patch").classList.toggle("active", tab === "patch");
    vscode.setState({ ...vscode.getState(), activeTab: tab });
  }

  function byteStats(value) {
    const chars = value.length;
    const kb = (new TextEncoder().encode(value).byteLength / 1024).toFixed(1);
    return chars > 0 ? chars.toLocaleString() + " chars / " + kb + " KB" : "Empty";
  }

  function updateStats() {
    promptStats.textContent = byteStats(prompt.value);
    patchStats.textContent = byteStats(patchInput.value);
  }

  function renderAssets() {
    assetList.innerHTML = "";
    assetList.classList.toggle("hidden", assets.length === 0);

    for (const asset of assets) {
      const row = document.createElement("div");
      row.className = "file-row";

      const title = document.createElement("b");
      title.textContent = asset.name;

      const location = document.createElement("code");
      location.textContent = asset.path;

      row.append(title, location);
      assetList.append(row);
    }
  }

  function setStatus(area, message, status, append) {
    const el = area === "builder" ? builderOutput : patchOutput;
    el.textContent = append ? (el.textContent + message) : message;
    el.className = "status " + (status || "idle");
  }

  function setBusy(isBusy) {
    document.querySelectorAll("button").forEach(button => {
      if (button.classList.contains("tab")) return;
      button.disabled = isBusy || button.dataset.locked === "true";
    });
    if (!isBusy) updatePreparedButtons();
  }

  function updatePreparedButtons() {
    copyFiles.disabled = handoffFilePaths.length === 0;
    openHandoff.disabled = !handoffDir;
  }

  function invalidatePreparedRequest() {
    preparedPrompt = "";
    handoffDir = "";
    handoffFilePaths = [];
    document.getElementById("handoff-files").classList.add("hidden");
    updatePreparedButtons();
  }

  function send(type) {
    vscode.postMessage({
      type,
      prompt: prompt.value,
      patchInput: patchInput.value,
      preparedPrompt,
      handoffDir,
      handoffFilePaths,
      provider: provider.value,
      assets
    });
  }

  tabs.forEach(button => button.addEventListener("click", () => setTab(button.dataset.tab)));
  prompt.addEventListener("input", () => {
    updateStats();
    invalidatePreparedRequest();
    persist();
  });
  patchInput.addEventListener("input", () => { updateStats(); persist(); });
  provider.addEventListener("change", persist);

  async function handlePaste(event) {
    const items = Array.from(event.clipboardData?.items || []);
    const imageItems = items.filter(item => item.kind === "file" && item.type.startsWith("image/"));
    if (imageItems.length === 0) return;

    event.preventDefault();
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;
      vscode.postMessage({
        type: "pasteAsset",
        assetName: file.name || "screenshot.png",
        assetDataUrl: await fileToDataUrl(file)
      });
    }
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  document.getElementById("asset-drop").addEventListener("paste", handlePaste);
  prompt.addEventListener("paste", handlePaste);

  document.getElementById("prepare-request").onclick = () => send("prepareRequest");
  document.getElementById("open-provider").onclick = () => send("openProvider");
  document.getElementById("add-files").onclick = () => send("addFiles");
  document.getElementById("clear-assets").onclick = () => {
    assets = [];
    invalidatePreparedRequest();
    renderAssets();
    persist();
    setStatus("builder", "Added files cleared from the next handoff package.", "idle");
  };
  document.getElementById("copy-files").onclick = () => send("copyFiles");
  document.getElementById("open-handoff").onclick = () => send("openHandoff");
  document.getElementById("cleanup-temp").onclick = () => send("cleanupTemp");
  document.getElementById("load").onclick = () => send("load");
  document.getElementById("format").onclick = () => send("format");
  document.getElementById("analyze").onclick = () => send("analyze");
  document.getElementById("preview").onclick = () => send("preview");
  document.getElementById("apply").onclick = () => send("apply");
  document.getElementById("clean").onclick = () => {
    patchInput.value = "";
    setStatus("patch", "Cleared.", "idle");
    updateStats();
    persist();
  };

  window.addEventListener("message", event => {
    const data = event.data;
    if (data.busy !== undefined) setBusy(data.busy);
    if (data.area && data.message !== undefined) setStatus(data.area, data.message, data.status, data.append);
    if (data.patchInput !== undefined) {
      patchInput.value = data.patchInput;
      updateStats();
      persist();
    }
    if (data.asset) {
      assets = [...assets, data.asset];
      invalidatePreparedRequest();
      renderAssets();
      persist();
    }
    if (data.assets) {
      assets = [...assets, ...data.assets];
      invalidatePreparedRequest();
      renderAssets();
      persist();
    }
    if (data.cleanupDone) {
      assets = [];
      preparedPrompt = "";
      handoffDir = "";
      handoffFilePaths = [];
      document.getElementById("handoff-files").classList.add("hidden");
      renderAssets();
      updatePreparedButtons();
      persist();
    }
    if (data.prepared) {
      preparedPrompt = data.prepared.prompt;
      handoffDir = data.prepared.handoffDir;
      handoffFilePaths = data.prepared.allFilePaths || [];
      document.getElementById("prompt-file").textContent = data.prepared.promptPath;
      document.getElementById("context-file").textContent = data.prepared.projectContextPath;
      const preparedAssets = document.getElementById("prepared-assets");
      preparedAssets.innerHTML = "";
      for (const asset of data.prepared.assets || []) {
        const row = document.createElement("div");
        row.className = "file-row";
        const title = document.createElement("b");
        title.textContent = asset.name;
        const location = document.createElement("code");
        location.textContent = asset.path;
        row.append(title, location);
        preparedAssets.append(row);
      }
      document.getElementById("handoff-files").classList.remove("hidden");
      updatePreparedButtons();
      persist();
    }
    if (data.tab) setTab(data.tab);
  });

  setTab(state.activeTab || "builder");
  updateStats();
  renderAssets();
  updatePreparedButtons();
})();
</script>
</body>
</html>`;
}

function generateNonce(): string {
  return crypto.randomBytes(16).toString("base64");
}

export function activate(context: vscode.ExtensionContext): void {
  const openPanel = () => {
    const panel = vscode.window.createWebviewPanel(
      "aiCodeWorkflow",
      "AI Code Workflow",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      }
    );

    panel.webview.html = getHtml(generateNonce());

    panel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      try {
        await handleMessage(context, panel, msg);
      } catch (error: unknown) {
        postStatus(panel, {
          area: isPatchAction(msg.type) ? "patch" : "builder",
          message: getErrorMessage(error),
          status: "error",
        });
      } finally {
        panel.webview.postMessage({ busy: false });
      }
    }, undefined, context.subscriptions);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("aiCodeWorkflow.open", openPanel)
  );
}

export function deactivate(): void { }

async function handleMessage(
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
  msg: WebviewMessage
): Promise<void> {
  if (msg.type === "openProvider") {
    await vscode.env.openExternal(vscode.Uri.parse(getProviderUrl(msg.provider)));
    return;
  }

  if (msg.type === "copyFiles") {
    const paths = msg.handoffFilePaths ?? [];
    if (paths.length === 0) throw new Error("Prepare an AI request first.");
    await copyFilesToClipboard(paths);
    postStatus(panel, {
      area: "builder",
      message: [
        `Copied ${paths.length} file(s) to the Windows clipboard.`,
        "",
        "Now try Ctrl+V in your AI chat. If the website blocks file paste, use Open Handoff Folder and upload or drag the files together.",
      ].join("\n"),
      status: "success",
    });
    return;
  }

  if (msg.type === "openHandoff") {
    if (!msg.handoffDir) throw new Error("Prepare an AI request first.");
    await vscode.env.openExternal(vscode.Uri.file(msg.handoffDir));
    return;
  }

  if (msg.type === "pasteAsset") {
    await handlePasteAsset(panel, msg);
    return;
  }

  if (msg.type === "addFiles") {
    await handleAddFiles(panel);
    return;
  }

  panel.webview.postMessage({ busy: true });

  if (msg.type === "prepareRequest") {
    await handlePrepareRequest(context, panel, msg.prompt ?? "", msg.assets ?? [], msg.provider);
    return;
  }

  if (msg.type === "cleanupTemp") {
    const removed = await cleanupWorkflowTempDirs();
    postStatus(panel, {
      area: "builder",
      message: `Cleaned ${removed} AI Code Workflow temp folder(s).`,
      status: "success",
    });
    panel.webview.postMessage({ cleanupDone: true });
    return;
  }

  await handlePatchMessage(panel, msg);
}

async function handlePasteAsset(panel: vscode.WebviewPanel, msg: WebviewMessage): Promise<void> {
  if (!msg.assetDataUrl) throw new Error("No pasted image data received.");

  const repo = await getRepoRoot();
  const asset = await savePastedAsset(repo, msg.assetDataUrl, msg.assetName);

  panel.webview.postMessage({
    area: "builder",
    message: `Saved pasted asset:\n${asset.path}`,
    status: "success",
    asset,
  });
}

async function handleAddFiles(panel: vscode.WebviewPanel): Promise<void> {
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: true,
    title: "Add files to the next AI handoff package",
    filters: { "All files": ["*"] },
  });

  if (!selected?.length) return;

  const assets = selected.map(uri => makeHandoffAsset(uri.fsPath));

  panel.webview.postMessage({
    area: "builder",
    message: `Added ${assets.length} file(s) to the next handoff package.`,
    status: "success",
    assets,
  });
}

async function handlePrepareRequest(
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
  userPrompt: string,
  assets: HandoffAsset[],
  provider?: string
): Promise<void> {
  await vscode.workspace.saveAll(false);
  const repo = await getRepoRoot();

  postStatus(panel, {
    area: "builder",
    message: "Refreshing project context with Repomix...\n\n",
    status: "running",
  });

  await updateProjectContext(repo, chunk => {
    panel.webview.postMessage({
      area: "builder",
      message: chunk,
      status: "running",
      append: true,
    } satisfies StatusMessage);
  });

  postStatus(panel, {
    area: "builder",
    message: "Building AI handoff package...",
    status: "running",
  });

  const prepared = await prepareAiRequest(context, repo, userPrompt, assets);
  await vscode.env.clipboard.writeText(prepared.prompt);
  await vscode.env.openExternal(vscode.Uri.parse(getProviderUrl(provider)));
  await vscode.env.openExternal(vscode.Uri.file(prepared.handoffDir));

  const assetLines = prepared.assets.map(asset => `- ${asset.name}`);

  panel.webview.postMessage({
    area: "builder",
    message: [
      "AI request is ready.",
      "",
      "The prompt was copied to your clipboard. The selected AI chat and handoff folder were opened.",
      "Attach these files from the handoff folder:",
      `- ${path.basename(prepared.promptPath)}`,
      `- ${path.basename(prepared.projectContextPath)}`,
      ...assetLines,
      "",
      "Tip: select all needed files in the handoff folder and upload them together through the AI chat attachment button or drag-and-drop.",
      "",
      `Handoff folder:\n${prepared.handoffDir}`,
    ].join("\n"),
    status: "success",
    prepared,
  });
}

async function handlePatchMessage(panel: vscode.WebviewPanel, msg: WebviewMessage): Promise<void> {
  if (msg.type === "load") {
    const selected = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "JSON / Text": ["json", "txt"], "All files": ["*"] },
    });
    if (!selected?.[0]) return;

    const raw = await fs.readFile(selected[0].fsPath, "utf8");
    panel.webview.postMessage({
      tab: "patch",
      patchInput: cleanJsonInput(raw),
      area: "patch",
      message: `Loaded:\n${selected[0].fsPath}`,
      status: "success",
    });
    return;
  }

  const raw = msg.patchInput ?? "";
  const mb = Buffer.byteLength(raw, "utf8") / 1024 / 1024;

  if (mb > MAX_INPUT_MB) {
    postStatus(panel, {
      area: "patch",
      message: `Input too large (${mb.toFixed(2)} MB). Maximum is ${MAX_INPUT_MB} MB.`,
      status: "error",
    });
    return;
  }

  if (msg.type === "format") {
    panel.webview.postMessage({
      tab: "patch",
      patchInput: formatJsonInput(raw),
      area: "patch",
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
      postStatus(panel, { area: "patch", message: "Cancelled.", status: "idle" });
      return;
    }
  }

  await vscode.workspace.saveAll(false);

  const repo = await getRepoRoot();
  const payload = parsePayload(raw);

  if (payload.operations.length === 0) {
    postStatus(panel, { area: "patch", message: "No operations found in JSON.", status: "idle" });
    return;
  }

  const result = await buildChanges(repo, payload);

  if (msg.type === "analyze") {
    postStatus(panel, {
      area: "patch",
      message: [`Repo: ${repo}`, "", summarize(result)].join("\n"),
      status: "idle",
    });
    return;
  }

  if (msg.type === "preview") {
    await previewChanges(result);
    postStatus(panel, {
      area: "patch",
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
      postStatus(panel, { area: "patch", message: "Cancelled.", status: "idle" });
      return;
    }

    await applyChanges(repo, result);
    await formatChangedFiles(repo, result);

    postStatus(panel, {
      area: "patch",
      message: ["Applied successfully.", "", summarize(result)].join("\n"),
      status: "success",
    });
  }
}

function postStatus(panel: vscode.WebviewPanel, message: StatusMessage): void {
  panel.webview.postMessage(message);
}

function isPatchAction(type: string): boolean {
  return new Set(["load", "format", "analyze", "preview", "apply"]).has(type);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
