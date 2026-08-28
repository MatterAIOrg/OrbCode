import type OpenAI from "openai";

export default {
  type: "function",
  function: {
    name: "search_files",
    description:
      "Search file contents recursively with a Rust-compatible regex. Returns up to 100 matching lines with file and line numbers; additional matches are omitted, so refine the pattern or path instead of repeating the same search. Use the narrowest plausible path and an optional file glob. Use read_file for surrounding context.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Directory to search recursively, relative to the workspace",
        },
        regex: {
          type: "string",
          minLength: 1,
          description: "Rust-compatible regular expression pattern to match",
        },
        file_pattern: {
          type: ["string", "null"],
          description:
            "Glob limiting searched files (e.g. '*.ts'), or null for all files",
        },
        max_results: {
          type: ["integer", "null"],
          minimum: 1,
          maximum: 100,
          description:
            "Target result count; null uses 100. Results are bounded, so refine the query if the target is too broad.",
        },
        context_lines: {
          type: ["integer", "null"],
          minimum: 0,
          maximum: 2,
          description: "Context lines before and after each match; null uses 0",
        },
      },
      required: [
        "path",
        "regex",
        "file_pattern",
        "max_results",
        "context_lines",
      ],
      additionalProperties: false,
    },
  },
} satisfies OpenAI.Chat.ChatCompletionTool;
