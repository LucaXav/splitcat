# SplitCat Mini App

The Telegram Mini App (Next.js) that handles tap-to-assign-items when a receipt
is uploaded. Deploys to Vercel in one click.

## Environment variables

Set these in your Vercel project (or a local `.env.local` for dev):

```
DATABASE_URL=postgres://splitcat:PASSWORD@YOUR_VPS_HOST:5432/splitcat
MINI_APP_SECRET=<same 32-byte hex string you set in deploy/.env>
```

`DATABASE_URL` must point at the same Postgres your n8n instance uses. If your
VPS Postgres isn't exposed publicly, either (a) open port 5432 behind firewall
rules that only allow Vercel's egress ranges, or (b) use a managed Postgres
(Neon, Supabase) that both n8n and Vercel can reach — this is the easier path
for most people.

## Local dev

```
npm install
npm run dev
```

Visit http://localhost:3000. Without a valid session token in the URL you'll
see a "this is meant to open from Telegram" page, which is expected.

## Deploy

1. Push the parent repo to GitHub.
2. In Vercel, import the repo and set the **Root Directory** to `mini-app`.
3. Set the env vars above.
4. Deploy.
5. Copy the resulting Vercel URL into `deploy/.env` on your VPS as `MINI_APP_URL`.
6. Restart n8n: `docker compose -f deploy/docker-compose.yml restart n8n`.

## How the auth works

When n8n parses a receipt, it:

1. Generates a random 24-byte token.
2. Signs `(token, receipt_id, user_id)` with `MINI_APP_SECRET` → HMAC.
3. Stores the token in `mini_app_sessions` (1-hour TTL).
4. Sends a Telegram button with URL
   `{MINI_APP_URL}/{receipt_id}?t={token}&u={user_id}&h={hmac}`.

The Mini App verifies both the HMAC (prevents URL tampering) and the DB row
(prevents replay after expiry). On successful assignment the token row is
deleted so the link is single-use.

## Register the Mini App with BotFather (optional but nicer UX)

```
/newapp            # in a chat with @BotFather
→ pick your bot
→ title: SplitCat
→ description: Tap-to-assign receipt splitting
→ photo: any 640x360 image
→ Web App URL: your Vercel URL
→ short name: splitcat
```

Registering means Telegram renders the link as a native Mini App (with the
Telegram theme automatically applied) rather than a regular web view.
