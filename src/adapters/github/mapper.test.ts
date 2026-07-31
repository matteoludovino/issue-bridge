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
    title: 'Falha no login',
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

describe('classificação por label', () => {
  it('resolve tipo por precedência quando há labels conflitantes', () => {
    expect(classifyType(['bug', 'epic'], DEFAULT_LABEL_CLASSIFICATION)).toBe('epic');
    expect(classifyType(['enhancement', 'bug'], DEFAULT_LABEL_CLASSIFICATION)).toBe('bug');
    expect(classifyType(['Bug'], DEFAULT_LABEL_CLASSIFICATION)).toBe('bug');
    expect(classifyType(['sem-correspondencia'], DEFAULT_LABEL_CLASSIFICATION)).toBe('task');
  });

  it('resolve prioridade pela mais alta e devolve undefined sem label', () => {
    expect(classifyPriority(['p3', 'p1'], DEFAULT_LABEL_CLASSIFICATION)).toBe('high');
    expect(classifyPriority(['priority: low'], DEFAULT_LABEL_CLASSIFICATION)).toBe('low');
    expect(classifyPriority(['docs'], DEFAULT_LABEL_CLASSIFICATION)).toBeUndefined();
  });

  it('deriva in_progress de label e closed do estado', () => {
    expect(classifyStatus('open', ['WIP'], DEFAULT_LABEL_CLASSIFICATION)).toBe('in_progress');
    expect(classifyStatus('open', [], DEFAULT_LABEL_CLASSIFICATION)).toBe('open');
    expect(classifyStatus('closed', ['wip'], DEFAULT_LABEL_CLASSIFICATION)).toBe('closed');
  });
});

describe('anexos inline no markdown', () => {
  it('captura imagem markdown, tag img e URL crua, sem duplicar', () => {
    const body = [
      '![captura de tela.png](https://user-images.githubusercontent.com/1/aaa.png)',
      '<img src="https://user-images.githubusercontent.com/1/bbb.png" width="300">',
      'Log completo: https://github.com/user-attachments/assets/9f2c-uuid',
      'Repetida: ![x](https://user-images.githubusercontent.com/1/aaa.png)',
      'Link normal ignorado: https://example.com/docs',
    ].join('\n\n');

    const attachments = extractInlineAttachments(context, body, 'issue-1');

    expect(attachments.map((attachment) => attachment.filename)).toEqual([
      'captura de tela.png',
      'bbb.png',
      'anexo-3',
    ]);
    expect(attachments.every((attachment) => attachment.origin === 'inline_body')).toBe(true);
    expect(attachments[0]?.sourceRef.id).toBe('github:acme/api:attachment:issue-1#inline-0');
  });

  it('não inventa anexo quando o corpo não tem URL de anexo do GitHub', () => {
    expect(extractInlineAttachments(context, 'texto puro', 'issue-1')).toEqual([]);
  });
});

describe('task list', () => {
  it('separa itens de checklist de referências a issues filhas', () => {
    const body = [
      '- [x] Escrever testes',
      '- [ ] #42',
      '* [ ] Revisar documentação',
      '- [ ] https://github.com/acme/api/issues/43',
      'texto que não é item',
    ].join('\n');

    const { checklist, childNumbers } = parseTaskList(body);

    expect(checklist).toEqual([
      { text: 'Escrever testes', checked: true },
      { text: 'Revisar documentação', checked: false },
    ]);
    expect(childNumbers).toEqual([42, 43]);
  });
});

describe('links por palavra-chave', () => {
  it('extrai relações agrupadas por tipo (a dedupe acontece em toIssue)', () => {
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

  it('toIssue remove links repetidos', () => {
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
  it('mapeia issue completa para o modelo neutro', () => {
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
          body: 'olha o print ![p](https://user-images.githubusercontent.com/1/p.png)',
          user: { login: 'carla', id: 30, html_url: 'https://github.com/carla' },
          created_at: '2026-01-03T00:00:00Z',
          html_url: 'https://github.com/acme/api/issues/7#issuecomment-555',
        },
      ],
    });

    expect(issue).toMatchObject({
      sourceRef: { id: 'github:acme/api:issue:7', humanRef: '#7', platform: 'github' },
      title: 'Falha no login',
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
    // Anexo do comentário fica no comentário, não na issue.
    expect(issue.attachments).toEqual([]);
    expect(issue.comments[0]?.attachments[0]?.filename).toBe('p.png');
    expect(issue.raw).toBeUndefined();
  });

  it('trata autor removido, issue fechada e raw opcional', () => {
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
  it('preenche parentSourceRef do filho a partir do parent_of do pai', () => {
    const parent = toIssue({ context, issue: rawIssue({ number: 1, body: '- [ ] #2' }), comments: [] });
    const child = toIssue({ context, issue: rawIssue({ number: 2 }), comments: [] });

    const [mappedParent, mappedChild] = applyHierarchy([parent, child]);

    expect(mappedChild?.parentSourceRef?.id).toBe('github:acme/api:issue:1');
    expect(mappedParent?.parentSourceRef).toBeUndefined();
  });

  it('ignora referência a issue fora da extração', () => {
    const parent = toIssue({ context, issue: rawIssue({ number: 1, body: '- [ ] #99' }), comments: [] });
    const [mapped] = applyHierarchy([parent]);
    expect(mapped?.parentSourceRef).toBeUndefined();
  });
});
