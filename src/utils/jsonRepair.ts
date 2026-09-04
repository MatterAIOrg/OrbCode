/**
 * Best-effort recovery for malformed LLM tool-call arguments.
 *
 * Models occasionally emit almost-JSON: unquoted strings (`"file_pattern": *.tsx`),
 * unquoted keys, single quotes, trailing commas, Python literals (`True`/`None`),
 * comments, or output truncated mid-call. Failing the call outright burns a
 * round trip, and weaker models repeat the same mistake on retry. This module
 * repairs the common cases and reports whether it intervened so the agent can
 * tell the model which arguments actually ran.
 */

export interface ParsedToolCallArguments {
  args: Record<string, unknown>;
  /** True when the source was not valid JSON and had to be repaired. */
  repaired: boolean;
}

/**
 * Parse tool-call arguments, repairing common JSON malformations. Returns null
 * only when nothing resembling an argument object can be recovered.
 */
export function parseToolCallArguments(
  raw: string,
): ParsedToolCallArguments | null {
  const trimmed = raw.trim();
  if (!trimmed) return { args: {}, repaired: false };

  const strict = tryParseObject(trimmed);
  if (strict) return { args: strict, repaired: false };

  // A lone object wrapped in an array is a common shape mistake.
  const unwrapped = tryParseSingleObjectArray(trimmed);
  if (unwrapped) return { args: unwrapped, repaired: true };

  const repairedSource = repairJsonSource(trimmed);
  if (!repairedSource) return null;
  const repaired =
    tryParseObject(repairedSource) ?? tryParseSingleObjectArray(repairedSource);
  return repaired ? { args: repaired, repaired: true } : null;
}

function tryParseObject(source: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(source);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function tryParseSingleObjectArray(
  source: string,
): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(source);
    if (!Array.isArray(parsed) || parsed.length !== 1) return null;
    return isRecord(parsed[0]) ? parsed[0] : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Characters that always terminate a bare (unquoted) token. */
const BARE_TOKEN_TERMINATORS = new Set([",", "{", "}", "[", "]", '"', "'"]);

/** Matching closer for each opening bracket. */
const CLOSERS = new Map([
  ["{", "}"],
  ["[", "]"],
]);

/** JSON literal spellings, including the Python variants models sometimes emit. */
const LITERAL_ALIASES: Record<string, string> = {
  true: "true",
  false: "false",
  null: "null",
  none: "null",
};

/** Escape text for use inside a JSON string literal. */
function quoteAsJsonString(text: string): string {
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    // Raw control characters are invalid inside JSON strings; drop them.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  return `"${escaped}"`;
}

/** Index of the closing quote for the string starting at `start`, or -1 when
 * the input ends first. Backslash escapes are skipped over. */
function findStringEnd(source: string, start: number, quote: string): number {
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === "\\") {
      i++;
      continue;
    }
    if (source[i] === quote) return i;
  }
  return -1;
}

/** Render a bare value token: boolean/null literals (including Python
 * spellings) and strict JSON numbers stay unquoted; anything else becomes a
 * JSON string. */
function formatBareValue(token: string): string {
  const literal = LITERAL_ALIASES[token.toLowerCase()];
  if (literal) return literal;
  try {
    if (typeof JSON.parse(token) === "number") return token;
  } catch {
    // Not a JSON number; fall through to quoting.
  }
  return quoteAsJsonString(token);
}

/** Scan a bare (unquoted) token starting at `start`. In value position the
 * token may contain spaces and colons (`git status`, `https://…`); in key
 * position it ends at the first whitespace or colon. */
function scanBareToken(
  source: string,
  start: number,
  valuePosition: boolean,
): { text: string; end: number } {
  let end = start;
  while (end < source.length) {
    const char = source[end];
    if (BARE_TOKEN_TERMINATORS.has(char)) break;
    if (!valuePosition && (char === ":" || /\s/.test(char))) break;
    end++;
  }
  return { text: source.slice(start, end).trim(), end };
}

/**
 * Re-write malformed JSON into something `JSON.parse` accepts. Handles unquoted
 * keys and values, single-quoted strings, trailing commas, `//` and `/* *\/`
 * comments, Python literals, and structure left open by truncated output.
 * Braceless object bodies are wrapped so `path: "src"` parses as an object.
 */
function repairJsonSource(input: string): string | null {
  const source = /^[[{]/.test(input) ? input : `{${input}}`;

  let out = "";
  let index = 0;
  /** Open braces/brackets, innermost last. */
  const stack: string[] = [];
  /** True while the next token is a value rather than an object key. */
  let expectValue = false;

  while (index < source.length) {
    const char = source[index];

    if (char === '"') {
      const end = findStringEnd(source, index, '"');
      if (end === -1) {
        // Truncated mid-string: close it and stop scanning.
        out += quoteAsJsonString(source.slice(index + 1));
        index = source.length;
      } else {
        out += source.slice(index, end + 1);
        index = end + 1;
      }
      expectValue = false;
      continue;
    }

    if (char === "'") {
      const end = findStringEnd(source, index, "'");
      out +=
        end === -1
          ? quoteAsJsonString(source.slice(index + 1))
          : quoteAsJsonString(source.slice(index + 1, end));
      index = end === -1 ? source.length : end + 1;
      expectValue = false;
      continue;
    }

    if (char === "/" && source[index + 1] === "/") {
      const newline = source.indexOf("\n", index);
      index = newline === -1 ? source.length : newline;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      index = close === -1 ? source.length : close + 2;
      continue;
    }

    if (char === ":") {
      out += ":";
      expectValue = true;
      index++;
      continue;
    }
    if (char === ",") {
      out += ",";
      // Inside an object the next token is a key; inside an array, a value.
      expectValue = stack[stack.length - 1] === "[";
      index++;
      continue;
    }
    if (char === "{" || char === "[") {
      out += char;
      stack.push(char);
      // Object contents are keys; array elements are values.
      expectValue = char === "[";
      index++;
      continue;
    }
    if (char === "}" || char === "]") {
      // Drop a trailing comma before the closer.
      out = out.replace(/,\s*$/, "");
      out += char;
      stack.pop();
      expectValue = false;
      index++;
      continue;
    }
    if (/\s/.test(char)) {
      out += char;
      index++;
      continue;
    }

    // Bare token: a key when a value isn't expected, otherwise a value.
    const token = scanBareToken(source, index, expectValue);
    if (!token.text) {
      // Unrecognized character; keep it and let JSON.parse judge.
      out += char;
      index++;
      continue;
    }
    out += expectValue
      ? formatBareValue(token.text)
      : quoteAsJsonString(token.text);
    index = token.end;
    expectValue = false;
  }

  // Close whatever truncation left open: drop a dangling comma or colon,
  // then append the missing closers innermost-first.
  out = out.replace(/,\s*$/, "");
  if (/:\s*$/.test(out)) out += " null";
  while (stack.length > 0) out += CLOSERS.get(stack.pop() ?? "") ?? "";

  return out.trim() || null;
}
