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
  /** Inject in tests; production uses the global `fetch`. */
  httpClient?: HttpClient;
  /** Name of the issue type used for epics in this project. */
  epicIssueTypeName?: string;
  /** Canonical link type → Jira link type name. */
  linkTypeNames?: Partial<Record<LinkType, string>>;
  /** Receives degradation warnings (e.g. an assignee with no match). */
  logger?: Logger;
}

/** Default Jira link type names. */
const DEFAULT_LINK_TYPE_NAMES: Record<LinkType, string> = {
  blocks: 'Blocks',
  blocked_by: 'Blocks',
  duplicates: 'Duplicate',
  duplicated_by: 'Duplicate',
  relates_to: 'Relates',
  parent_of: 'Relates',
  child_of: 'Relates',
};

/** Jira's length limit for `summary`. */
const MAX_SUMMARY_LENGTH = 255;

/**
 * Implements `TargetAdapter` on top of Jira Cloud REST v3, without an SDK.
 *
 * Structural decisions:
 *  - `createLabel` is a no-op: a Jira label is a free-form string on the issue, not an entity.
 *  - An epic is an issue of the type configured in `epicIssueTypeName`; the association
 *    goes through the `parent` field, as in Jira's current hierarchy model.
 *  - The capabilities' `workflow.transitions` is OPTIMISTIC (see `discoverCapabilities`).
 *  - No write is retried: retry policy belongs to the Executor.
 */
export class JiraTargetAdapter implements TargetAdapter {
  readonly platformName = 'jira';

  private readonly http: JiraHttp;
  private readonly baseUrl: string;
  private readonly epicIssueTypeName: string;
  /** Accepts `string` keys because `CreateLinkInput.linkType` is a string in the port. */
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
   * Builds a snapshot of the target project.
   *
   * Caveat: the Jira Cloud REST API does NOT expose the transition graph without
   * an existing issue (transitions are queried per issue). Therefore
   * `workflow.transitions` is optimistic — every status is declared reachable
   * from any other. The real validation happens in `transitionIssue`,
   * which lists the issue's transitions and fails with the available list if the
   * requested status is not there. Without this, the Planner would emit `unreachable_status`
   * for every issue not in the initial status.
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

    // Order preserved: the first status of the first type is the initial status,
    // and the Planner uses `statuses[0]` with exactly that meaning.
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

    // Global label list; some projects deny access — degrading is better
    // than failing the whole discovery.
    const labels = await this.tryOr(
      async () =>
        (await this.http.get('/rest/api/3/label?maxResults=1000', JiraLabelsSchema)).values,
      [],
      'could not list Jira labels; the plan will try to create all of them',
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

  /** An epic is an issue of type `epicIssueTypeName`; there is no dedicated endpoint. */
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
        // Jira only accepts `YYYY-MM-DD` here.
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
   * Deliberate no-op: in Jira a label is a free-form string stored on the issue — there
   * is no entity to create. The returned reference only serves the ledger.
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

    // Jira has ONE `parent` field. A direct parent wins over the epic; the Planner
    // already avoids sending both (see `buildPlan`).
    const parent = input.parentRef ?? input.epicRef;
    if (parent !== undefined) fields['parent'] = { id: parent.id };

    const assigneeId = await this.resolveAssignee(input.assignees);
    if (assigneeId !== null) fields['assignee'] = { id: assigneeId };

    // The plan's custom fields go last: they may override any default.
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
    return { id: created.id, humanRef: `${input.issueRef.humanRef} · comment ${created.id}` };
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
        message: `Jira accepted attachment "${input.payload.filename}" but returned no reference.`,
        subjectKey: input.sourceRef.id,
      });
    }
    return { id: attachment.id, humanRef: attachment.filename ?? input.payload.filename };
  }

  /**
   * `POST /issueLink` responds 201 with no body, so there is no reference to return
   * — the Executor records its own marker in the ledger.
   */
  async createLink(input: CreateLinkInput): Promise<TargetItemRef | null> {
    await this.http.postVoid('/rest/api/3/issueLink', {
      type: { name: this.linkTypeNames[input.linkType] ?? 'Relates' },
      // In Jira's vocabulary, `outwardIssue` is the active side ("blocks",
      // "duplicates") and `inwardIssue` the passive side.
      outwardIssue: { id: input.fromRef.id },
      inwardIssue: { id: input.toRef.id },
    });
    return null;
  }

  /**
   * One transition per call (no multi-step path). If the requested status is not
   * available, the message lists the issue's actual options — the diagnosis
   * that `analyze` cannot provide, because the workflow cannot be introspected
   * without an issue.
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
        message: `Status "${targetStatus}" is not reachable in a single step for ${issueRef.humanRef}. Available: ${
          available.transitions.map((transition) => transition.to.name).join(', ') || 'none'
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

  /** First resolvable assignee. Jira accepts a single assignee per issue. */
  private async resolveAssignee(assignees: string[]): Promise<string | null> {
    for (const identifier of assignees) {
      const accountId = await this.resolveAccountId(identifier);
      if (accountId !== null) return accountId;
      this.logger?.warn('Assignee has no match in Jira; the issue will be created unassigned', {
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
        `user search failed for "${identifier}"`,
      );
      accountId = found[0]?.accountId ?? null;
    }

    this.accountIdCache.set(identifier, accountId);
    return accountId;
  }

  /** Degrades instead of failing the whole operation, logging the reason. */
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

/** Jira labels do not accept spaces. */
function sanitizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, '-');
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function escapeJql(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Atlassian accountId: 24 hex chars, or `<siteId>:<uuid>` for newer accounts. */
function looksLikeAccountId(value: string): boolean {
  return /^[0-9a-f]{24}$/i.test(value) || /^\d{5,7}:[0-9a-f-]{36}$/i.test(value);
}
