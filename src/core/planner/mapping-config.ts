import type { IssuePriority, IssueStatus, IssueType } from '../models/common.js';

/**
 * Regras de tradução origem → destino consumidas pelo Planner.
 *
 * Carregada do YAML na Fase de Config; aqui existe apenas o contrato que o
 * Planner consome. Todos os `Record` são totais sobre o enum neutro — não há
 * "tipo sem mapeamento", só mapeamento que aponta para um valor inexistente no
 * destino (detectado contra `TargetCapabilities` e reportado como
 * `unmapped_value`).
 */
export interface MappingConfig {
  /** Tipo neutro → nome do tipo de issue no destino. */
  issueTypes: Record<IssueType, string>;
  /** Prioridade neutra → nome da prioridade no destino. */
  priorities: Record<IssuePriority, string>;
  /** Status neutro → nome do status no destino. */
  statuses: Record<IssueStatus, string>;
  /** Como materializar milestones: como épico ou como versão do projeto. */
  milestoneStrategy: 'epic' | 'version';
  /**
   * Prioridade usada quando a issue de origem não tem nenhuma.
   * Ausente = issue fica sem prioridade no destino.
   */
  // `| undefined` explícito: este tipo é preenchido direto pelo output do Zod,
  // que sempre inclui `undefined` em campo opcional.
  defaultPriority?: IssuePriority | undefined;
  /**
   * Valores para campos do destino, por id de campo (`customfield_10042`).
   *
   * É o único canal capaz de satisfazer custom field obrigatório: sem isso,
   * qualquer projeto com campo obrigatório customizado produz
   * `missing_required_field` e bloqueia o `apply`. `byIssueType` sobrescreve
   * `defaults` e é indexado pelo NOME do tipo no destino.
   */
  fields?:
    | {
        defaults?: Record<string, unknown> | undefined;
        byIssueType?: Record<string, Record<string, unknown>> | undefined;
      }
    | undefined;
}

/** Junta `defaults` + `byIssueType[targetType]`, com o específico vencendo. */
export function resolveFieldsFor(
  config: MappingConfig,
  targetIssueType: string,
): Record<string, unknown> {
  return {
    ...(config.fields?.defaults ?? {}),
    ...(config.fields?.byIssueType?.[targetIssueType] ?? {}),
  };
}
