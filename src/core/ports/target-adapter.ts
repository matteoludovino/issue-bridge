import type { SourceRef } from '../models/common.js';
import type { AttachmentPayload } from './attachment-fetcher.js';

export interface CustomFieldDescriptor {
  id: string;
  name: string;
  type: string;
}

/**
 * Retrato do destino descoberto em runtime. É a segunda entrada do Planner e o
 * motivo pelo qual o planejamento pode ser puro: o core nunca assume tipos,
 * status ou campos obrigatórios.
 *
 * Convenções:
 *  - `workflow.statuses[0]` é o status inicial de uma issue recém-criada.
 *  - `workflow.transitions` mapeia status atual → status alcançáveis a partir dele.
 *  - `requiredFieldsByIssueType` é indexado pelo NOME do tipo no destino e lista
 *    ids/nomes de campo obrigatórios (`summary`, `customfield_10042`).
 */
export interface TargetCapabilities {
  issueTypes: string[];
  priorities: string[];
  workflow: {
    statuses: string[];
    transitions: Record<string, string[]>;
  };
  components: string[];
  versions: string[];
  labels: string[];
  requiredFieldsByIssueType: Record<string, string[]>;
  customFields: CustomFieldDescriptor[];
}

/**
 * Referência a um item já existente no destino.
 *
 * `url` admite `undefined` explícito porque este tipo atravessa fronteiras Zod
 * (ledger em JSON, log de execução), e o output do Zod sempre inclui `undefined`
 * em campo opcional. Nenhum consumidor distingue "ausente" de "undefined".
 */
export interface TargetItemRef {
  id: string;
  humanRef: string;
  url?: string | undefined;
}

export type TargetItemKind = 'issue' | 'epic' | 'version' | 'component' | 'label';

/**
 * Critério de busca por item pré-existente no destino. Usado para reconciliar
 * migrações parciais quando o RollbackStore foi perdido.
 */
export interface FindExistingCriteria {
  kind: TargetItemKind;
  projectKey: string;
  /** Entidade de origem que se procura no destino (via marcador de proveniência). */
  sourceRef?: SourceRef;
  /** Nome exato, para catálogos (versão, componente, label, épico). */
  name?: string;
  /** Título exato, para issues. */
  summary?: string;
}

export interface CreateEpicInput {
  projectKey: string;
  name: string;
  description?: string;
  /** Campos extras por id de campo do destino (inclui custom fields). */
  fields: Record<string, unknown>;
  sourceRef: SourceRef;
}

export interface CreateVersionInput {
  projectKey: string;
  name: string;
  description?: string;
  releaseDate?: string;
  sourceRef: SourceRef;
}

export interface CreateComponentInput {
  projectKey: string;
  name: string;
  description?: string;
}

export interface CreateLabelInput {
  projectKey: string;
  name: string;
}

export interface CreateIssueInput {
  projectKey: string;
  issueType: string;
  summary: string;
  description: string;
  priority?: string;
  labels: string[];
  assignees: string[];
  /** Referências já resolvidas pelo Executor via RollbackStore. */
  epicRef?: TargetItemRef;
  versionRef?: TargetItemRef;
  parentRef?: TargetItemRef;
  fields: Record<string, unknown>;
  sourceRef: SourceRef;
}

export interface CreateCommentInput {
  issueRef: TargetItemRef;
  body: string;
  sourceRef: SourceRef;
}

export interface CreateAttachmentInput {
  issueRef: TargetItemRef;
  /**
   * Conteúdo já baixado pelo Executor via `AttachmentFetcher`. O adapter de
   * destino NÃO acessa a origem — não conhece a URL nem a credencial dela.
   */
  payload: AttachmentPayload;
  /** URL de origem, apenas para diagnóstico e proveniência. */
  sourceUrl: string;
  sourceRef: SourceRef;
}

export interface CreateLinkInput {
  fromRef: TargetItemRef;
  toRef: TargetItemRef;
  linkType: string;
}

/**
 * Porta de escrita. Um novo destino (Azure DevOps, Linear) implementa apenas
 * esta interface.
 *
 * Contrato:
 *  - Cada método é uma escrita única e atômica do ponto de vista do Executor;
 *    o adapter NÃO faz retry nem batching (isso é política do Executor).
 *  - `discoverCapabilities()` é a única fonte de verdade sobre o destino.
 *  - Erros são lançados como `MigrationError` para o Executor classificar.
 */
export interface TargetAdapter {
  /** Identificador da plataforma (`jira`). */
  readonly platformName: string;

  authenticate(): Promise<void>;

  discoverCapabilities(projectKey: string): Promise<TargetCapabilities>;

  findExisting(criteria: FindExistingCriteria): Promise<TargetItemRef | null>;

  createEpic(input: CreateEpicInput): Promise<TargetItemRef>;

  createVersion(input: CreateVersionInput): Promise<TargetItemRef>;

  createComponent(input: CreateComponentInput): Promise<TargetItemRef>;

  createLabel(input: CreateLabelInput): Promise<TargetItemRef>;

  createIssue(input: CreateIssueInput): Promise<TargetItemRef>;

  createComment(input: CreateCommentInput): Promise<TargetItemRef>;

  createAttachment(input: CreateAttachmentInput): Promise<TargetItemRef>;

  createLink(input: CreateLinkInput): Promise<TargetItemRef | null>;

  transitionIssue(issueRef: TargetItemRef, targetStatus: string): Promise<void>;
}
