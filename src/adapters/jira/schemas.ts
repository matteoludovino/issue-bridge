import { z } from 'zod';

/**
 * Schemas dos payloads da REST v3 do Jira Cloud que o adapter consome.
 * Só os campos usados; o Zod descarta o resto.
 */

export const JiraMyselfSchema = z.object({
  accountId: z.string(),
  displayName: z.string(),
  emailAddress: z.string().nullish(),
});

export const JiraNamedSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type JiraNamed = z.infer<typeof JiraNamedSchema>;

export const JiraProjectSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  components: z.array(JiraNamedSchema).default([]),
  versions: z.array(JiraNamedSchema).default([]),
});

/** `GET /issue/createmeta/{key}/issuetypes` */
export const JiraCreateMetaIssueTypesSchema = z.object({
  issueTypes: z
    .array(z.object({ id: z.string(), name: z.string(), subtask: z.boolean().default(false) }))
    .default([]),
});

/** `GET /issue/createmeta/{key}/issuetypes/{id}` — a fonte da verdade sobre campos obrigatórios. */
export const JiraCreateMetaFieldsSchema = z.object({
  fields: z
    .array(
      z.object({
        fieldId: z.string(),
        name: z.string(),
        required: z.boolean().default(false),
        schema: z
          .object({ type: z.string().nullish(), custom: z.string().nullish() })
          .nullish(),
      }),
    )
    .default([]),
});

/** `GET /project/{key}/statuses` — statuses por tipo de issue, em ordem de workflow. */
export const JiraProjectStatusesSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    statuses: z.array(JiraNamedSchema).default([]),
  }),
);

/** `GET /label` — lista global e paginada. */
export const JiraLabelsSchema = z.object({
  values: z.array(z.string()).default([]),
  isLast: z.boolean().nullish(),
  total: z.number().nullish(),
});

export const JiraCreatedIssueSchema = z.object({
  id: z.string(),
  key: z.string(),
  self: z.string().nullish(),
});

export const JiraCreatedCommentSchema = z.object({
  id: z.string(),
});

export const JiraTransitionsSchema = z.object({
  transitions: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        to: z.object({ id: z.string(), name: z.string() }),
      }),
    )
    .default([]),
});

export const JiraAttachmentsSchema = z.array(
  z.object({ id: z.string(), filename: z.string().nullish() }),
);

export const JiraUserSearchSchema = z.array(
  z.object({
    accountId: z.string(),
    displayName: z.string().nullish(),
    emailAddress: z.string().nullish(),
  }),
);

/** `GET /search/jql` — busca de issues existentes (reconciliação). */
export const JiraSearchSchema = z.object({
  issues: z.array(z.object({ id: z.string(), key: z.string() })).default([]),
});
