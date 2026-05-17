import { OperationType } from "./model";

export const ALLOWED_TYPES = new Set<OperationType>([
  "replace",
  "replace_all",
  "replace_block",
  "insert_before",
  "insert_after",
  "delete",
  "create_file",
  "delete_file",
  "replace_file",
]);

export const NEEDS_REPLACE = new Set<OperationType>(["replace", "replace_all", "replace_block"]);

export const NEEDS_SEARCH = new Set<OperationType>([
  "replace",
  "replace_all",
  "replace_block",
  "insert_before",
  "insert_after",
  "delete",
]);

export const NEEDS_TEXT = new Set<OperationType>(["insert_before", "insert_after"]);
export const NEEDS_CONTENT = new Set<OperationType>(["create_file", "replace_file"]);

export const MAX_INPUT_MB = 5;
export const WARN_INPUT_MB = 1;
export const TEMP_DIR_PREFIX = "ai-json-preview-";
export const HANDOFF_DIR_PREFIX = "ai-code-workflow-";
export const ASSET_DIR_PREFIX = "ai-code-workflow-assets-";
export const DEFAULT_INSTRUCTION_RESOURCE_DIR = "resources";
export const DEFAULT_INSTRUCTION_RESOURCE_FILE = "instruction.txt";

export const AI_PROVIDER_URLS = {
  chatgpt: "https://chatgpt.com/",
  claude: "https://claude.ai/new",
  gemini: "https://gemini.google.com/app",
  grok: "https://grok.com/",
} as const;

export const PROJECT_CONTEXT_CANDIDATES = [
  "repomix-output.xml",
  "repomix-output.md",
  "repomix-output.txt",
];
