# CineNova Hub — Updated Starter

This ZIP is an updated **starter**, not a production-ready deployed service. It preserves the supplied Premium Dark UI and makes the current limitations explicit so the project is not launched with unsafe or misleading behaviour.

## Included
- Premium Dark catalogue and admin UI
- Node.js / Express starter backend
- SQLite demo database and admin session scaffold
- S3-compatible upload URL scaffold (Cloudflare R2 can be configured)
- Telegram WebApp SDK loaded by the homepage
- Delivery button intentionally disabled until secure Telegram identity verification and webhook linking are implemented
- Existing 10-second ad placeholder and 60-minute delivery schema remain configuration concepts, not a live ad or delivery system

## Important hosting note
The supplied backend uses Node.js, Express, `better-sqlite3`, filesystem storage, and a long-running cron job. **It cannot be deployed directly as a Cloudflare Worker.** Cloudflare Pages can host static frontend files, but this backend needs a Node.js host or a deliberate rewrite to Workers + D1 + Queues/Cron Triggers. Do not connect this repository to Workers and expect the full app to work unchanged.

## Run locally
1. Install Node.js 20 or later.
2. Copy `.env.example` to `.env`.
3. Generate an admin password hash:
   `node -e "import('bcryptjs').then(async b=>console.log(await b.hash('YOUR_LONG_PASSWORD',12)))"`
4. Put the hash in `ADMIN_PASSWORD_HASH`; replace all development secrets.
5. Run `npm install` and `npm start`.
6. Open `http://localhost:3000`; admin page: `/admin.html`.

## Before enabling Telegram delivery
These items are **not yet implemented/verified** in this starter and must be completed:
- Validate Telegram Mini App `initData` server-side using the bot token and reject stale signatures.
- Add a Telegram webhook and verify `X-Telegram-Bot-Api-Secret-Token`.
- Link users only after a genuine `/start` update; never accept a chat ID typed into the browser.
- Ingest channel posts from the configured private storage channel and store each Telegram `file_id` in the database.
- Deliver using the stored `file_id` and `protect_content: true`.
- Implement retry-safe 60-minute deletion using a persistent scheduler/queue. Telegram deletion only removes the bot's message; it cannot erase copies, screenshots, or recordings made elsewhere.
- Add CSRF protection, rate limits, secure admin provisioning, database migrations, and monitoring.

## Video storage choices
For Telegram-channel storage, a bot must be an administrator with permission to post/read updates as required. A Bot API `file_id` can be reused by the same bot, but Telegram file size and API limits apply. For a durable independent archive, use private Cloudflare R2/S3 storage and keep credentials server-side. Do not assume Telegram channel storage is a guaranteed backup.

## Environment
See `.env.example`. Never commit `.env`, bot tokens, passwords, or storage credentials. Keep this GitHub repository private.

## Status
This package is a safer, clearer starter update. No live Telegram bot, channel, R2 bucket, webhook, ad provider, or Cloudflare deployment is configured by this ZIP alone.
