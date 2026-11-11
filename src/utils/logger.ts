import type { Logger } from '../core/executor/executor.js';
import { color, symbol } from './ui.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface ConsoleLoggerOptions {
  level?: LogLevel;
  /** One JSON line per event — for CI and log aggregators. */
  json?: boolean;
  /** Default: `stderr`, so `stdout` stays free for data. */
  stream?: NodeJS.WriteStream;
}

/**
 * Dependency-free terminal logger.
 *
 * Pino would do this with more throughput, but its value is structured logging on
 * high-load servers; what matters here is human-readable output with an
 * optional `--json` mode. `Logger` is a port, so switching to Pino later is
 * one new class and nothing more.
 *
 * Everything goes to `stderr` on purpose: `stdout` is reserved for data
 * (`ledger --json`), so `issue-bridge ledger --json | jq` works.
 */
export class ConsoleLogger implements Logger {
  private readonly level: LogLevel;
  private readonly json: boolean;
  private readonly stream: NodeJS.WriteStream;

  constructor(options: ConsoleLoggerOptions = {}) {
    this.level = options.level ?? 'info';
    this.json = options.json ?? false;
    this.stream = options.stream ?? process.stderr;
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.write('info', color.dim(symbol.info), message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.write('warn', color.yellow(symbol.warn), message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.write('error', color.red(symbol.error), message, context);
  }

  private write(
    level: LogLevel,
    prefix: string,
    message: string,
    context?: Record<string, unknown>,
  ): void {
    if (RANK[level] < RANK[this.level]) return;

    if (this.json) {
      this.stream.write(
        `${JSON.stringify({ level, message, ...(context ?? {}) })}\n`,
      );
      return;
    }

    const details = formatContext(context);
    this.stream.write(`${prefix} ${message}${details}\n`);
  }
}

function formatContext(context: Record<string, unknown> | undefined): string {
  if (context === undefined) return '';
  const parts = Object.entries(context)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${stringify(value)}`);
  return parts.length === 0 ? '' : color.dim(` (${parts.join(' ')})`);
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? 'null';
}
