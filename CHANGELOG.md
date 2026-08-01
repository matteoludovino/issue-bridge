# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- MIT license, contribution guide, security policy and GitHub Actions CI.

### Changed

- Project language is now English throughout: code comments, documentation, CLI
  help and user-facing messages.

## [0.1.0] - 2026-07-31

First working version. Migrates GitHub issues to Jira Cloud with a reviewable
plan, an idempotency ledger and a markdown report.

### Added

- **Hexagonal core** — `IssueModel` as the intermediate representation, a pure
  `buildPlan` with no I/O, and an executor that is the only place performing
  writes. Nothing under `src/core/` depends on GitHub or Jira.
- **GitHub source adapter** — REST, no SDK. Label-based classification into
  neutral type/status/priority, inline attachment discovery from markdown,
  hierarchy from task lists, and pagination via the `Link` header.
- **Jira Cloud target adapter** — REST v3, no SDK. Capability discovery from
  `createmeta`, a markdown to ADF converter, multipart attachment upload and
  single-step status transitions.
- **Incremental sync** — `updatedSince` on the source port, with a watermark
  stored separately from the ledger. Simulation and failure do not advance it.
- **Parallel execution** — a dependency-aware scheduler over the plan's
  `dependsOn`, with configurable concurrency. Results are always reported in plan
  order.
- **Retry with exponential backoff**, driven by error classification. A
  server-provided `Retry-After` is honoured over the computed delay.
- **Durable ledger** — atomic JSON writes, serialized, so an interrupted run
  never loses the mappings it already created.
- **CLI** — `login`, `export`, `analyze`, `apply`, `sync`, `report`, `ledger`.
  `apply` and `sync` require `--yes` to write; without it they simulate. Exit
  code 1 makes `analyze` usable as a CI gate.
- **Configuration** — YAML validated with Zod in strict mode, so an unknown key
  is an error rather than silently ignored. Credentials come only from
  environment variables.
- 153 tests, none of which reach the network, including a process-level suite
  that drives the real binary against a local HTTP server.

[Unreleased]: https://github.com/matteoludovino/issue-bridge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/matteoludovino/issue-bridge/releases/tag/v0.1.0
