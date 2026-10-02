# Deploying Multi Agent Trader to mat.siv19.dev

Single Worker + D1 + static assets. One command to deploy once prerequisites are done.

## Free-tier cost guardrails

This application is designed to run on Workers Free + D1 Free + Cloudflare
Access Free. The every-minute trigger uses about 1,440 Worker invocations per
day before browser and agent traffic, comfortably below the 100,000-request
daily Workers allowance. Keep the account on the Workers Free plan: when a
Free-plan Worker or D1 database reaches a daily quota, Cloudflare returns an
error until the quota resets instead of billing an overage.

- Do not upgrade this Worker to the Workers Paid plan unless paid usage is intentional.
- Keep `workers_dev` and preview URLs disabled, as configured in `wrangler.jsonc`.
- Configure the production route to fail closed because it contains authenticated owner actions.
- Enable Cloudflare usage notifications and review Workers/D1 analytics after launch.
- The `siv19.dev` registration/renewal and any external market-data or AI APIs are separate costs.

## Prerequisites (needed from Sivaganesh)

1. **Cloudflare account** — sign up at https://dash.cloudflare.com/sign-up (free plan is enough).
2. **siv19.dev DNS on Cloudflare** — in the Cloudflare dashboard: *Add domain* → `siv19.dev`, then point the domain's nameservers at Cloudflare at your registrar. The Worker custom domain (`mat.siv19.dev`) requires this.
3. **API token (secure flow)** — for GitHub Actions, create a token at *My Profile → API Tokens* with these permissions:
   - `Workers Scripts:Edit`, `Workers Routes:Edit`, `D1:Edit`, `Account Settings:Read`, `Zone:Read` / `DNS:Edit` (for `siv19.dev`)
   
   Hand it over through the normal secure channel — **never paste it in chat**. On the deploy machine: `npx wrangler login` (browser OAuth, preferred) or `export CLOUDFLARE_API_TOKEN=…` for one shot.
4. **Cloudflare Access owner application** — create one self-hosted Access application containing both `mat.siv19.dev/proposals` and `mat.siv19.dev/api/admin/*`. Add an Allow policy containing only the owner's verified email. Copy the team domain and Application Audience (AUD) tag. The Worker validates the JWT independently, so an Access dashboard policy alone is not sufficient.

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

# 4. Configure the Access identity verifier. These are stored as encrypted
# Worker configuration so the owner email is not published in the repository.
npx wrangler secret put ACCESS_TEAM_DOMAIN
# → e.g. your-team.cloudflareaccess.com
npx wrangler secret put ACCESS_AUD
# → the Access application's Audience tag
npx wrangler secret put OWNER_EMAILS
# → comma-separated verified owner emails

# 5. Validate and deploy. The custom domain in wrangler.jsonc is created when
#    siv19.dev is active in this Cloudflare account.
npm run check
npx wrangler deploy
# → https://mat.siv19.dev (workers.dev and preview URLs are disabled)

# 6. Issue agent keys (run once per agent)
npx wrangler d1 execute trader-db --remote --command="SELECT id, name, status FROM agents;"
# For each LLM agent, call the rotate endpoint from an Access-authenticated
# owner client. Cloudflare injects Cf-Access-Jwt-Assertion and the Worker verifies it:
# POST https://mat.siv19.dev/api/admin/agents/muse/rotate-key
# → {"api_key":"tp_…"} — SAVE IT NOW, it can't be retrieved again.
# Do the same for /api/admin/agents/instinct/rotate-key, or use the owner-only
# Agent keys panel on https://mat.siv19.dev/proposals.
```

## After deploy — smoke test

```bash
curl https://mat.siv19.dev/api/health
curl https://mat.siv19.dev/api/portfolio | head -c 300
curl "https://mat.siv19.dev/api/intelligence?format=md" -o /tmp/i.md && head -3 /tmp/i.md
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

Set `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and `OWNER_EMAILS` directly on the
Worker as shown above. No shared browser admin token exists.

## Owner-auth smoke test

1. Open `https://mat.siv19.dev/proposals` in a private browser window.
2. Verify Cloudflare Access requires login and rejects any email not in the Allow policy.
3. After login, verify the page shows the authenticated email returned by `/api/admin/me`.
4. Resolve a test decision and confirm `admin_audit` records the same email and Access subject.
5. Confirm a direct request without `Cf-Access-Jwt-Assertion` returns `401`, even if it reaches the Worker.

## What's NOT here (by design)

- No broker credentials, no order routing, no real-money code paths — anywhere.
- `JEV_API_KEY` is reserved for a future integration. Do not set it; the `jev`/`laya` providers are unwired stubs that throw if called.
