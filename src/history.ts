import * as vscode from "vscode";
import { ApplyResult, PatchHistoryEntry, UndoSnapshot } from "./model";

const PATCH_HISTORY_KEY = "aiCodeWorkflow.patchHistory";
const UNDO_SNAPSHOT_KEY = "aiCodeWorkflow.lastUndoSnapshot";
const MAX_HISTORY_ENTRIES = 10;

export function getPatchHistory(context: vscode.ExtensionContext): PatchHistoryEntry[] {
  return context.globalState.get<PatchHistoryEntry[]>(PATCH_HISTORY_KEY, []);
}

export async function recordPatchHistory(
  context: vscode.ExtensionContext,
  rawJson: string,
  result: ApplyResult,
  status: PatchHistoryEntry["status"]
): Promise<void> {
  const entry: PatchHistoryEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    operationsCount: result.changes.reduce((total, change) => total + change.operations.length, 0),
    filesAffected: result.changes.map(change => change.file),
    status,
    rawJson,
  };

  const next = [entry, ...getPatchHistory(context)].slice(0, MAX_HISTORY_ENTRIES);
  await context.globalState.update(PATCH_HISTORY_KEY, next);
}

export async function saveUndoSnapshot(context: vscode.ExtensionContext, result: ApplyResult): Promise<void> {
  const snapshot: UndoSnapshot = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    files: result.changes.map(change => ({ file: change.file, before: change.before })),
  };

  await context.globalState.update(UNDO_SNAPSHOT_KEY, snapshot);
}

export function getUndoSnapshot(context: vscode.ExtensionContext): UndoSnapshot | undefined {
  return context.globalState.get<UndoSnapshot>(UNDO_SNAPSHOT_KEY);
}

export async function clearUndoSnapshot(context: vscode.ExtensionContext): Promise<void> {
  await context.globalState.update(UNDO_SNAPSHOT_KEY, undefined);
}
