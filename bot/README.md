# SplitCat Bot

The TypeScript Telegram bot — receipt handling, commands, callbacks, and the cron-driven nudge scheduler. Single Node process; deploys as one Docker container.

## Architecture

```
src/
├── index.ts                 # entry: webhook server + bot + scheduler
├── env.ts                   # zod-validated env config
├── handlers/
│   ├── photo.ts             # receipt OCR pipeline
│   ├── commands.ts          # /balance /settle /currency /snooze /paid /help
│   └── callbacks.ts         # inline buttons (split equally, mark paid)
├── services/
│   ├── claude.ts            # Anthropic SDK — vision + memes
│   ├── fx.ts                # currency lookup with in-memory cache
│   └── scheduler.ts         # node-cron job for escalating nudges
├── lib/
│   ├── db.ts                # pg pool
│   ├── log.ts               # pino logger
│   ├── hmac.ts              # signed Mini App URLs
│   └── split.ts             # proportional split + greedy settlement
└── scripts/
    └── migrate.ts           # applies db/schema.sql
```

## Local dev

```bash
npm install
cp .env.example .env
# fill in .env, then:
npm run migrate                # apply schema to your local Postgres
npm run dev                    # start the bot in watch mode
```

For local development you need a public HTTPS URL so Telegram can reach you. Use `ngrok http 3000` or similar and set `PUBLIC_URL` to the ngrok URL.

## Production

Built and run as a Docker container — see `deploy/docker-compose.yml` in the repo root.

```bash
# from repo root
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

Logs:
```bash
docker compose -f deploy/docker-compose.yml logs -f bot
```

## Adding a new command

1. Add a handler function in `src/handlers/commands.ts`.
2. Register it in `src/index.ts`: `bot.command("foo", handleFoo);`
3. Update the `/help` text.
4. Commit, push — auto-deploys via systemd timer.

## Adding a new callback action

1. Add a case in `src/handlers/callbacks.ts`'s switch on `action`.
2. Wherever you build the inline keyboard, set `callback_data` to `${action}:${arg}`.

## Testing the OCR offline

The `parseReceipt` function in `src/services/claude.ts` takes a base64 image. You can write a one-off script to feed it a local file and inspect the output:

```typescript
import { readFileSync } from "node:fs";
import { parseReceipt } from "./services/claude.js";

const img = readFileSync("./test-receipt.jpg").toString("base64");
console.log(JSON.stringify(await parseReceipt(img), null, 2));
```

Run with `tsx src/scripts/test-ocr.ts`.

## Cost notes

Per receipt with `claude-opus-4-7`: roughly $0.01–0.02 depending on image size. Switch to `claude-sonnet-4-6` via `CLAUDE_VISION_MODEL` env var to drop cost ~3× with a small accuracy hit on messy receipts; switch to `claude-haiku-4-5` to drop ~10× with a noticeable hit. Test on your typical receipts before downgrading.

The meme generator uses `claude-haiku-4-5` by default, which is cheap (~$0.0005 per nudge).
