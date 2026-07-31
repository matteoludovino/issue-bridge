import { MigrationError } from '../../core/errors.js';
import type { LinkType } from '../../core/models/common.js';
import type { Logger } from '../../core/executor/executor.js';
import type {
  CreateAttachmentInput,
  CreateCommentInput,
  CreateComponentInput,
  CreateEpicInput,
  CreateIssueInput,
  CreateLabelInput,
  CreateLinkInput,
  CreateVersionInput,
  CustomFieldDescriptor,
  FindExistingCriteria,
  TargetAdapter,
  TargetCapabilities,
  TargetItemRef,
} from '../../core/ports/target-adapter.js';
import { FetchHttpClient, type HttpClient } from '../http.js';
import { markdownToAdf } from './adf.js';
import { JiraHttp, type JiraHttpOptions } from './http.js';
import {
  JiraAttachmentsSchema,
  JiraCreateMetaFieldsSchema,
  JiraCreateMetaIssueTypesSchema,
  JiraCreatedCommentSchema,
  JiraCreatedIssueSchema,
  JiraLabelsSchema,
  JiraMyselfSchema,
  JiraNamedSchema,
  JiraProjectSchema,
  JiraProjectStatusesSchema,
  JiraSearchSchema,
  JiraTransitionsSchema,
  JiraUserSearchSchema,
} from './schemas.js';
import { z } from 'zod';

export interface JiraTargetAdapterOptions extends JiraHttpOptions {
  /** Injete nos testes; em produção usa o `fetch` global. */
  httpClient?: HttpClient;
  /** Nome do tipo de issue usado para épicos neste projeto. */
  epicIssueTypeName?: string;
  /** Tipo canônico de link → nome do tipo de link no Jira. */
  linkTypeNames?: Partial<Record<LinkType, string>>;
  /** Recebe avisos de degradação (ex.: assignee sem correspondente). */
  logger?: Logger;
}

/** Nomes padrão dos tipos de link no Jira. */
const DEFAULT_LINK_TYPE_NAMES: Record<LinkType, string> = {
  blocks: 'Blocks',
  blocked_by: 'Blocks',
  duplicates: 'Duplicate',
  duplicated_by: 'Duplicate',
  relates_to: 'Relates',
  parent_of: 'Relates',
  child_of: 'Relates',
};

/** Limite de `summary` no Jira. */
const MAX_SUMMARY_LENGTH = 255;

/**
 * Implementa `TargetAdapter` sobre a REST v3 do Jira Cloud, sem SDK.
 *
 * Decisões estruturais:
 *  - `createLabel` é no-op: label no Jira é string livre na issue, não entidade.
 *  - Épico é uma issue do tipo configurado em `epicIssueTypeName`; a associação
 *    acontece pelo campo `parent`, como no modelo de hierarquia atual do Jira.
 *  - `workflow.transitions` das capabilities é OTIMISTA (ver `discoverCapabilities`).
 *  - Nenhuma escrita faz retry: política de retry é do Executor.
 */
export class JiraTargetAdapter implements TargetAdapter {
  readonly platformName = 'jira';

  private readonly http: JiraHttp;
  private readonly baseUrl: string;
  private readonly epicIssueTypeName: string;
  /** Aceita chave `string` porque `CreateLinkInput.linkType` é string no port. */
  private readonly linkTypeNames: Record<string, string>;
  private readonly logger: Logger | undefined;
  private readonly accountIdCache = new Map<string, string | null>();
  private readonly projectIdCache = new Map<string, string>();

  constructor(options: JiraTargetAdapterOptions) {
    const { httpClient, epicIssueTypeName, linkTypeNames, logger, ...httpOptions } = options;
    this.http = new JiraHttp(httpClient ?? new FetchHttpClient(), httpOptions);
    this.baseUrl = httpOptions.baseUrl.replace(/\/+$/, '');
    this.epicIssueTypeName = epicIssueTypeName ?? 'Epic';
    this.linkTypeNames = { ...DEFAULT_LINK_TYPE_NAMES, ...linkTypeNames };
    this.logger = logger;
  }

  async authenticate(): Promise<void> {
    await this.http.get('/rest/api/3/myself', JiraMyselfSchema);
  }

  /**
   * Monta o retrato do projeto de destino.
   *
   * Ponto de atenção: a REST do Jira Cloud NÃO expõe o grafo de transições sem
   * uma issue existente (transições são consultadas por issue). Portanto
   * `workflow.transitions` é otimista — todo status é declarado alcançável a
   * partir de qualquer outro. A validação real acontece em `transitionIssue`,
   * que lista as transições da issue e falha com a lista disponível se o status
   * pedido não estiver lá. Sem isso, o Planner emitiria `unreachable_status`
   * para toda issue não-inicial.
   */
  async discoverCapabilities(projectKey: string): Promise<TargetCapabilities> {
    const project = await this.http.get(
      `/rest/api/3/project/${encodeURIComponent(projectKey)}`,
      JiraProjectSchema,
    );
    this.projectIdCache.set(project.key, project.id);

    const meta = await this.http.get(
      `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes?maxResults=100`,
      JiraCreateMetaIssueTypesSchema,
    );

    const requiredFieldsByIssueType: Record<string, string[]> = {};
    const customFields = new Map<string, CustomFieldDescriptor>();

    for (const issueType of meta.issueTypes) {
      const fields = await this.http.get(
        `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${issueType.id}?maxResults=200`,
        JiraCreateMetaFieldsSchema,
      );

      requiredFieldsByIssueType[issueType.name] = fields.fields
        .filter((field) => field.required)
        .map((field) => field.fieldId);

      for (const field of fields.fields) {
        if (field.schema?.custom === null || field.schema?.custom === undefined) continue;
        customFields.set(field.fieldId, {
          id: field.fieldId,
          name: field.name,
          type: field.schema.type ?? 'unknown',
        });
      }
    }

    const priorities = await this.http.get('/rest/api/3/priority', z.array(JiraNamedSchema));
    const statusesByType = await this.http.get(
      `/rest/api/3/project/${encodeURIComponent(projectKey)}/statuses`,
      JiraProjectStatusesSchema,
    );

    // Ordem preservada: o primeiro status do primeiro tipo é o status inicial,
    // e o Planner usa `statuses[0]` exatamente com esse significado.
    const statuses: string[] = [];
    for (const type of statusesByType) {
      for (const status of type.statuses) {
        if (!statuses.includes(status.name)) statuses.push(status.name);
      }
    }

    const transitions: Record<string, string[]> = {};
    for (const status of statuses) {
      transitions[status] = statuses.filter((candidate) => candidate !== status);
    }

    // Lista global de labels; alguns projetos negam acesso — degradar é melhor
    // que falhar a descoberta inteira.
    const labels = await this.tryOr(
      async () =>
        (await this.http.get('/rest/api/3/label?maxResults=1000', JiraLabelsSchema)).values,
      [],
      'não foi possível listar labels do Jira; o plano vai tentar criar todas',
    );

    return {
      issueTypes: meta.issueTypes.map((issueType) => issueType.name),
      priorities: priorities.map((priority) => priority.name),
      workflow: { statuses, transitions },
      components: project.components.map((component) => component.name),
      versions: project.versions.map((version) => version.name),
      labels,
      requiredFieldsByIssueType,
      customFields: [...customFields.values()],
    };
  }

  async findExisting(criteria: FindExistingCriteria): Promise<TargetItemRef | null> {
    if (criteria.kind === 'label') return null;

    if (criteria.kind === 'version' || criteria.kind === 'component') {
      const project = await this.http.get(
        `/rest/api/3/project/${encodeURIComponent(criteria.projectKey)}`,
        JiraProjectSchema,
      );
      const pool = criteria.kind === 'version' ? project.versions : project.components;
      const found = pool.find((item) => item.name === criteria.name);
      return found === undefined ? null : { id: found.id, humanRef: found.name };
    }

    const summary = criteria.summary ?? criteria.name;
    if (summary === undefined) return null;

    const jql = `project = "${escapeJql(criteria.projectKey)}" AND summary ~ "${escapeJql(summary)}"`;
    const result = await this.http.get(
      `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=1&fields=id`,
      JiraSearchSchema,
    );
    const issue = result.issues[0];
    return issue === undefined ? null : this.issueRef(issue.id, issue.key);
  }

  /** Épico é uma issue do tipo `epicIssueTypeName`; não há endpoint dedicado. */
  createEpic(input: CreateEpicInput): Promise<TargetItemRef> {
    return this.createIssue({
      projectKey: input.projectKey,
      issueType: this.epicIssueTypeName,
      summary: input.name,
      description: input.description ?? '',
      labels: [],
      assignees: [],
      fields: input.fields,
      sourceRef: input.sourceRef,
    });
  }

  async createVersion(input: CreateVersionInput): Promise<TargetItemRef> {
    const projectId = await this.projectId(input.projectKey);
    const created = await this.http.post(
      '/rest/api/3/version',
      {
        name: input.name,
        projectId: Number(projectId),
        ...(input.description === undefined ? {} : { description: input.description }),
        // O Jira aceita apenas `YYYY-MM-DD` aqui.
        ...(input.releaseDate === undefined
          ? {}
          : { releaseDate: input.releaseDate.slice(0, 10) }),
      },
      JiraNamedSchema,
    );
    return { id: created.id, humanRef: created.name };
  }

  async createComponent(input: CreateComponentInput): Promise<TargetItemRef> {
    const created = await this.http.post(
      '/rest/api/3/component',
      {
        name: input.name,
        project: input.projectKey,
        ...(input.description === undefined ? {} : { description: input.description }),
      },
      JiraNamedSchema,
    );
    return { id: created.id, humanRef: created.name };
  }

  /**
   * No-op deliberado: no Jira, label é string livre gravada na issue — não existe
   * entidade a criar. A referência devolvida serve apenas para o ledger.
   */
  createLabel(input: CreateLabelInput): Promise<TargetItemRef> {
    return Promise.resolve({ id: input.name, humanRef: input.name });
  }

  async createIssue(input: CreateIssueInput): Promise<TargetItemRef> {
    const fields: Record<string, unknown> = {
      project: { key: input.projectKey },
      issuetype: { name: input.issueType },
      summary: truncate(input.summary, MAX_SUMMARY_LENGTH),
      description: markdownToAdf(input.description),
    };

    if (input.priority !== undefined) fields['priority'] = { name: input.priority };
    if (input.labels.length > 0) fields['labels'] = input.labels.map(sanitizeLabel);
    if (input.versionRef !== undefined) fields['fixVersions'] = [{ id: input.versionRef.id }];

    // O Jira tem UM campo `parent`. Hierarquia direta ganha do épico; o Planner
    // já evita mandar os dois (ver `buildPlan`).
    const parent = input.parentRef ?? input.epicRef;
    if (parent !== undefined) fields['parent'] = { id: parent.id };

    const assigneeId = await this.resolveAssignee(input.assignees);
    if (assigneeId !== null) fields['assignee'] = { id: assigneeId };

    // Custom fields do plano por último: podem sobrescrever qualquer default.
    Object.assign(fields, input.fields);

    const created = await this.http.post('/rest/api/3/issue', { fields }, JiraCreatedIssueSchema);
    return this.issueRef(created.id, created.key);
  }

  async createComment(input: CreateCommentInput): Promise<TargetItemRef> {
    const created = await this.http.post(
      `/rest/api/3/issue/${encodeURIComponent(input.issueRef.id)}/comment`,
      { body: markdownToAdf(input.body) },
      JiraCreatedCommentSchema,
    );
    return { id: created.id, humanRef: `${input.issueRef.humanRef} · comentário ${created.id}` };
  }

  async createAttachment(input: CreateAttachmentInput): Promise<TargetItemRef> {
    const created = await this.http.postFile(
      `/rest/api/3/issue/${encodeURIComponent(input.issueRef.id)}/attachments`,
      {
        filename: input.payload.filename,
        contentType: input.payload.contentType,
        bytes: input.payload.bytes,
      },
      JiraAttachmentsSchema,
    );

    const attachment = created[0];
    if (attachment === undefined) {
      throw new MigrationError({
        code: 'unknown',
        message: `Jira aceitou o anexo "${input.payload.filename}" mas não devolveu referência.`,
        subjectKey: input.sourceRef.id,
      });
    }
    return { id: attachment.id, humanRef: attachment.filename ?? input.payload.filename };
  }

  /**
   * `POST /issueLink` responde 201 sem corpo, então não há referência a devolver
   * — o Executor grava um marcador próprio no ledger.
   */
  async createLink(input: CreateLinkInput): Promise<TargetItemRef | null> {
    await this.http.postVoid('/rest/api/3/issueLink', {
      type: { name: this.linkTypeNames[input.linkType] ?? 'Relates' },
      // No vocabulário do Jira, `outwardIssue` é o lado ativo ("blocks",
      // "duplicates") e `inwardIssue` o lado passivo.
      outwardIssue: { id: input.fromRef.id },
      inwardIssue: { id: input.toRef.id },
    });
    return null;
  }

  /**
   * Uma transição por chamada (sem caminho multi-passo). Se o status pedido não
   * estiver disponível, a mensagem lista as opções reais da issue — é o
   * diagnóstico que o `analyze` não consegue dar, porque o workflow não é
   * introspectável sem issue.
   */
  async transitionIssue(issueRef: TargetItemRef, targetStatus: string): Promise<void> {
    const available = await this.http.get(
      `/rest/api/3/issue/${encodeURIComponent(issueRef.id)}/transitions`,
      JiraTransitionsSchema,
    );

    const match = available.transitions.find(
      (transition) => transition.to.name.toLowerCase() === targetStatus.toLowerCase(),
    );

    if (match === undefined) {
      throw new MigrationError({
        code: 'validation',
        message: `Status "${targetStatus}" não é alcançável em um passo para ${issueRef.humanRef}. Disponíveis: ${
          available.transitions.map((transition) => transition.to.name).join(', ') || 'nenhuma'
        }.`,
      });
    }

    await this.http.postVoid(`/rest/api/3/issue/${encodeURIComponent(issueRef.id)}/transitions`, {
      transition: { id: match.id },
    });
  }

  private issueRef(id: string, key: string): TargetItemRef {
    return { id, humanRef: key, url: `${this.baseUrl}/browse/${key}` };
  }

  private async projectId(projectKey: string): Promise<string> {
    const cached = this.projectIdCache.get(projectKey);
    if (cached !== undefined) return cached;

    const project = await this.http.get(
      `/rest/api/3/project/${encodeURIComponent(projectKey)}`,
      JiraProjectSchema,
    );
    this.projectIdCache.set(projectKey, project.id);
    return project.id;
  }

  /** Primeiro assignee resolvível. O Jira aceita um único assignee por issue. */
  private async resolveAssignee(assignees: string[]): Promise<string | null> {
    for (const identifier of assignees) {
      const accountId = await this.resolveAccountId(identifier);
      if (accountId !== null) return accountId;
      this.logger?.warn('Assignee sem correspondente no Jira; issue segue sem responsável', {
        identifier,
      });
    }
    return null;
  }

  private async resolveAccountId(identifier: string): Promise<string | null> {
    const cached = this.accountIdCache.get(identifier);
    if (cached !== undefined) return cached;

    let accountId: string | null = null;
    if (looksLikeAccountId(identifier)) {
      accountId = identifier;
    } else {
      const found = await this.tryOr(
        () =>
          this.http.get(
            `/rest/api/3/user/search?query=${encodeURIComponent(identifier)}&maxResults=2`,
            JiraUserSearchSchema,
          ),
        [],
        `busca de usuário falhou para "${identifier}"`,
      );
      accountId = found[0]?.accountId ?? null;
    }

    this.accountIdCache.set(identifier, accountId);
    return accountId;
  }

  /** Degrada em vez de derrubar a operação inteira, registrando o motivo. */
  private async tryOr<T>(operation: () => Promise<T>, fallback: T, warning: string): Promise<T> {
    try {
      return await operation();
    } catch (cause: unknown) {
      this.logger?.warn(warning, {
        cause: cause instanceof Error ? cause.message : String(cause),
      });
      return fallback;
    }
  }
}

/** Label do Jira não aceita espaço. */
function sanitizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, '-');
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function escapeJql(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** accountId da Atlassian: 24 hex, ou `<siteId>:<uuid>` para contas novas. */
function looksLikeAccountId(value: string): boolean {
  return /^[0-9a-f]{24}$/i.test(value) || /^\d{5,7}:[0-9a-f-]{36}$/i.test(value);
}
