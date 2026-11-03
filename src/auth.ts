import { betterAuth } from "better-auth";
import { twoFactor } from "better-auth/plugins";

export type AuthEnvironment = {
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
};

export function createAuth(database: unknown, env: AuthEnvironment) {
  const secret = env.BETTER_AUTH_SECRET?.trim();
  const baseURL = env.BETTER_AUTH_URL?.trim();
  if (!secret || secret.length < 32) throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  if (!baseURL) throw new Error("BETTER_AUTH_URL is required");
  const url = new URL(baseURL);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error("BETTER_AUTH_URL must use HTTPS outside localhost");
  }

  return betterAuth({
    appName: "MKETY Campaigns",
    baseURL: url.origin,
    basePath: "/api/auth",
    secret,
    trustedOrigins: [url.origin],
    database: database as never,
    user: {
      modelName: "users",
      fields: {
        name: "display_name",
        emailVerified: "email_verified",
        image: "image",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      additionalFields: {
        role: {
          type: "string",
          required: false,
          defaultValue: "tenant",
          input: false,
        },
      },
    },
    session: {
      modelName: "sessions",
      fields: {
        userId: "user_id",
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
      },
      expiresIn: 60 * 60 * 12,
      updateAge: 60 * 15,
    },
    account: {
      modelName: "accounts",
      fields: {
        accountId: "account_id",
        providerId: "provider_id",
        userId: "user_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    verification: {
      modelName: "auth_verifications",
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
    },
    plugins: [twoFactor({
      issuer: "MKETY Campaigns",
      twoFactorTable: "user_two_factors",
      twoFactorCookieMaxAge: 600,
      trustDeviceMaxAge: 0,
      schema: {
        user: { fields: { twoFactorEnabled: "two_factor_enabled" } },
        twoFactor: {
          fields: {
            userId: "user_id",
            backupCodes: "backup_codes",
            failedVerificationCount: "failed_verification_count",
            lockedUntil: "locked_until",
          },
        },
      },
    })],
    advanced: {
      database: { generateId: () => crypto.randomUUID() },
      useSecureCookies: url.protocol === "https:",
    },
    telemetry: { enabled: false },
  });
}
