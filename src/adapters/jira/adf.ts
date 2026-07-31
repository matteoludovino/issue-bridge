/**
 * Conversor markdown → ADF (Atlassian Document Format).
 *
 * A REST v3 do Jira Cloud rejeita string em `description` e `comment.body`: exige
 * ADF. Sem esta conversão, todo corpo migrado chegaria como um bloco de markdown
 * literal — perda permanente de qualidade numa migração de mão única.
 *
 * Escopo suportado: parágrafo, quebra de linha, heading, code block cercado,
 * lista com marcador, lista ordenada, citação, régua, e inline `code`, **negrito**,
 * *itálico*, ~~riscado~~, link markdown e URL crua.
 *
 * Fora de escopo (degrada para texto, não quebra): tabela, marcas aninhadas,
 * lista aninhada, HTML embutido. Tudo aqui é função PURA.
 */

export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: AdfMark[];
}

export interface AdfDocument {
  version: 1;
  type: 'doc';
  content: AdfNode[];
}

const FENCE = /^```(\S*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})$/;
const QUOTE = /^>\s?(.*)$/;
const BULLET = /^[ \t]*[-*+][ \t]+(.*)$/;
const ORDERED = /^[ \t]*\d+[.)][ \t]+(.*)$/;

export function markdownToAdf(markdown: string): AdfDocument {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const content: AdfNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line.trim());
    if (fence !== null) {
      const language = fence[1] ?? '';
      const code: string[] = [];
      index += 1;
      while (index < lines.length && FENCE.exec((lines[index] ?? '').trim()) === null) {
        code.push(lines[index] ?? '');
        index += 1;
      }
      index += 1; // consome a cerca de fechamento (ou o fim do texto)
      content.push({
        type: 'codeBlock',
        ...(language.length > 0 ? { attrs: { language } } : {}),
        content: code.length > 0 ? [{ type: 'text', text: code.join('\n') }] : [],
      });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      content.push({
        type: 'heading',
        attrs: { level: (heading[1] ?? '#').length },
        content: parseInline(heading[2] ?? ''),
      });
      index += 1;
      continue;
    }

    if (RULE.test(line.trim())) {
      content.push({ type: 'rule' });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const match = QUOTE.exec(lines[index] ?? '');
        if (match === null) break;
        quoted.push(match[1] ?? '');
        index += 1;
      }
      content.push({
        type: 'blockquote',
        content: [{ type: 'paragraph', content: parseInlineLines(quoted) }],
      });
      continue;
    }

    const listKind = BULLET.test(line) ? 'bulletList' : ORDERED.test(line) ? 'orderedList' : null;
    if (listKind !== null) {
      const pattern = listKind === 'bulletList' ? BULLET : ORDERED;
      const items: AdfNode[] = [];
      while (index < lines.length) {
        const match = pattern.exec(lines[index] ?? '');
        if (match === null) break;
        items.push({
          type: 'listItem',
          content: [{ type: 'paragraph', content: parseInline(match[1] ?? '') }],
        });
        index += 1;
      }
      content.push({ type: listKind, content: items });
      continue;
    }

    // Parágrafo: consome até linha vazia ou início de outro bloco.
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (current.trim().length === 0 || startsBlock(current)) break;
      paragraph.push(current);
      index += 1;
    }
    content.push({ type: 'paragraph', content: parseInlineLines(paragraph) });
  }

  // ADF não aceita `doc` sem conteúdo.
  if (content.length === 0) content.push({ type: 'paragraph', content: [] });
  return { version: 1, type: 'doc', content };
}

function startsBlock(line: string): boolean {
  const trimmed = line.trim();
  return (
    FENCE.test(trimmed) ||
    HEADING.test(line) ||
    RULE.test(trimmed) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line)
  );
}

/** Linhas de um mesmo parágrafo viram `hardBreak` — o GFM quebra em `\n` simples. */
function parseInlineLines(lines: string[]): AdfNode[] {
  const nodes: AdfNode[] = [];
  lines.forEach((line, position) => {
    if (position > 0) nodes.push({ type: 'hardBreak' });
    nodes.push(...parseInline(line));
  });
  return nodes;
}

const INLINE_PATTERN = new RegExp(
  [
    '`([^`]+)`', // 1: code
    '\\*\\*([^*]+)\\*\\*', // 2: strong
    '__([^_]+)__', // 3: strong
    '~~([^~]+)~~', // 4: strike
    '\\*([^*\\n]+)\\*', // 5: em
    '(?<![\\w_])_([^_\\n]+)_(?![\\w_])', // 6: em (ignora snake_case)
    '\\[([^\\]]*)\\]\\((https?://[^)\\s]+)\\)', // 7,8: link markdown
    '(https?://[^\\s<>)\\]]+)', // 9: URL crua
  ].join('|'),
  'g',
);

export function parseInline(text: string): AdfNode[] {
  if (text.length === 0) return [];

  const nodes: AdfNode[] = [];
  let cursor = 0;

  for (const match of text.matchAll(INLINE_PATTERN)) {
    const start = match.index;
    if (start > cursor) nodes.push({ type: 'text', text: text.slice(cursor, start) });
    cursor = start + match[0].length;

    const [, code, strongA, strongB, strike, emA, emB, linkText, linkHref, bareUrl] = match;

    if (code !== undefined) nodes.push(textNode(code, [{ type: 'code' }]));
    else if (strongA !== undefined) nodes.push(textNode(strongA, [{ type: 'strong' }]));
    else if (strongB !== undefined) nodes.push(textNode(strongB, [{ type: 'strong' }]));
    else if (strike !== undefined) nodes.push(textNode(strike, [{ type: 'strike' }]));
    else if (emA !== undefined) nodes.push(textNode(emA, [{ type: 'em' }]));
    else if (emB !== undefined) nodes.push(textNode(emB, [{ type: 'em' }]));
    else if (linkHref !== undefined) {
      const label = linkText === undefined || linkText.length === 0 ? linkHref : linkText;
      nodes.push(textNode(label, [{ type: 'link', attrs: { href: linkHref } }]));
    } else if (bareUrl !== undefined) {
      nodes.push(textNode(bareUrl, [{ type: 'link', attrs: { href: bareUrl } }]));
    }
  }

  if (cursor < text.length) nodes.push({ type: 'text', text: text.slice(cursor) });
  return nodes;
}

function textNode(text: string, marks: AdfMark[]): AdfNode {
  return { type: 'text', text, marks };
}
