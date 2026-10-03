# Crew lobby

The lobby is how two players find each other. A player creates a crew and gets a four-letter code; the crewmate joins with the code. The lobby then relays the WebRTC offer, answer and network candidates between them, and from that point the two browsers talk directly. Game traffic never passes through the lobby.

The same room rules (`LobbyRoom` in `src/net/lobby-protocol.ts`) run in two places:

- `dev-server.ts`: a small Node WebSocket server for local development (`npm run lobby` in the repository root, port 8787). The game's dev server proxies `/parties` to it.
- `worker.ts`: the deployed lobby, a Cloudflare Worker using [PartyServer](https://github.com/cloudflare/partykit/tree/main/packages/partyserver) with one Durable Object per room code.

## Deploying to Cloudflare

You need a Cloudflare account (the free Workers plan is enough for the lobby).

1. In this folder, run `npm install` and then `npx wrangler login`.
2. If the game is hosted somewhere other than `https://henderjj.github.io`, edit `ALLOWED_ORIGINS` in `wrangler.jsonc` (comma-separated). Requests from other web origins are refused.
3. Run `npm run deploy`. Wrangler prints the Worker's address, for example `https://patchwork-lobby.<your-subdomain>.workers.dev`.
4. In the GitHub repository, add an Actions variable (Settings → Secrets and variables → Actions → Variables) named `LOBBY_URL` with that address as a WebSocket URL, for example `wss://patchwork-lobby.<your-subdomain>.workers.dev`. The next deploy builds the game with it. Without a rebuild, `?lobby=wss://...` in the page address does the same.

## TURN (for players behind strict networks)

Most home connections can talk directly once STUN tells each browser its public address. Some networks (mobile hotspots, some corporate or university Wi-Fi) need a relay. Cloudflare's TURN service provides one:

1. In the Cloudflare dashboard, open **Realtime → TURN Server** and create a TURN key.
2. Store its id and API token as Worker secrets: `npx wrangler secret put TURN_KEY_ID` and `npx wrangler secret put TURN_KEY_API_TOKEN`.

The lobby then hands each player short-lived TURN credentials (six hours) in its welcome message. Without the secrets it hands out Cloudflare's public STUN server only.

## Local check against Cloudflare's runtime

`npx wrangler dev --port 8788` runs the Worker locally; point the game at it with `?lobby=ws://localhost:8788`.
