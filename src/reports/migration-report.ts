import type { ExecutionResult, FailedOutcome } from '../core/executor/executor.js';
import type {
  MigrationPlan,
  PlanAction,
  PlanFinding,
  PlanFindingCode,
} from '../core/models/migration-plan.js';

/**
 * Markdown report generation. PURE functions: they take a plan and a result and
 * return a string. No I/O and no system clock, which is what makes the whole
 * content testable and the report reproducible from its inputs.
 */

const ACTION_LABELS: Record<PlanAction['kind'], string> = {
  create_epic: 'Epics',
  create_version: 'Versions',
  create_component: 'Components',
  create_label: 'Labels',
  create_issue: 'Issues',
  create_comment: 'Comments',
  create_attachment: 'Attachments',
  create_link: 'Links',
  transition_issue: 'Transitions',
};

const FINDING_HINTS: Partial<Record<PlanFindingCode, string>> = {
  missing_required_field: 'Provide a value under `mappings.fields` in the configuration file.',
  unmapped_value: 'Point `mappings` at a value that exists in the target.',
  dependency_cycle: 'Fix the hierarchy in the source; the issues in the cycle were left out.',
  unreachable_status: 'The target workflow may require intermediate steps.',
  hierarchy_conflict: 'The target accepts a single parent per issue.',
};

/** The `analyze` report: what will be done, and what blocks it. */
export function renderPlanReport(plan: MigrationPlan): string {
  const errors = plan.findings.filter((finding) => finding.severity === 'error');
  const warnings = plan.findings.filter((finding) => finding.severity === 'warning');
  const infos = plan.findings.filter((finding) => finding.severity === 'info');

  const lines: string[] = [
    '# Migration report — plan',
    '',
    `- **Source:** \`${plan.model.source.platform}:${plan.model.source.identifier}\``,
    `- **Target:** project \`${plan.targetProjectKey}\``,
    `- **Extracted at:** ${plan.model.source.extractedAt}`,
    `- **Plan generated at:** ${plan.generatedAt}`,
    `- **Issues in source:** ${String(plan.model.issues.length)}`,
    '',
    errors.length > 0
      ? `> **Plan blocked:** ${String(errors.length)} error(s) must be resolved before \`apply\`.`
      : '> Plan is valid: no blocking errors.',
    '',
    '## Planned actions',
    '',
    ...renderActionTable(plan.actions),
    '',
  ];

  if (errors.length > 0) {
    lines.push('## Errors (these block apply)', '', ...renderFindings(errors), '');
  }
  if (warnings.length > 0) {
    lines.push('## Warnings', '', ...renderFindings(warnings), '');
  }
  if (infos.length > 0) {
    lines.push('## Notes', '', ...renderFindings(infos), '');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/** The `apply` report: what actually happened, with the source → target map. */
export function renderExecutionReport(plan: MigrationPlan, result: ExecutionResult): string {
  const total = result.succeeded.length + result.skipped.length + result.failed.length;
  const retried = result.succeeded.filter((outcome) => outcome.attempts > 1);

  const lines: string[] = [
    `# Migration report — ${result.dryRun ? 'simulation' : 'execution'}`,
    '',
    `- **Source:** \`${plan.model.source.platform}:${plan.model.source.identifier}\``,
    `- **Target:** project \`${plan.targetProjectKey}\``,
    `- **Started:** ${result.startedAt}`,
    `- **Finished:** ${result.finishedAt}`,
    result.dryRun
      ? '- **Mode:** simulation — nothing was written to the target.'
      : '- **Mode:** real execution.',
    '',
    '## Summary',
    '',
    '| Outcome | Actions |',
    '| --- | --- |',
    `| Completed | ${String(result.succeeded.length)} |`,
    `| Skipped (already migrated) | ${String(result.skipped.length)} |`,
    `| Failed | ${String(result.failed.length)} |`,
    `| **Total** | **${String(total)}** |`,
    '',
  ];

  if (retried.length > 0) {
    lines.push(
      `${String(retried.length)} action(s) only succeeded after a retry — a sign of rate limiting or API instability.`,
      '',
    );
  }

  if (result.failed.length > 0) {
    lines.push('## Failures', '', ...renderFailures(result.failed), '');
  }

  const created = result.succeeded.filter(
    (outcome) => outcome.action.kind === 'create_issue' || outcome.action.kind === 'create_epic',
  );
  if (created.length > 0) {
    lines.push(
      '## Source → target mapping',
      '',
      '| Source | Target |',
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
    lines.push('## Not migrated', '', ...notMigrated.map((finding) => `- ${finding.message}`), '');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function renderActionTable(actions: PlanAction[]): string[] {
  const counts = new Map<PlanAction['kind'], number>();
  for (const action of actions) {
    counts.set(action.kind, (counts.get(action.kind) ?? 0) + 1);
  }

  if (counts.size === 0) return ['No actions — the source produced nothing migratable.'];

  return [
    '| Kind | Count |',
    '| --- | --- |',
    ...[...counts.entries()].map(([kind, count]) => `| ${ACTION_LABELS[kind]} | ${String(count)} |`),
    `| **Total** | **${String(actions.length)}** |`,
  ];
}

function renderFindings(findings: PlanFinding[]): string[] {
  return findings.map((finding) => {
    const subject = finding.relatedSourceRef;
    const where = subject === undefined ? '' : ` — [${subject.humanRef}](${subject.url})`;
    const hint = FINDING_HINTS[finding.code];
    const suffix = hint === undefined ? '' : ` _${hint}_`;
    return `- \`${finding.code}\`${where}: ${finding.message}${suffix}`;
  });
}

function renderFailures(failures: FailedOutcome[]): string[] {
  return [
    '| Action | Source | Code | Attempts | Error |',
    '| --- | --- | --- | --- | --- |',
    ...failures.map((failure) => {
      const code = failure.error.retryable
        ? `${failure.error.code} (retryable)`
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

/** A raw pipe would break the markdown table. */
function escapePipes(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}
