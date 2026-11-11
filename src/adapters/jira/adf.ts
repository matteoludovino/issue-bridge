/**
 * Markdown → ADF (Atlassian Document Format) converter.
 *
 * Jira Cloud REST v3 rejects plain strings in `description` and `comment.body`: it requires
 * ADF. Without this conversion, every migrated body would arrive as a block of literal
 * markdown — a permanent loss of quality in a one-way migration.
 *
 * Supported: paragraph, line break, heading, fenced code block,
 * bullet list, ordered list, blockquote, horizontal rule, plus inline `code`, **bold**,
 * *italic*, ~~strikethrough~~, markdown links and bare URLs.
 *
 * Out of scope (degrades to text, does not break): tables, nested marks,
 * nested lists, embedded HTML. Everything here is a PURE function.
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
      index += 1; // consumes the closing fence (or the end of the text)
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

    // Paragraph: consumes up to a blank line or the start of another block.
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (current.trim().length === 0 || startsBlock(current)) break;
      paragraph.push(current);
      index += 1;
    }
    content.push({ type: 'paragraph', content: parseInlineLines(paragraph) });
  }

  // ADF does not accept a `doc` without content.
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

/** Lines of the same paragraph become `hardBreak` — GFM breaks on a single `\n`. */
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
    '(?<![\\w_])_([^_\\n]+)_(?![\\w_])', // 6: em (ignores snake_case)
    '\\[([^\\]]*)\\]\\((https?://[^)\\s]+)\\)', // 7,8: markdown link
    '(https?://[^\\s<>)\\]]+)', // 9: bare URL
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
