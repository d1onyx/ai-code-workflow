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

    const invocation = createInvocation(cleanCommand, args);
    const child = cp.spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: process.env,
      shell: invocation.shell,
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

function createInvocation(command: string, args: string[]): { command: string; args: string[]; shell: boolean } {
  if (process.platform !== "win32") {
    return { command, args, shell: false };
  }

  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", [command, ...args].map(quoteWindowsCommandArg).join(" ")],
    shell: false,
  };
}

function quoteWindowsCommandArg(value: string): string {
  if (value.length === 0) return '""';

  let result = '"';
  let backslashes = 0;

  for (const ch of value) {
    if (ch === "\\") {
      backslashes++;
      continue;
    }

    if (ch === '"') {
      result += "\\".repeat(backslashes * 2 + 1);
      result += '"';
      backslashes = 0;
      continue;
    }

    result += "\\".repeat(backslashes);
    backslashes = 0;

    if (/[%^&|<>()!]/u.test(ch)) {
      result += "^";
    }

    result += ch;
  }

  result += "\\".repeat(backslashes * 2);
  result += '"';
  return result;
}
