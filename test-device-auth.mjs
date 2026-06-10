// Device-auth polling flow test against a local mock of the backend endpoints.
// Simulates: CLI start -> user authorizes in browser (after 2 polls) -> CLI
// receives token via poll (one-time read).
import http from "node:http"
import { randomBytes } from "node:crypto"

const codes = new Map()

const server = http.createServer((req, res) => {
	const url = new URL(req.url, "http://localhost")
	res.setHeader("Content-Type", "application/json")

	if (req.method === "POST" && url.pathname === "/orbcode/auth/start") {
		const devicecode = randomBytes(24).toString("hex")
		codes.set(devicecode, { status: "pending", polls: 0 })
		res.end(JSON.stringify({ devicecode, expiresIn: 600, interval: 0.05 }))
		return
	}
	if (req.method === "GET" && url.pathname === "/orbcode/auth/poll") {
		const entry = codes.get(url.searchParams.get("devicecode"))
		if (!entry) return res.end(JSON.stringify({ status: "expired" }))
		entry.polls++
		// "User clicks Authorize" after the second poll.
		if (entry.polls >= 2 && entry.status === "pending") {
			entry.status = "authorized"
			entry.token = "fake.jwt.token"
		}
		if (entry.status === "authorized") {
			codes.delete(url.searchParams.get("devicecode"))
			return res.end(JSON.stringify({ status: "authorized", token: entry.token }))
		}
		return res.end(JSON.stringify({ status: "pending" }))
	}
	res.statusCode = 404
	res.end("{}")
})

await new Promise((resolve) => server.listen(0, resolve))
process.env.ORBCODE_BACKEND_URL = `http://localhost:${server.address().port}`
process.env.ORBCODE_APP_URL = "http://localhost:9999"

const { startDeviceAuth, pollDeviceAuth, getAuthorizeUrl } = await import("./dist/auth/auth.js")

let failures = 0
const check = (label, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"}: ${label}`)
	if (!ok) failures++
}

const start = await startDeviceAuth()
check("start returns 48-hex devicecode", /^[a-f0-9]{48}$/.test(start.devicecode))
check(
	"authorize URL targets /orbital with devicecode",
	getAuthorizeUrl(start.devicecode) ===
		`http://localhost:9999/orbital?loginType=orbcode&devicecode=${start.devicecode}`,
)

const first = await pollDeviceAuth(start.devicecode)
check("first poll is pending", first.status === "pending")

const second = await pollDeviceAuth(start.devicecode)
check("second poll returns token", second.status === "authorized" && second.token === "fake.jwt.token")

const third = await pollDeviceAuth(start.devicecode)
check("token is one-time (third poll expired)", third.status === "expired")

server.close()
process.exit(failures ? 1 : 0)
