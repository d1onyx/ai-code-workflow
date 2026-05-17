import * as fs from "fs/promises";
import * as path from "path";
import { applyTextOperation } from "./operations";
import { ApplyResult, EditOperation, OperationsPayload } from "./model";
import { normalizeNewlines } from "./text";
import { resolveRepoPath, validateOperation } from "./validation";

export async function buildChanges(repo: string, payload: OperationsPayload): Promise<ApplyResult> {
  const warnings: string[] = [];
  const groups = groupByFile(payload.operations);
  const changes = await Promise.all(
    Array.from(groups.entries()).map(async ([file, operations]) => {
      const abs = resolveRepoPath(repo, file);
      const before = await readFileIfExists(abs);
      let current = before ?? "";

      for (const op of operations) {
        validateFileState(file, before, op);
        current = applyTextOperation(current, op, warnings);
      }

      const willDelete = operations.some(op => op.type === "delete_file");
      return { file, before, after: willDelete ? null : current, operations };
    })
  );

  const order = Array.from(groups.keys());
  changes.sort((a, b) => order.indexOf(a.file) - order.indexOf(b.file));

  return { changes, warnings };
}

export async function applyChanges(repo: string, result: ApplyResult): Promise<void> {
  await Promise.all(
    result.changes.map(async change => {
      const abs = resolveRepoPath(repo, change.file);

      if (change.after === null) {
        await fs.rm(abs, { force: true });
        return;
      }

      await ensureDir(abs);
      await fs.writeFile(abs, change.after, "utf8");
    })
  );
}

export async function writeTempFile(dir: string, name: string, content: string): Promise<string> {
  const safeName = name.replace(/[/\\:*?"<>|]/g, "__");
  const file = path.join(dir, safeName);
  await ensureDir(file);
  await fs.writeFile(file, content, "utf8");
  return file;
}

export function summarize(result: ApplyResult): string {
  const lines: string[] = [`Files affected: ${result.changes.length}`, ""];

  for (const change of result.changes) {
    const ops = change.operations.map(op => op.type).join(", ");
    if (change.before === null) {
      lines.push(`  CREATE  ${change.file}  [${ops}]`);
    } else if (change.after === null) {
      lines.push(`  DELETE  ${change.file}  [${ops}]`);
    } else {
      const before = change.before.split("\n").length;
      const after = change.after.split("\n").length;
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

async function readFileIfExists(absPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(absPath, "utf8");
    return normalizeNewlines(raw);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function ensureDir(absFile: string): Promise<void> {
  await fs.mkdir(path.dirname(absFile), { recursive: true });
}

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

function validateFileState(file: string, before: string | null, op: EditOperation): void {
  if (op.type === "create_file" && before !== null) {
    throw new Error(`"${file}" already exists. Use "replace_file" to overwrite, or "delete_file" first.`);
  }

  if (op.type !== "create_file" && op.type !== "replace_file" && op.type !== "delete_file" && before === null) {
    throw new Error(`"${file}" does not exist. Cannot apply "${op.type}".`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
