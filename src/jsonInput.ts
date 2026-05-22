import { OperationsPayload } from "./model";
import { normalizeNewlines } from "./text";

export function cleanJsonInput(input: string): string {
  let text = normalizeNewlines(input).trim();

  text = text.replace(/^```(?:json|javascript|js|ts|typescript)?\s*/i, "").replace(/\s*```\s*$/i, "");
  text = text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }

  return removeTrailingCommasOutsideStrings(text).trim();
}

export function parsePayload(input: string): OperationsPayload {
  const data = parseJsonWithRepair(input);

  if (!data || typeof data !== "object" || !Array.isArray((data as Partial<OperationsPayload>).operations)) {
    throw new Error('Invalid payload. Expected: { "operations": [...] }');
  }

  return data as OperationsPayload;
}

export function formatJsonInput(input: string): string {
  const data = parseJsonWithRepair(input);
  return JSON.stringify(data, null, 2);
}

function parseJsonWithRepair(input: string): unknown {
  const cleaned = cleanJsonInput(input);

  try {
    return JSON.parse(cleaned);
  } catch (firstError: unknown) {
    const repaired = repairJsonStrings(cleaned);
    try {
      return JSON.parse(repaired);
    } catch (secondError: unknown) {
      throw new Error(
        `Invalid JSON: ${getErrorMessage(firstError)}\n` +
        `Auto-repair also failed: ${getErrorMessage(secondError)}\n\n` +
        `Tip: the most reliable format is JSON with code blocks escaped as strings, ` +
        `or use line-based operations (startLine/endLine) for large code replacements.`
      );
    }
  }
}

function repairJsonStrings(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }

    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }

    if (ch === "\n") {
      out += "\\n";
      continue;
    }

    if (ch === "\r") {
      out += "\\r";
      continue;
    }

    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }

    out += ch;
  }

  return removeTrailingCommasOutsideStrings(out);
}

function removeTrailingCommasOutsideStrings(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) j++;
      if (input[j] === "}" || input[j] === "]") continue;
    }

    out += ch;
  }

  return out;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
