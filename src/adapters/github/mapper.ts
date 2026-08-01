import type { LinkType, Person, SourceRef } from '../../core/models/common.js';
import type {
  Attachment,
  ChecklistItem,
  Comment,
  Issue,
  IssueLink,
  Label,
  Milestone,
} from '../../core/models/issue-model.js';
import { classifyPriority, classifyStatus, classifyType } from './classification.js';
import type { LabelClassification } from './classification.js';
import type { GitHubComment, GitHubIssue, GitHubLabel, GitHubMilestone, GitHubUser } from './schemas.js';

/**
 * Tradução GitHub → `IssueModel`. Tudo aqui é função PURA: nenhuma chamada de
 * rede, nenhum estado. É o que permite testar o mapeamento (incluindo parsing de
 * markdown) sem tocar na API.
 */

const PLATFORM = 'github';

/** Hosts que o GitHub usa para anexos colados no corpo do markdown. */
const ATTACHMENT_URL_MARKERS = [
  'user-images.githubusercontent.com',
  'objects.githubusercontent.com',
  'github.com/user-attachments/',
  '/assets/',
];

export interface MapperContext {
  /** `owner/repo`. */
  scope: string;
  /** Base web para montar URL de issue referenciada mas não extraída. */
  webBaseUrl: string;
  classification: LabelClassification;
  /** Guarda o payload original em `Issue.raw` (dobra o tamanho do snapshot). */
  includeRaw: boolean;
}

export function issueRef(context: MapperContext, number: number, htmlUrl?: string): SourceRef {
  return {
    platform: PLATFORM,
    id: `${PLATFORM}:${context.scope}:issue:${String(number)}`,
    humanRef: `#${String(number)}`,
    url: htmlUrl ?? `${context.webBaseUrl}/${context.scope}/issues/${String(number)}`,
  };
}

export function commentRef(context: MapperContext, comment: GitHubComment): SourceRef {
  return {
    platform: PLATFORM,
    id: `${PLATFORM}:${context.scope}:comment:${String(comment.id)}`,
    humanRef: `comment ${String(comment.id)}`,
    url: comment.html_url,
  };
}

export function milestoneRef(context: MapperContext, milestone: GitHubMilestone): SourceRef {
  return {
    platform: PLATFORM,
    id: `${PLATFORM}:${context.scope}:milestone:${String(milestone.number)}`,
    humanRef: milestone.title,
    url: milestone.html_url,
  };
}

export function userRef(context: MapperContext, user: GitHubUser): SourceRef {
  return {
    platform: PLATFORM,
    id: `${PLATFORM}:${context.scope}:person:${String(user.id)}`,
    humanRef: `@${user.login}`,
    url: user.html_url,
  };
}

/** Usuário removido do GitHub vem como `null`; o modelo exige autor. */
export function toPerson(context: MapperContext, user: GitHubUser | null | undefined): Person {
  if (user === null || user === undefined) return { displayName: 'ghost' };
  return {
    displayName: user.name ?? user.login,
    ...(user.email === null || user.email === undefined ? {} : { email: user.email }),
    sourceRef: userRef(context, user),
  };
}

export function toLabel(label: GitHubLabel): Label {
  return {
    name: label.name,
    ...(label.color === null || label.color === undefined ? {} : { color: label.color }),
    ...(label.description === null || label.description === undefined
      ? {}
      : { description: label.description }),
  };
}

export function toMilestone(context: MapperContext, milestone: GitHubMilestone): Milestone {
  return {
    sourceRef: milestoneRef(context, milestone),
    title: milestone.title,
    state: milestone.state,
    ...(milestone.description === null || milestone.description === undefined
      ? {}
      : { description: milestone.description }),
    ...(milestone.due_on === null || milestone.due_on === undefined
      ? {}
      : { dueOn: milestone.due_on }),
    ...(milestone.closed_at === null || milestone.closed_at === undefined
      ? {}
      : { closedAt: milestone.closed_at }),
  };
}

export function toComment(context: MapperContext, comment: GitHubComment): Comment {
  const body = comment.body ?? '';
  return {
    sourceRef: commentRef(context, comment),
    author: toPerson(context, comment.user),
    body,
    createdAt: comment.created_at,
    ...(comment.updated_at === null || comment.updated_at === undefined
      ? {}
      : { updatedAt: comment.updated_at }),
    attachments: extractInlineAttachments(context, body, `comment-${String(comment.id)}`),
  };
}

export interface MapIssueInput {
  context: MapperContext;
  issue: GitHubIssue;
  comments: GitHubComment[];
}

export function toIssue({ context, issue, comments }: MapIssueInput): Issue {
  const body = issue.body ?? '';
  const labelNames = issue.labels.map((label) => label.name);
  const { checklist, childNumbers } = parseTaskList(body);
  const priority = classifyPriority(labelNames, context.classification);

  const links: IssueLink[] = [
    ...childNumbers.map(
      (number): IssueLink => ({ type: 'parent_of', targetSourceRef: issueRef(context, number) }),
    ),
    ...extractKeywordLinks(context, body),
  ];

  return {
    sourceRef: issueRef(context, issue.number, issue.html_url),
    title: issue.title,
    body,
    type: classifyType(labelNames, context.classification),
    status: classifyStatus(issue.state, labelNames, context.classification),
    labels: issue.labels.map(toLabel),
    assignees: issue.assignees.map((user) => toPerson(context, user)),
    author: toPerson(context, issue.user),
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    comments: comments.map((comment) => toComment(context, comment)),
    attachments: extractInlineAttachments(context, body, `issue-${String(issue.number)}`),
    links: dedupeLinks(links),
    checklist,
    ...(priority === undefined ? {} : { priority }),
    ...(issue.closed_at === null || issue.closed_at === undefined
      ? {}
      : { closedAt: issue.closed_at }),
    ...(issue.milestone === null || issue.milestone === undefined
      ? {}
      : { milestone: milestoneRef(context, issue.milestone) }),
    ...(context.includeRaw ? { raw: { github: issue as unknown as Record<string, unknown> } } : {}),
  };
}

/**
 * Preenche `parentSourceRef` dos filhos a partir dos links `parent_of` do pai
 * (task list `- [ ] #12`). O GitHub não expõe hierarquia no payload de issues,
 * então essa é a única fonte disponível sem a API de sub-issues.
 */
export function applyHierarchy(issues: Issue[]): Issue[] {
  const known = new Set(issues.map((issue) => issue.sourceRef.id));
  const parentByChildId = new Map<string, SourceRef>();

  for (const issue of issues) {
    for (const link of issue.links) {
      if (link.type !== 'parent_of') continue;
      const childId = link.targetSourceRef.id;
      if (!known.has(childId) || parentByChildId.has(childId)) continue;
      parentByChildId.set(childId, issue.sourceRef);
    }
  }

  return issues.map((issue) => {
    const parent = parentByChildId.get(issue.sourceRef.id);
    if (parent === undefined || issue.parentSourceRef !== undefined) return issue;
    return { ...issue, parentSourceRef: parent };
  });
}

/**
 * Anexos do GitHub não vêm por API: imagens e arquivos colados vivem como URL no
 * markdown. `sourceRef.id` é sintetizado de forma determinística para que a
 * idempotência do Executor funcione entre execuções.
 */
export function extractInlineAttachments(
  context: MapperContext,
  body: string,
  ownerSlug: string,
): Attachment[] {
  const attachments: Attachment[] = [];
  const seen = new Set<string>();

  for (const candidate of iterateBodyUrls(body)) {
    if (!isAttachmentUrl(candidate.url) || seen.has(candidate.url)) continue;
    seen.add(candidate.url);

    const index = attachments.length;
    attachments.push({
      sourceRef: {
        platform: PLATFORM,
        id: `${PLATFORM}:${context.scope}:attachment:${ownerSlug}#inline-${String(index)}`,
        humanRef: attachmentFilename(candidate.url, candidate.label, index),
        url: candidate.url,
      },
      filename: attachmentFilename(candidate.url, candidate.label, index),
      url: candidate.url,
      origin: 'inline_body',
    });
  }

  return attachments;
}

/** `- [x] texto` → checklist; `- [ ] #12` → filho na hierarquia. */
export function parseTaskList(body: string): {
  checklist: ChecklistItem[];
  childNumbers: number[];
} {
  const checklist: ChecklistItem[] = [];
  const childNumbers: number[] = [];

  for (const match of body.matchAll(/^[ \t]*[-*+][ \t]+\[([ xX])\][ \t]*(.*)$/gm)) {
    const checked = (match[1] ?? ' ').toLowerCase() === 'x';
    const text = (match[2] ?? '').trim();
    if (text.length === 0) continue;

    const reference = /^#(\d+)\b/.exec(text) ?? /^https?:\/\/\S*\/issues\/(\d+)\b/.exec(text);
    const number = reference?.[1];
    if (number !== undefined) {
      childNumbers.push(Number(number));
      continue;
    }
    checklist.push({ text, checked });
  }

  return { checklist, childNumbers };
}

/** Palavras-chave que expressam relação entre issues no corpo. */
const KEYWORD_LINK_PATTERNS: readonly { pattern: RegExp; type: LinkType }[] = [
  { pattern: /\b(?:blocked by|depends on|depende de|bloqueada por)\s+#(\d+)/gi, type: 'blocked_by' },
  { pattern: /\b(?:blocks|bloqueia)\s+#(\d+)/gi, type: 'blocks' },
  { pattern: /\b(?:duplicate of|duplicates|duplica)\s+#(\d+)/gi, type: 'duplicates' },
  { pattern: /\b(?:relates to|related to|see also|relacionada a)\s+#(\d+)/gi, type: 'relates_to' },
];

export function extractKeywordLinks(context: MapperContext, body: string): IssueLink[] {
  const links: IssueLink[] = [];
  for (const { pattern, type } of KEYWORD_LINK_PATTERNS) {
    for (const match of body.matchAll(pattern)) {
      const number = match[1];
      if (number === undefined) continue;
      links.push({ type, targetSourceRef: issueRef(context, Number(number)) });
    }
  }
  return links;
}

function dedupeLinks(links: IssueLink[]): IssueLink[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = `${link.type}|${link.targetSourceRef.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface BodyUrl {
  url: string;
  /** Texto do link/alt da imagem — melhor palpite de nome de arquivo. */
  label: string;
}

function* iterateBodyUrls(body: string): Generator<BodyUrl> {
  // Markdown: ![alt](url) e [texto](url)
  for (const match of body.matchAll(/!?\[([^\]]*)\]\(\s*<?(https?:\/\/[^\s)>]+)>?[^)]*\)/g)) {
    const url = match[2];
    if (url !== undefined) yield { url, label: (match[1] ?? '').trim() };
  }
  // HTML: <img src="url">
  for (const match of body.matchAll(/<img[^>]+src=["'](https?:\/\/[^"']+)["']/gi)) {
    const url = match[1];
    if (url !== undefined) yield { url, label: '' };
  }
  // URL crua (anexo colado sem markdown)
  for (const match of body.matchAll(/(?<![("'[])https?:\/\/[^\s)"'<>\]]+/g)) {
    yield { url: match[0], label: '' };
  }
}

function isAttachmentUrl(url: string): boolean {
  return ATTACHMENT_URL_MARKERS.some((marker) => url.includes(marker));
}

function attachmentFilename(url: string, label: string, index: number): string {
  if (looksLikeFilename(label)) return label;

  const withoutQuery = url.split('?')[0] ?? url;
  const lastSegment = withoutQuery.split('/').filter((part) => part.length > 0).at(-1) ?? '';
  const decoded = safeDecode(lastSegment);
  if (looksLikeFilename(decoded)) return decoded;

  return `anexo-${String(index + 1)}`;
}

const looksLikeFilename = (value: string): boolean => /^[^\\/]+\.[a-z0-9]{2,5}$/i.test(value);

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
