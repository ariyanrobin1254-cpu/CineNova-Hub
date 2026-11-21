# Deployment notes

Recommended next engineering step: choose one architecture before deployment.

A. Keep Node.js/Express: deploy to a Node.js host with persistent database and scheduled jobs; use Cloudflare R2 for private media.

B. Cloudflare-native rewrite: Pages for static UI, Workers for API/webhook, D1 for relational data, R2 for media, and Queues/Cron Triggers for reliable delivery/deletion jobs. This requires a code migration; it is not a one-click deploy of the current Express app.

Do not paste Telegram bot tokens into chat or source files. Add secrets through the hosting provider's secret/environment-variable interface.
