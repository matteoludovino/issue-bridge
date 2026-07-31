/**
 * Formatação de terminal, sem dependência.
 *
 * Chalk e Ora resolvem isso, mas o que a CLI precisa aqui são ~30 linhas de
 * códigos ANSI e uma linha de progresso. Menos dependência = menos superfície de
 * supply chain num binário que carrega credenciais de dois sistemas.
 */

const colorsEnabled = (): boolean => {
  const env = process.env;
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return false;
  if (env['FORCE_COLOR'] !== undefined && env['FORCE_COLOR'] !== '') return true;
  return process.stderr.isTTY === true;
};

const wrap = (open: string) => {
  return (text: string): string => (colorsEnabled() ? `\u001b[${open}m${text}\u001b[0m` : text);
};

export const color = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  cyan: wrap('36'),
};

export const symbol = {
  ok: '✔',
  warn: '!',
  error: '✖',
  info: '·',
  arrow: '→',
};

/** `1234` → `1.234` (separador pt-BR, sem depender de Intl na saída de log). */
export function formatNumber(value: number): string {
  return value.toLocaleString('pt-BR');
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}m ${String(Math.round(seconds % 60))}s`;
}

/**
 * Linha de progresso reescrita in-place quando há TTY; em pipe/CI, imprime só
 * marcos, para não poluir o log com milhares de linhas.
 */
export class ProgressLine {
  private lastPrinted = -1;

  constructor(
    private readonly label: string,
    private readonly stream: NodeJS.WriteStream = process.stderr,
  ) {}

  update(done: number, total: number, failures: number): void {
    const suffix = failures > 0 ? color.red(` ${String(failures)} falha(s)`) : '';
    const text = `${this.label} ${String(done)}/${String(total)}${suffix}`;

    if (this.stream.isTTY === true) {
      this.stream.write(`\r\u001b[2K${text}`);
      return;
    }

    // Sem TTY: um marco a cada 10%.
    const decile = total === 0 ? 10 : Math.floor((done / total) * 10);
    if (decile === this.lastPrinted) return;
    this.lastPrinted = decile;
    this.stream.write(`${text}\n`);
  }

  done(): void {
    if (this.stream.isTTY === true) this.stream.write('\r\u001b[2K');
  }
}
