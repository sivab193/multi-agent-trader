// Auth helpers: per-agent bearer tokens + Cloudflare Access owner identity.

import { createRemoteJWKSet, jwtVerify } from "jose";

const accessJwks = new Map();

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

function accessConfig(env) {
  const team = (env.ACCESS_TEAM_DOMAIN || "").trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const audience = (env.ACCESS_AUD || "").trim();
  const owners = new Set(
    (env.OWNER_EMAILS || "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean)
  );
  return { team, audience, owners };
}

// Returns a verified owner identity, or null. This deliberately fails closed:
// production owner actions do not fall back to a shared browser/localStorage token.
export async function verifyOwnerJwt(token, env, jwksOverride = null) {
  const { team, audience, owners } = accessConfig(env);
  if (!team || !audience || owners.size === 0) return null;
  if (!token) return null;

  try {
    let jwks = jwksOverride || accessJwks.get(team);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
      accessJwks.set(team, jwks);
    }
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `https://${team}`,
      audience,
    });
    const email = String(payload.email || "").toLowerCase();
    if (!email || !owners.has(email) || payload.type !== "app") return null;
    return { email, subject: String(payload.sub || ""), issuer: String(payload.iss || "") };
  } catch {
    return null;
  }
}

export async function ownerFromRequest(request, env) {
  return verifyOwnerJwt(request.headers.get("Cf-Access-Jwt-Assertion") || "", env);
}

export function clientIpHash(request) {
  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
  return sha256Hex("strategy-box|" + ip);
}
