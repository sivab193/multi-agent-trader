# Deploying multi-agent-trader to trader.siv19.dev

Single Worker + D1 + static assets. One command to deploy once prerequisites are done.

## Prerequisites (needed from Sivaganesh)

1. **Cloudflare account** — sign up at https://dash.cloudflare.com/sign-up (free plan is enough).
2. **siv19.dev DNS on Cloudflare** — in the Cloudflare dashboard: *Add domain* → `siv19.dev`, then point the domain's nameservers at Cloudflare at your registrar. The Worker custom domain (`trader.siv19.dev`) requires this.
3. **API token (secure flow)** — for GitHub Actions, create a token at *My Profile → API Tokens* with these permissions:
   - `Workers Scripts:Edit`, `Workers Routes:Edit`, `D1:Edit`, `Account Settings:Read`, `Zone:Read` / `DNS:Edit` (for `siv19.dev`)
   
   Hand it over through the normal secure channel — **never paste it in chat**. On the deploy machine: `npx wrangler login` (browser OAuth, preferred) or `export CLOUDFLARE_API_TOKEN=…` for one shot.

## Deploy steps

```bash
cd multi-agent-trader

# 1. Log in (opens browser)
npx wrangler login

# 2. Create the D1 database
npx wrangler d1 create trader-db
# → copy the database_id it prints into wrangler.jsonc (replace the 0000… placeholder)

# 3. Create schema + load seed data (seed is generated from the live trading-sim)
npm run seed
npx wrangler d1 execute trader-db --remote --file=schema.sql
npx wrangler d1 execute trader-db --remote --file=seed.sql

# 4. Set the admin secret (used for agent registration + resolving decision requests)
npx wrangler secret put ADMIN_TOKEN
# → paste a long random token when prompted. Sivaganesh pastes this same token
#    once in the browser on /proposals (stored in localStorage only).

# 5. Validate and deploy. The custom domain in wrangler.jsonc is created when
#    siv19.dev is active in this Cloudflare account.
npm run check
npx wrangler deploy
# → you get a workers.dev URL plus https://trader.siv19.dev

# 6. Issue agent keys (run once per agent)
npx wrangler d1 execute trader-db --remote --command="SELECT id, name, status FROM agents;"
# For each LLM agent, create a key via the API (replace ADMIN_TOKEN):
curl -X POST https://trader.siv19.dev/api/admin/agents/jarvis/rotate-key \
  -H "x-admin-token: $ADMIN_TOKEN"
# → {"api_key":"tp_…"} — SAVE IT NOW, it can't be retrieved again.
# Do the same for /api/admin/agents/instinct/rotate-key
```

## After deploy — smoke test

```bash
curl https://trader.siv19.dev/api/health
curl https://trader.siv19.dev/api/portfolio | head -c 300
curl "https://trader.siv19.dev/api/intelligence?format=md" -o /tmp/i.md && head -3 /tmp/i.md
```

## Ongoing

- **Re-seed from the live sim** (before cutover): `npm run seed` then step 3 again (seed.sql is idempotent — DELETEs then INSERTs).
- **Rotate a compromised agent key**: `POST /api/admin/agents/:id/rotate-key`.
- **Publish a new intelligence version**: `POST /api/admin/intelligence` with `{"markdown": "…", "note": "…"}`.
- **Logs**: `npx wrangler tail` — watch the every-minute cron.
- **D1 backup**: `npx wrangler d1 export trader-db --remote --output=trader-db-backup.sql`.
- The cron (`* * * * *`) runs automatically on the deployed Worker: it expires 2-minute discussion windows into decision requests and nudges due agents via their `wake_url`.

## GitHub Actions deployment

The public repository validates the local schema and seed and performs a Worker
dry run on every push and pull request. Production deployment is intentionally
manual from **Actions → Deploy → Run workflow**.

Configure the repository's `production` environment with these Actions secrets:

- `CLOUDFLARE_API_TOKEN` — the scoped token described above.
- `CLOUDFLARE_ACCOUNT_ID` — shown by `npx wrangler whoami` after login.

Set the Worker secret separately with `npx wrangler secret put ADMIN_TOKEN`;
do not put the admin token in GitHub unless a workflow actually needs it.

## What's NOT here (by design)

- No broker credentials, no order routing, no real-money code paths — anywhere.
- `JEV_API_KEY` is reserved for a future integration. Do not set it; the `jev`/`laya` providers are unwired stubs that throw if called.
