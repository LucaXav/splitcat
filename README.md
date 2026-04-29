# 🐾 SplitCat

> The slightly grumpy cat that splits your group's bills, so you don't have to.

A Telegram bot for splitting bills with friends. Snap a receipt in any group chat, the bot parses it, you assign items in a Telegram Mini App, and the bot keeps track of who owes who. Forgotten debts get gentle (then less gentle) cat-themed reminders.

Optimized for friend groups, dinners out, trips, and anything bill-splittable.

## Features

- 📸 Receipt OCR — text receipts, card slips, photos
- 🐾 Tap-to-assign Telegram Mini App for splitting line items
- 🌐 Multi-currency support with automatic FX conversion
- 🤖 Natural-language commands — "@bot who owes who", "@bot Wei cleared his tab"
- 😼 Personality — dry, slightly grumpy cat energy
- 📈 Auto-escalating reminders — sleepy paw-lite after the first day, escalating through tail-flick, cat court, and unhinged detective, capped at 5 levels so the bot doesn't spiral forever
- 🎯 Only acts on @-mentioned photos in groups (silent on random group photos)
- 💸 Equal-split mode for receipts without itemization (card slips, etc.)
- 🤫 Auto-discovers group members from passive activity — no manual setup
- 🥰 Rare easter egg sticker if you praise the bot too much

## Who it's for

- Friend groups planning trips together
- Dinner clubs where the same people eat out often
- Roommates splitting groceries
- Anyone tired of doing receipt math in their head
- People who like their utility bots with a bit of personality

## How to add SplitCat to your group

1. Search for the bot on Telegram (`@Splitkitcat_bot` or whatever username it's hosted at)
2. Tap **Add to Group** → pick the group
3. In BotFather, disable Privacy Mode for the bot (or promote it to admin in your group) so it can see messages
4. Snap a receipt with `@<bot_name>` in the caption — that's the trigger
5. Tap **Assign items** when the bot replies
6. Tap who had what, hit **Save split**
7. The bot now knows everyone's debts. Forget to pay? Cat memes will follow.

## Architecture

- **Bot**: TypeScript, [grammY](https://grammy.dev) framework, Docker on a small VPS
- **Mini App**: Next.js on Vercel
- **Database**: Postgres (managed via [Neon](https://neon.tech))
- **Cost**: ~$10/month at hobby scale

## Self-hosting

1. Clone this repo
2. Provision: a Telegram bot ([@BotFather](https://t.me/botfather)), a small VPS, a Neon Postgres project, a Vercel account
3. Follow [`docs/vps-setup.md`](docs/vps-setup.md) to deploy the bot
4. Deploy `mini-app/` to Vercel — set Root Directory to `mini-app`, add `DATABASE_URL` and `MINI_APP_SECRET` env vars
5. Apply the schema: `psql "$DATABASE_URL" < db/schema.sql`
6. Add the bot to a group and start splitting

Detailed setup guide: [`docs/vps-setup.md`](docs/vps-setup.md)

## Limits & gotchas

- Group chats only (DMs work for testing but the product is multiplayer by nature)
- Bot needs Privacy Mode disabled OR admin status to receive group messages
- Receipts must be photos, not PDFs
- Single-instance deployment — fine for one bot, would need Redis for horizontal scaling

## Contributing

Issues and PRs welcome. Open an issue first for anything substantial so we can discuss before you write code.

The bot has a personality — please don't make it nicer or remove the spikes. Slightly grumpy cat is a feature, not a bug.

## License

MIT — see [LICENSE](LICENSE)
