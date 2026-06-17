import type { ApprovalKind } from "../tools/index.js"

export type AgentEvent =
	| { type: "reasoning-delta"; text: string }
	| { type: "reasoning-done"; durationMs: number }
	| { type: "text-delta"; text: string }
	| { type: "text-done" }
	| { type: "tool-start"; id: string; name: string; summary: string }
	| {
			type: "tool-end"
			id: string
			name: string
			summary: string
			resultPreview: string
			isError: boolean
			/** unified diff for file-modifying tools */
			diff?: string
	  }
	| { type: "todos"; todos: string }
	| { type: "usage"; inputTokens: number; outputTokens: number; cost: number; totalCost: number }
	| { type: "completion"; result: string }
	| { type: "error"; message: string }
	/** a hook's systemMessage / non-blocking error, surfaced to the user */
	| { type: "system"; message: string; isError: boolean }
	| { type: "turn-end" }

export interface ApprovalRequest {
	kind: ApprovalKind
	toolName: string
	summary: string
	/** full detail shown to the user (command text, file diff summary, …) */
	detail: string
	/** unified diff for edit approvals, rendered with +/- coloring */
	diff?: string
	isDangerous?: boolean
}

export type ApprovalDecision = "yes" | "no" | "always"

export interface FollowupSuggestion {
	text: string
}

export interface AgentCallbacks {
	onEvent: (event: AgentEvent) => void
	requestApproval: (request: ApprovalRequest) => Promise<ApprovalDecision>
	requestFollowup: (question: string, suggestions: FollowupSuggestion[]) => Promise<string>
}
