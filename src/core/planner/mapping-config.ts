import type { IssuePriority, IssueStatus, IssueType } from '../models/common.js';

/**
 * Source → target translation rules consumed by the Planner.
 *
 * Loaded from YAML in the Config Phase; this file only holds the contract the
 * Planner consumes. Every `Record` is total over the neutral enum — there is no
 * "unmapped type", only a mapping that points to a value that does not exist in
 * the target (detected against `TargetCapabilities` and reported as
 * `unmapped_value`).
 */
export interface MappingConfig {
  /** Neutral type → issue type name in the target. */
  issueTypes: Record<IssueType, string>;
  /** Neutral priority → priority name in the target. */
  priorities: Record<IssuePriority, string>;
  /** Neutral status → status name in the target. */
  statuses: Record<IssueStatus, string>;
  /** How to materialize milestones: as an epic or as a project version. */
  milestoneStrategy: 'epic' | 'version';
  /**
   * Priority used when the source issue has none.
   * Absent = the issue has no priority in the target.
   */
  // Explicit `| undefined`: this type is filled directly from Zod's output,
  // which always includes `undefined` in optional fields.
  defaultPriority?: IssuePriority | undefined;
  /**
   * Values for target fields, keyed by field id (`customfield_10042`).
   *
   * This is the only channel able to satisfy a required custom field: without
   * it, any project with a required custom field produces
   * `missing_required_field` and blocks `apply`. `byIssueType` overrides
   * `defaults` and is keyed by the type NAME in the target.
   */
  fields?:
    | {
        defaults?: Record<string, unknown> | undefined;
        byIssueType?: Record<string, Record<string, unknown>> | undefined;
      }
    | undefined;
}

/** Merges `defaults` + `byIssueType[targetType]`, with the more specific one winning. */
export function resolveFieldsFor(
  config: MappingConfig,
  targetIssueType: string,
): Record<string, unknown> {
  return {
    ...(config.fields?.defaults ?? {}),
    ...(config.fields?.byIssueType?.[targetIssueType] ?? {}),
  };
}
