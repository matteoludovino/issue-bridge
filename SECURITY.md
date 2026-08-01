# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Use GitHub's [private vulnerability
reporting](https://github.com/matteoludovino/issue-bridge/security/advisories/new)
so the report stays confidential until a fix is available.

Include the version, the commands you ran, and the smallest configuration that
reproduces the problem. Please redact tokens from any log you attach.

## What this tool has access to

`issue-bridge` runs locally with two sets of credentials: a token that can read
the source tracker, and a token that can **write** to the target project. A
defect that causes it to write to the wrong project, or that leaks either token,
is in scope.

Handling rules the codebase follows, and that a fix must not regress:

- **Credentials are never read from the configuration file.** The YAML holds only
  the *name* of an environment variable, so the file is safe to commit.
- **Credentials are never logged.** Errors carry HTTP status, vendor error codes
  and field names — not request headers. URLs in error messages have their query
  string redacted, because a search URL can carry issue content.
- **`--yes` is required to write.** Without it, `apply` and `sync` run as a
  simulation. Any change that lets a write happen without explicit confirmation
  is a security-relevant regression.

## Handling migration artifacts

The files under `.issue-bridge/` are not secrets, but they are sensitive:
`snapshot.json` contains the full body of every extracted issue, including from
private repositories, and the report contains issue titles.

That directory is in `.gitignore`. Please keep it that way — a snapshot attached
to a public pull request would expose a third party's private data.

## Supported versions

The project is pre-1.0. Fixes land on `main` and are released from there; there
are no maintenance branches for older versions yet.
