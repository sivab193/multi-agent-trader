// Every-minute cron jobs:
//   1. Close PROPOSED proposals whose 2-minute discussion window expired ->
//      mark EXPIRED and escalate to the active decision provider (human today).
//   2. Best-effort wake nudges: POST a wake payload to agents whose next_wake_at
//      is due and that registered a wake_url. Agents that cannot receive
//      inbound HTTP (most LLM agents) rely on their own poll loop instead —
//      the portal can only nudge, never truly wake, those.

import { activeProvider, buildArbitrationState } from "./decision-provider.js";

async function systemChat(env, body) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO chat_messages (agent_id, body, created_at) VALUES (NULL, ?, ?)"
  ).bind(body, now).run();
}

async function logWake(env, agent, success, statusCode, detail) {
  await env.DB.prepare(
    `INSERT INTO agent_activity_log
       (event_type, agent_id, agent_name, endpoint, success, status_code, detail, created_at)
     VALUES ('wake', ?, ?, 'wake_url', ?, ?, ?, ?)`
  ).bind(agent.id, agent.name, success ? 1 : 0, statusCode, detail.slice(0, 300), new Date().toISOString()).run();
}

async function expireDiscussions(env, now) {
  const expired = await env.DB.prepare(
    "SELECT * FROM proposals WHERE status = 'PROPOSED' AND discussion_ends_at <= ?"
  ).bind(now).all();

  const provider = activeProvider();
  let escalated = 0;
  for (const p of expired.results) {
    const claimed = await env.DB.prepare("UPDATE proposals SET status = 'EXPIRED' WHERE id = ? AND status = 'PROPOSED'")
      .bind(p.id).run();
    if (!claimed.meta?.changes) continue;
    const state = await buildArbitrationState(env, p);
    const res = await provider.arbitrate(env, state);
    await systemChat(
      env,
      `⏱ Discussion window (2 min) expired for proposal ${p.id} (${p.action} ${p.qty} ${p.symbol} @ ${p.price}). ` +
        `Escalated via '${res.provider}' → decision request ${res.decision_request_id}.`
    );
    escalated++;
  }
  return escalated;
}

async function wakeDueAgents(env, now) {
  // Only attempt each agent at most once per minute to avoid hammering.
  const oneMinAgo = new Date(Date.now() - 60_000).toISOString();
  const due = await env.DB.prepare(
    `SELECT id, name, wake_url FROM agents
     WHERE wake_url IS NOT NULL AND next_wake_at IS NOT NULL AND next_wake_at <= ?
       AND status NOT IN ('disabled', 'paused', 'removed')
       AND (last_wake_attempt_at IS NULL OR last_wake_attempt_at <= ?)`
  ).bind(now, oneMinAgo).all();

  let attempted = 0, failed = 0;
  for (const a of due.results) {
    attempted++;
    try {
      const res = await fetch(a.wake_url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "wake",
          agent_id: a.id,
          at: now,
          portal: "mat.siv19.dev",
          message: "Your declared next_wake_at is due. Poll /api/chat and /api/proposals.",
        }),
        // Don't let a hung agent webhook stall the cron.
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`wake_url responded ${res.status}`);
      await env.DB.prepare(
        "UPDATE agents SET last_wake_attempt_at = ?, wake_failures = 0 WHERE id = ?"
      ).bind(now, a.id).run();
      await logWake(env, a, true, res.status, "scheduled wake webhook accepted");
    } catch (e) {
      failed++;
      await env.DB.prepare(
        "UPDATE agents SET last_wake_attempt_at = ?, wake_failures = wake_failures + 1 WHERE id = ?"
      ).bind(now, a.id).run();
      await logWake(env, a, false, null, String(e && e.message || e));
      await systemChat(env, `⚠️ Wake nudge to ${a.name} failed (${String(e && e.message || e)}). It stays on its own poll loop.`);
    }
  }
  return { attempted, failed };
}

export async function runScheduled(env) {
  const now = new Date().toISOString();
  const escalated = await expireDiscussions(env, now);
  const wake = await wakeDueAgents(env, now);
  await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?")
    .bind(Date.now() - 7_200_000).run();
  await env.DB.prepare("DELETE FROM agent_activity_log WHERE created_at < ?")
    .bind(new Date(Date.now() - 30 * 86_400_000).toISOString()).run();
  await env.DB.prepare("DELETE FROM api_request_log WHERE created_at < ?")
    .bind(new Date(Date.now() - 30 * 86_400_000).toISOString()).run();
  return { at: now, discussions_escalated: escalated, wake_attempted: wake.attempted, wake_failed: wake.failed };
}
