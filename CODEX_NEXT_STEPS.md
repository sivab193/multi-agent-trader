# Handoff — Multi Agent Trader / mat.siv19.dev

You are picking up a working codebase. Read this file first, then README.md, then DEPLOY.md.

## What this is

A multi-agent **paper-trading** portal (Cloudflare Workers + D1). Two LLM agents
(Muse + Instinct) debate trades in a chat room; both must approve within a
2-minute window or the proposal becomes a decision request the human resolves.
**Paper trading only — there must never be real-money/brokerage code paths.**

## What's built and verified

- `src/index.js` — REST API (agents, chat, proposals, votes, decision-requests,
  ledger, strategies, intelligence download). Syntax-checked with node.
- `src/auth.js`, `src/cron.js` — bearer auth, every-minute cron (expires
  discussion windows, nudges due agents via `wake_url`). Syntax-checked.
- `src/decision-provider.js` — THE key abstraction. Active provider is `human`.
  `jev` and `laya` are intentional throwing stubs (COMING SOON, no API access
  yet). Never silently fall through to a stub.
- `schema.sql` / `seed.sql` — D1 schema; seed generated from the live sim
  (`npm run seed` regenerates from `~/workspace/trading-sim/`).
- `public/` — dashboard, chat, proposals inbox, strategies box, how-it-works,
  intelligence download. Every page carries the paper-trading banner.
- `wrangler.jsonc` — D1, cron, observability, and custom domain `mat.siv19.dev`.

## Next steps (in order)

1. **Deploy.** Follow DEPLOY.md. Repository checks, manual production workflow,
   custom-domain configuration, observability, and schema are ready. Cloudflare
   authorization and a real D1 database ID are still required; do not invent them.
2. **Smoke-test the deployed API** (health, portfolio, intelligence download —
   commands in DEPLOY.md), then run one full proposal lifecycle by hand:
   register 2 test agents → proposal → both approve → verify ledger row and
   portfolio update; then a second proposal with no votes → verify it becomes
   a decision_request after 2 minutes and resolves via the admin endpoint.
3. **Initial hardening is complete:** `POST /api/strategies` and `POST /api/chat`
   use atomic D1 fixed-window counters; privileged actions require a verified
   Cloudflare Access JWT and are recorded in `admin_audit`; proposal and decision
   uniqueness constraints prevent duplicate execution/escalation.
4. **Engine cutover (after deploy):** the live trading engine currently runs on
   local files at `~/workspace/trading-sim/`. Migrate it to drive the portal:
   engine polls `/api/chat?since=` + `/api/proposals?status=PROPOSED`, posts
   proposals/votes with its API key, heartbeats with `next_wake_at`. Keep the
   local files as the fallback ledger until cutover is proven; re-run
   `npm run seed` right before cutover so no trades are lost.
5. **Muse + Instinct onboarding:** issue separate keys from the owner-only Agent
   keys panel on `/proposals`. Each agent must poll (≤60s) unless it exposes a
   `wake_url`. The README has the integration guide to hand over.
6. **Wire Jev/Laya ONLY when API access exists.** TODOs are in
   `src/decision-provider.js`. Policy: execute on high confidence, escalate to
   human on flat distributions (top prob < ~0.6). Until then, `human` stays.

## Conventions

- ES modules (`"type": "module"`), vanilla JS frontend, minimal deps.
- Never hardcode secrets — `wrangler secret put`.
- Paper-trading rule is load-bearing: if a change could touch real money,
  stop and ask the human.
- After each change: `node --input-type=module --check` on edited `src/*.js`,
  and `npx wrangler d1 execute trader-db --local --file=schema.sql` still
  applies cleanly.
