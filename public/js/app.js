// Shared frontend helpers for trader.siv19.dev
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const res = await fetch(path, { ...opts, headers, credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const esc = (s) =>
  String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const fmtINR = (n) => "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const fmtUSD = (n) => "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
const money = (portfolio, n) => (portfolio === "india_inr" ? fmtINR(n) : fmtUSD(n));
const timeAgo = (iso) => {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
};
// Mark the current nav link active
document.addEventListener("DOMContentLoaded", () => {
  const p = location.pathname.replace(/\.html$/, "") || "/";
  document.querySelectorAll("nav.topnav a.nl").forEach((a) => {
    const h = a.getAttribute("href").replace(/\.html$/, "") || "/";
    if (h === p || (p === "/" && h === "/")) a.classList.add("active");
  });
});
