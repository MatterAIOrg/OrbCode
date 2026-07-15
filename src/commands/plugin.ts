import {
	fetchOfficialMarketplace,
	installMarketplacePlugin,
	listInstalledPlugins,
	uninstallPlugin,
} from "../plugins/manager.js"

function printHelp(): void {
	console.log(`Usage:
  orbcode plugin install <name>@claude-plugins-official
  orbcode plugin list
  orbcode plugin uninstall <name>

Plugins are installed for the current project in .orb/plugins/.`)
}

export async function runPluginCommand(args: string[]): Promise<number> {
	const [command, spec] = args
	if (!command || command === "help" || command === "--help" || command === "-h") {
		printHelp()
		return 0
	}

	if (command === "list") {
		const plugins = listInstalledPlugins()
		if (plugins.length === 0) {
			console.log("No plugins installed in this project.")
			return 0
		}
		for (const plugin of plugins) {
			const inventory = plugin.inventory
			const parts = [
				inventory.skills ? `${inventory.skills} skills` : "",
				inventory.commands ? `${inventory.commands} commands` : "",
				inventory.agents ? `${inventory.agents} agents` : "",
				inventory.mcpServers ? `${inventory.mcpServers} MCP` : "",
			].filter(Boolean)
			console.log(`${plugin.name}${parts.length ? ` (${parts.join(", ")})` : ""}`)
		}
		return 0
	}

	if (command === "install") {
		if (!spec) {
			console.error("Missing plugin name. Example: orbcode plugin install clickhouse@claude-plugins-official")
			return 1
		}
		const at = spec.lastIndexOf("@")
		const name = at > 0 ? spec.slice(0, at) : spec
		const marketplaceName = at > 0 ? spec.slice(at + 1) : "claude-plugins-official"
		if (marketplaceName !== "claude-plugins-official") {
			console.error(`Unknown marketplace "${marketplaceName}". Only claude-plugins-official is configured.`)
			return 1
		}
		const marketplace = await fetchOfficialMarketplace()
		const plugin = marketplace.plugins.find((entry) => entry.name === name)
		if (!plugin) {
			console.error(`Plugin "${name}" was not found in ${marketplaceName}.`)
			return 1
		}
		console.log(`Installing ${name}@${marketplaceName}…`)
		const installed = await installMarketplacePlugin(plugin, process.cwd(), marketplaceName)
		console.log(`Installed ${installed.name} to .orb/plugins/${installed.name}/`)
		console.log("Restart OrbCode to load all plugin components.")
		return 0
	}

	if (command === "uninstall" || command === "remove" || command === "rm") {
		if (!spec) {
			console.error("Missing plugin name.")
			return 1
		}
		const name = spec.split("@")[0]!
		const plugin = listInstalledPlugins().find((entry) => entry.name === name)
		if (!plugin) {
			console.error(`Plugin "${name}" is not installed in this project.`)
			return 1
		}
		uninstallPlugin(plugin)
		console.log(`Uninstalled ${name}.`)
		return 0
	}

	console.error(`Unknown plugin command "${command}".`)
	printHelp()
	return 1
}
