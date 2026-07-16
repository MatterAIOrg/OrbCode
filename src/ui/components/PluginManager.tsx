import React, { useEffect, useMemo, useState } from "react"
import { Box, Text, useInput } from "../primitives.js"

import { COLORS } from "../../branding.js"
import {
	fetchOfficialMarketplace,
	installMarketplacePlugin,
	listInstalledPlugins,
	pluginAuthor,
	uninstallPlugin,
} from "../../plugins/manager.js"
import type { InstalledPlugin, MarketplacePlugin, PluginInventory } from "../../plugins/types.js"
import { PopoverBox } from "./PopoverBox.js"

const VISIBLE_ROWS = 12

interface PluginManagerProps {
	onClose: () => void
}

function inventoryText(inventory: PluginInventory): string {
	const parts: string[] = []
	if (inventory.skills) parts.push(`${inventory.skills} skill${inventory.skills === 1 ? "" : "s"}`)
	if (inventory.commands) parts.push(`${inventory.commands} command${inventory.commands === 1 ? "" : "s"}`)
	if (inventory.agents) parts.push(`${inventory.agents} agent${inventory.agents === 1 ? "" : "s"}`)
	if (inventory.mcpServers) parts.push(`${inventory.mcpServers} MCP`)
	if (inventory.hooks) parts.push(`${inventory.hooks} hook${inventory.hooks === 1 ? "" : "s"}`)
	return parts.join(" · ") || "bundle files"
}

/** Browse and install complete Claude-compatible plugin bundles. */
export function PluginManager({ onClose }: PluginManagerProps) {
	const [installedPlugins, setInstalledPlugins] = useState<InstalledPlugin[]>([])
	const [marketplacePlugins, setMarketplacePlugins] = useState<MarketplacePlugin[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState("")
	const [status, setStatus] = useState("")
	const [selected, setSelected] = useState(0)
	const [activeTab, setActiveTab] = useState<"installed" | "marketplace">("marketplace")
	const [installing, setInstalling] = useState(false)
	const [search, setSearch] = useState("")
	const [searching, setSearching] = useState(false)

	useEffect(() => {
		refreshInstalled()
		void fetchMarketplace()
	}, [])

	function refreshInstalled() {
		setInstalledPlugins(listInstalledPlugins())
	}

	async function fetchMarketplace() {
		try {
			const marketplace = await fetchOfficialMarketplace()
			setMarketplacePlugins(marketplace.plugins)
		} catch (err) {
			setError((err as Error).message)
		} finally {
			setLoading(false)
		}
	}

	async function installPlugin(plugin: MarketplacePlugin) {
		setInstalling(true)
		setStatus(`Installing complete ${plugin.name} plugin…`)
		try {
			const installed = await installMarketplacePlugin(plugin)
			setStatus(
				`Installed ${installed.name} (${inventoryText(installed.inventory)}) -> .orb/plugins/${installed.name}/. ` +
					"Restart OrbCode to load all components.",
			)
			refreshInstalled()
		} catch (err) {
			setStatus(`Error installing ${plugin.name}: ${(err as Error).message}`)
		} finally {
			setInstalling(false)
		}
	}

	function deletePlugin(plugin: InstalledPlugin) {
		try {
			uninstallPlugin(plugin)
			setStatus(`Uninstalled ${plugin.name}. Restart OrbCode to unload all components.`)
			refreshInstalled()
			setSelected((value) => Math.max(0, value - 1))
		} catch (err) {
			setStatus(`Error uninstalling ${plugin.name}: ${(err as Error).message}`)
		}
	}

	const filteredPlugins = useMemo(() => {
		if (!search) return marketplacePlugins
		const query = search.toLowerCase()
		return marketplacePlugins.filter((plugin) => {
			const author = pluginAuthor(plugin)
			return (
				plugin.name.toLowerCase().includes(query) ||
				(plugin.description ?? "").toLowerCase().includes(query) ||
				Boolean(author?.toLowerCase().includes(query))
			)
		})
	}, [marketplacePlugins, search])

	const currentList = activeTab === "installed" ? installedPlugins : filteredPlugins
	const count = currentList.length

	useInput((input, key) => {
		if (installing) return
		if (searching) {
			if (key.escape) {
				setSearching(false)
				setSearch("")
				setSelected(0)
				return
			}
			if (key.return) {
				setSearching(false)
				setSelected(0)
				return
			}
			if (key.backspace || key.delete) {
				setSearch((value) => value.slice(0, -1))
				return
			}
			if (input && !key.ctrl && !key.meta) {
				setSearch((value) => value + input)
				setSelected(0)
			}
			return
		}

		if (key.escape) return onClose()
		if (key.leftArrow || key.rightArrow || key.tab) {
			setActiveTab((tab) => (tab === "installed" ? "marketplace" : "installed"))
			setSelected(0)
			setStatus("")
			return
		}
		if (input === "/" && activeTab === "marketplace") {
			setSearching(true)
			setSearch("")
			return
		}
		if (key.upArrow) {
			setSelected((value) => (value - 1 + count) % (count || 1))
			return
		}
		if (key.downArrow) {
			setSelected((value) => (value + 1) % (count || 1))
			return
		}
		if (key.return && activeTab === "marketplace" && count > 0) {
			void installPlugin(filteredPlugins[selected]!)
			return
		}
		if (activeTab === "installed" && count > 0 && (input === "d" || key.backspace || key.delete)) {
			deletePlugin(installedPlugins[selected]!)
		}
	})

	const windowStart = Math.max(0, Math.min(selected - VISIBLE_ROWS + 1, count - VISIBLE_ROWS))
	const visible = currentList.slice(windowStart, windowStart + VISIBLE_ROWS)

	return (
		<PopoverBox flexDirection="column" borderStyle="round" borderColor={COLORS.primary} paddingX={1}>
			<Box flexDirection="row" justifyContent="space-between">
				<Box flexDirection="row">
					<Text bold color={activeTab === "installed" ? COLORS.primary : COLORS.dim}>
						Installed ({installedPlugins.length})
					</Text>
					<Text color={COLORS.dim}>  |  </Text>
					<Text bold color={activeTab === "marketplace" ? COLORS.primary : COLORS.dim}>
						Marketplace ({marketplacePlugins.length})
					</Text>
				</Box>
				<Text color={COLORS.dim}>Plugins [x]</Text>
			</Box>

			{activeTab === "marketplace" && (
				<Box>
					<Text color={COLORS.dim}>
						{searching ? "> " : "/ "}
						{searching ? (
							<Text color={COLORS.accent}>
								{search}
								<Text underline> </Text>
							</Text>
						) : (
							<Text color={COLORS.dim}>to search</Text>
						)}
					</Text>
				</Box>
			)}

			{loading && activeTab === "marketplace" ? (
				<Text color={COLORS.dim}>Loading official plugin marketplace…</Text>
			) : error && activeTab === "marketplace" ? (
				<Text color={COLORS.error}>{error}</Text>
			) : count === 0 ? (
				<Text color={COLORS.dim}>
					{activeTab === "installed"
						? "No plugins installed in this project."
						: search
							? `No plugins match "${search}".`
							: "No plugins found."}
				</Text>
			) : (
				<Box flexDirection="column">
					{windowStart > 0 && <Text color={COLORS.dim}>  ↑ {windowStart} more</Text>}
					{visible.map((item, indexOffset) => {
						const isSelected = windowStart + indexOffset === selected
						if (activeTab === "installed") {
							const plugin = item as InstalledPlugin
							return (
								<Box key={plugin.name} flexDirection="column">
									<Text color={isSelected ? COLORS.accent : undefined} wrap="truncate">
										{isSelected ? "◆ " : "  "}
										{plugin.name} <Text color={COLORS.dim}>({inventoryText(plugin.inventory)})</Text>
									</Text>
									{isSelected && plugin.description && <Text color={COLORS.dim}>    {plugin.description}</Text>}
								</Box>
							)
						}
						const plugin = item as MarketplacePlugin
						const author = pluginAuthor(plugin)
						return (
							<Box key={plugin.name} flexDirection="column">
								<Text color={isSelected ? COLORS.accent : undefined} wrap="truncate">
									{isSelected ? "◆ " : "  "}
									{plugin.name}
									{author && <Text color={COLORS.dim}> (by {author})</Text>}
								</Text>
								{isSelected && plugin.description && (
									<Text color={COLORS.dim} wrap="truncate">
										{"    "}
										{plugin.description.length > 100 ? plugin.description.slice(0, 97) + "…" : plugin.description}
									</Text>
								)}
							</Box>
						)
					})}
					{windowStart + VISIBLE_ROWS < count && (
						<Text color={COLORS.dim}>  ↓ {count - windowStart - VISIBLE_ROWS} more</Text>
					)}
				</Box>
			)}

			<Box marginTop={1} flexDirection="column">
				{status && <Text color={COLORS.warning}>{status}</Text>}
				<Text color={COLORS.dim}>
					{activeTab === "installed"
						? "←/→ tabs · ↑/↓ select · d uninstall · esc close"
						: "←/→ tabs · ↑/↓ select · / search · enter install · esc close"}
				</Text>
			</Box>
		</PopoverBox>
	)
}
