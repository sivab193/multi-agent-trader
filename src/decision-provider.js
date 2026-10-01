// Decision-provider abstraction.
//
// The portal separates DEBATE (LLM agents argue in the chat room, in natural
// language) from DECISION (a typed, auditable arbitration step).
//
// ACTIVE PROVIDER TODAY: 'human'
//   Contested or expired proposals become decision_requests that Sivaganesh
//   resolves in /proposals by picking the winning agent's position.
//
// COMING SOON: 'jev' and 'laya'
//   - jev:  TypeSafe's Jev "System One" decision model (hosted API). Feed it the
//           debate state + a typed Choice question ("whose position: A / B / no-trade?")
//           and it returns a calibrated pick with a probability.
//   - laya: the open-weight System-1 decision model, run locally next to the
//           portal ($0, fully private) behind the same {state, questions} contract.
//   Both stubs below are INTENTIONALLY unwired: they throw if called. Wiring
//   them is a future task once API access exists. NEVER silently fall through
//   to a stub.

export const ACTIVE_PROVIDER = "human";

function requireHuman() {
  if (ACTIVE_PROVIDER !== "human") {
    throw new Error(`Unknown active decision provider: ${ACTIVE_PROVIDER}`);
  }
}

function newId(prefix) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  const rand = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  return `${prefix}_${stamp}_${rand}`;
}

// Build the arbitration state snapshot: proposal + votes + recent chat excerpt.
export async function buildArbitrationState(env, proposal) {
  const votes = await env.DB.prepare(
    `SELECT v.*, a.name AS agent_name FROM proposal_votes v
     JOIN agents a ON a.id = v.agent_id
     WHERE v.proposal_id = ? ORDER BY v.created_at`
  ).bind(proposal.id).all();
  const chat = await env.DB.prepare(
    `SELECT m.id, m.body, m.created_at, COALESCE(a.name, 'system') AS agent_name
     FROM chat_messages m LEFT JOIN agents a ON a.id = m.agent_id
     ORDER BY m.id DESC LIMIT 20`
  ).all();
  const proposer = await env.DB.prepare("SELECT id, name FROM agents WHERE id = ?")
    .bind(proposal.proposer_id).first();
  return {
    proposal,
    proposer,
    votes: votes.results,
    chat_excerpt: [...chat.results].reverse(), // chronological
  };
}

export const providers = {
  human: {
    name: "human",
    description:
      "Creates a decision_request for Sivaganesh to resolve by picking the winning agent's position.",
    async arbitrate(env, state) {
      requireHuman();
      const id = newId("dr");
      const now = new Date().toISOString();
      const inserted = await env.DB.prepare(
        `INSERT INTO decision_requests
           (id, proposal_id, payload_json, status, decided_by, created_at)
         VALUES (?, ?, ?, 'OPEN', 'human', ?)
         ON CONFLICT(proposal_id) DO NOTHING
         RETURNING id`
      ).bind(id, state.proposal.id, JSON.stringify(state), now).first();
      const decisionId = inserted?.id || (await env.DB.prepare(
        "SELECT id FROM decision_requests WHERE proposal_id = ?"
      ).bind(state.proposal.id).first())?.id;
      return { choice: "deferred", provider: "human", decision_request_id: decisionId };
    },
  },

  // ---------------------------------------------------------------------------
  // COMING SOON — do not wire until API access exists. These throw on purpose.
  // ---------------------------------------------------------------------------

  // TODO(jev): wire TypeSafe Jev once an API key is available.
  //   1. `wrangler secret put JEV_API_KEY`
  //   2. POST https://api.typesafe.ai/v1/decide (confirm endpoint in their docs)
  //      body: { state: <arbitration state JSON>, questions: [
  //        { id: "winner", type: "Choice",
  //          options: ["proposal_A", "proposal_B", "no_trade"] } ] }
  //   3. Map the returned choice + probability to { choice, confidence, provider: 'jev' },
  //      persist the probability on the decision_request, execute on high confidence,
  //      escalate to human when the distribution is flat (top prob < ~0.6).
  jev: {
    name: "jev",
    description: "COMING SOON — TypeSafe Jev decision model arbitration. Not wired.",
    async arbitrate(_env, _state) {
      throw new Error(
        "jev provider is COMING SOON and not wired: no API access yet. Kept as 'human'."
      );
    },
  },

  // TODO(laya): wire the local Laya System-1 model once it is running.
  //   1. Run the open-weight Laya server next to the portal
  //      (e.g. `python -m laya serve --port 8770`, or a sidecar Worker).
  //   2. POST http://127.0.0.1:8770/v1/system-one (or the sidecar URL)
  //      body: { state: <arbitration state JSON>,
  //              questions: [{ id: "winner", ...same Choice shape as jev... }] }
  //      NOTE: plain calls without `questions` fail by design (400 laya_questions_missing).
  //   3. Same confidence policy as jev: execute on high confidence, escalate to
  //      human on flat distributions. $0 per call, fully private.
  laya: {
    name: "laya",
    description: "COMING SOON — local Laya decision-model arbitration. Not wired.",
    async arbitrate(_env, _state) {
      throw new Error(
        "laya provider is COMING SOON and not wired: no local model running yet. Kept as 'human'."
      );
    },
  },
};

export function activeProvider() {
  const p = providers[ACTIVE_PROVIDER];
  if (!p) throw new Error(`Active provider '${ACTIVE_PROVIDER}' is not implemented`);
  return p;
}
