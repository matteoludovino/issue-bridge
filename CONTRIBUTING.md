# Contributing

Thanks for considering a contribution. This document covers the two things that
are specific to this project: the architectural rule that must not be broken,
and how to work without touching a real GitHub or Jira instance.

## Getting started

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build
```

Node 22.12 or newer. There is no test that reaches the network — see below.

## The one architectural rule

**Nothing under `src/core/` may import a vendor-specific module.** The core knows
the intermediate model (`IssueModel`) and the ports (`SourceAdapter`,
`TargetAdapter`, `RollbackStore`, `AttachmentFetcher`) and nothing else.

That rule is what makes a new connector cheap: adding GitLab as a source means
implementing `SourceAdapter`, with zero changes to the planner or executor. If a
change requires the core to learn about GitHub or Jira, the change is in the
wrong layer.

You can check the boundary yourself:

```bash
grep -rhoE "from '[^.][^']*'" src/core --include='*.ts' | sort -u
# expected: only 'zod' (and 'vitest' in test files)
```

Layer direction: `cli` → `composition` → `adapters` / `storage` / `config` →
`core`. Never the other way.

## Where things go

| Layer | Responsibility |
|---|---|
| `core/models` | Intermediate model, as Zod schemas. Source of truth for types. |
| `core/ports` | Interfaces. No implementation. |
| `core/planner` | `buildPlan` — a pure function. No I/O, not even a clock. |
| `core/executor` | The only place that performs writes, plus retry and scheduling. |
| `adapters/*` | Vendor translation. All external payloads validated with Zod. |
| `config` | YAML loading and validation. Credentials only from env vars. |
| `storage` | Durable state: ledger and sync watermark. |
| `reports` | Markdown rendering — pure functions. |
| `cli` | Argument parsing and wiring. No business logic. |

## Testing

Every test is offline. Two mechanisms make that possible:

- **`HttpClient` is an interface.** Adapter tests inject a fake that matches
  routes by substring and returns canned payloads.
- **`src/cli/main.process.test.ts` spawns the real binary** against a local
  `node:http` server that simulates both GitHub and Jira. It is the only test
  that covers the commander wiring, so if you touch `src/cli/main.ts`, it is the
  one that will catch you.

Please do not add a test that requires credentials or network access.

When you add a rule to the planner, prefer a test that asserts the emitted
`PlanFinding` code rather than a message — codes are the stable contract.

## Style

- TypeScript strict, with `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. Both are on for a reason: they have already
  caught real defects in this codebase. Do not weaken them to make a change
  compile.
- Comments explain **why**, not what. If a decision looks arbitrary, the comment
  should say what the alternative was and why it lost.
- English for code, comments, docs, commit messages and user-facing strings.
- Runtime dependencies are deliberately minimal (`zod`, `yaml`, `commander`). A
  PR adding one should explain why the ~30 lines it replaces are not worth
  owning.

## Commits and pull requests

- Conventional Commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.
- The subject line says what the thing *is*, not what you did.
- Describe user-visible behaviour changes in the body, and add an entry to
  `CHANGELOG.md` under `## Unreleased`.
- CI must be green: typecheck, tests and build, on Node 22 and 24.

## Adding a connector

1. Implement the port in `src/adapters/<vendor>/`, validating every payload with
   Zod at the boundary.
2. Translate vendor errors into `MigrationError` with the right code — the
   executor's retry policy depends on `retryable`, so classifying a rate limit as
   `unknown` silently disables retry.
3. Register it in `src/composition.ts` and extend the `platform` literal in
   `src/config/schema.ts`, so an unsupported value fails at config validation
   instead of at runtime.
4. Document the vendor's real limitations in `README.md`. Honest limitations are
   better than surprises during a one-way migration.

## Reporting a security issue

Do not open a public issue. See [SECURITY.md](SECURITY.md).
