# Getting Started

End-to-end setup for the SplitCat bot. About 30 minutes if you have a domain ready.

## What you'll need

- A domain name (`.xyz` is fine — ~$1/year at Porkbun or Cloudflare Registrar)
- A VPS (Hetzner CX11 €3/month is plenty)
- An Anthropic API key from [console.anthropic.com](https://console.anthropic.com)
- A Telegram account
- A GitHub account (for auto-deploy)

## 1. Create the Telegram bot

In Telegram, message [@BotFather](https://t.me/BotFather):

1. `/newbot` — pick a name and username (must end in `bot`).
2. Copy the token — this is your `TELEGRAM_BOT_TOKEN`.
3. `/setjoingroups` → pick your bot → **Enable**.
4. `/setprivacy` → pick your bot → **Disable** (so it can read photos in groups, not just commands).
5. `/setdomain` → pick your bot → enter your Mini App domain once you've deployed it (e.g. `splitcat-miniapp.vercel.app`). You can come back to this later.

## 2. Set up the VPS

See [`vps-setup.md`](vps-setup.md). End state: Postgres, the bot, and Caddy all running on the VPS, accessible at `https://splitcat.yourdomain.com`.

## 3. Deploy the Mini App to Vercel

See [`../mini-app/README.md`](../mini-app/README.md). End state: Mini App URL like `https://splitcat-miniapp.vercel.app`.

Add that URL to `deploy/.env` on the VPS as `MINI_APP_URL`, then:

```bash
cd /opt/splitcat
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

(The auto-update timer will catch this on its own within 5 minutes, but rebuilding now is faster.)

## 4. Test it

1. Add your bot to a Telegram group with a couple of friends (or DM it for solo testing).
2. Send `/start` — you should see the welcome message.
3. Snap a photo of any receipt — within 5–15 seconds Claude parses it and the bot posts an "Assign items" button.
4. Tap through the Mini App, assign items, pick payer, hit **Save split**.
5. Run `/balance` — you'll see who owes what.
6. Try `/settle` for the suggested transfers.
7. Travel test: take a photo of a foreign receipt (or any receipt you'll claim is foreign) — confirm the FX conversion appears in the response.

## 5. Verify nudges (optional)

Nudges fire every 6 hours by default and start one day after a receipt is assigned. To force one for testing, run inside the bot container:

```bash
docker compose -f deploy/docker-compose.yml exec bot \
  node -e "import('./dist/services/scheduler.js').then(m => m.runOnce(globalThis.bot)).catch(console.error)"
```

Or just lower `NUDGE_CHECK_CRON` in `deploy/.env` to `* * * * *` (every minute) and adjust the SQL intervals in `bot/src/services/scheduler.ts` to test escalation faster.

## Troubleshooting

**No response to messages.**
```bash
docker compose -f deploy/docker-compose.yml logs bot | tail -100
```
Check for webhook errors. Confirm the bot started by hitting `https://splitcat.yourdomain.com/health` — should return `{"ok":true,...}`.

**"Failed to parse receipt."**
Check the bot logs for the raw Claude response. Usually means an extremely blurry photo or rate-limit. Ask the user to retake.

**Mini App shows "Session expired."**
Sessions last 1 hour. Also happens if `MINI_APP_SECRET` differs between the VPS and Vercel — they must match exactly.

**Nudges not firing.**
- Confirm the cron is running: `docker compose logs bot | grep "Nudge scheduler started"`.
- Run `/balance` to confirm there's actually outstanding debt.
- The first nudge waits 24 hours after the receipt is assigned. Use the test command above to force one.

**FX conversion missing.**
The bot uses [open.er-api.com](https://open.er-api.com) which is free and no-key. If their service is down, the bot stores `fx_rate=null` and notes "FX rate unavailable" in the reply. The Mini App will let you assign items anyway and the conversion can be added later.

## Cost check-in

After a month of light use (10–20 receipts, a small group of friends):

| Item | Cost |
|---|---|
| Hetzner CX11 | €3 |
| Claude API (Opus for vision, ~$0.015/receipt) | ~$0.50 |
| Claude API (Haiku for memes) | <$0.10 |
| Vercel Hobby | $0 |
| Domain (amortised) | ~$0.10 |
| **Total** | **~€4** |

For heavier use, switching `CLAUDE_VISION_MODEL` to `claude-sonnet-4-6` cuts vision cost ~3× with minor accuracy loss on messy receipts.
