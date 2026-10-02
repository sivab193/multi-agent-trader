// Auth helpers: per-agent bearer tokens + Cloudflare Access owner identity.

import { createRemoteJWKSet, jwtVerify } from "jose";

const accessJwks = new Map();
const OWNER_COOKIE = "mat_owner_session";
const OWNER_SESSION_SECONDS = 8 * 60 * 60;

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

function base64UrlEncode(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function sessionSignature(payload, secret) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return base64UrlEncode(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))));
}

async function constantTimeEqual(left, right) {
  const [a, b] = await Promise.all([sha256Hex(left), sha256Hex(right)]);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return mismatch === 0;
}

function ownerEmail(env) {
  return (env.OWNER_EMAILS || "owner").split(",")[0].trim().toLowerCase() || "owner";
}

export async function verifyOwnerToken(token, env) {
  const expected = (env.OWNER_TOKEN || "").trim();
  if (!expected || expected.length < 32 || !token) return false;
  return constantTimeEqual(String(token), expected);
}

export async function createOwnerSession(env, maxAgeSeconds = OWNER_SESSION_SECONDS) {
  const secret = (env.OWNER_TOKEN || "").trim();
  if (secret.length < 32) throw new Error("OWNER_TOKEN is not configured");
  const now = Math.floor(Date.now() / 1000);
  const payload = base64UrlEncode(JSON.stringify({ sub: "owner-token", iat: now, exp: now + maxAgeSeconds }));
  const signature = await sessionSignature(payload, secret);
  return `${payload}.${signature}`;
}

export function ownerSessionCookie(session, maxAgeSeconds = OWNER_SESSION_SECONDS) {
  return `${OWNER_COOKIE}=${session}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearOwnerSessionCookie() {
  return `${OWNER_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

async function ownerFromSession(request, env) {
  const cookies = request.headers.get("Cookie") || "";
  const raw = cookies.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${OWNER_COOKIE}=`));
  const session = raw?.slice(OWNER_COOKIE.length + 1);
  if (!session || !(env.OWNER_TOKEN || "").trim()) return null;
  const [payload, signature, extra] = session.split(".");
  if (!payload || !signature || extra) return null;
  try {
    const expected = await sessionSignature(payload, env.OWNER_TOKEN.trim());
    if (!(await constantTimeEqual(signature, expected))) return null;
    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
    if (claims.sub !== "owner-token" || !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000) return null;
    return { email: ownerEmail(env), subject: "owner-token", issuer: "mat-owner-session", auth_method: "owner_token" };
  } catch {
    return null;
  }
}

// Returns the agent row for a valid `Authorization: Bearer <key>` header, else null.
export async function agentFromRequest(env, request) {
  const h = request.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const hash = await sha256Hex(m[1].trim());
  const row = await env.DB.prepare(
    "SELECT * FROM agents WHERE api_key_hash = ? AND status NOT IN ('disabled', 'paused', 'removed')"
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
  const accessOwner = await verifyOwnerJwt(request.headers.get("Cf-Access-Jwt-Assertion") || "", env);
  return accessOwner || ownerFromSession(request, env);
}

export function clientIpHash(request) {
  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
  return sha256Hex("strategy-box|" + ip);
}
