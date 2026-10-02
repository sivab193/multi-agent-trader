import test from "node:test";
import assert from "node:assert/strict";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  ownerFromRequest, verifyOwnerJwt, verifyOwnerToken,
  createOwnerSession, ownerSessionCookie,
} from "../src/auth.js";

const env = {
  ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
  ACCESS_AUD: "owner-app-audience",
  OWNER_EMAILS: "owner@example.com, backup@example.com",
  OWNER_TOKEN: "test-owner-token-that-is-longer-than-thirty-two-characters",
};

async function fixture(email = "owner@example.com", audience = env.ACCESS_AUD) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "test-key";
  publicJwk.use = "sig";
  publicJwk.alg = "RS256";
  const token = await new SignJWT({ email, type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(`https://${env.ACCESS_TEAM_DOMAIN}`)
    .setAudience(audience)
    .setSubject("owner-subject")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  return { token, jwks: createLocalJWKSet({ keys: [publicJwk] }) };
}

test("accepts a signed Access app token for an allowlisted owner", async () => {
  const { token, jwks } = await fixture();
  assert.deepEqual(await verifyOwnerJwt(token, env, jwks), {
    email: "owner@example.com",
    subject: "owner-subject",
    issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
  });
});

test("rejects valid tokens for users outside the owner allowlist", async () => {
  const { token, jwks } = await fixture("public@example.com");
  assert.equal(await verifyOwnerJwt(token, env, jwks), null);
});

test("rejects tokens issued for another Access application", async () => {
  const { token, jwks } = await fixture("owner@example.com", "wrong-audience");
  assert.equal(await verifyOwnerJwt(token, env, jwks), null);
});

test("rejects requests without an Access assertion", async () => {
  const request = new Request("https://mat.siv19.dev/api/admin/me");
  assert.equal(await ownerFromRequest(request, env), null);
});

test("accepts the configured owner token and a signed session cookie", async () => {
  assert.equal(await verifyOwnerToken(env.OWNER_TOKEN, env), true);
  assert.equal(await verifyOwnerToken("wrong-token", env), false);
  const session = await createOwnerSession(env);
  const cookie = ownerSessionCookie(session).split(";")[0];
  const request = new Request("https://mat.siv19.dev/api/admin/me", { headers: { Cookie: cookie } });
  assert.deepEqual(await ownerFromRequest(request, env), {
    email: "owner@example.com",
    subject: "owner-token",
    issuer: "mat-owner-session",
    auth_method: "owner_token",
  });
});

test("rejects tampered and expired owner sessions", async () => {
  const session = await createOwnerSession(env);
  const tampered = session.slice(0, -1) + (session.endsWith("a") ? "b" : "a");
  const badRequest = new Request("https://mat.siv19.dev/api/admin/me", { headers: { Cookie: `mat_owner_session=${tampered}` } });
  assert.equal(await ownerFromRequest(badRequest, env), null);
  const expired = await createOwnerSession(env, -1);
  const expiredRequest = new Request("https://mat.siv19.dev/api/admin/me", { headers: { Cookie: `mat_owner_session=${expired}` } });
  assert.equal(await ownerFromRequest(expiredRequest, env), null);
});
