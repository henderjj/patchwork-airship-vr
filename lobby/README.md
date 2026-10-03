# Crew lobby

The lobby is how two players find each other. A player creates a crew and gets a four-letter code; the crewmate joins with the code. The lobby then relays the WebRTC offer, answer and network candidates between them, and from that point the two browsers talk directly. Game traffic never passes through the lobby.

The same room rules (`LobbyRoom` in `src/net/lobby-protocol.ts`) run in two places:

- `dev-server.ts`: a small Node WebSocket server for local development (`npm run lobby` in the repository root, port 8787). The game's dev server proxies `/parties` to it.
- `worker.ts`: the deployed lobby, a Cloudflare Worker using [PartyServer](https://github.com/cloudflare/partykit/tree/main/packages/partyserver) with one Durable Object per room code.

## Deploying to Cloudflare

CI deploys the lobby. Every push to `main` runs the `lobby` job in `.github/workflows/ci.yml`, which deploys this folder with `wrangler deploy`, stores the TURN key as Worker secrets when it is configured, and hands the Worker's `wss://` address to the GitHub Pages build of the game. Nothing is deployed from a laptop and nobody pastes a token into chat: the credentials live only in GitHub Actions secrets. Until those secrets exist the job leaves a notice and the game is built without a lobby.

### One-time setup (done by hand, by the account owner)

1. Create a free Cloudflare account at <https://dash.cloudflare.com/sign-up> and verify the email address. The free Workers plan is enough for the lobby.
2. In the dashboard, open **Compute (Workers) → Workers & Pages** once. If it asks you to choose a `workers.dev` subdomain, pick one (for example your name). The lobby will live at `https://patchwork-lobby.<subdomain>.workers.dev`.
3. Copy your **Account ID**. It is shown on the **Workers & Pages** overview page (right-hand side) and under the account name's **⋯ → Copy account ID** menu on the dashboard home page.
4. Create an API token for CI: profile icon (top right) → **My Profile → API Tokens → Create Token**, then use the **Edit Cloudflare Workers** template.
   - Token name: `patchwork-airship-ci`.
   - Permissions: leave the template's list as it is (its key permission is Account → Workers Scripts → Edit, which covers deploying the Worker, its Durable Object and its secrets).
   - Account Resources: **Include → your account**.
   - Zone Resources: **Include → All zones from an account → your account** (the lobby uses no zone, but the template requires the field).
   - Client IP filtering and TTL: leave empty.
   - **Continue to summary → Create Token**, then copy the token. Cloudflare shows it only once.
5. Optional, for players behind strict networks (see TURN below): open **Realtime → TURN Server** (older dashboards call it **Calls**), choose **Create**, name the key `patchwork-airship`, and copy its **Turn Token ID** and **API Token**. If the page asks for a payment method you can skip this step; the lobby works without TURN on most home networks.
6. Hand the values to CI as repository secrets: on GitHub open `henderjj/patchwork-airship-vr` → **Settings → Secrets and variables → Actions → New repository secret**, and add each one with exactly these names:

   | Secret name | Value |
   | --- | --- |
   | `CLOUDFLARE_API_TOKEN` | the token from step 4 |
   | `CLOUDFLARE_ACCOUNT_ID` | the Account ID from step 3 |
   | `TURN_KEY_ID` | optional, the Turn Token ID from step 5 |
   | `TURN_KEY_API_TOKEN` | optional, the TURN API Token from step 5 |

7. Re-run the latest `CI` run on `main` (Actions tab → CI → the newest run → **Re-run all jobs**), or merge any pull request. The `lobby` job deploys the Worker and the `deploy` job rebuilds the game pointing at it.

### What is managed in the repository from then on

Everything else is code reviewed through pull requests and deployed by CI on merge: the Worker (`worker.ts`), its configuration (`wrangler.jsonc`, including `ALLOWED_ORIGINS`, the web origins allowed to join; add one there if the game is ever hosted somewhere other than `https://henderjj.github.io`), Durable Object migrations, Wrangler upgrades, and the lobby address baked into the game build. The only reasons to go back to the dashboard are rotating the API token or TURN key (update the matching GitHub secret afterwards) and checking usage.

If the lobby is ever hosted outside this workflow, set an Actions variable (Settings → Secrets and variables → Actions → Variables) named `LOBBY_URL` to its `wss://` address and the game build uses it instead. Without a rebuild, `?lobby=wss://...` in the page address does the same.

### Deploying by hand (fallback)

In this folder run `npm install`, `npx wrangler login` and `npm run deploy`.

## TURN (for players behind strict networks)

Most home connections can talk directly once STUN tells each browser its public address. Some networks (mobile hotspots, some corporate or university Wi-Fi) need a relay, and Cloudflare's TURN service provides one. With the `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` secrets set, the lobby hands each player short-lived TURN credentials (six hours) in its welcome message. Without them it hands out Cloudflare's public STUN server only. To set them by hand instead of through CI: `npx wrangler secret put TURN_KEY_ID` and `npx wrangler secret put TURN_KEY_API_TOKEN`.

## Local check against Cloudflare's runtime

`npx wrangler dev --port 8788` runs the Worker locally; point the game at it with `?lobby=ws://localhost:8788`.
