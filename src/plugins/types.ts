export type PluginSource =
	| string
	| {
			source: "git-subdir" | "url" | "github" | "npm"
			url?: string
			path?: string
			ref?: string
			sha?: string
			repo?: string
			commit?: string
			package?: string
			version?: string
	  }

export interface MarketplacePlugin {
	name: string
	description?: string
	author?: string | { name?: string; email?: string }
	category?: string
	source: PluginSource
	skills?: string[]
	commands?: string | string[]
	agents?: string | string[]
	hooks?: unknown
	mcpServers?: unknown
	strict?: boolean
	homepage?: string
	version?: string
}

export interface MarketplaceJson {
	name: string
	description?: string
	plugins: MarketplacePlugin[]
}

export interface InstalledPluginMetadata {
	schemaVersion: 1
	name: string
	marketplace: string
	description?: string
	author?: string
	category?: string
	homepage?: string
	version?: string
	source: PluginSource
	skills?: string[]
	commands?: string | string[]
	agents?: string | string[]
	hooks?: unknown
	mcpServers?: unknown
	strict?: boolean
	installedAt: string
}

export interface PluginInventory {
	skills: number
	commands: number
	agents: number
	mcpServers: number
	hooks: number
}

export interface InstalledPlugin {
	name: string
	description: string
	author?: string
	dir: string
	metadata?: InstalledPluginMetadata
	inventory: PluginInventory
}
