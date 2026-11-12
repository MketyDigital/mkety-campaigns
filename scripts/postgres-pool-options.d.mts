import type { PoolConfig } from "pg";

export function getPostgresPoolOptions(
  env: NodeJS.ProcessEnv,
  max: number,
): PoolConfig | undefined;
