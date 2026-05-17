import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
  AI_PROVIDER_URLS,
  ASSET_DIR_PREFIX,
  DEFAULT_INSTRUCTION_RESOURCE_DIR,
  DEFAULT_INSTRUCTION_RESOURCE_FILE,
  HANDOFF_DIR_PREFIX,
  PROJECT_CONTEXT_CANDIDATES,
  TEMP_DIR_PREFIX,
} from "./constants";
import { runProcess } from "./processRunner";

export interface HandoffAsset {
  name: string;
  path: string;
}

export interface PreparedRequest {
  prompt: string;
  projectContextPath: string;
  promptPath: string;
  handoffDir: string;
  assets: HandoffAsset[];
  allFilePaths: string[];
}

export async function updateProjectContext(repo: string, onOutput?: (chunk: string) => void): Promise<string> {
  const config = vscode.workspace.getConfiguration("aiCodeWorkflow");
  const command = config.get<string>("repomixCommand", "npx").trim() || "npx";
  const configuredArgs = config.get<unknown>("repomixArgs", ["repomix"]);
  const args = (Array.isArray(configuredArgs) ? configuredArgs : ["repomix"]).map(String).filter(Boolean);

  try {
    await runProcess(command, args, { cwd: repo, onOutput });
  } catch (error: unknown) {
    throw new Error(formatRepomixError(command, args, repo, error));
  }

  return findProjectContextFile(repo);
}

export async function prepareAiRequest(
  context: vscode.ExtensionContext,
  repo: string,
  userPrompt: string,
  assets: HandoffAsset[] = []
): Promise<PreparedRequest> {
  const trimmedPrompt = userPrompt.trim();
  if (!trimmedPrompt) {
    throw new Error("Write a task for the AI model first.");
  }

  const projectContextPath = await findProjectContextFile(repo);
  const instructionPath = await getInstructionPath(context, repo);
  const instructionText = await fs.readFile(instructionPath, "utf8");
  const prompt = buildPrompt(trimmedPrompt, instructionText, projectContextPath, assets);
  const handoffDir = await createHandoffDirectory(repo);

  const handoffContextPath = path.join(handoffDir, path.basename(projectContextPath));
  const promptPath = path.join(handoffDir, "ai-request.txt");
  const copiedAssets = await copyAssets(handoffDir, assets);
  const allFilePaths = [
    promptPath,
    handoffContextPath,
    ...copiedAssets.map(asset => asset.path),
  ];

  await Promise.all([
    fs.copyFile(projectContextPath, handoffContextPath),
    fs.writeFile(promptPath, prompt, "utf8"),
  ]);

  return {
    prompt,
    projectContextPath: handoffContextPath,
    promptPath,
    handoffDir,
    assets: copiedAssets,
    allFilePaths,
  };
}

export function getProviderUrl(provider?: string): string {
  return AI_PROVIDER_URLS[provider as keyof typeof AI_PROVIDER_URLS] ?? AI_PROVIDER_URLS.chatgpt;
}

export async function savePastedAsset(repo: string, dataUrl: string, originalName?: string): Promise<HandoffAsset> {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) throw new Error("Unsupported pasted asset format.");

  const mimeType = match[1].toLowerCase();
  const ext = extensionFromMimeType(mimeType);
  const dir = await createAssetDirectory(repo);
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const safeBase = sanitizeFileName(originalName ? stripExtension(originalName) : `screenshot-${stamp}`);
  const name = `${safeBase}.${ext}`;
  const file = await uniquePath(dir, name);

  await fs.writeFile(file, Buffer.from(match[2], "base64"));

  return { name: path.basename(file), path: file };
}

export async function cleanupWorkflowTempDirs(): Promise<number> {
  const tmp = path.resolve(os.tmpdir());
  const entries = await fs.readdir(tmp, { withFileTypes: true });
  let removed = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isWorkflowTempDir(entry.name)) continue;

    const target = path.resolve(tmp, entry.name);
    const relative = path.relative(tmp, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;

    await fs.rm(target, { recursive: true, force: true });
    removed++;
  }

  return removed;
}

export function makeHandoffAsset(filePath: string): HandoffAsset {
  return {
    name: path.basename(filePath),
    path: filePath,
  };
}

export async function findProjectContextFile(repo: string): Promise<string> {
  for (const candidate of PROJECT_CONTEXT_CANDIDATES) {
    const file = path.join(repo, candidate);
    if (await exists(file)) return file;
  }

  throw new Error(
    `Project context not found after running Repomix. Expected one of: ${PROJECT_CONTEXT_CANDIDATES.join(", ")}. Check your Repomix output settings.`
  );
}

async function getInstructionPath(context: vscode.ExtensionContext, repo: string): Promise<string> {
  const config = vscode.workspace.getConfiguration("aiCodeWorkflow");
  const customPath = config.get<string>("instructionPath", "").trim();

  if (customPath) {
    const resolved = path.isAbsolute(customPath) ? customPath : path.join(repo, customPath);
    if (await exists(resolved)) return resolved;
    throw new Error(`Configured instruction file was not found: ${resolved}`);
  }

  const bundled = vscode.Uri.joinPath(
    context.extensionUri,
    DEFAULT_INSTRUCTION_RESOURCE_DIR,
    DEFAULT_INSTRUCTION_RESOURCE_FILE
  ).fsPath;
  if (await exists(bundled)) return bundled;

  throw new Error(`Bundled instruction file was not found: ${bundled}`);
}

function buildPrompt(
  userPrompt: string,
  instructionText: string,
  projectContextPath: string,
  assets: HandoffAsset[]
): string {
  const assetLines = assets.length
    ? assets.map(asset => `- Extra visual/context asset: ${asset.name}`)
    : ["- No extra screenshots or assets were provided."];

  return [
    "Use the attached project context to produce a JSON operations patch for my VS Code workflow.",
    "",
    "Task:",
    userPrompt,
    "",
    "Required response format:",
    "Return only the JSON object described below. Do not include markdown, explanations, or prose.",
    "",
    "Attached files to use:",
    `- Project context: ${path.basename(projectContextPath)}`,
    ...assetLines,
    "",
    "Output instructions:",
    instructionText.trim(),
  ].join("\n");
}

async function createHandoffDirectory(repo: string): Promise<string> {
  const repoName = path.basename(repo).replace(/[^a-z0-9._-]/gi, "-") || "workspace";
  const base = path.join(os.tmpdir(), `${HANDOFF_DIR_PREFIX}${repoName}-`);
  return fs.mkdtemp(base);
}

async function createAssetDirectory(repo: string): Promise<string> {
  const repoName = path.basename(repo).replace(/[^a-z0-9._-]/gi, "-") || "workspace";
  const base = path.join(os.tmpdir(), `${ASSET_DIR_PREFIX}${repoName}-`);
  return fs.mkdtemp(base);
}

async function copyAssets(handoffDir: string, assets: HandoffAsset[]): Promise<HandoffAsset[]> {
  if (assets.length === 0) return [];

  const copied: HandoffAsset[] = [];
  for (const asset of assets) {
    const target = await uniquePath(handoffDir, sanitizeFileName(asset.name));
    await fs.copyFile(asset.path, target);
    copied.push({ name: path.basename(target), path: target });
  }

  return copied;
}

function extensionFromMimeType(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/png":
    default:
      return "png";
  }
}

function stripExtension(fileName: string): string {
  const ext = path.extname(fileName);
  return ext ? fileName.slice(0, -ext.length) : fileName;
}

function sanitizeFileName(fileName: string): string {
  const safe = fileName.replace(/[/\\:*?"<>|]/g, "-").replace(/\s+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "asset";
}

async function uniquePath(dir: string, fileName: string): Promise<string> {
  const ext = path.extname(fileName);
  const base = ext ? fileName.slice(0, -ext.length) : fileName;

  for (let i = 0; ; i++) {
    const candidate = path.join(dir, i === 0 ? fileName : `${base}-${i}${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
}

function isWorkflowTempDir(name: string): boolean {
  return name.startsWith(HANDOFF_DIR_PREFIX) || name.startsWith(ASSET_DIR_PREFIX) || name.startsWith(TEMP_DIR_PREFIX);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function formatRepomixError(command: string, args: string[], repo: string, error: unknown): string {
  const details = error instanceof Error ? error.message : String(error);
  const fullCommand = [command, ...args].join(" ");

  return [
    "Could not refresh project context with Repomix.",
    "",
    `Command: ${fullCommand}`,
    `Workspace: ${repo}`,
    "",
    "How to fix:",
    "1. Make sure Node.js and npm are installed and available in PATH.",
    "2. Run this command manually in the workspace terminal:",
    `   ${fullCommand}`,
    "3. If Repomix is not installed, install it or keep using npx so it can download Repomix.",
    "4. If you use a custom command, check aiCodeWorkflow.repomixCommand and aiCodeWorkflow.repomixArgs in VS Code settings.",
    "",
    "Original error:",
    details,
  ].join("\n");
}
