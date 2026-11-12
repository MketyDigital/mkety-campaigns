const DEFAULT_SCHEMA = "campaigns";
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

export function getPostgresPoolOptions(env, max) {
  if (!env.DATABASE_URL) return undefined;
  const schema = env.CAMPAIGNS_DB_SCHEMA?.trim() || DEFAULT_SCHEMA;
  if (!IDENTIFIER.test(schema)) {
    throw new Error("CAMPAIGNS_DB_SCHEMA must be a lowercase PostgreSQL identifier");
  }
  return {
    connectionString: env.DATABASE_URL,
    max,
    options: `-c search_path=${schema},public`,
  };
}
