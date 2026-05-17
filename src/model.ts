export type OperationType =
  | "replace"
  | "replace_all"
  | "replace_block"
  | "insert_before"
  | "insert_after"
  | "delete"
  | "create_file"
  | "delete_file"
  | "replace_file";

export interface EditOperation {
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
}

export interface OperationsPayload {
  operations: EditOperation[];
}

export interface FileChange {
  file: string;
  before: string | null;
  after: string | null;
  operations: EditOperation[];
}

export interface ApplyResult {
  changes: FileChange[];
  warnings: string[];
}
