# Amanah sync server

A small Cloudflare Worker (free plan) that does two jobs:
- **Encrypted sync.** It stores budget records that the app has already encrypted, so it can't read them.
- **Push notifications.** It sends your bill and Zakat reminders on time.

It uses Durable Objects (SQLite) for storage and a cron trigger every 15 minutes for reminders. You don't need any API keys or secrets: the notification signing key is generated automatically the first time it runs.

## Deploy from your phone (about 10 minutes)

1. Sign in at **dash.cloudflare.com**. Go to **Workers & Pages** (on a phone it may be under the ☰ menu, in *Compute*).
2. Tap **Create application**, then **Get started** next to **Import a repository**.
3. Choose your **GitHub** account and select the **amanah-budget** repository. Allow Cloudflare access to it if asked.
4. Configure:
   - **Project name:** `amanah-sync`. It must be exactly this, matching `wrangler.toml`.
   - **Root directory** (sometimes under *Advanced settings*, or called *Path*): `worker`
   - **Build command:** leave empty
   - **Deploy command:** `npx wrangler deploy` (the default)
5. Tap **Save and Deploy**, then wait about a minute for the build to finish.
6. If Cloudflare asks you to choose a **workers.dev subdomain**, pick any name.
7. Open the Worker and copy its address, e.g. `https://amanah-sync.yourname.workers.dev`. Opening it in your browser should show `{"ok":true,"service":"amanah-sync",...}`.

Then, in the app, go to **Settings → Sync & notifications**, paste the address and tap **Start syncing from this device**.

Every future change pushed to the GitHub repo redeploys the Worker automatically.

## Optional: lock it to your app
In the Worker's **Settings → Variables and Secrets**, add a variable named `ALLOWED_ORIGIN` with the value `https://aethlaecoclean.github.io`. Browsers on other websites can then no longer use your server.

## Cost
Personal or family use fits comfortably within Cloudflare's free Workers plan.
