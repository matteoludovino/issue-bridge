import { describe, expect, it } from 'vitest';
import { markdownToAdf, parseInline } from './adf.js';

describe('markdownToAdf — blocos', () => {
  it('documento vazio ainda é um doc válido', () => {
    expect(markdownToAdf('')).toEqual({
      version: 1,
      type: 'doc',
      content: [{ type: 'paragraph', content: [] }],
    });
  });

  it('converte heading, parágrafo e régua', () => {
    const doc = markdownToAdf('# Título\n\nTexto do corpo.\n\n---\n');

    expect(doc.content).toEqual([
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Título' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Texto do corpo.' }] },
      { type: 'rule' },
    ]);
  });

  it('preserva quebra simples dentro do parágrafo como hardBreak', () => {
    const doc = markdownToAdf('linha um\nlinha dois');

    expect(doc.content[0]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'linha um' },
        { type: 'hardBreak' },
        { type: 'text', text: 'linha dois' },
      ],
    });
  });

  it('converte code block cercado com linguagem', () => {
    const doc = markdownToAdf('```ts\nconst a = 1;\nconst b = 2;\n```');

    expect(doc.content[0]).toEqual({
      type: 'codeBlock',
      attrs: { language: 'ts' },
      content: [{ type: 'text', text: 'const a = 1;\nconst b = 2;' }],
    });
  });

  it('não interpreta markdown dentro de code block', () => {
    const doc = markdownToAdf('```\n**não é negrito**\n```');
    expect(doc.content[0]?.content?.[0]?.text).toBe('**não é negrito**');
  });

  it('converte lista com marcador e lista ordenada', () => {
    const doc = markdownToAdf('- um\n- dois\n\n1. primeiro\n2. segundo');

    expect(doc.content[0]).toMatchObject({ type: 'bulletList' });
    expect(doc.content[0]?.content).toHaveLength(2);
    expect(doc.content[1]).toMatchObject({ type: 'orderedList' });
    expect(doc.content[1]?.content?.[0]).toEqual({
      type: 'listItem',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'primeiro' }] }],
    });
  });

  it('converte citação de múltiplas linhas', () => {
    const doc = markdownToAdf('> primeira\n> segunda');

    expect(doc.content[0]).toEqual({
      type: 'blockquote',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'primeira' },
            { type: 'hardBreak' },
            { type: 'text', text: 'segunda' },
          ],
        },
      ],
    });
  });

  it('item de task list vira item de lista com o marcador preservado', () => {
    const doc = markdownToAdf('- [x] feito\n- [ ] pendente');

    expect(doc.content[0]).toMatchObject({ type: 'bulletList' });
    expect(doc.content[0]?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe('[x] feito');
  });
});

describe('parseInline — marcas', () => {
  it('aplica code, strong, em e strike', () => {
    expect(parseInline('use `npm ci`, é **importante** e *urgente*, não ~~opcional~~')).toEqual([
      { type: 'text', text: 'use ' },
      { type: 'text', text: 'npm ci', marks: [{ type: 'code' }] },
      { type: 'text', text: ', é ' },
      { type: 'text', text: 'importante', marks: [{ type: 'strong' }] },
      { type: 'text', text: ' e ' },
      { type: 'text', text: 'urgente', marks: [{ type: 'em' }] },
      { type: 'text', text: ', não ' },
      { type: 'text', text: 'opcional', marks: [{ type: 'strike' }] },
    ]);
  });

  it('converte link markdown e URL crua', () => {
    expect(parseInline('veja [o doc](https://example.test/a) ou https://example.test/b')).toEqual([
      { type: 'text', text: 'veja ' },
      {
        type: 'text',
        text: 'o doc',
        marks: [{ type: 'link', attrs: { href: 'https://example.test/a' } }],
      },
      { type: 'text', text: ' ou ' },
      {
        type: 'text',
        text: 'https://example.test/b',
        marks: [{ type: 'link', attrs: { href: 'https://example.test/b' } }],
      },
    ]);
  });

  it('não trata snake_case como itálico', () => {
    expect(parseInline('campo user_name_id')).toEqual([
      { type: 'text', text: 'campo user_name_id' },
    ]);
  });
});
