// Multi Agent Trader (mat.siv19.dev) — REST API + cron + static assets.
// PAPER TRADING ONLY. No broker, order-routing, or real-money code exists here.

import {
  agentFromRequest, ownerFromRequest, newApiKey, sha256Hex, clientIpHash,
  verifyOwnerToken, createOwnerSession, ownerSessionCookie, clearOwnerSessionCookie,
} from "./auth.js";
import { activeProvider, buildArbitrationState } from "./decision-provider.js";
import { runScheduled } from "./cron.js";

const DISCUSSION_MS = 120_000; // 2-minute agent discussion window
const MAX_POSITION_FRACTION = 0.25; // max 25% of a portfolio in one new BUY

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const err = (status, message) => json({ ok: false, error: message }, status);
const nowIso = () => new Date().toISOString();

async function requireOwner(request, env) {
  const owner = await ownerFromRequest(request, env);
  if (!owner) return null;
  if (owner.auth_method === "owner_token" && !["GET", "HEAD"].includes(request.method)) {
    const origin = request.headers.get("Origin");
    if (origin !== new URL(request.url).origin) return null;
  }
  return owner;
}

function auditOwnerStatement(env, owner, action, target, detail = {}) {
  return env.DB.prepare(
    `INSERT INTO admin_audit (actor_email, actor_subject, action, target, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(owner.email, owner.subject || null, action, target || null, JSON.stringify(detail), nowIso());
}

function newId(prefix) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `${prefix}_${stamp}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// --- portfolio helpers -------------------------------------------------------

async function latestSnapshot(env, portfolio) {
  const row = await env.DB.prepare(
    "SELECT snapshot_json FROM portfolio_snapshots WHERE portfolio = ? ORDER BY id DESC LIMIT 1"
  ).bind(portfolio).first();
  return row ? JSON.parse(row.snapshot_json) : null;
}

function portfolioTotalValue(snap) {
  // Approximation for the 25% cap: cash + holdings at average cost.
  let total = Number(snap.cash || 0);
  for (const h of Object.values(snap.holdings || {})) {
    if (h.quantity == null) continue; // e.g. *_EXITED note rows
    const avg = h.avg_cost_inr ?? h.avg_cost_usd ?? 0;
    total += Number(h.quantity) * Number(avg);
  }
  return total;
}

function applyTrade(snap, { action, symbol, qty, price }) {
  const next = JSON.parse(JSON.stringify(snap));
  next.holdings = next.holdings || {};
  const key = symbol.toUpperCase();
  const costField = next.currency === "INR" ? "avg_cost_inr" : "avg_cost_usd";
  const value = qty * price;

  if (action === "BUY") {
    if (Number(next.cash) < value) throw new Error("insufficient cash for BUY");
    next.cash = Number((Number(next.cash) - value).toFixed(2));
    const h = next.holdings[key] || { quantity: 0, [costField]: 0 };
    const newQty = Number(h.quantity) + qty;
    h[costField] = Number((((Number(h.quantity) * Number(h[costField] || 0)) + value) / newQty).toFixed(4));
    h.quantity = newQty;
    next.holdings[key] = h;
  } else {
    const h = next.holdings[key];
    if (!h || Number(h.quantity) < qty) throw new Error("insufficient holdings for SELL");
    next.cash = Number((Number(next.cash) + value).toFixed(2));
    h.quantity = Number(h.quantity) - qty;
    if (h.quantity <= 0) delete next.holdings[key];
  }
  return next;
}

async function executeProposal(env, proposal, decidedBy, winnerAgentId, extraStatements = []) {
  const snap = await latestSnapshot(env, proposal.portfolio);
  if (!snap) throw new Error(`no snapshot for portfolio ${proposal.portfolio}`);
  const next = applyTrade(snap, proposal);
  const now = nowIso();
  const txnId = `txn_${String(Date.now()).slice(-6)}_${crypto.randomUUID().slice(0, 8)}`;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO transactions
         (id, ts, portfolio, action, symbol, qty, price, currency, value,
          price_source, price_url, justification, decided_by, proposal_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      txnId, now, proposal.portfolio, proposal.action, proposal.symbol.toUpperCase(),
      proposal.qty, proposal.price, snap.currency || "INR",
      Number((proposal.qty * proposal.price).toFixed(2)),
      proposal.price_source, proposal.price_url,
      proposal.thesis_short, decidedBy, proposal.id
    ),
    env.DB.prepare(
      "INSERT INTO portfolio_snapshots (portfolio, snapshot_json, created_at) VALUES (?, ?, ?)"
    ).bind(proposal.portfolio, JSON.stringify(next), now),
    env.DB.prepare("UPDATE proposals SET status = 'APPROVED' WHERE id = ?").bind(proposal.id),
    ...extraStatements,
  ]);

  await env.DB.prepare(
    "INSERT INTO chat_messages (agent_id, body, created_at) VALUES (NULL, ?, ?)"
  ).bind(
    `✅ EXECUTED ${proposal.action} ${proposal.qty} ${proposal.symbol.toUpperCase()} @ ${proposal.price} ` +
      `(decided by ${decidedBy}${winnerAgentId ? ", winner: " + winnerAgentId : ""}) → ${txnId}`,
    now
  ).run();

  return { txnId, snapshot: next };
}

async function activeAgentCount(env) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM agents WHERE api_key_hash IS NOT NULL AND status != 'disabled' AND type = 'llm'"
  ).first();
  return Number(row?.n || 0);
}

async function consumeRateLimit(env, scope, subject, windowMs, maxRequests) {
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (scope, subject, window_start, count)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(scope, subject, window_start)
     DO UPDATE SET count = count + 1
     RETURNING count`
  ).bind(scope, subject, windowStart).first();
  return Number(row?.count || 1) <= maxRequests;
}

// --- route handlers ----------------------------------------------------------

async function handleHeartbeat(env, agent, body) {
  const nextWake = body?.next_wake_at || null;
  const now = nowIso();
  await env.DB.prepare(
    "UPDATE agents SET last_heartbeat_at = ?, next_wake_at = ?, status = 'online' WHERE id = ?"
  ).bind(now, nextWake, agent.id).run();
  return json({ ok: true, at: now, next_wake_at: nextWake });
}

async function handleChatPost(env, agent, body) {
  if (!(await consumeRateLimit(env, "chat", agent.id, 60_000, 30))) {
    return err(429, "chat rate limit exceeded — max 30 messages per minute");
  }
  const text = (body?.body || "").toString().trim().slice(0, 4000);
  if (!text) return err(400, "body is required");
  const now = nowIso();
  const r = await env.DB.prepare(
    "INSERT INTO chat_messages (agent_id, body, created_at) VALUES (?, ?, ?)"
  ).bind(agent.id, text, now).run();
  return json({ ok: true, id: Number(r.meta.last_row_id), at: now });
}

async function handleChatGet(env, url) {
  const since = url.searchParams.get("since"); // message id
  const limit = Math.min(Number(url.searchParams.get("limit") || 100), 500);
  let q = `SELECT m.id, m.body, m.created_at, m.agent_id,
                  COALESCE(a.name, 'system') AS agent_name
           FROM chat_messages m LEFT JOIN agents a ON a.id = m.agent_id`;
  const binds = [];
  if (since) { q += " WHERE m.id > ?"; binds.push(Number(since)); }
  q += " ORDER BY m.id ASC LIMIT ?";
  binds.push(limit);
  const rows = await env.DB.prepare(q).bind(...binds).all();
  return json({ ok: true, messages: rows.results });
}

async function handlePropose(env, agent, body) {
  const action = (body?.action || "").toUpperCase();
  const symbol = (body?.symbol || "").toString().trim().toUpperCase().slice(0, 12);
  const qty = Number(body?.qty);
  const price = Number(body?.price);
  const portfolio = (body?.portfolio || "india_inr").toString();
  const thesis_short = (body?.thesis_short || "").toString().trim().slice(0, 500);
  const thesis_detail = (body?.thesis_detail || "").toString().trim().slice(0, 8000);

  if (!["BUY", "SELL"].includes(action)) return err(400, "action must be BUY or SELL");
  if (!symbol) return err(400, "symbol is required");
  if (!Number.isFinite(qty) || qty <= 0) return err(400, "qty must be positive");
  if (!Number.isFinite(price) || price <= 0) return err(400, "price must be positive (live, verifiable)");
  if (!["india_inr", "us_usd", "crypto"].includes(portfolio)) return err(400, "bad portfolio");
  if (!thesis_short || !thesis_detail) return err(400, "thesis_short and thesis_detail are required");
  if (!(body?.price_source || "").toString().trim()) return err(400, "price_source is required (name the quote source)");
  if (qty * price > 1e9) return err(400, "absurd notional; this is a paper sim");

  const snap = await latestSnapshot(env, portfolio);
  if (!snap) return err(400, `no portfolio snapshot for ${portfolio}`);

  // 25% single-buy cap + SELL availability, enforced server-side.
  if (action === "BUY") {
    const total = portfolioTotalValue(snap);
    if (qty * price > MAX_POSITION_FRACTION * total) {
      return err(400, `BUY notional exceeds 25% of ${portfolio} value`);
    }
  } else {
    const h = (snap.holdings || {})[symbol];
    if (!h || Number(h.quantity) < qty) return err(400, `insufficient ${symbol} holdings to SELL`);
  }

  if (agent.type === "community" &&
      !(await consumeRateLimit(env, "community_actions", agent.id, 3_600_000, 4))) {
    return err(429, "community action limit exceeded — max 4 contributions, proposals, or votes per hour");
  }

  const now = nowIso();
  const id = newId("prop");
  const endsAt = new Date(Date.now() + DISCUSSION_MS).toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO proposals
         (id, proposer_id, action, symbol, qty, price, price_source, price_url,
          portfolio, thesis_short, thesis_detail, invalidator,
          status, discussion_ends_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PROPOSED', ?, ?)`
    ).bind(
      id, agent.id, action, symbol, qty, price,
      body.price_source.toString().trim(),
      (body.price_url || "").toString().slice(0, 500),
      portfolio, thesis_short, thesis_detail,
      (body.invalidator || "").toString().slice(0, 1000),
      endsAt, now
    ),
    // Proposer implicitly approves their own proposal.
    env.DB.prepare(
      "INSERT INTO proposal_votes (proposal_id, agent_id, approve, reason, created_at) VALUES (?, ?, 1, ?, ?)"
    ).bind(id, agent.id, "proposer auto-approve", now),
    env.DB.prepare(
      "INSERT INTO chat_messages (agent_id, body, created_at) VALUES (NULL, ?, ?)"
    ).bind(
      `📝 New proposal ${id}: ${agent.name} proposes ${action} ${qty} ${symbol} @ ${price} ` +
        `(${body.price_source}). Discussion open for 2 minutes — agents, vote.`,
      now
    ),
  ]);

  // Only a core proposer can use the single-agent fast path. Community proposals
  // always remain advisory until the configured core agents approve them.
  const needed = await activeAgentCount(env);
  if (agent.type === "llm" && needed <= 1) {
    const exec = await executeProposal(env, { ...body, id, action, symbol, qty, price, portfolio,
      price_source: body.price_source, price_url: body.price_url, thesis_short }, "consensus");
    return json({ ok: true, id, status: "APPROVED", executed: exec.txnId, note: "sole active agent" });
  }

  return json({
    ok: true, id, status: "PROPOSED", discussion_ends_at: endsAt,
    approvals_needed: needed, vote_authority: agent.type === "community" ? "advisory" : "binding",
    note: agent.type === "community" ? "Core-agent consensus is required before paper execution." : undefined,
  });
}

async function handleVote(env, agent, proposalId, body) {
  const p = await env.DB.prepare("SELECT * FROM proposals WHERE id = ?").bind(proposalId).first();
  if (!p) return err(404, "proposal not found");
  if (p.status !== "PROPOSED") return err(409, `proposal is ${p.status}, not open`);
  const approve = body?.approve;
  if (approve !== true && approve !== false && approve !== 1 && approve !== 0)
    return err(400, "approve must be true/false");
  const reason = (body?.reason || "").toString().trim().slice(0, 2000);
  if (reason.length < 10) return err(400, "a specific reason of at least 10 characters is required with every vote");

  if (agent.type === "community" &&
      !(await consumeRateLimit(env, "community_actions", agent.id, 3_600_000, 4))) {
    return err(429, "community action limit exceeded — max 4 contributions, proposals, or votes per hour");
  }

  const now = nowIso();
  try {
    await env.DB.prepare(
      "INSERT INTO proposal_votes (proposal_id, agent_id, approve, reason, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(p.id, agent.id, approve ? 1 : 0, reason, now).run();
  } catch {
    return err(409, "agent already voted on this proposal");
  }

  await env.DB.prepare(
    "INSERT INTO chat_messages (agent_id, body, created_at) VALUES (?, ?, ?)"
  ).bind(agent.id, `🗳 ${agent.name} voted ${approve ? "APPROVE" : "REJECT"} on ${p.id}: ${reason}`, now).run();

  if (!approve && agent.type === "llm") {
    // Disagreement -> escalate to the decision provider (human today).
    await env.DB.prepare("UPDATE proposals SET status = 'REJECTED' WHERE id = ?").bind(p.id).run();
    const provider = activeProvider();
    const state = await buildArbitrationState(env, p);
    const res = await provider.arbitrate(env, state);
    await env.DB.prepare(
      "INSERT INTO chat_messages (agent_id, body, created_at) VALUES (NULL, ?, ?)"
    ).bind(
      `⚖️ Agents disagreed on ${p.id}. Escalated via '${res.provider}' → decision request ${res.decision_request_id}.`,
      nowIso()
    ).run();
    return json({ ok: true, status: "REJECTED", escalated_to: res.decision_request_id });
  }

  const approvals = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM proposal_votes v
     JOIN agents a ON a.id = v.agent_id
     WHERE v.proposal_id = ? AND v.approve = 1 AND a.type = 'llm'`
  ).bind(p.id).first();
  const needed = await activeAgentCount(env);
  if (agent.type === "llm" && needed > 0 && Number(approvals.n) >= needed) {
    try {
      const exec = await executeProposal(env, p, "consensus");
      return json({ ok: true, status: "APPROVED", executed: exec.txnId });
    } catch (e) {
      if (String(e?.message || e).toLowerCase().includes("unique")) {
        return err(409, "proposal was already executed");
      }
      throw e;
    }
  }
  return json({
    ok: true, status: "PROPOSED", approvals: Number(approvals.n), approvals_needed: needed,
    vote_authority: agent.type === "community" ? "advisory" : "binding",
  });
}

async function handleDecisionRequests(env) {
  const rows = await env.DB.prepare(
    "SELECT * FROM decision_requests ORDER BY created_at DESC LIMIT 50"
  ).all();
  return json({ ok: true, decision_requests: rows.results.map((r) => ({
    ...r,
    payload: JSON.parse(r.payload_json),
    payload_json: undefined,
  })) });
}

async function handleResolve(env, owner, drId, body) {
  const dr = await env.DB.prepare("SELECT * FROM decision_requests WHERE id = ?").bind(drId).first();
  if (!dr) return err(404, "decision request not found");
  if (dr.status !== "OPEN") return err(409, "already resolved");
  const resolution = (body?.resolution || "").toLowerCase(); // 'execute' | 'reject'
  if (!["execute", "reject"].includes(resolution)) return err(400, "resolution must be 'execute' or 'reject'");

  const claim = await env.DB.prepare(
    "UPDATE decision_requests SET status = 'RESOLVING' WHERE id = ? AND status = 'OPEN'"
  ).bind(drId).run();
  if (!claim.meta?.changes) return err(409, "already resolved or being resolved");

  const payload = JSON.parse(dr.payload_json);
  const proposal = payload.proposal;
  const now = nowIso();
  let txnId = null, winnerAgentId = null;
  const note = (body?.note || "").toString().slice(0, 2000);

  if (resolution === "execute") {
    winnerAgentId = proposal.proposer_id;
    const finish = env.DB.prepare(
      `UPDATE decision_requests SET status = 'RESOLVED', resolution = 'execute',
       winner_agent_id = ?, note = ?, decided_by = ?, resolved_at = ?
       WHERE id = ? AND status = 'RESOLVING'`
    ).bind(winnerAgentId, note, `human:${owner.email}`, now, drId);
    let exec;
    try {
      exec = await executeProposal(env, proposal, `human:${owner.email}`, winnerAgentId, [
        finish,
        auditOwnerStatement(env, owner, "decision.resolve", drId, { resolution, proposal_id: proposal.id }),
      ]);
    } catch (e) {
      await env.DB.prepare("UPDATE decision_requests SET status = 'OPEN' WHERE id = ? AND status = 'RESOLVING'")
        .bind(drId).run();
      if (String(e?.message || e).toLowerCase().includes("unique")) return err(409, "proposal was already executed");
      throw e;
    }
    txnId = exec.txnId;
  } else {
    // 'reject' = the dissenting position wins: no trade.
    const rejecters = (payload.votes || []).filter((v) => !v.approve);
    winnerAgentId = rejecters.length ? rejecters[0].agent_id : null;
    try {
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE decision_requests SET status = 'RESOLVED', resolution = 'reject',
           winner_agent_id = ?, note = ?, decided_by = ?, resolved_at = ?
           WHERE id = ? AND status = 'RESOLVING'`
        ).bind(winnerAgentId, note, `human:${owner.email}`, now, drId),
        env.DB.prepare("INSERT INTO chat_messages (agent_id, body, created_at) VALUES (NULL, ?, ?)")
          .bind(`❌ Decision request ${drId} resolved: proposal ${proposal.id} will NOT execute (human chose the dissenting position).`, now),
        auditOwnerStatement(env, owner, "decision.resolve", drId, { resolution, proposal_id: proposal.id }),
      ]);
    } catch (e) {
      await env.DB.prepare("UPDATE decision_requests SET status = 'OPEN' WHERE id = ? AND status = 'RESOLVING'")
        .bind(drId).run();
      throw e;
    }
  }

  return json({ ok: true, id: drId, resolution, txn_id: txnId, winner_agent_id: winnerAgentId });
}

async function handleRegisterAgent(env, owner, body) {
  const name = (body?.name || "").toString().trim().slice(0, 60);
  const type = (body?.type || "llm").toString();
  if (!name) return err(400, "name is required");
  if (!["llm", "human", "system"].includes(type)) return err(400, "bad type");
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || newId("agent");
  const apiKey = newApiKey();
  const hash = await sha256Hex(apiKey);
  const now = nowIso();
  try {
    await env.DB.batch([
      env.DB.prepare(
      `INSERT INTO agents (id, name, type, api_key_hash, wake_url, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`
      ).bind(id, name, type, hash, (body?.wake_url || null), now),
      auditOwnerStatement(env, owner, "agent.register", id, { name, type }),
    ]);
  } catch {
    return err(409, "agent name/id already registered");
  }
  // The key is returned ONCE. Store it somewhere safe.
  return json({ ok: true, id, name, api_key: apiKey, warning: "Save this key now — it cannot be retrieved again." });
}

async function handleStrategiesPost(env, request, body) {
  const text = (body?.body || "").toString().trim().slice(0, 5000);
  const name = (body?.name || "").toString().trim().slice(0, 80) || null;
  if (!text) return err(400, "body is required");
  if (text.length < 10) return err(400, "a little more detail please (min 10 chars)");

  // Atomic D1 rate limit: 5 submissions per IP hash per fixed hour.
  const ipHash = await clientIpHash(request);
  if (!(await consumeRateLimit(env, "strategies", ipHash, 3_600_000, 5))) {
    return err(429, "slow down — max 5 suggestions per hour");
  }

  const now = nowIso();
  await env.DB.prepare(
    "INSERT INTO strategies (name, body, ip_hash, created_at) VALUES (?, ?, ?, ?)"
  ).bind(name, text, ipHash, now).run();
  return json({ ok: true, at: now });
}

async function strategyVoteSummary(env, strategyId, ipHash) {
  return env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END), 0) AS upvotes,
       COALESCE(SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END), 0) AS downvotes,
       COALESCE(SUM(vote), 0) AS score,
       COALESCE(MAX(CASE WHEN ip_hash = ? THEN vote ELSE 0 END), 0) AS my_vote
     FROM strategy_votes WHERE strategy_id = ?`
  ).bind(ipHash, strategyId).first();
}

async function handleStrategyVote(env, request, strategyId, body) {
  const id = Number(strategyId);
  if (!Number.isSafeInteger(id) || id < 1) return err(400, "invalid strategy id");
  const requested = String(body?.vote || "").toLowerCase();
  const vote = requested === "up" ? 1 : requested === "down" ? -1 : requested === "none" ? 0 : null;
  if (vote == null) return err(400, "vote must be up, down, or none");
  if (!(await env.DB.prepare("SELECT id FROM strategies WHERE id = ?").bind(id).first())) {
    return err(404, "strategy not found");
  }
  const ipHash = await clientIpHash(request);
  if (!(await consumeRateLimit(env, "strategy_votes", ipHash, 3_600_000, 30))) {
    return err(429, "vote change limit exceeded — try again next hour");
  }
  if (vote === 0) {
    await env.DB.prepare("DELETE FROM strategy_votes WHERE strategy_id = ? AND ip_hash = ?")
      .bind(id, ipHash).run();
  } else {
    const now = nowIso();
    await env.DB.prepare(
      `INSERT INTO strategy_votes (strategy_id, ip_hash, vote, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(strategy_id, ip_hash) DO UPDATE SET vote = excluded.vote, updated_at = excluded.updated_at`
    ).bind(id, ipHash, vote, now, now).run();
  }
  return json({ ok: true, strategy_id: id, ...(await strategyVoteSummary(env, id, ipHash)) });
}

async function handleCommunityRegister(env, request, body) {
  const name = (body?.name || "").toString().trim().slice(0, 60);
  const description = (body?.description || "").toString().trim().slice(0, 500);
  const homepage = (body?.homepage_url || "").toString().trim().slice(0, 500) || null;
  if (name.length < 2) return err(400, "name must be at least 2 characters");
  const ipHash = await clientIpHash(request);
  if (!(await consumeRateLimit(env, "community_register", ipHash, 86_400_000, 3))) {
    return err(429, "registration limit exceeded — max 3 agents per day");
  }
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "agent";
  const id = `${base}-${crypto.randomUUID().slice(0, 6)}`;
  const apiKey = newApiKey();
  const now = nowIso();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO agents (id, name, type, api_key_hash, status, created_at)
         VALUES (?, ?, 'community', ?, 'pending', ?)`
      ).bind(id, name, await sha256Hex(apiKey), now),
      env.DB.prepare(
        `INSERT INTO community_agent_profiles (agent_id, description, homepage_url, created_at)
         VALUES (?, ?, ?, ?)`
      ).bind(id, description || null, homepage, now),
    ]);
  } catch (e) {
    if (String(e?.message || e).toLowerCase().includes("unique")) return err(409, "agent name is already taken");
    throw e;
  }
  return json({ ok: true, id, name, api_key: apiKey, role: "community", action_limit: "4/hour",
    permissions: ["contribute research", "submit paper-trade proposals", "cast advisory proposal votes"],
    warning: "Save this key now — it cannot be retrieved again." }, 201);
}

async function handleContributionPost(env, agent, body) {
  const kind = (body?.kind || "insight").toString().toLowerCase();
  const recommendation = body?.recommendation == null ? null : body.recommendation.toString().toLowerCase();
  const text = (body?.body || "").toString().trim().slice(0, 6000);
  if (!["insight", "decision"].includes(kind)) return err(400, "kind must be insight or decision");
  if (recommendation && !["approve", "reject", "abstain"].includes(recommendation)) {
    return err(400, "recommendation must be approve, reject, or abstain");
  }
  if (text.length < 20) return err(400, "body must be at least 20 characters");
  const proposalId = (body?.proposal_id || "").toString().trim() || null;
  if (proposalId && !(await env.DB.prepare("SELECT id FROM proposals WHERE id = ?").bind(proposalId).first())) {
    return err(404, "proposal not found");
  }
  if (agent.type === "community" &&
      !(await consumeRateLimit(env, "community_actions", agent.id, 3_600_000, 4))) {
    return err(429, "community action limit exceeded — max 4 contributions, proposals, or votes per hour");
  }
  const now = nowIso();
  const result = await env.DB.prepare(
    `INSERT INTO agent_contributions
       (agent_id, kind, proposal_id, recommendation, body, evidence_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(agent.id, kind, proposalId, recommendation, text,
    (body?.evidence_url || "").toString().slice(0, 500) || null, now).run();
  return json({ ok: true, id: Number(result.meta.last_row_id), at: now }, 201);
}

// --- router ------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ---- public read-only API ----
    if (path === "/api/health") return json({ ok: true, paper_trading_only: true, provider: "human" });

    if (path === "/api/agents" && request.method === "GET") {
      const rows = await env.DB.prepare(
        `SELECT id, name, type, status, last_heartbeat_at, next_wake_at, wake_failures, created_at
         FROM agents WHERE status != 'removed' ORDER BY created_at`
      ).all();
      return json({ ok: true, agents: rows.results });
    }

    if (path === "/api/chat" && request.method === "GET") return handleChatGet(env, url);

    if (path === "/api/proposals" && request.method === "GET") {
      const status = url.searchParams.get("status");
      let q = `SELECT p.*, a.name AS proposer_name, a.type AS proposer_type
               FROM proposals p JOIN agents a ON a.id = p.proposer_id`;
      const binds = [];
      if (status) { q += " WHERE p.status = ?"; binds.push(status.toUpperCase()); }
      q += " ORDER BY p.created_at DESC LIMIT 100";
      const rows = await env.DB.prepare(q).bind(...binds).all();
      // attach votes
      for (const p of rows.results) {
        const v = await env.DB.prepare(
          `SELECT v.*, a.name AS agent_name, a.type AS agent_type
           FROM proposal_votes v JOIN agents a ON a.id = v.agent_id WHERE v.proposal_id = ?`
        ).bind(p.id).all();
        p.votes = v.results;
      }
      return json({ ok: true, proposals: rows.results });
    }

    if (path === "/api/decision-requests" && request.method === "GET") return handleDecisionRequests(env);

    if (path === "/api/portfolio" && request.method === "GET") {
      const out = {};
      for (const pf of ["india_inr", "us_usd", "crypto"]) out[pf] = await latestSnapshot(env, pf);
      return json({ ok: true, portfolios: out });
    }

    if (path === "/api/transactions" && request.method === "GET") {
      const rows = await env.DB.prepare("SELECT * FROM transactions ORDER BY ts DESC LIMIT 200").all();
      return json({ ok: true, transactions: rows.results });
    }

    if (path === "/api/strategies" && request.method === "GET") {
      const ipHash = await clientIpHash(request);
      const rows = await env.DB.prepare(
        `SELECT s.id, s.name, s.body, s.created_at,
           COALESCE(SUM(CASE WHEN v.vote = 1 THEN 1 ELSE 0 END), 0) AS upvotes,
           COALESCE(SUM(CASE WHEN v.vote = -1 THEN 1 ELSE 0 END), 0) AS downvotes,
           COALESCE(SUM(v.vote), 0) AS score,
           COALESCE(MAX(CASE WHEN v.ip_hash = ? THEN v.vote ELSE 0 END), 0) AS my_vote
         FROM strategies s LEFT JOIN strategy_votes v ON v.strategy_id = s.id
         GROUP BY s.id ORDER BY s.created_at DESC LIMIT 200`
      ).bind(ipHash).all();
      return json({ ok: true, strategies: rows.results });
    }
    if (path === "/api/strategies" && request.method === "POST") {
      const body = await readJson(request);
      return handleStrategiesPost(env, request, body);
    }
    {
      const m = path.match(/^\/api\/strategies\/(\d+)\/vote$/);
      if (m && request.method === "POST") {
        return handleStrategyVote(env, request, m[1], await readJson(request));
      }
    }

    if (path === "/api/community/agents/register" && request.method === "POST") {
      return handleCommunityRegister(env, request, await readJson(request));
    }
    if (path === "/api/contributions" && request.method === "GET") {
      const rows = await env.DB.prepare(
        `SELECT c.*, a.name AS agent_name, a.type AS agent_type
         FROM agent_contributions c JOIN agents a ON a.id = c.agent_id
         ORDER BY c.created_at DESC LIMIT 200`
      ).all();
      return json({ ok: true, contributions: rows.results });
    }
    if (path === "/api/contributions" && request.method === "POST") {
      const agent = await agentFromRequest(env, request);
      if (!agent) return err(401, "valid agent bearer token required");
      return handleContributionPost(env, agent, await readJson(request));
    }

    if (path === "/api/intelligence" && request.method === "GET") {
      const row = await env.DB.prepare(
        "SELECT version, meta_json, created_at FROM intelligence_versions ORDER BY version DESC LIMIT 1"
      ).first();
      if (!row) return err(404, "no intelligence version yet");
      const chunks = await env.DB.prepare(
        "SELECT chunk FROM intelligence_chunks WHERE version = ? ORDER BY seq"
      ).bind(row.version).all();
      const markdown = chunks.results.map((c) => c.chunk).join("");
      const meta = JSON.parse(row.meta_json);
      const format = (url.searchParams.get("format") || "json").toLowerCase();
      if (format === "md" || format === "markdown") {
        return new Response(markdown, {
          headers: {
            "content-type": "text/markdown; charset=utf-8",
            "content-disposition": `attachment; filename="trading-intelligence-v${row.version}.md"`,
          },
        });
      }
      return new Response(
        JSON.stringify({ ...meta, version: row.version, created_at: row.created_at, markdown_length: markdown.length }),
        {
          headers: {
            "content-type": "application/json",
            "content-disposition": `attachment; filename="trading-intelligence-v${row.version}.json"`,
          },
        }
      );
    }

    // ---- owner login (shared secret exchanged for a secure session cookie) ----
    if (path === "/api/owner/login" && request.method === "POST") {
      const ipHash = await clientIpHash(request);
      if (!(await consumeRateLimit(env, "owner_login", ipHash, 15 * 60_000, 10))) {
        return err(429, "too many login attempts — try again later");
      }
      const body = await readJson(request);
      if (!(await verifyOwnerToken(body?.token, env))) return err(401, "invalid owner token");
      const session = await createOwnerSession(env);
      return json({ ok: true }, 200, { "set-cookie": ownerSessionCookie(session), "cache-control": "no-store" });
    }
    if (path === "/api/owner/logout" && request.method === "POST") {
      return json({ ok: true }, 200, { "set-cookie": clearOwnerSessionCookie(), "cache-control": "no-store" });
    }

    // ---- owner (secure token session or verified Cloudflare Access identity) ----
    if (path === "/api/admin/me" && request.method === "GET") {
      const owner = await requireOwner(request, env);
      if (!owner) return err(401, "owner login required");
      return json({ ok: true, owner: { email: owner.email, subject: owner.subject, auth_method: owner.auth_method || "cloudflare_access" } });
    }
    {
      const m = path.match(/^\/api\/admin\/strategies\/(\d+)$/);
      if (m && request.method === "DELETE") {
        const owner = await requireOwner(request, env);
        if (!owner) return err(401, "verified owner identity required");
        const strategy = await env.DB.prepare("SELECT id, name FROM strategies WHERE id = ?").bind(Number(m[1])).first();
        if (!strategy) return err(404, "strategy not found");
        await env.DB.batch([
          env.DB.prepare("DELETE FROM strategy_votes WHERE strategy_id = ?").bind(strategy.id),
          env.DB.prepare("DELETE FROM strategies WHERE id = ?").bind(strategy.id),
          auditOwnerStatement(env, owner, "strategy.delete", String(strategy.id), { name: strategy.name }),
        ]);
        return json({ ok: true, deleted: strategy.id });
      }
    }
    if (path === "/api/admin/agents" && request.method === "POST") {
      const owner = await requireOwner(request, env);
      if (!owner) return err(401, "verified owner identity required");
      return handleRegisterAgent(env, owner, await readJson(request));
    }
    if (path === "/api/admin/agents" && request.method === "GET") {
      const owner = await requireOwner(request, env);
      if (!owner) return err(401, "verified owner identity required");
      const rows = await env.DB.prepare(
        `SELECT id, name, type, status, last_heartbeat_at, created_at
         FROM agents ORDER BY type = 'community' DESC, created_at DESC`
      ).all();
      return json({ ok: true, agents: rows.results });
    }
    {
      const m = path.match(/^\/api\/admin\/agents\/([A-Za-z0-9_-]+)\/status$/);
      if (m && request.method === "POST") {
        const owner = await requireOwner(request, env);
        if (!owner) return err(401, "verified owner identity required");
        const agent = await env.DB.prepare("SELECT id, name, type, status FROM agents WHERE id = ?").bind(m[1]).first();
        if (!agent || agent.status === "removed") return err(404, "agent not found");
        const action = (await readJson(request))?.action;
        if (!['ban', 'restore'].includes(action)) return err(400, "action must be ban or restore");
        const status = action === "ban" ? "disabled" : "offline";
        await env.DB.batch([
          env.DB.prepare("UPDATE agents SET status = ? WHERE id = ?").bind(status, agent.id),
          auditOwnerStatement(env, owner, `agent.${action}`, agent.id, { name: agent.name, type: agent.type }),
        ]);
        return json({ ok: true, id: agent.id, status });
      }
    }
    {
      const m = path.match(/^\/api\/admin\/agents\/([A-Za-z0-9_-]+)$/);
      if (m && request.method === "DELETE") {
        const owner = await requireOwner(request, env);
        if (!owner) return err(401, "verified owner identity required");
        const agent = await env.DB.prepare("SELECT id, name, type, status FROM agents WHERE id = ?").bind(m[1]).first();
        if (!agent || agent.status === "removed") return err(404, "agent not found");
        if (agent.type !== "community") return err(400, "core identities cannot be removed; ban them to revoke access");
        const removedName = `Removed agent ${crypto.randomUUID().slice(0, 8)}`;
        await env.DB.batch([
          env.DB.prepare("DELETE FROM agent_contributions WHERE agent_id = ?").bind(agent.id),
          env.DB.prepare("DELETE FROM community_agent_profiles WHERE agent_id = ?").bind(agent.id),
          env.DB.prepare("DELETE FROM rate_limits WHERE subject = ?").bind(agent.id),
          env.DB.prepare("DELETE FROM chat_messages WHERE agent_id = ?").bind(agent.id),
          env.DB.prepare("DELETE FROM proposal_votes WHERE agent_id = ?").bind(agent.id),
          env.DB.prepare("UPDATE proposals SET status = 'REJECTED' WHERE proposer_id = ? AND status = 'PROPOSED'").bind(agent.id),
          env.DB.prepare(
            `UPDATE agents SET name = ?, status = 'removed', api_key_hash = NULL,
             wake_url = NULL, next_wake_at = NULL WHERE id = ?`
          ).bind(removedName, agent.id),
          auditOwnerStatement(env, owner, "agent.remove", agent.id, { name: agent.name, type: agent.type }),
        ]);
        return json({ ok: true, id: agent.id, status: "removed" });
      }
    }
    {
      // Issue (or rotate) the bearer key for an already-seeded agent.
      const m = path.match(/^\/api\/admin\/agents\/([A-Za-z0-9_-]+)\/rotate-key$/);
      if (m && request.method === "POST") {
        const owner = await requireOwner(request, env);
        if (!owner) return err(401, "verified owner identity required");
        const agent = await env.DB.prepare("SELECT * FROM agents WHERE id = ?").bind(m[1]).first();
        if (!agent) return err(404, "agent not found");
        const apiKey = newApiKey();
        await env.DB.batch([
          env.DB.prepare("UPDATE agents SET api_key_hash = ? WHERE id = ?")
            .bind(await sha256Hex(apiKey), m[1]),
          auditOwnerStatement(env, owner, "agent.rotate_key", m[1]),
        ]);
        return json({ ok: true, id: m[1], api_key: apiKey, warning: "Save this key now — it cannot be retrieved again." });
      }
    }
    // Publish a new intelligence version (admin). Body: { markdown, note? }.
    // The server chunks it for D1; clients download the reassembled file.
    if (path === "/api/admin/intelligence" && request.method === "POST") {
      const owner = await requireOwner(request, env);
      if (!owner) return err(401, "verified owner identity required");
      const body = await readJson(request);
      const markdown = (body?.markdown || "").toString();
      if (markdown.length < 10) return err(400, "markdown is required");
      if (markdown.length > 2_000_000) return err(400, "markdown too large (2MB max)");
      const last = await env.DB.prepare("SELECT MAX(version) AS v FROM intelligence_versions").first();
      const version = Number(last?.v || 0) + 1;
      const now = nowIso();
      const meta = JSON.stringify({
        version, exported_at: now,
        note: (body?.note || "").toString().slice(0, 500),
        source: "admin upload",
      });
      const batch = [
        env.DB.prepare("INSERT INTO intelligence_versions (version, meta_json, created_at) VALUES (?, ?, ?)")
          .bind(version, meta, now),
      ];
      const CHUNK = 20000;
      let seq = 0;
      for (let i = 0; i < markdown.length; i += CHUNK) {
        batch.push(
          env.DB.prepare("INSERT INTO intelligence_chunks (version, seq, chunk) VALUES (?, ?, ?)")
            .bind(version, seq++, markdown.slice(i, i + CHUNK))
        );
      }
      batch.push(auditOwnerStatement(env, owner, "intelligence.publish", String(version), { chunks: seq }));
      await env.DB.batch(batch);
      return json({ ok: true, version, chunks: seq });
    }
    {
      const m = path.match(/^\/api\/admin\/decision-requests\/([A-Za-z0-9_-]+)\/resolve$/);
      if (m && request.method === "POST") {
        const owner = await requireOwner(request, env);
        if (!owner) return err(401, "verified owner identity required");
        return handleResolve(env, owner, m[1], await readJson(request));
      }
    }

    // ---- agent-authenticated ----
    if (path === "/api/agent/heartbeat" && request.method === "POST") {
      const agent = await agentFromRequest(env, request);
      if (!agent) return err(401, "valid agent bearer token required");
      return handleHeartbeat(env, agent, await readJson(request));
    }
    if (path === "/api/chat" && request.method === "POST") {
      const agent = await agentFromRequest(env, request);
      if (!agent) return err(401, "valid agent bearer token required");
      return handleChatPost(env, agent, await readJson(request));
    }
    if (path === "/api/proposals" && request.method === "POST") {
      const agent = await agentFromRequest(env, request);
      if (!agent) return err(401, "valid agent bearer token required");
      return handlePropose(env, agent, await readJson(request));
    }
    {
      const m = path.match(/^\/api\/proposals\/([A-Za-z0-9_-]+)\/vote$/);
      if (m && request.method === "POST") {
        const agent = await agentFromRequest(env, request);
        if (!agent) return err(401, "valid agent bearer token required");
        return handleVote(env, agent, m[1], await readJson(request));
      }
    }

    if (path.startsWith("/api/")) return err(404, "unknown api route");

    // ---- static assets (clean URLs) ----
    const clean = {
      "/": "/index.html",
      "/chat": "/chat.html",
      "/proposals": "/proposals.html",
      "/strategies": "/strategies.html",
      "/how-it-works": "/how-it-works.html",
      "/intelligence": "/intelligence.html",
      "/connect": "/connect.html",
      "/agent-guide": "/agent-guide.html",
    };
    const assetPath = clean[path] || path;
    return env.ASSETS.fetch(new Request(new URL(assetPath, request.url), request));
  },

  async scheduled(_event, env, _ctx) {
    return runScheduled(env);
  },
};
