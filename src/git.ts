import * as cp from "child_process";
import * as vscode from "vscode";

export function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
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
        return;
      }

      reject(Object.assign(new Error(stderr || stdout || `git exited ${code}`), { stdout, stderr }));
    });
  });
}

export async function getRepoRoot(): Promise<string> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error("No workspace folder open. Please open a project first.");

  const result = await runGit(["rev-parse", "--show-toplevel"], folder.uri.fsPath);
  return result.stdout.trim();
}
