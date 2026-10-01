// Auth helpers: agent bearer tokens + human admin token.
// Secrets are NEVER hardcoded — ADMIN_TOKEN comes from `wrangler secret put`.

export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newApiKey() {
  // Shown ONCE at registration; only the hash is stored.
  const r = crypto.getRandomValues(new Uint8Array(24));
  const b64 = btoa(String.fromCharCode(...r)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return "tp_" + b64;
}

// Returns the agent row for a valid `Authorization: Bearer <key>` header, else null.
export async function agentFromRequest(env, request) {
  const h = request.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const hash = await sha256Hex(m[1].trim());
  const row = await env.DB.prepare(
    "SELECT * FROM agents WHERE api_key_hash = ? AND status != 'disabled'"
  ).bind(hash).first();
  return row || null;
}

// Admin actions (register agent, resolve decision request) need the human token:
// header `x-admin-token: <ADMIN_TOKEN>`.
export async function isAdmin(request, env) {
  const token = request.headers.get("x-admin-token") || "";
  if (!env.ADMIN_TOKEN) return false;
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(token)),
    crypto.subtle.digest("SHA-256", encoder.encode(env.ADMIN_TOKEN)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

export function clientIpHash(request) {
  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
  return sha256Hex("strategy-box|" + ip);
}
