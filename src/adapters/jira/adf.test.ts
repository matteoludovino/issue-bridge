import { describe, expect, it } from 'vitest';
import { markdownToAdf, parseInline } from './adf.js';

describe('markdownToAdf — blocks', () => {
  it('an empty document is still a valid doc', () => {
    expect(markdownToAdf('')).toEqual({
      version: 1,
      type: 'doc',
      content: [{ type: 'paragraph', content: [] }],
    });
  });

  it('converts heading, paragraph and horizontal rule', () => {
    const doc = markdownToAdf('# Title\n\nBody text.\n\n---\n');

    expect(doc.content).toEqual([
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Body text.' }] },
      { type: 'rule' },
    ]);
  });

  it('keeps a single line break inside a paragraph as hardBreak', () => {
    const doc = markdownToAdf('line one\nline two');

    expect(doc.content[0]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'line one' },
        { type: 'hardBreak' },
        { type: 'text', text: 'line two' },
      ],
    });
  });

  it('converts a fenced code block with a language', () => {
    const doc = markdownToAdf('```ts\nconst a = 1;\nconst b = 2;\n```');

    expect(doc.content[0]).toEqual({
      type: 'codeBlock',
      attrs: { language: 'ts' },
      content: [{ type: 'text', text: 'const a = 1;\nconst b = 2;' }],
    });
  });

  it('does not interpret markdown inside a code block', () => {
    const doc = markdownToAdf('```\n**not bold**\n```');
    expect(doc.content[0]?.content?.[0]?.text).toBe('**not bold**');
  });

  it('converts bullet and ordered lists', () => {
    const doc = markdownToAdf('- one\n- two\n\n1. first\n2. second');

    expect(doc.content[0]).toMatchObject({ type: 'bulletList' });
    expect(doc.content[0]?.content).toHaveLength(2);
    expect(doc.content[1]).toMatchObject({ type: 'orderedList' });
    expect(doc.content[1]?.content?.[0]).toEqual({
      type: 'listItem',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }],
    });
  });

  it('converts a multi-line blockquote', () => {
    const doc = markdownToAdf('> first\n> second');

    expect(doc.content[0]).toEqual({
      type: 'blockquote',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'first' },
            { type: 'hardBreak' },
            { type: 'text', text: 'second' },
          ],
        },
      ],
    });
  });

  it('a task list item becomes a list item with its marker preserved', () => {
    const doc = markdownToAdf('- [x] done\n- [ ] pending');

    expect(doc.content[0]).toMatchObject({ type: 'bulletList' });
    expect(doc.content[0]?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe('[x] done');
  });
});

describe('parseInline — marks', () => {
  it('applies code, strong, em and strike', () => {
    expect(parseInline('use `npm ci`, it is **important** and *urgent*, not ~~optional~~')).toEqual([
      { type: 'text', text: 'use ' },
      { type: 'text', text: 'npm ci', marks: [{ type: 'code' }] },
      { type: 'text', text: ', it is ' },
      { type: 'text', text: 'important', marks: [{ type: 'strong' }] },
      { type: 'text', text: ' and ' },
      { type: 'text', text: 'urgent', marks: [{ type: 'em' }] },
      { type: 'text', text: ', not ' },
      { type: 'text', text: 'optional', marks: [{ type: 'strike' }] },
    ]);
  });

  it('converts markdown links and bare URLs', () => {
    expect(parseInline('see [the doc](https://example.test/a) or https://example.test/b')).toEqual([
      { type: 'text', text: 'see ' },
      {
        type: 'text',
        text: 'the doc',
        marks: [{ type: 'link', attrs: { href: 'https://example.test/a' } }],
      },
      { type: 'text', text: ' or ' },
      {
        type: 'text',
        text: 'https://example.test/b',
        marks: [{ type: 'link', attrs: { href: 'https://example.test/b' } }],
      },
    ]);
  });

  it('does not treat snake_case as italic', () => {
    expect(parseInline('field user_name_id')).toEqual([
      { type: 'text', text: 'field user_name_id' },
    ]);
  });
});
