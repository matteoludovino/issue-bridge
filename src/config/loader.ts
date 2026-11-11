import { readFile } from 'node:fs/promises';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { MigrationError } from '../core/errors.js';
import { MigrationConfigSchema, type MigrationConfig } from './schema.js';

/** Credentials resolved from the environment. Never read from the file. */
export interface Credentials {
  sourceToken: string;
  targetEmail: string;
  targetToken: string;
}

export interface LoadedConfig {
  config: MigrationConfig;
  credentials: Credentials;
  /** File path, for error messages and the report. */
  filePath: string;
}

export type EnvLike = Record<string, string | undefined>;

/** Reads, validates and resolves credentials. Fails with an actionable message. */
export async function loadConfig(filePath: string, env: EnvLike): Promise<LoadedConfig> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (cause: unknown) {
    throw new MigrationError({
      code: 'not-found',
      message: `Configuration file not found at ${filePath}.`,
      cause,
    });
  }

  const config = parseConfig(raw, filePath);
  return { config, credentials: resolveCredentials(config, env), filePath };
}

/** YAML → validated config. Separate from `loadConfig` so it is testable without disk I/O. */
export function parseConfig(raw: string, filePath: string): MigrationConfig {
  let document: unknown;
  try {
    document = parseYaml(raw);
  } catch (cause: unknown) {
    throw new MigrationError({
      code: 'validation',
      message: `Invalid YAML in ${filePath}: ${
        cause instanceof YAMLParseError ? cause.message : String(cause)
      }`,
      cause,
    });
  }

  if (document === null || document === undefined) {
    throw new MigrationError({
      code: 'validation',
      message: `Configuration file ${filePath} is empty.`,
    });
  }

  const result = MigrationConfigSchema.safeParse(document);
  if (result.success) return result.data;

  // Report ALL problems at once: fixing a config piecemeal is painful.
  const problems = result.error.issues
    .map((issue) => `  • ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new MigrationError({
    code: 'validation',
    message: `Invalid configuration in ${filePath}:\n${problems}`,
    cause: result.error,
  });
}

/** Resolves the three credentials and reports ALL missing ones at once. */
export function resolveCredentials(config: MigrationConfig, env: EnvLike): Credentials {
  const required = [
    { key: 'source.tokenEnv', variable: config.source.tokenEnv },
    { key: 'target.emailEnv', variable: config.target.emailEnv },
    { key: 'target.tokenEnv', variable: config.target.tokenEnv },
  ];

  const missing = required.filter(({ variable }) => {
    const value = env[variable];
    return value === undefined || value.trim().length === 0;
  });

  if (missing.length > 0) {
    throw new MigrationError({
      code: 'auth',
      message: `Environment variables not set:\n${missing
        .map(({ key, variable }) => `  • ${variable} (referenced by ${key})`)
        .join('\n')}`,
    });
  }

  return {
    sourceToken: env[config.source.tokenEnv] ?? '',
    targetEmail: env[config.target.emailEnv] ?? '',
    targetToken: env[config.target.tokenEnv] ?? '',
  };
}
