# SplitCat 🐱

A Telegram bot for splitting receipts among friends — with automatic OCR via Claude Vision, multi-currency support for overseas travel, and escalating cat-meme payment reminders.

Single TypeScript service. Self-hosted on a small VPS. Mini App on Vercel for the tap-to-assign UI.

## What it does

- 📸 Snap a photo of any receipt in a Telegram group chat — Claude Vision parses line items, subtotals, tax, service charge. Whoever uploads is the payer.
- 🌏 Automatic currency conversion when travelling overseas (JPY, USD, EUR, THB, etc. → SGD or any home currency).
- 🧮 Tap-to-assign items via an inline Mini App. Handles proportional service charge + GST correctly.
- 💬 **Talk to it in plain English by @-mentioning the bot.** "Who owes who", "I paid Priya 20", "Priya cleared her tab", "settle up" — Claude parses the intent and does the right thing.
- 💸 Running ledger of who owes whom across multiple receipts.
- 🐈 Escalating cat-meme reminders for overdue debts — capped at 5 nudges so it stays funny, not annoying.
- 🤝 `/settle` (or "@bot settle up") suggests the minimum set of transfers to zero out all balances.

## Architecture

```
┌─────────────┐   webhook   ┌──────────────────┐
│  Telegram   │ ──────────▶ │   Bot (Node)     │
│             │ ◀── reply ──│   on the VPS     │
└─────────────┘             └────────┬─────────┘
                                     │
                  ┌──────────────────┼─────────────────┐
                  │                  │                 │
                  ▼                  ▼                 ▼
           ┌────────────┐     ┌────────────┐   ┌──────────────┐
           │  Postgres  │     │   Claude   │   │  Mini App    │
           │  (ledger)  │     │  vision +  │   │  (Vercel)    │
           └────────────┘     │   memes    │   └──────────────┘
                              └────────────┘
```

One Node process handles webhooks, commands, callbacks, and the cron-driven nudge scheduler. Postgres holds all state. Caddy fronts everything with auto-TLS.

## Repo layout

```
splitcat/
├── bot/                    TypeScript bot — webhook server + scheduler
├── mini-app/               Next.js Telegram Mini App for item assignment
├── db/schema.sql           Postgres schema (shared between bot and Mini App)
├── deploy/                 docker-compose, Caddy, systemd auto-update
├── prompts/                Standalone Claude prompt version (no infra needed)
└── docs/                   Setup guides
```

## Quick start

**1. VPS** — see [`docs/vps-setup.md`](docs/vps-setup.md). Hetzner CX11 (€3/mo) is enough.

**2. Telegram bot** — talk to [@BotFather](https://t.me/BotFather), grab the token.

**3. Deploy the Mini App** — see [`mini-app/README.md`](mini-app/README.md). Vercel one-click.

**4. Bring up the stack** — copy `deploy/.env.example` → `.env`, fill in secrets, then `docker compose up -d --build`.

**5. Add bot to a group chat**, snap a receipt, watch it work.

Full walkthrough: [`docs/getting-started.md`](docs/getting-started.md).

## Costs

| Component | Provider | Monthly |
|-----------|----------|---------|
| VPS (bot + Postgres) | Hetzner CX11 | ~€3 |
| Mini App hosting | Vercel Hobby | Free |
| Claude API (~50 receipts) | Anthropic | ~$1–2 |
| Domain | Any registrar | ~$1 |
| **Total** | | **~€4–5/month** |

## The standalone Claude prompt

Don't want to deploy anything? [`prompts/splitcat-system-prompt.md`](prompts/splitcat-system-prompt.md) gives you ~80% of the bot's behaviour as a single Claude.ai system prompt, with the conversation itself as the database. Drop receipts in, ask for splits, request meme nudges. No infra, no persistence, but useful for one-off trips.

## A note on the memes

The nudge system caps at 5 escalating messages and only ever messages the person who owes, never their contacts or social accounts. It's a joke, not a pressure tactic. Singapore's Protection from Harassment Act is real and the app stores take this seriously — fork at your own risk if you remove the cap.

## Licence

MIT.
