import { MigrationError } from '../errors.js';
import type { Person, SourceRef } from '../models/common.js';
import type { Comment, Issue, IssueModel, Milestone } from '../models/issue-model.js';
import type { Logger } from '../executor/executor.js';
import type { AttachmentFetcher, AttachmentPayload } from '../ports/attachment-fetcher.js';
import type { Sleeper } from '../ports/clock.js';
import type { ExtractOptions, SourceAdapter } from '../ports/source-adapter.js';
import type {
  CreateAttachmentInput,
  CreateCommentInput,
  CreateComponentInput,
  CreateEpicInput,
  CreateIssueInput,
  CreateLabelInput,
  CreateLinkInput,
  CreateVersionInput,
  FindExistingCriteria,
  TargetAdapter,
  TargetCapabilities,
  TargetItemRef,
} from '../ports/target-adapter.js';
import type { MappingConfig } from '../planner/mapping-config.js';

/** Fixtures in-memory. Nada aqui toca rede ou disco. */

export function ref(kind: string, id: string): SourceRef {
  return {
    platform: 'fake',
    id: `fake:acme/api:${kind}:${id}`,
    humanRef: `#${id}`,
    url: `https://example.test/${kind}/${id}`,
  };
}

export function person(displayName: string, email?: string): Person {
  return { displayName, ...(email === undefined ? {} : { email }) };
}

export interface IssueOptions extends Partial<Omit<Issue, 'sourceRef'>> {
  id: string;
}

export function makeIssue(options: IssueOptions): Issue {
  const { id, ...rest } = options;
  return {
    sourceRef: ref('issue', id),
    title: `Issue ${id}`,
    body: `Corpo da issue ${id}`,
    type: 'task',
    status: 'open',
    labels: [],
    assignees: [],
    author: person('Ana Souza', 'ana@example.test'),
    createdAt: '2026-01-01T00:00:00Z',
    comments: [],
    attachments: [],
    links: [],
    checklist: [],
    ...rest,
  };
}

export function makeComment(id: string, body = 'comentário'): Comment {
  return {
    sourceRef: ref('comment', id),
    author: person('Bruno Lima'),
    body,
    createdAt: '2026-01-02T00:00:00Z',
    attachments: [],
  };
}

export function makeMilestone(id: string, title: string, dueOn?: string): Milestone {
  return {
    sourceRef: ref('milestone', id),
    title,
    state: 'open',
    ...(dueOn === undefined ? {} : { dueOn }),
  };
}

export function makeModel(overrides: Partial<IssueModel> = {}): IssueModel {
  return {
    source: { platform: 'fake', identifier: 'acme/api', extractedAt: '2026-01-10T00:00:00Z' },
    issues: [],
    milestones: [],
    labels: [],
    ...overrides,
  };
}

export function makeCapabilities(
  overrides: Partial<TargetCapabilities> = {},
): TargetCapabilities {
  return {
    issueTypes: ['Epic', 'Story', 'Task', 'Bug', 'Sub-task'],
    priorities: ['Highest', 'High', 'Medium', 'Low', 'Lowest'],
    workflow: {
      statuses: ['To Do', 'In Progress', 'Done'],
      transitions: {
        'To Do': ['In Progress', 'Done'],
        'In Progress': ['Done', 'To Do'],
        Done: ['To Do'],
      },
    },
    components: [],
    versions: [],
    labels: [],
    requiredFieldsByIssueType: {},
    customFields: [],
    ...overrides,
  };
}

export function makeMappingConfig(overrides: Partial<MappingConfig> = {}): MappingConfig {
  return {
    issueTypes: {
      epic: 'Epic',
      story: 'Story',
      task: 'Task',
      bug: 'Bug',
      subtask: 'Sub-task',
    },
    priorities: {
      highest: 'Highest',
      high: 'High',
      medium: 'Medium',
      low: 'Low',
      lowest: 'Lowest',
    },
    statuses: { open: 'To Do', in_progress: 'In Progress', closed: 'Done' },
    milestoneStrategy: 'epic',
    ...overrides,
  };
}

/** `AttachmentFetcher` in-memory: devolve bytes determinísticos por URL. */
export class FakeAttachmentFetcher implements AttachmentFetcher {
  readonly requested: string[] = [];

  fetch(url: string, filename: string): Promise<AttachmentPayload> {
    this.requested.push(url);
    return Promise.resolve({
      filename,
      contentType: 'image/png',
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    });
  }
}

/** `SourceAdapter` in-memory: devolve um modelo fixo e registra as opções recebidas. */
export class FakeSourceAdapter implements SourceAdapter {
  readonly platformName = 'fake-source';
  readonly extractCalls: ExtractOptions[] = [];
  authenticated = false;

  constructor(private readonly model: IssueModel) {}

  authenticate(): Promise<void> {
    this.authenticated = true;
    return Promise.resolve();
  }

  extract(options: ExtractOptions): Promise<IssueModel> {
    this.extractCalls.push(options);
    return Promise.resolve(this.model);
  }
}

/** `Sleeper` que não dorme: registra as esperas e resolve na hora. */
export class RecordingSleeper implements Sleeper {
  readonly delays: number[] = [];

  sleep(ms: number): Promise<void> {
    this.delays.push(ms);
    return Promise.resolve();
  }
}

/** Logger que só acumula — permite assertar avisos sem poluir a saída do teste. */
export class RecordingLogger implements Logger {
  readonly infos: string[] = [];
  readonly warns: string[] = [];
  readonly errors: string[] = [];

  info(message: string): void {
    this.infos.push(message);
  }

  warn(message: string): void {
    this.warns.push(message);
  }

  error(message: string): void {
    this.errors.push(message);
  }
}

/**
 * `TargetAdapter` in-memory. Registra a ordem exata das chamadas e permite
 * programar falhas por id de origem, sem nenhum mock de rede.
 */
export class FakeTargetAdapter implements TargetAdapter {
  readonly platformName = 'fake-target';
  /** Chamadas na ordem em que ocorreram: `<método>:<identificador>`. */
  readonly calls: string[] = [];
  /** Ids de origem cuja criação falha de forma PERMANENTE (não-retentável). */
  readonly failingSourceIds = new Set<string>();
  /** Id de origem → quantas vezes falhar com erro TRANSITÓRIO antes de dar certo. */
  readonly transientFailures = new Map<string, number>();
  /** Quando true, `createLink` devolve `null` (destino sem referência de link). */
  linkReturnsNull = false;
  /** Tamanho de cada anexo recebido — prova que o conteúdo chegou, não a URL. */
  readonly uploadedBytes: number[] = [];

  private counter = 0;

  authenticate(): Promise<void> {
    this.calls.push('authenticate:');
    return Promise.resolve();
  }

  discoverCapabilities(projectKey: string): Promise<TargetCapabilities> {
    this.calls.push(`discoverCapabilities:${projectKey}`);
    return Promise.resolve(makeCapabilities());
  }

  findExisting(criteria: FindExistingCriteria): Promise<TargetItemRef | null> {
    this.calls.push(`findExisting:${criteria.kind}`);
    return Promise.resolve(null);
  }

  createEpic(input: CreateEpicInput): Promise<TargetItemRef> {
    return this.record('createEpic', input.sourceRef.id);
  }

  createVersion(input: CreateVersionInput): Promise<TargetItemRef> {
    return this.record('createVersion', input.sourceRef.id);
  }

  createComponent(input: CreateComponentInput): Promise<TargetItemRef> {
    return this.record('createComponent', input.name);
  }

  createLabel(input: CreateLabelInput): Promise<TargetItemRef> {
    return this.record('createLabel', input.name);
  }

  createIssue(input: CreateIssueInput): Promise<TargetItemRef> {
    return this.record('createIssue', input.sourceRef.id);
  }

  createComment(input: CreateCommentInput): Promise<TargetItemRef> {
    // O `@<issueRef>` deixa a resolução de dependência visível nos testes.
    return this.record('createComment', `${input.sourceRef.id}@${input.issueRef.id}`);
  }

  createAttachment(input: CreateAttachmentInput): Promise<TargetItemRef> {
    this.uploadedBytes.push(input.payload.bytes.length);
    return this.record('createAttachment', `${input.sourceRef.id}@${input.issueRef.id}`);
  }

  async createLink(input: CreateLinkInput): Promise<TargetItemRef | null> {
    const created = await this.record(
      'createLink',
      `${input.fromRef.id}->${input.toRef.id}:${input.linkType}`,
    );
    return this.linkReturnsNull ? null : created;
  }

  transitionIssue(issueRef: TargetItemRef, targetStatus: string): Promise<void> {
    this.calls.push(`transitionIssue:${issueRef.id}:${targetStatus}`);
    if (this.failingSourceIds.has(issueRef.id)) {
      return Promise.reject(
        new MigrationError({ code: 'validation', message: `transição rejeitada (${issueRef.id})` }),
      );
    }
    return Promise.resolve();
  }

  private record(method: string, identifier: string): Promise<TargetItemRef> {
    this.calls.push(`${method}:${identifier}`);
    // Aceita falhar por id de origem puro, mesmo quando o identificador
    // registrado carrega a referência resolvida (`<sourceId>@<targetId>`).
    const sourceId = identifier.split('@')[0] ?? identifier;

    const remaining = this.transientFailures.get(sourceId) ?? this.transientFailures.get(identifier);
    if (remaining !== undefined && remaining > 0) {
      this.transientFailures.set(sourceId, remaining - 1);
      return Promise.reject(
        new MigrationError({
          code: 'transient',
          message: `falha transitória programada em ${method} (${identifier})`,
        }),
      );
    }

    if (this.failingSourceIds.has(identifier) || this.failingSourceIds.has(sourceId)) {
      return Promise.reject(
        new MigrationError({
          code: 'validation',
          message: `falha permanente programada em ${method} (${identifier})`,
        }),
      );
    }
    this.counter += 1;
    const id = `TGT-${String(this.counter)}`;
    return Promise.resolve({ id, humanRef: id, url: `https://target.test/${id}` });
  }
}
