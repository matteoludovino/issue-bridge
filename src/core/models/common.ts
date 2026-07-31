import { z } from 'zod';

/**
 * Referência a uma entidade no sistema de ORIGEM.
 *
 * `id` é a chave de identidade usada pelo RollbackStore (idempotência) e deve ser
 * determinística: extrair a mesma entidade duas vezes produz o mesmo `id`.
 * Convenção recomendada: `<platform>:<scope>:<kind>:<nativeId>`
 * (ex.: `github:acme/api:issue:123`). `humanRef` é o rótulo legível (`#123`).
 */
export const SourceRefSchema = z.object({
  platform: z.string().min(1),
  id: z.string().min(1),
  humanRef: z.string().min(1),
  url: z.string().url(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

/**
 * Pessoa referenciada por uma issue. `email` e `sourceRef` são opcionais porque
 * a maioria das APIs não expõe e-mail de terceiros e autores de sistema
 * (bots, importadores) podem não ter entidade própria na origem.
 */
export const PersonSchema = z.object({
  displayName: z.string().min(1),
  email: z.string().email().optional(),
  sourceRef: SourceRefSchema.optional(),
});
export type Person = z.infer<typeof PersonSchema>;

/**
 * Tipo neutro. O Planner traduz para o nome real do destino via
 * `MappingConfig.issueTypes` e valida contra `TargetCapabilities.issueTypes`.
 */
export const IssueTypeSchema = z.enum(['epic', 'story', 'task', 'bug', 'subtask']);
export type IssueType = z.infer<typeof IssueTypeSchema>;

/** Estado neutro. Traduzido via `MappingConfig.statuses`. */
export const IssueStatusSchema = z.enum(['open', 'in_progress', 'closed']);
export type IssueStatus = z.infer<typeof IssueStatusSchema>;

/** Prioridade neutra. Traduzida via `MappingConfig.priorities`. */
export const IssuePrioritySchema = z.enum(['highest', 'high', 'medium', 'low', 'lowest']);
export type IssuePriority = z.infer<typeof IssuePrioritySchema>;

/**
 * Relação entre issues, em vocabulário neutro. O adapter de destino traduz para
 * o catálogo próprio (issueLinkType, campo `parent`, etc.).
 */
export const LinkTypeSchema = z.enum([
  'relates_to',
  'blocks',
  'blocked_by',
  'duplicates',
  'duplicated_by',
  'parent_of',
  'child_of',
]);
export type LinkType = z.infer<typeof LinkTypeSchema>;

/**
 * Tipos de link que definem HIERARQUIA e, portanto, ordem de criação.
 * Um ciclo aqui é fatal (ver `detectCycles` no Planner); ciclos em `blocks`/
 * `blocked_by` não são, porque links só são criados depois de todas as issues.
 */
export const HIERARCHY_LINK_TYPES: readonly LinkType[] = ['parent_of', 'child_of'];

/** Tipos de link que expressam bloqueio (sem efeito na ordem de criação). */
export const BLOCKING_LINK_TYPES: readonly LinkType[] = ['blocks', 'blocked_by'];
