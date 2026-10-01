import test from "node:test";
import assert from "node:assert/strict";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { ownerFromRequest, verifyOwnerJwt } from "../src/auth.js";

const env = {
  ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
  ACCESS_AUD: "owner-app-audience",
  OWNER_EMAILS: "owner@example.com, backup@example.com",
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
  const request = new Request("https://trader.siv19.dev/api/admin/me");
  assert.equal(await ownerFromRequest(request, env), null);
});
