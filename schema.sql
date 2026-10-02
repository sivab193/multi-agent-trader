-- Multi Agent Trader (mat.siv19.dev) — D1 schema
-- PAPER TRADING ONLY. There is intentionally no table, column, or code path
-- for broker credentials, real-money balances, or order routing.

-- Registered agents (LLM agents like Muse/Instinct, plus system/human rows).
CREATE TABLE IF NOT EXISTS agents (
  id                   TEXT PRIMARY KEY,            -- e.g. 'muse', 'instinct'
  name                 TEXT NOT NULL UNIQUE,        -- display name
  type                 TEXT NOT NULL,               -- 'llm' core | 'community' advisory | human | system
  api_key_hash         TEXT,                        -- SHA-256 hex of bearer key; NULL until issued
  wake_url             TEXT,                        -- optional inbound webhook; portal POSTs wake payloads here
  last_heartbeat_at    TEXT,
  next_wake_at         TEXT,                        -- agent-declared; portal displays it and may nudge via wake_url
  last_wake_attempt_at TEXT,
  wake_failures        INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'pending', -- pending|online|offline|disabled
  created_at           TEXT NOT NULL
);

-- Agent chat room (append-only). agent_id NULL = system message.
CREATE TABLE IF NOT EXISTS chat_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT REFERENCES agents(id),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_created ON chat_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_id ON chat_messages(id);

-- Trade proposals. A proposal needs approval from EVERY active agent
-- (agents with an issued key and status != 'disabled').
-- discussion_ends_at = created_at + 120 seconds. Any explicit reject, or the
-- 2-minute window expiring, escalates to a decision_request (human decides).
CREATE TABLE IF NOT EXISTS proposals (
  id                TEXT PRIMARY KEY,              -- e.g. 'prop_20261001_001'
  proposer_id       TEXT NOT NULL REFERENCES agents(id),
  action            TEXT NOT NULL,                 -- BUY | SELL
  symbol            TEXT NOT NULL,
  qty               REAL NOT NULL,
  price             REAL NOT NULL,                 -- frozen execution quote
  price_source      TEXT NOT NULL,                 -- e.g. 'finnhub.io HILINFRA.NS live quote'
  price_url         TEXT,                          -- source URL for verification
  portfolio         TEXT NOT NULL DEFAULT 'india_inr', -- india_inr | us_usd | crypto
  thesis_short      TEXT NOT NULL,                 -- 1 sentence
  thesis_detail     TEXT NOT NULL,                 -- 2-4 paragraphs
  invalidator       TEXT,                          -- what would invalidate the thesis
  status            TEXT NOT NULL DEFAULT 'PROPOSED', -- PROPOSED|APPROVED|REJECTED|EXPIRED
  discussion_ends_at TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);

CREATE TABLE IF NOT EXISTS proposal_votes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  approve     INTEGER NOT NULL,                    -- 1 = approve, 0 = reject
  reason      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(proposal_id, agent_id)
);

-- Human decision inbox. Created when agents disagree or the 2-minute window
-- lapses. Sivaganesh picks the winning position (execute the proposal, or not).
-- COMING SOON: the 'jev'/'laya' decision models arbitrate here instead.
CREATE TABLE IF NOT EXISTS decision_requests (
  id              TEXT PRIMARY KEY,                -- e.g. 'dr_20261001_001'
  proposal_id     TEXT NOT NULL REFERENCES proposals(id),
  payload_json    TEXT NOT NULL,                   -- proposal + votes + chat excerpt snapshot
  status          TEXT NOT NULL DEFAULT 'OPEN',    -- OPEN | RESOLVING | RESOLVED
  resolution      TEXT,                            -- 'execute' | 'reject'
  winner_agent_id TEXT REFERENCES agents(id),      -- whose position won
  decided_by      TEXT NOT NULL DEFAULT 'human',   -- 'human' today; 'jev'/'laya' COMING SOON
  note            TEXT,
  created_at      TEXT NOT NULL,
  resolved_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_dr_status ON decision_requests(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dr_proposal_unique ON decision_requests(proposal_id);

-- Paper-trade ledger (mirror of the original all_transactions.csv).
CREATE TABLE IF NOT EXISTS transactions (
  id             TEXT PRIMARY KEY,                  -- e.g. 'txn_001'
  ts             TEXT NOT NULL,
  portfolio      TEXT NOT NULL,                     -- india_inr | us_usd | crypto
  action         TEXT NOT NULL,                     -- BUY | SELL
  symbol         TEXT NOT NULL,
  qty            REAL NOT NULL,
  price          REAL NOT NULL,
  currency       TEXT NOT NULL,                     -- INR | USD
  value          REAL NOT NULL,
  price_source   TEXT,
  price_url      TEXT,
  justification  TEXT,
  decided_by     TEXT NOT NULL DEFAULT 'consensus', -- 'consensus' | 'human'
  proposal_id    TEXT REFERENCES proposals(id)
);
CREATE INDEX IF NOT EXISTS idx_txn_ts ON transactions(ts);
CREATE UNIQUE INDEX IF NOT EXISTS idx_txn_proposal_unique ON transactions(proposal_id);

-- Immutable audit trail for every privileged human action.
CREATE TABLE IF NOT EXISTS admin_audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_email   TEXT NOT NULL,
  actor_subject TEXT,
  action        TEXT NOT NULL,
  target        TEXT,
  detail_json   TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit(created_at);

-- Public community agents contribute research without execution authority.
CREATE TABLE IF NOT EXISTS community_agent_profiles (
  agent_id      TEXT PRIMARY KEY REFERENCES agents(id),
  description   TEXT,
  homepage_url  TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_contributions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  kind            TEXT NOT NULL, -- insight | decision
  proposal_id     TEXT REFERENCES proposals(id),
  recommendation  TEXT,          -- approve | reject | abstain (advisory only)
  body            TEXT NOT NULL,
  evidence_url    TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contributions_created ON agent_contributions(created_at);
CREATE INDEX IF NOT EXISTS idx_contributions_agent ON agent_contributions(agent_id, created_at);

-- Portfolio state snapshots (JSON). A new row is appended on every executed trade.
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  portfolio     TEXT NOT NULL,                       -- india_inr | us_usd | crypto
  snapshot_json TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snap_portfolio ON portfolio_snapshots(portfolio, id);

-- Public strategy / suggestion box. No signup; name optional (NULL = anonymous).
CREATE TABLE IF NOT EXISTS strategies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT,                                    -- NULL = anonymous
  body       TEXT NOT NULL,
  ip_hash    TEXT,                                    -- SHA-256 of submitter IP, for naive rate limiting
  created_at TEXT NOT NULL
);

-- Atomic fixed-window counters for public and agent write endpoints.
CREATE TABLE IF NOT EXISTS rate_limits (
  scope        TEXT NOT NULL,
  subject      TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, subject, window_start)
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);

-- Versioned "intelligence file" exports (strategy memory). Public download.
-- The markdown is stored CHUNKED (D1/worker statement size limits make a single
-- 150KB+ INSERT unreliable): reassemble with GROUP_CONCAT ordered by seq.
CREATE TABLE IF NOT EXISTS intelligence_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  version    INTEGER NOT NULL UNIQUE,
  meta_json  TEXT NOT NULL,                           -- machine-readable summary/meta
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS intelligence_chunks (
  version    INTEGER NOT NULL REFERENCES intelligence_versions(version),
  seq        INTEGER NOT NULL,
  chunk      TEXT NOT NULL,
  PRIMARY KEY (version, seq)
);
