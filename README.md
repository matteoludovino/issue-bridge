# issue-bridge

Migrate issues between trackers — today GitHub → Jira Cloud — with a reviewable
plan, an idempotency ledger and a markdown report.

[![CI](https://github.com/matteoludovino/issue-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/matteoludovino/issue-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A tracker migration is a one-way operation against someone's real backlog, so
this tool is built around three properties:

- **Nothing is written before you can read what will be written.** `analyze`
  produces a plan and a report; `apply` refuses to run while the plan has a
  blocking error, and simulates unless you pass `--yes`.
- **Re-running is always safe.** Every created item is recorded in a ledger, so
  a run interrupted halfway resumes instead of duplicating.
- **Limitations are documented, not discovered.** What the GitHub and Jira APIs
  cannot do is listed below, before you find out mid-migration.

Runtime dependencies: `zod`, `yaml`, `commander` — none of which have transitive
dependencies.

> Status: pre-1.0, not yet published to npm. Install from source.

## Install

```bash
git clone https://github.com/matteoludovino/issue-bridge.git
cd issue-bridge
npm install
npm run build
npm link          # optional, puts `issue-bridge` on your PATH
```

Node 22.12 or newer.

## Quick start

```bash
cp issue-bridge.example.yaml issue-bridge.yaml   # then edit it

export GITHUB_TOKEN=ghp_...
export JIRA_EMAIL=bot@acme.com
export JIRA_API_TOKEN=...

issue-bridge login      # validate both credentials
issue-bridge analyze    # build the plan and report, writing nothing
issue-bridge apply      # SIMULATION (no --yes)
issue-bridge apply --yes
```

Credentials **never** live in the YAML — it only holds the *name* of the
environment variable to read. The configuration file is meant to be committed.

### Recommended flow

1. Run `analyze` until it exits 0. Every blocking error names the problem code
   and the configuration key that resolves it.
2. Run `apply` without `--yes` to see exactly what would be written.
3. Run `apply --yes`. If anything fails, fix it and run again — the ledger skips
   everything that already exists.

## Commands

| Command | What it does |
|---|---|
| `login` | Validates the source and target credentials |
| `export` | Extracts the source into a local snapshot, target untouched |
| `analyze` | Builds the plan and report; exits 1 if the plan has an error |
| `apply` | Executes the plan; simulates unless `--yes` |
| `sync` | Migrates only what changed since the last successful sync |
| `report` | Re-renders the report from artifacts on disk, offline |
| `ledger` | Lists the source → target map |

Global flags: `-c/--config`, `-o/--out-dir`, `-v/--verbose`, `-q/--quiet`,
`--json`. Human logging goes to stderr, data to stdout, so
`issue-bridge ledger --json | jq` works.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Ran, but the plan has a blocking error or an action failed |
| 2 | Aborted: invalid config, credentials or artifact |

`analyze` exiting 1 makes it usable as a CI gate.

### Artifacts

Everything lands in `.issue-bridge/` (change it with `-o`):

| File | Contents |
|---|---|
| `snapshot.json` | The extracted source, in the intermediate model |
| `plan.json` | Ordered list of actions plus diagnostics |
| `execution.json` | Per-action outcome, including attempts spent |
| `migration-report.md` | Human-readable report |
| `ledger.json` | Source → target map |
| `sync-state.json` | Watermark: how far the source has been read |

That directory is gitignored: `snapshot.json` holds the full body of every
extracted issue, including from private repositories.

## Configuration

See [`issue-bridge.example.yaml`](issue-bridge.example.yaml) — it is commented and
validated by a test, so it cannot drift from the schema.

The YAML is parsed in **strict mode**: an unknown key is an error, not something
silently ignored. A typo like `milestoneStategy` fails validation instead of
quietly changing behaviour.

Every mapped value is checked against the target during `analyze`. If
`mappings.issueTypes.bug` points at a type that does not exist in Jira, you get
an `unmapped_value` error before anything is written.

## Incremental sync

`sync` reads only what changed since the last successful run (using the source's
`updated_at` filter), applies it, and only then advances the watermark.

- The stored watermark is the moment the extraction **started**. An item changed
  mid-run falls into the next window instead of being lost — the cost is
  reprocessing a few items, which idempotency absorbs.
- **Simulation and failure do not advance the watermark.** Advancing there would
  hide items that never reached the target.
- `--since <iso>` overrides the watermark; `--full` ignores it.
- Deleting `sync-state.json` forces a full re-read **without** losing the
  mappings already created — they are deliberately separate records.

What `sync` **brings**: new issues, new comments, status changes.
What `sync` **does not bring**: edits to the title, body, labels or assignee of an
already-migrated item — the plan has no update action, only create.

## Parallelism

`execution.concurrency` (default 4) controls how many independent actions are
written at once. The scheduler uses the plan's `dependsOn`: an action starts only
after all of its dependencies have completed, and if one of them failed, the
dependents are dropped without spending an attempt.

Past roughly 8, the target's rate limit tends to become the bottleneck — retry
absorbs it, but the run gets slower. Use `concurrency: 1` to debug with a
deterministic order. Report output is always in plan order regardless of
concurrency.

## Why `ledger` and not `rollback`

Jira cannot cleanly undo issue creation: there is no endpoint that reverts a
migration without a trace, and bulk-deleting issues destroys history that may
already have been referenced. Calling the command `rollback` would promise
something the target API does not deliver.

What the record actually does, in order of importance:

1. **idempotency** — re-running `apply` duplicates nothing;
2. **reconciliation** — resolves where to write when something failed midway;
3. **audit** — lists what was created, for a manual cleanup if you need one.

## Known limitations

These are limits of the APIs involved, not missing work:

- **GitHub attachments** have no dedicated endpoint: they exist only as URLs in
  the markdown body. Anything outside the body is not discovered.
- **Hierarchy** comes from task lists (`- [ ] #42`); the sub-issues GraphQL API is
  not used.
- **Status transitions are single-step.** A workflow that requires an
  intermediate step fails on the transition action, with the available
  transitions listed in the error.
- **Jira's workflow is not introspectable** without an existing issue, so
  `analyze` cannot precisely validate status reachability.
- **A required custom field needs a value** under `mappings.fields`; without one,
  `analyze` blocks — deliberately, since failing there beats failing halfway
  through writing.
- **ADF conversion** covers paragraphs, headings, code, lists, quotes and inline
  marks. Tables and nested lists degrade to text.

## Architecture

Hexagonal, ports and adapters. The core (`src/core/`) knows the intermediate
model and the interfaces — nothing else. Adding GitLab as a source means
implementing `SourceAdapter`; adding Azure DevOps as a target means implementing
`TargetAdapter`. No line of the core changes.

Outside its tests, `src/core/` imports exactly one external package: `zod`. That
is checkable:

```bash
grep -rhoE "from '[^.][^']*'" src/core --include='*.ts' --exclude='*.test.ts' | sort -u
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the layer map and where things belong.

## Development

```bash
npm run typecheck   # tsc --noEmit (strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes)
npm test            # vitest
npm run build
```

No test touches the network. Adapters are exercised through a fake `HttpClient`,
and `src/cli/main.process.test.ts` spawns the real binary against a local HTTP
server that simulates both GitHub and Jira — including a full
`analyze → apply → ledger → re-apply` cycle.

## Contributing

Bug reports and pull requests are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md). For a security issue, please follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.

## License

[MIT](LICENSE) © Matteo Ludovino
