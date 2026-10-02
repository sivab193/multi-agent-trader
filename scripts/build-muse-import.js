import fs from "node:fs";
import path from "node:path";

const [rootArg, outputArg, sha256] = process.argv.slice(2);
if (!rootArg || !outputArg || !sha256) {
  console.error("usage: node scripts/build-muse-import.js <export-dir> <output.sql> <zip-sha256>");
  process.exit(2);
}

const root = path.resolve(rootArg);
const output = path.resolve(outputArg);
const exportId = `muse-2026-10-02-${sha256.slice(0, 12).toLowerCase()}`;
const snapshotAt = "2026-10-02T18:55:00Z";
const importedAt = new Date().toISOString();
const chunkSize = 20_000;
const statements = [];

const quote = (value) => value == null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
const number = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`invalid numeric value: ${value}`);
  return String(n);
};
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const json = (relative) => JSON.parse(read(relative));
const chunks = (text) => {
  const out = [];
  for (let i = 0; i < text.length; i += chunkSize) out.push(text.slice(i, i + chunkSize));
  return out;
};
const parseCsv = (text) => {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  const headers = rows.shift();
  return rows.filter((values) => values.some(Boolean)).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]))
  );
};
const findField = (value, keys) => {
  if (!value || typeof value !== "object") return null;
  for (const key of keys) if (typeof value[key] === "string" && value[key]) return value[key];
  for (const nested of Object.values(value)) {
    const found = findField(nested, keys);
    if (found) return found;
  }
  return null;
};

const positions = json("positions.json");
const transactionFiles = fs.readdirSync(path.join(root, "transactions"))
  .filter((name) => name.endsWith(".json")).sort();
const transactionDetails = transactionFiles.map((name) => {
  const detail = json(path.join("transactions", name));
  const id = detail.txn_id || detail.id || name.match(/txn_\d+/)?.[0];
  if (!id) throw new Error(`cannot determine transaction id for ${name}`);
  return { id, detail };
});
const transactions = parseCsv(read("transactions.csv"));
const decisions = read("decisions.jsonl").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
const dailyFiles = fs.readdirSync(path.join(root, "daily_logs"))
  .filter((name) => name.endsWith(".md")).sort();
const strategyMemory = read("STRATEGY_MEMORY.md");

if (transactions.length !== 12) throw new Error(`expected 12 transactions, found ${transactions.length}`);
if (decisions.length !== 227) throw new Error(`expected 227 decisions, found ${decisions.length}`);
for (const required of ["crypto", "india_inr", "us_usd"]) {
  if (!positions.portfolios?.[required]) throw new Error(`missing portfolio ${required}`);
}

const manifest = {
  source: "Muse trading simulator export",
  snapshot_as_of_et: positions.snapshot_as_of_et,
  transaction_count: transactions.length,
  decision_count: decisions.length,
  daily_log_count: dailyFiles.length,
  strategy_memory_chars: strategyMemory.length,
};

statements.push(
  `INSERT OR IGNORE INTO legacy_imports (id, source, snapshot_at, sha256, manifest_json, imported_at) VALUES (${quote(exportId)}, 'Muse trading simulator export', ${quote(snapshotAt)}, ${quote(sha256.toLowerCase())}, ${quote(JSON.stringify(manifest))}, ${quote(importedAt)});`
);

for (const [index, tx] of transactions.entries()) {
  const txnId = `txn_${String(index + 1).padStart(3, "0")}`;
  const detail = transactionDetails.find((item) => item.id === txnId)?.detail;
  if (!detail) throw new Error(`missing detail for ${txnId}`);
  const priceUrl = findField(detail, ["price_source_url", "source_url"]);
  statements.push(
    `INSERT INTO transactions (id, ts, portfolio, action, symbol, qty, price, currency, value, price_source, price_url, justification, decided_by, proposal_id) VALUES (` +
    [txnId, tx.timestamp, tx.portfolio, tx.type, tx.symbol].map(quote).join(", ") + `, ${number(tx.quantity)}, ${number(tx.price)}, ${quote(tx.currency)}, ${number(tx.value)}, ${quote(tx.source)}, ${quote(priceUrl)}, ${quote(tx.short_justification)}, 'legacy', NULL)` +
    ` ON CONFLICT(id) DO UPDATE SET ts=excluded.ts, portfolio=excluded.portfolio, action=excluded.action, symbol=excluded.symbol, qty=excluded.qty, price=excluded.price, currency=excluded.currency, value=excluded.value, price_source=excluded.price_source, price_url=excluded.price_url, justification=excluded.justification;`
  );
  statements.push(
    `INSERT INTO transaction_details (txn_id, detail_json) VALUES (${quote(txnId)}, ${quote(JSON.stringify(detail))}) ON CONFLICT(txn_id) DO UPDATE SET detail_json=excluded.detail_json;`
  );
}

for (const [portfolio, source] of Object.entries(positions.portfolios)) {
  const holdings = {};
  const exitedPositions = {};
  for (const [symbol, holding] of Object.entries(source.holdings || {})) {
    if (Number.isFinite(Number(holding.quantity))) holdings[symbol] = holding;
    else exitedPositions[symbol] = holding;
  }
  const symbols = new Set(Object.keys(holdings));
  const lastMarks = Object.fromEntries(Object.entries(positions.last_marks || {}).filter(([symbol]) => symbols.has(symbol)));
  const snapshot = {
    ...source,
    holdings,
    exited_positions: exitedPositions,
    last_marks: lastMarks,
    mark_to_market_total: positions.mark_to_market_totals?.[portfolio === "crypto" ? "crypto_usd" : portfolio],
    snapshot_as_of_et: positions.snapshot_as_of_et,
    source_import_id: exportId,
  };
  statements.push(
    `INSERT INTO portfolio_snapshots (portfolio, snapshot_json, created_at) SELECT ${quote(portfolio)}, ${quote(JSON.stringify(snapshot))}, ${quote(snapshotAt)} WHERE NOT EXISTS (SELECT 1 FROM portfolio_snapshots WHERE portfolio=${quote(portfolio)} AND created_at=${quote(snapshotAt)});`
  );
}

statements.push(
  `INSERT OR IGNORE INTO intelligence_versions (version, meta_json, created_at) VALUES (2, ${quote(JSON.stringify({ version: 2, source: "Muse export/STRATEGY_MEMORY.md", source_import_id: exportId, exported_at: snapshotAt, note: "Final simulator strategy memory before Cloudflare migration." }))}, ${quote(snapshotAt)});`
);
chunks(strategyMemory).forEach((chunk, seq) => statements.push(
  `INSERT OR REPLACE INTO intelligence_chunks (version, seq, chunk) VALUES (2, ${seq}, ${quote(chunk)});`
));

decisions.forEach((decision, index) => {
  const runCandidate = decision.run_no ?? decision.run_number ?? decision.run ?? null;
  const runNo = Number.isFinite(Number(runCandidate)) ? Number(runCandidate) : null;
  statements.push(
    `INSERT OR REPLACE INTO engine_decisions (import_id, seq, run_no, ts_et, ts_utc, decision, reason, txn_id, prices_json, raw_json) VALUES (` +
    `${quote(exportId)}, ${index + 1}, ${runNo == null ? "NULL" : number(runNo)}, ${quote(decision.timestamp_et)}, ${quote(decision.timestamp_utc)}, ${quote(decision.decision || "UNKNOWN")}, ${quote(decision.reason || decision.note)}, ${quote(decision.txn_id)}, ${quote(JSON.stringify(decision.prices_checked ?? null))}, ${quote(JSON.stringify(decision))});`
  );
});

for (const name of dailyFiles) {
  const id = `${exportId}:daily:${name.replace(/\.md$/i, "")}`;
  const markdown = read(path.join("daily_logs", name));
  statements.push(
    `INSERT OR IGNORE INTO legacy_documents (id, import_id, kind, label, created_at) VALUES (${quote(id)}, ${quote(exportId)}, 'daily_log', ${quote(name)}, ${quote(snapshotAt)});`
  );
  chunks(markdown).forEach((chunk, seq) => statements.push(
    `INSERT OR REPLACE INTO legacy_document_chunks (document_id, seq, chunk) VALUES (${quote(id)}, ${seq}, ${quote(chunk)});`
  ));
}

fs.writeFileSync(output, statements.join("\n"), "utf8");
console.log(JSON.stringify({ output, exportId, ...manifest }, null, 2));
