import { describe, expect, it } from 'vitest';
import { DEFAULT_LABEL_CLASSIFICATION, classifyPriority, classifyStatus, classifyType } from './classification.js';
import {
  applyHierarchy,
  extractInlineAttachments,
  extractKeywordLinks,
  parseTaskList,
  toIssue,
  type MapperContext,
} from './mapper.js';
import type { GitHubIssue } from './schemas.js';

const context: MapperContext = {
  scope: 'acme/api',
  webBaseUrl: 'https://github.com',
  classification: DEFAULT_LABEL_CLASSIFICATION,
  includeRaw: false,
};

function rawIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 1,
    title: 'Login failure',
    body: '',
    state: 'open',
    labels: [],
    user: { login: 'ana', id: 10, html_url: 'https://github.com/ana', name: 'Ana Souza' },
    assignees: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    html_url: 'https://github.com/acme/api/issues/1',
    comments: 0,
    ...overrides,
  };
}

describe('label classification', () => {
  it('resolves the type by precedence when labels conflict', () => {
    expect(classifyType(['bug', 'epic'], DEFAULT_LABEL_CLASSIFICATION)).toBe('epic');
    expect(classifyType(['enhancement', 'bug'], DEFAULT_LABEL_CLASSIFICATION)).toBe('bug');
    expect(classifyType(['Bug'], DEFAULT_LABEL_CLASSIFICATION)).toBe('bug');
    expect(classifyType(['no-match'], DEFAULT_LABEL_CLASSIFICATION)).toBe('task');
  });

  it('resolves priority to the highest one and returns undefined without a label', () => {
    expect(classifyPriority(['p3', 'p1'], DEFAULT_LABEL_CLASSIFICATION)).toBe('high');
    expect(classifyPriority(['priority: low'], DEFAULT_LABEL_CLASSIFICATION)).toBe('low');
    expect(classifyPriority(['docs'], DEFAULT_LABEL_CLASSIFICATION)).toBeUndefined();
  });

  it('derives in_progress from a label and closed from the state', () => {
    expect(classifyStatus('open', ['WIP'], DEFAULT_LABEL_CLASSIFICATION)).toBe('in_progress');
    expect(classifyStatus('open', [], DEFAULT_LABEL_CLASSIFICATION)).toBe('open');
    expect(classifyStatus('closed', ['wip'], DEFAULT_LABEL_CLASSIFICATION)).toBe('closed');
  });
});

describe('inline attachments in markdown', () => {
  it('captures markdown images, img tags and bare URLs, without duplicates', () => {
    const body = [
      '![screen capture.png](https://user-images.githubusercontent.com/1/aaa.png)',
      '<img src="https://user-images.githubusercontent.com/1/bbb.png" width="300">',
      'Full log: https://github.com/user-attachments/assets/9f2c-uuid',
      'Repeated: ![x](https://user-images.githubusercontent.com/1/aaa.png)',
      'Plain link, ignored: https://example.com/docs',
    ].join('\n\n');

    const attachments = extractInlineAttachments(context, body, 'issue-1');

    expect(attachments.map((attachment) => attachment.filename)).toEqual([
      'screen capture.png',
      'bbb.png',
      'attachment-3',
    ]);
    expect(attachments.every((attachment) => attachment.origin === 'inline_body')).toBe(true);
    expect(attachments[0]?.sourceRef.id).toBe('github:acme/api:attachment:issue-1#inline-0');
  });

  it('does not invent attachments when the body has no GitHub attachment URL', () => {
    expect(extractInlineAttachments(context, 'plain text', 'issue-1')).toEqual([]);
  });
});

describe('task list', () => {
  it('separates checklist items from references to child issues', () => {
    const body = [
      '- [x] Write tests',
      '- [ ] #42',
      '* [ ] Review documentation',
      '- [ ] https://github.com/acme/api/issues/43',
      'text that is not an item',
    ].join('\n');

    const { checklist, childNumbers } = parseTaskList(body);

    expect(checklist).toEqual([
      { text: 'Write tests', checked: true },
      { text: 'Review documentation', checked: false },
    ]);
    expect(childNumbers).toEqual([42, 43]);
  });
});

describe('keyword links', () => {
  it('extracts relationships grouped by type (deduplication happens in toIssue)', () => {
    const body = 'Blocked by #10. Depends on #10. Duplicate of #11. Relates to #12. Blocks #13.';
    const links = extractKeywordLinks(context, body);

    expect(links.map((link) => `${link.type}:${link.targetSourceRef.humanRef}`)).toEqual([
      'blocked_by:#10',
      'blocked_by:#10',
      'blocks:#13',
      'duplicates:#11',
      'relates_to:#12',
    ]);
  });

  it('toIssue removes duplicate links', () => {
    const issue = toIssue({
      context,
      issue: rawIssue({ body: 'Blocked by #10. Depends on #10.' }),
      comments: [],
    });
    expect(issue.links).toEqual([
      { type: 'blocked_by', targetSourceRef: expect.objectContaining({ humanRef: '#10' }) },
    ]);
  });
});

describe('toIssue', () => {
  it('maps a complete issue to the neutral model', () => {
    const issue = toIssue({
      context,
      issue: rawIssue({
        number: 7,
        labels: [{ name: 'bug' }, { name: 'p1' }, { name: 'wip', color: 'ededed' }],
        state: 'open',
        body: '- [ ] #8\n\nBlocked by #9',
        milestone: {
          number: 3,
          title: 'Sprint 3',
          state: 'open',
          html_url: 'https://github.com/acme/api/milestone/3',
        },
        assignees: [{ login: 'bruno', id: 20, html_url: 'https://github.com/bruno' }],
      }),
      comments: [
        {
          id: 555,
          body: 'see the screenshot ![p](https://user-images.githubusercontent.com/1/p.png)',
          user: { login: 'carla', id: 30, html_url: 'https://github.com/carla' },
          created_at: '2026-01-03T00:00:00Z',
          html_url: 'https://github.com/acme/api/issues/7#issuecomment-555',
        },
      ],
    });

    expect(issue).toMatchObject({
      sourceRef: { id: 'github:acme/api:issue:7', humanRef: '#7', platform: 'github' },
      title: 'Login failure',
      type: 'bug',
      priority: 'high',
      status: 'in_progress',
      milestone: { id: 'github:acme/api:milestone:3' },
      checklist: [],
    });
    expect(issue.author).toEqual({
      displayName: 'Ana Souza',
      sourceRef: {
        platform: 'github',
        id: 'github:acme/api:person:10',
        humanRef: '@ana',
        url: 'https://github.com/ana',
      },
    });
    expect(issue.assignees[0]?.displayName).toBe('bruno');
    expect(issue.links).toEqual([
      { type: 'parent_of', targetSourceRef: expect.objectContaining({ humanRef: '#8' }) },
      { type: 'blocked_by', targetSourceRef: expect.objectContaining({ humanRef: '#9' }) },
    ]);
    // The comment's attachment stays on the comment, not on the issue.
    expect(issue.attachments).toEqual([]);
    expect(issue.comments[0]?.attachments[0]?.filename).toBe('p.png');
    expect(issue.raw).toBeUndefined();
  });

  it('handles a deleted author, a closed issue and optional raw', () => {
    const issue = toIssue({
      context: { ...context, includeRaw: true },
      issue: rawIssue({ user: null, state: 'closed', closed_at: '2026-02-01T00:00:00Z' }),
      comments: [],
    });

    expect(issue.author).toEqual({ displayName: 'ghost' });
    expect(issue.status).toBe('closed');
    expect(issue.closedAt).toBe('2026-02-01T00:00:00Z');
    expect(issue.raw).toBeDefined();
  });
});

describe('applyHierarchy', () => {
  it('fills in the child parentSourceRef from the parent_of of the parent', () => {
    const parent = toIssue({ context, issue: rawIssue({ number: 1, body: '- [ ] #2' }), comments: [] });
    const child = toIssue({ context, issue: rawIssue({ number: 2 }), comments: [] });

    const [mappedParent, mappedChild] = applyHierarchy([parent, child]);

    expect(mappedChild?.parentSourceRef?.id).toBe('github:acme/api:issue:1');
    expect(mappedParent?.parentSourceRef).toBeUndefined();
  });

  it('ignores references to issues outside the extraction', () => {
    const parent = toIssue({ context, issue: rawIssue({ number: 1, body: '- [ ] #99' }), comments: [] });
    const [mapped] = applyHierarchy([parent]);
    expect(mapped?.parentSourceRef).toBeUndefined();
  });
});
