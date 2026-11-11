import { z } from 'zod';

/**
 * Schemas for the Jira Cloud REST v3 payloads the adapter consumes.
 * Only the fields in use; Zod strips the rest.
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

/** `GET /issue/createmeta/{key}/issuetypes/{id}` — the source of truth for required fields. */
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

/** `GET /project/{key}/statuses` — statuses per issue type, in workflow order. */
export const JiraProjectStatusesSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    statuses: z.array(JiraNamedSchema).default([]),
  }),
);

/** `GET /label` — global, paginated list. */
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

/** `GET /search/jql` — search for existing issues (reconciliation). */
export const JiraSearchSchema = z.object({
  issues: z.array(z.object({ id: z.string(), key: z.string() })).default([]),
});
