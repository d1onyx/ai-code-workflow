import * as cp from "child_process";
import * as fs from "fs";

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export interface RunProcessOptions {
  cwd: string;
  onOutput?: (chunk: string) => void;
}

export function runProcess(command: string, args: string[], options: RunProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const cleanCommand = command.trim();
    if (!cleanCommand) {
      reject(new Error("Process command is empty."));
      return;
    }

    if (!fs.existsSync(options.cwd)) {
      reject(new Error(`Working directory does not exist: ${options.cwd}`));
      return;
    }

    const child = cp.spawn(cleanCommand, args, {
      cwd: options.cwd,
      env: process.env,
      shell: process.platform === "win32",
      windowsHide: true,
    });

    const chunks: { out: Buffer[]; err: Buffer[] } = { out: [], err: [] };

    child.stdout.on("data", (data: Buffer) => {
      chunks.out.push(data);
      options.onOutput?.(data.toString("utf8"));
    });

    child.stderr.on("data", (data: Buffer) => {
      chunks.err.push(data);
      options.onOutput?.(data.toString("utf8"));
    });

    child.on("error", reject);
    child.on("close", code => {
      const stdout = Buffer.concat(chunks.out).toString("utf8");
      const stderr = Buffer.concat(chunks.err).toString("utf8");

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr || stdout || `${cleanCommand} exited ${code}`));
    });
  });
}
