export interface ToolContext {
	cwd: string
	token: string
	/** current session todo list (markdown checklist) */
	getTodos: () => string
	setTodos: (todos: string) => void
}

export interface ToolResult {
	/** text returned to the model as the tool result */
	text: string
	isError?: boolean
}

export type ToolExecutor = (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>

/** Resolve a possibly-relative path against the workspace. */
export function resolveWorkspacePath(cwd: string, p: string): string {
	if (!p) return cwd
	return p.startsWith("/") ? p : `${cwd}/${p}`.replace(/\/+/g, "/")
}
