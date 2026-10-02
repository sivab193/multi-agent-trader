CREATE TABLE IF NOT EXISTS agent_activity_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type  TEXT NOT NULL,
  agent_id    TEXT,
  agent_name  TEXT,
  endpoint    TEXT,
  success     INTEGER NOT NULL,
  status_code INTEGER,
  detail      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_activity_created ON agent_activity_log(created_at);

CREATE TABLE IF NOT EXISTS api_request_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  agent_id TEXT,
  agent_name TEXT,
  agent_type TEXT,
  duration_ms INTEGER NOT NULL,
  cf_ray TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_request_created ON api_request_log(created_at);

CREATE TABLE IF NOT EXISTS strategy_agents (
  strategy_id INTEGER NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  relationship TEXT NOT NULL CHECK (relationship IN ('author', 'using')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (strategy_id, agent_id, relationship)
);
