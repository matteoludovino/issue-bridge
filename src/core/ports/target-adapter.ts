import type { SourceRef } from '../models/common.js';
import type { AttachmentPayload } from './attachment-fetcher.js';

export interface CustomFieldDescriptor {
  id: string;
  name: string;
  type: string;
}

/**
 * Snapshot of the target discovered at runtime. It is the Planner's second input
 * and the reason planning can be pure: the core never assumes issue types,
 * statuses or required fields.
 *
 * Conventions:
 *  - `workflow.statuses[0]` is the initial status of a newly created issue.
 *  - `workflow.transitions` maps current status → statuses reachable from it.
 *  - `requiredFieldsByIssueType` is keyed by the type NAME in the target and lists
 *    required field ids/names (`summary`, `customfield_10042`).
 */
export interface TargetCapabilities {
  issueTypes: string[];
  priorities: string[];
  workflow: {
    statuses: string[];
    transitions: Record<string, string[]>;
  };
  components: string[];
  versions: string[];
  labels: string[];
  requiredFieldsByIssueType: Record<string, string[]>;
  customFields: CustomFieldDescriptor[];
}

/**
 * Reference to an item that already exists in the target.
 *
 * `url` allows an explicit `undefined` because this type crosses Zod boundaries
 * (JSON ledger, run log), and Zod's output always includes `undefined` in
 * optional fields. No consumer distinguishes "absent" from "undefined".
 */
export interface TargetItemRef {
  id: string;
  humanRef: string;
  url?: string | undefined;
}

export type TargetItemKind = 'issue' | 'epic' | 'version' | 'component' | 'label';

/**
 * Search criteria for a pre-existing item in the target. Used to reconcile
 * partial migrations when the RollbackStore has been lost.
 */
export interface FindExistingCriteria {
  kind: TargetItemKind;
  projectKey: string;
  /** Source entity to look for in the target (via the provenance marker). */
  sourceRef?: SourceRef;
  /** Exact name, for catalogs (version, component, label, epic). */
  name?: string;
  /** Exact title, for issues. */
  summary?: string;
}

export interface CreateEpicInput {
  projectKey: string;
  name: string;
  description?: string;
  /** Extra fields keyed by target field id (includes custom fields). */
  fields: Record<string, unknown>;
  sourceRef: SourceRef;
}

export interface CreateVersionInput {
  projectKey: string;
  name: string;
  description?: string;
  releaseDate?: string;
  sourceRef: SourceRef;
}

export interface CreateComponentInput {
  projectKey: string;
  name: string;
  description?: string;
}

export interface CreateLabelInput {
  projectKey: string;
  name: string;
}

export interface CreateIssueInput {
  projectKey: string;
  issueType: string;
  summary: string;
  description: string;
  priority?: string;
  labels: string[];
  assignees: string[];
  /** References already resolved by the Executor via the RollbackStore. */
  epicRef?: TargetItemRef;
  versionRef?: TargetItemRef;
  parentRef?: TargetItemRef;
  fields: Record<string, unknown>;
  sourceRef: SourceRef;
}

export interface CreateCommentInput {
  issueRef: TargetItemRef;
  body: string;
  sourceRef: SourceRef;
}

export interface CreateAttachmentInput {
  issueRef: TargetItemRef;
  /**
   * Content already downloaded by the Executor via `AttachmentFetcher`. The target
   * adapter does NOT access the source — it knows neither its URL nor its credential.
   */
  payload: AttachmentPayload;
  /** Source URL, for diagnostics and provenance only. */
  sourceUrl: string;
  sourceRef: SourceRef;
}

export interface CreateLinkInput {
  fromRef: TargetItemRef;
  toRef: TargetItemRef;
  linkType: string;
}

/**
 * Write port. A new target (Azure DevOps, Linear) implements only
 * this interface.
 *
 * Contract:
 *  - Each method is a single, atomic write from the Executor's point of view;
 *    the adapter does NOT retry or batch (that is the Executor's policy).
 *  - `discoverCapabilities()` is the single source of truth about the target.
 *  - Errors are thrown as `MigrationError` for the Executor to classify.
 */
export interface TargetAdapter {
  /** Platform identifier (`jira`). */
  readonly platformName: string;

  authenticate(): Promise<void>;

  discoverCapabilities(projectKey: string): Promise<TargetCapabilities>;

  findExisting(criteria: FindExistingCriteria): Promise<TargetItemRef | null>;

  createEpic(input: CreateEpicInput): Promise<TargetItemRef>;

  createVersion(input: CreateVersionInput): Promise<TargetItemRef>;

  createComponent(input: CreateComponentInput): Promise<TargetItemRef>;

  createLabel(input: CreateLabelInput): Promise<TargetItemRef>;

  createIssue(input: CreateIssueInput): Promise<TargetItemRef>;

  createComment(input: CreateCommentInput): Promise<TargetItemRef>;

  createAttachment(input: CreateAttachmentInput): Promise<TargetItemRef>;

  createLink(input: CreateLinkInput): Promise<TargetItemRef | null>;

  transitionIssue(issueRef: TargetItemRef, targetStatus: string): Promise<void>;
}
