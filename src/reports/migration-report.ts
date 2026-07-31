import type { ExecutionResult, FailedOutcome } from '../core/executor/executor.js';
import type {
  MigrationPlan,
  PlanAction,
  PlanFinding,
  PlanFindingCode,
} from '../core/models/migration-plan.js';

/**
 * Geração do relatório em markdown. Funções PURAS: recebem plano e resultado,
 * devolvem string. Sem I/O, sem data do sistema — o que permite testar o
 * conteúdo inteiro e versionar o relatório junto do resultado.
 */

const ACTION_LABELS: Record<PlanAction['kind'], string> = {
  create_epic: 'Épicos',
  create_version: 'Versões',
  create_component: 'Componentes',
  create_label: 'Labels',
  create_issue: 'Issues',
  create_comment: 'Comentários',
  create_attachment: 'Anexos',
  create_link: 'Links',
  transition_issue: 'Transições',
};

const FINDING_HINTS: Partial<Record<PlanFindingCode, string>> = {
  missing_required_field: 'Preencha em `mappings.fields` no arquivo de configuração.',
  unmapped_value: 'Ajuste `mappings` para um valor que exista no destino.',
  dependency_cycle: 'Corrija a hierarquia na origem; as issues do ciclo ficaram fora do plano.',
  unreachable_status: 'O workflow do destino pode exigir passos intermediários.',
  hierarchy_conflict: 'O destino aceita um único pai por issue.',
};

/** Relatório do `analyze`: o que será feito e o que impede. */
export function renderPlanReport(plan: MigrationPlan): string {
  const errors = plan.findings.filter((finding) => finding.severity === 'error');
  const warnings = plan.findings.filter((finding) => finding.severity === 'warning');
  const infos = plan.findings.filter((finding) => finding.severity === 'info');

  const lines: string[] = [
    '# Relatório de migração — plano',
    '',
    `- **Origem:** \`${plan.model.source.platform}:${plan.model.source.identifier}\``,
    `- **Destino:** projeto \`${plan.targetProjectKey}\``,
    `- **Extraído em:** ${plan.model.source.extractedAt}`,
    `- **Plano gerado em:** ${plan.generatedAt}`,
    `- **Issues na origem:** ${String(plan.model.issues.length)}`,
    '',
    errors.length > 0
      ? `> **Plano bloqueado:** ${String(errors.length)} erro(s) precisam ser resolvidos antes do \`apply\`.`
      : '> Plano válido: nenhum erro bloqueante.',
    '',
    '## Ações planejadas',
    '',
    ...renderActionTable(plan.actions),
    '',
  ];

  if (errors.length > 0) {
    lines.push('## Erros (bloqueiam o apply)', '', ...renderFindings(errors), '');
  }
  if (warnings.length > 0) {
    lines.push('## Avisos', '', ...renderFindings(warnings), '');
  }
  if (infos.length > 0) {
    lines.push('## Observações', '', ...renderFindings(infos), '');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/** Relatório do `apply`: o que aconteceu de fato, com o mapa origem → destino. */
export function renderExecutionReport(plan: MigrationPlan, result: ExecutionResult): string {
  const total = result.succeeded.length + result.skipped.length + result.failed.length;
  const retried = result.succeeded.filter((outcome) => outcome.attempts > 1);

  const lines: string[] = [
    `# Relatório de migração — ${result.dryRun ? 'simulação' : 'execução'}`,
    '',
    `- **Origem:** \`${plan.model.source.platform}:${plan.model.source.identifier}\``,
    `- **Destino:** projeto \`${plan.targetProjectKey}\``,
    `- **Início:** ${result.startedAt}`,
    `- **Fim:** ${result.finishedAt}`,
    result.dryRun ? '- **Modo:** simulação — nada foi escrito no destino.' : '- **Modo:** execução real.',
    '',
    '## Resumo',
    '',
    '| Situação | Ações |',
    '| --- | --- |',
    `| Concluídas | ${String(result.succeeded.length)} |`,
    `| Puladas (já migradas) | ${String(result.skipped.length)} |`,
    `| Falhas | ${String(result.failed.length)} |`,
    `| **Total** | **${String(total)}** |`,
    '',
  ];

  if (retried.length > 0) {
    lines.push(
      `${String(retried.length)} ação(ões) só passaram após retry — sinal de rate limit ou instabilidade na API.`,
      '',
    );
  }

  if (result.failed.length > 0) {
    lines.push('## Falhas', '', ...renderFailures(result.failed), '');
  }

  const created = result.succeeded.filter(
    (outcome) => outcome.action.kind === 'create_issue' || outcome.action.kind === 'create_epic',
  );
  if (created.length > 0) {
    lines.push(
      '## Correspondência origem → destino',
      '',
      '| Origem | Destino |',
      '| --- | --- |',
      ...created.map((outcome) => {
        const source = sourceLink(outcome.action);
        const target =
          outcome.targetRef === null
            ? '—'
            : outcome.targetRef.url === undefined
              ? `\`${outcome.targetRef.humanRef}\``
              : `[${outcome.targetRef.humanRef}](${outcome.targetRef.url})`;
        return `| ${source} | ${target} |`;
      }),
      '',
    );
  }

  const notMigrated = plan.findings.filter((finding) => finding.code === 'not_migrated');
  if (notMigrated.length > 0) {
    lines.push(
      '## Não migrado',
      '',
      ...notMigrated.map((finding) => `- ${finding.message}`),
      '',
    );
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function renderActionTable(actions: PlanAction[]): string[] {
  const counts = new Map<PlanAction['kind'], number>();
  for (const action of actions) {
    counts.set(action.kind, (counts.get(action.kind) ?? 0) + 1);
  }

  if (counts.size === 0) return ['Nenhuma ação — a origem não produziu nada migrável.'];

  return [
    '| Tipo | Quantidade |',
    '| --- | --- |',
    ...[...counts.entries()].map(([kind, count]) => `| ${ACTION_LABELS[kind]} | ${String(count)} |`),
    `| **Total** | **${String(actions.length)}** |`,
  ];
}

function renderFindings(findings: PlanFinding[]): string[] {
  return findings.map((finding) => {
    const subject = finding.relatedSourceRef;
    const where =
      subject === undefined ? '' : ` — [${subject.humanRef}](${subject.url})`;
    const hint = FINDING_HINTS[finding.code];
    const suffix = hint === undefined ? '' : ` _${hint}_`;
    return `- \`${finding.code}\`${where}: ${finding.message}${suffix}`;
  });
}

function renderFailures(failures: FailedOutcome[]): string[] {
  return [
    '| Ação | Origem | Código | Tentativas | Erro |',
    '| --- | --- | --- | --- | --- |',
    ...failures.map((failure) => {
      const code = failure.error.retryable
        ? `${failure.error.code} (retentável)`
        : failure.error.code;
      return `| ${ACTION_LABELS[failure.action.kind]} | ${sourceLink(failure.action)} | \`${code}\` | ${String(failure.attempts)} | ${escapePipes(failure.error.message)} |`;
    }),
  ];
}

function sourceLink(action: PlanAction): string {
  if (action.kind === 'create_component' || action.kind === 'create_label') {
    return `\`${action.name}\``;
  }
  return `[${action.sourceRef.humanRef}](${action.sourceRef.url})`;
}

/** Pipe cru quebraria a tabela markdown. */
function escapePipes(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}
