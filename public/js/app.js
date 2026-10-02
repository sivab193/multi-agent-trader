// Shared frontend helpers for Multi Agent Trader.
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const res = await fetch(path, { ...opts, headers, credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const esc = (s) =>
  String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const fmtINR = (n) => "₹" + Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtUSD = (n) => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (portfolio, n) => (portfolio === "india_inr" ? fmtINR(n) : fmtUSD(n));
const fmtQty = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 8 });
const fmtPct = (n) => (Math.abs(n) < 0.005 ? "0.00" : (n > 0 ? "+" : "") + n.toFixed(2)) + "%";
const timeAgo = (iso) => {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
};

// Account metadata: short code, label, CSS class (colour), venue.
const ACCOUNTS = {
  india_inr: { code: "IN", label: "India", cls: "in", venue: "NSE · BSE" },
  us_usd: { code: "US", label: "US", cls: "us", venue: "NYSE · Nasdaq" },
  crypto: { code: "CRYPTO", label: "Crypto", cls: "cr", venue: "24/7" },
};
const acct = (k) => ACCOUNTS[k] || { code: String(k || "").toUpperCase(), label: k, cls: "", venue: "" };

// "Oct 2, 09:40 AM" + "Fri · ET"
function fmtWhen(iso, zone = "America/New_York", zoneLabel = "ET") {
  const d = new Date(iso);
  if (isNaN(d)) return { main: esc(iso), sub: "" };
  const main = new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short" }).format(d);
  return { main, sub: `${wd} · ${zoneLabel}` };
}
const whenHtml = (iso) => { const w = fmtWhen(iso); return `${esc(w.main)}<span class="sub2">${esc(w.sub)}</span>`; };

// Stable per-agent colour for avatars.
function agentColor(name) {
  const n = String(name || "").toLowerCase();
  if (n === "muse") return "var(--in)";
  if (n === "instinct") return "var(--us)";
  if (n === "system") return "var(--accent)";
  let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 62%)`;
}

// --- market hours (regular sessions, weekends excluded; exchange holidays not modelled) ---
function wallNow(zone, now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(now).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}
function marketStatus(zone, openMin, closeMin, now = new Date()) {
  const w = wallNow(zone, now), day = 86400000;
  const start = w - (w % day);
  const dow = new Date(start).getUTCDay();
  const open = start + openMin * 60000, close = start + closeMin * 60000;
  const weekday = dow >= 1 && dow <= 5;
  if (weekday && w >= open && w < close) return { open: true, ms: close - w };
  for (let i = 0; i <= 7; i++) {
    const s = start + i * day, d = new Date(s).getUTCDay();
    if (d === 0 || d === 6) continue;
    const o = s + openMin * 60000;
    if (o > w) return { open: false, ms: o - w, day: new Date(s).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }) };
  }
  return { open: false, ms: 0 };
}
function fmtDur(ms) {
  const m = Math.floor(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${mm}m`;
  return `${mm}m ${Math.floor((ms % 60000) / 1000)}s`;
}
function marketPills() {
  const nse = marketStatus("Asia/Kolkata", 9 * 60 + 15, 15 * 60 + 30);
  const nyse = marketStatus("America/New_York", 9 * 60 + 30, 16 * 60);
  const pill = (name, s) => `<span class="spill ${s.open ? "open" : "closed"}"><i class="ldot ${s.open ? "on" : ""}"></i><b>${name}</b><span class="st">${s.open ? "OPEN" : "CLOSED"}</span>· ${s.open ? "closes" : "opens"} in ${fmtDur(s.ms)}${!s.open && s.day ? ` · ${s.day}` : ""}</span>`;
  const now = new Date();
  const left = 15 - (now.getUTCMinutes() % 15) - now.getUTCSeconds() / 60;
  return pill("NSE", nse) + pill("NYSE/NASDAQ", nyse) +
    `<span class="spill open"><i class="ldot amber"></i><b>CRYPTO</b><span class="st">OPEN</span>24×7</span>` +
    `<span class="spill"><i class="ldot amber pulse"></i><b>CORE CYCLE</b>≈15 min · next ≈ ${Math.max(0, Math.ceil(left))}m</span>`;
}

// Client-side CSV download.
function downloadCsv(filename, rows) {
  const cell = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
  const blob = new Blob([rows.map((r) => r.map(cell).join(",")).join("\n")], { type: "text/csv" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: filename });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
}

// Mark the current nav link active
document.addEventListener("DOMContentLoaded", () => {
  const p = location.pathname.replace(/\.html$/, "") || "/";
  document.querySelectorAll("nav.topnav a.nl").forEach((a) => {
    const h = a.getAttribute("href").replace(/\.html$/, "") || "/";
    if (h === p || (p === "/index" && h === "/")) a.classList.add("active");
  });
});
