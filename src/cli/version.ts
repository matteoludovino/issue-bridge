import { readFileSync } from 'node:fs';

/**
 * The version from package.json, read at runtime: a release can never ship a CLI
 * that reports the previous version. The path resolves the same way from src/ and
 * from dist/, and package.json is always part of the published package.
 */
export const VERSION: string = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;
