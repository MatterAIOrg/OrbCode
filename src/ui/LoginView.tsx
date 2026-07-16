import React, { useEffect, useRef, useState } from "react"
import { Box, Text, useInput } from "./primitives.js"
import open from "open"

import { COLORS, PRODUCT_NAME } from "../branding.js"
import {
	getAuthorizeUrl,
	pollDeviceAuth,
	startDeviceAuth,
	verifyToken,
	type ProfileData,
} from "../auth/auth.js"
import { Spinner } from "./components/Spinner.js"

interface LoginViewProps {
	onLogin: (token: string, profile: ProfileData) => void
}

type Phase = "idle" | "starting" | "waiting" | "verifying"

export function LoginView({ onLogin }: LoginViewProps) {
	const [phase, setPhase] = useState<Phase>("idle")
	const [error, setError] = useState<string | null>(null)
	const [authorizeUrl, setAuthorizeUrl] = useState("")
	const cancelledRef = useRef(false)
	const pollGeneration = useRef(0)

	useEffect(
		() => () => {
			cancelledRef.current = true
		},
		[],
	)

	const finishWithToken = async (token: string) => {
		setPhase("verifying")
		setError(null)
		try {
			const profile = await verifyToken(token)
			if (!cancelledRef.current) onLogin(token, profile)
		} catch (err) {
			setPhase("idle")
			setError((err as Error).message)
		}
	}

	const beginBrowserLogin = async () => {
		setPhase("starting")
		setError(null)
		const generation = ++pollGeneration.current
		try {
			const { devicecode, expiresIn, interval } = await startDeviceAuth()
			const url = getAuthorizeUrl(devicecode)
			setAuthorizeUrl(url)
			open(url).catch(() => {})
			setPhase("waiting")

			const deadline = Date.now() + expiresIn * 1000
			while (Date.now() < deadline) {
				if (cancelledRef.current || pollGeneration.current !== generation) return
				await new Promise((resolve) => setTimeout(resolve, interval * 1000))
				if (cancelledRef.current || pollGeneration.current !== generation) return
				const result = await pollDeviceAuth(devicecode)
				if (result.status === "authorized") {
					await finishWithToken(result.token)
					return
				}
				if (result.status === "expired") break
			}
			if (pollGeneration.current === generation && !cancelledRef.current) {
				setPhase("idle")
				setError("Sign-in timed out. Press Enter to try again.")
			}
		} catch (err) {
			if (pollGeneration.current === generation && !cancelledRef.current) {
				setPhase("idle")
				setError((err as Error).message)
			}
		}
	}

	useInput((input, key) => {
		if (phase === "verifying" || phase === "starting") return
		if (key.escape && phase === "waiting") {
			// Cancel polling and go back to idle so the user can retry.
			pollGeneration.current++
			setPhase("idle")
			setError(null)
			return
		}
		if (key.return && phase === "idle") {
			void beginBrowserLogin()
		}
	})

	return (
		<Box flexDirection="column" borderStyle="round" borderColor={COLORS.primary} paddingX={1}>
			<Text bold color={COLORS.primary}>
				Sign in to {PRODUCT_NAME}
			</Text>
			{phase === "waiting" ? (
				<>
					<Box marginTop={1}>
						<Spinner label="Waiting for authorization in your browser" />
					</Box>
					<Text color={COLORS.dim}>
						Approve the &quot;Authorize OrbCode CLI&quot; dialog at:
					</Text>
					<Text color={COLORS.dim}> {authorizeUrl}</Text>
					<Text color={COLORS.dim}>Esc to cancel</Text>
				</>
			) : (
				<Text>
					Press <Text bold>Enter</Text> to open MatterAI in your browser and authorize OrbCode CLI.
				</Text>
			)}
			{phase === "starting" && <Text color={COLORS.thinking}>Contacting sign-in service…</Text>}
			{phase === "verifying" && <Text color={COLORS.thinking}>Verifying…</Text>}
			{error && <Text color={COLORS.error}>✗ {error}</Text>}
			<Text color={COLORS.dim}>
				To use a token instead, set apiKey in ~/.orbcode/settings.json or the MATTERAI_TOKEN env var.
			</Text>
		</Box>
	)
}
