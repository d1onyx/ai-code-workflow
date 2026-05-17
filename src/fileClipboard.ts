import * as cp from "child_process";

export function copyFilesToClipboard(filePaths: string[]): Promise<void> {
  if (filePaths.length === 0) {
    throw new Error("No handoff files are available yet.");
  }

  if (process.platform !== "win32") {
    throw new Error("Copying actual files to the system clipboard is currently supported only on Windows. Use Open Handoff Folder and upload the files together.");
  }

  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$files = New-Object System.Collections.Specialized.StringCollection",
    ...filePaths.map(file => `[void]$files.Add(${toPowerShellString(file)})`),
    "[System.Windows.Forms.Clipboard]::SetFileDropList($files)",
  ].join("\n");

  const encoded = Buffer.from(script, "utf16le").toString("base64");

  return new Promise((resolve, reject) => {
    const child = cp.spawn(
      "powershell.exe",
      ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true }
    );

    const stderr: Buffer[] = [];
    child.stderr.on("data", (data: Buffer) => stderr.push(data));
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(Buffer.concat(stderr).toString("utf8") || `powershell exited ${code}`));
    });
  });
}

function toPowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
