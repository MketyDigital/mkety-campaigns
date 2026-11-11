import type { Pool } from "pg";

export interface OperatorSession { id: string; email: string; }
export interface OperatorAuth {
  start(request: Request): Promise<Response>;
  callback(request: Request): Promise<Response>;
  session(headers: Headers): Promise<OperatorSession | null>;
  logout(headers: Headers): Promise<Response>;
}
type Env = { MKETY_OPS_AUTH_ISSUER?: string; MKETY_OPS_AUTH_CLIENT_ID?: string; MKETY_OPS_ALLOWED_EMAIL?: string; MKETY_OPS_AUTH_CALLBACK_URL?: string };
type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string };
type TokenResponse = { id_token?: string };
type Claims = { iss?: string; aud?: string | string[]; azp?: string; exp?: number; iat?: number; nonce?: string; email?: string; email_verified?: boolean };
type Jwks = { keys?: Array<JsonWebKey & { kid?: string }> };
const COOKIE = "mkety_campaigns_ops";
const SESSION_SECONDS = 12 * 60 * 60;
const encoder = new TextEncoder();

/** MKETY identity-provider login with PKCE and application-local, hashed sessions. */
export function createOperatorAuth(database: Pool, env: Env): OperatorAuth {
  return {
    start: async (_request) => {
      const config = readConfig(env);
      const callback = callbackUrl(config.callbackUrl);
      const discovery = await discover(config.issuer);
      const state = randomToken(32), verifier = randomToken(48), nonce = randomToken(32);
      const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
      await database.query("DELETE FROM campaign_ops_auth_transactions WHERE expires_at < NOW()");
      await database.query("INSERT INTO campaign_ops_auth_transactions (state_hash, code_verifier, nonce, expires_at) VALUES ($1,$2,$3,NOW() + INTERVAL '10 minutes')", [await sha256(state), verifier, nonce]);
      const authorization = new URL(discovery.authorization_endpoint);
      authorization.searchParams.set("client_id", config.clientId);
      authorization.searchParams.set("redirect_uri", callback);
      authorization.searchParams.set("response_type", "code");
      authorization.searchParams.set("scope", "openid profile email");
      authorization.searchParams.set("state", state);
      authorization.searchParams.set("nonce", nonce);
      authorization.searchParams.set("code_challenge", challenge);
      authorization.searchParams.set("code_challenge_method", "S256");
      return Response.redirect(authorization.toString(), 302);
    },
    callback: async (request) => {
      try {
        const config = readConfig(env), callback = callbackUrl(config.callbackUrl);
        const url = new URL(request.url), state = url.searchParams.get("state") || "", code = url.searchParams.get("code") || "";
        if (!state || !code || code.length > 4096 || state.length > 256) throw new Error("invalid_callback");
        const consumed = await database.query<{ code_verifier: string; nonce: string }>("DELETE FROM campaign_ops_auth_transactions WHERE state_hash=$1 AND expires_at>NOW() RETURNING code_verifier,nonce", [await sha256(state)]);
        const transaction = consumed.rows[0];
        if (!transaction) throw new Error("invalid_callback");
        const discovery = await discover(config.issuer);
        const response = await fetch(discovery.token_endpoint, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: callback, client_id: config.clientId, code_verifier: transaction.code_verifier }),
        });
        if (!response.ok) throw new Error("token_exchange_failed");
        const tokens = await response.json() as TokenResponse;
        if (!tokens.id_token) throw new Error("id_token_missing");
        const email = await verifyIdToken(tokens.id_token, discovery.jwks_uri, config.issuer, config.clientId, transaction.nonce);
        if (email !== config.allowedEmail) throw new Error("operator_not_allowed");
        const operator = await database.query<{ id: string }>("INSERT INTO campaign_ops_users (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET last_login_at=NOW(), status='active' RETURNING id", [email]);
        const token = randomToken(32);
        await database.query("INSERT INTO campaign_ops_sessions (token_hash,user_id,expires_at) VALUES ($1,$2,NOW() + INTERVAL '12 hours')", [await sha256(token), operator.rows[0]!.id]);
        return new Response(null, { status: 302, headers: { location: new URL("/app/ops", callback).toString(), "set-cookie": sessionCookie(token, SESSION_SECONDS), "cache-control": "no-store", "referrer-policy": "no-referrer" } });
      } catch {
        const fallback = env.MKETY_OPS_AUTH_CALLBACK_URL || "https://campaign.mkety.com/api/ops/auth/callback";
        return Response.redirect(new URL("/ops-login?error=login_failed", fallback).toString(), 302);
      }
    },
    session: async (headers) => {
      const token = readCookie(headers.get("cookie") || "", COOKIE);
      if (!token || token.length > 128) return null;
      const result = await database.query<{ id: string; email: string }>(
        "SELECT u.id,u.email FROM campaign_ops_sessions s JOIN campaign_ops_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW() AND u.status='active' LIMIT 1",
        [await sha256(token)],
      );
      return result.rows[0] ?? null;
    },
    logout: async (headers) => {
      const token = readCookie(headers.get("cookie") || "", COOKIE);
      if (token) await database.query("DELETE FROM campaign_ops_sessions WHERE token_hash=$1", [await sha256(token)]);
      return new Response(null, { status: 302, headers: { location: "/ops-login", "set-cookie": sessionCookie("", 0), "cache-control": "no-store" } });
    },
  };
}

function readConfig(env: Env) {
  const issuer = normalizeIssuer(env.MKETY_OPS_AUTH_ISSUER || "");
  const clientId = env.MKETY_OPS_AUTH_CLIENT_ID?.trim() || "";
  const allowedEmail = env.MKETY_OPS_ALLOWED_EMAIL?.trim().toLowerCase() || "";
  const callbackUrlValue = env.MKETY_OPS_AUTH_CALLBACK_URL?.trim() || "";
  if (!issuer || !clientId || !allowedEmail || !callbackUrlValue) throw new Error("operator_auth_not_configured");
  if (new URL(issuer).protocol !== "https:") throw new Error("operator_issuer_must_use_https");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(allowedEmail)) throw new Error("operator_email_invalid");
  callbackUrl(callbackUrlValue);
  return { issuer, clientId, allowedEmail, callbackUrl: callbackUrlValue };
}
function callbackUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost") throw new Error("operator_callback_must_use_https");
  if (url.pathname !== "/api/ops/auth/callback" || url.search || url.hash || url.username || url.password) throw new Error("operator_callback_invalid");
  return url.toString();
}
async function discover(issuer: string): Promise<Discovery> {
  const response = await fetch(issuer + "/.well-known/openid-configuration", { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("oidc_discovery_failed");
  const document = await response.json() as Discovery;
  for (const field of ["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
    if (typeof document[field] !== "string" || new URL(document[field]).protocol !== "https:") throw new Error("oidc_discovery_invalid");
  }
  if (normalizeIssuer(document.issuer) !== issuer) throw new Error("oidc_issuer_mismatch");
  return document;
}
async function verifyIdToken(token: string, jwksUri: string, issuer: string, clientId: string, nonce: string): Promise<string> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("id_token_invalid");
  const header = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0]!))) as { alg?: string; kid?: string };
  const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1]!))) as Claims;
  if (header.alg !== "RS256" || !header.kid) throw new Error("id_token_algorithm_invalid");
  const response = await fetch(jwksUri, { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("oidc_jwks_failed");
  const jwks = await response.json() as Jwks, jwk = jwks.keys?.find((key) => key.kid === header.kid);
  if (!jwk) throw new Error("oidc_signing_key_missing");
  const publicKey = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const signature = toArrayBuffer(fromBase64Url(parts[2]!));
  const signedContent = toArrayBuffer(encoder.encode(parts[0] + "." + parts[1]));
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, signature, signedContent);
  if (!valid) throw new Error("id_token_signature_invalid");
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud], now = Math.floor(Date.now() / 1000);
  if (normalizeIssuer(claims.iss || "") !== issuer || !audience.includes(clientId) || (audience.length > 1 && claims.azp !== clientId)) throw new Error("id_token_claims_invalid");
  if (!claims.exp || claims.exp <= now || !claims.iat || claims.iat > now + 60 || claims.nonce !== nonce) throw new Error("id_token_time_or_nonce_invalid");
  if (claims.email_verified !== true || typeof claims.email !== "string") throw new Error("operator_email_unverified");
  return claims.email.trim().toLowerCase();
}
function normalizeIssuer(value: string): string { return value.trim().replace(/\/+$/, ""); }
function randomToken(bytes: number): string { const data = new Uint8Array(bytes); crypto.getRandomValues(data); return base64Url(data); }
async function sha256(value: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function base64Url(bytes: Uint8Array): string {
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function readCookie(cookie: string, name: string): string | null {
  const prefix = name + "=";
  for (const item of cookie.split(";")) { const candidate = item.trim(); if (candidate.startsWith(prefix)) return decodeURIComponent(candidate.slice(prefix.length)); }
  return null;
}
function sessionCookie(token: string, maxAge: number): string {
  return COOKIE + "=" + token + "; Path=/; Max-Age=" + maxAge + "; HttpOnly; Secure; SameSite=Strict";
}
\nfunction toArrayBuffer(bytes: Uint8Array): ArrayBuffer {\n  const copy = new Uint8Array(bytes.byteLength);\n  copy.set(bytes);\n  return copy.buffer;\n}\n