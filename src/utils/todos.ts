/**
 * Normalize a todo list into the markdown checklist format the UI renders
 * (`- [x] item` / `[-]` / `[ ]`). Some models pass the `update_todo_list`
 * `todos` argument as a JSON array of `{status, content}` objects instead of
 * the documented markdown string, and sessions saved before that was handled
 * store the raw array. Every entry point (tool execution, resume, rewind)
 * funnels through here so the task panel never shows raw JSON.
 */
export function normalizeTodoList(input: unknown): string {
	if (Array.isArray(input)) return renderTodoArray(input)
	if (typeof input !== "string") return String(input ?? "")
	const trimmed = input.trim()
	if (!trimmed.startsWith("[")) return input
	try {
		const parsed: unknown = JSON.parse(trimmed)
		return Array.isArray(parsed) ? renderTodoArray(parsed) : input
	} catch {
		return input
	}
}

function renderTodoArray(items: unknown[]): string {
	return items
		.map((item) => {
			if (typeof item === "string") {
				const text = item.trim()
				return text ? `- [ ] ${text}` : null
			}
			if (typeof item !== "object" || item === null) return null
			const record = item as { status?: unknown; content?: unknown; text?: unknown }
			const content = String(record.content ?? record.text ?? "").trim()
			if (!content) return null
			const marker =
				record.status === "completed" ? "[x]" : record.status === "in_progress" ? "[-]" : "[ ]"
			return `- ${marker} ${content}`
		})
		.filter((line): line is string => line !== null)
		.join("\n")
}
