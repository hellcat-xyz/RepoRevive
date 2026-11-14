import path from 'node:path';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REPOREVIVE_DATA_DIR: z.string().default('./.data'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  JOB_TIMEOUT_MINUTES: z.coerce.number().min(5).max(240).default(45),
  MAX_REPAIR_ATTEMPTS: z.coerce.number().int().min(0).max(50).default(12),
  SANDBOX_MEMORY: z
    .string()
    .regex(/^\d+[mg]$/i)
    .default('2g'),
  SANDBOX_CPUS: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .default('2'),
  SANDBOX_PIDS_LIMIT: z.coerce.number().int().min(64).max(8192).default(512),
  CLONE_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(1800).default(180),
  INSTALL_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(3600).default(600),
  BUILD_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(3600).default(600),
  TEST_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(3600).default(600),
  SANDBOX_NETWORK_FOR_BUILD: bool,
  MAX_REPO_SIZE_MB: z.coerce.number().int().min(1).max(5000).default(300),
  GITHUB_TOKEN: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  LLM_MODEL: z.string().default('gpt-4o-mini'),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(5),
});

export type AppConfig = ReturnType<typeof loadConfig>;

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    dataDir: path.resolve(e.REPOREVIVE_DATA_DIR),
    workerConcurrency: e.WORKER_CONCURRENCY,
    jobTimeoutMs: e.JOB_TIMEOUT_MINUTES * 60_000,
    maxAttempts: e.MAX_REPAIR_ATTEMPTS,
    sandbox: { memory: e.SANDBOX_MEMORY, cpus: e.SANDBOX_CPUS, pidsLimit: e.SANDBOX_PIDS_LIMIT },
    cloneTimeoutMs: e.CLONE_TIMEOUT_SECONDS * 1000,
    timeouts: {
      install: e.INSTALL_TIMEOUT_SECONDS * 1000,
      build: e.BUILD_TIMEOUT_SECONDS * 1000,
      test: e.TEST_TIMEOUT_SECONDS * 1000,
    },
    networkForBuild: e.SANDBOX_NETWORK_FOR_BUILD,
    maxRepoSizeMb: e.MAX_REPO_SIZE_MB,
    githubToken: e.GITHUB_TOKEN || null,
    llm: e.LLM_API_KEY ? { apiKey: e.LLM_API_KEY, baseUrl: e.LLM_BASE_URL, model: e.LLM_MODEL } : null,
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
  };
}

export function config(): AppConfig {
  cached ??= loadConfig();
  return cached;
}
