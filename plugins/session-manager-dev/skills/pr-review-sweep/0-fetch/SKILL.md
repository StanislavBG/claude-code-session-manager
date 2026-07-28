---
name: pr-review-sweep:fetch
description: Step 0 of pr-review-sweep — fetch every unresolved review thread on one or more of the current project's PRs, fully paginated. Never trust file names, a prior status report, or a reply's own claim about what's outstanding.
---

# pr-review-sweep:fetch

Query GitHub's GraphQL API directly for each PR. Resolve `$owner`/`$name` from the current
project's own remote — `gh repo view --json owner,name -q '.owner.login,.name'` — never
hardcode a repo.

```graphql
query($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $n) {
      reviewThreads(first: 100) {
        totalCount
        nodes {
          isResolved
          path
          line
          comments(first: 3) { nodes { author { login } body createdAt } }
        }
      }
    }
  }
}
```

Filter to `isResolved: false`. **`first: 100` is load-bearing** — `first: 50` silently
truncates on any PR that has grown past 50 threads (two real PRs hit this: one had 64
threads, another had 55; the truncated queries under-reported unresolved counts and caused
genuinely-missed comments). Always compare `totalCount` to how many nodes you actually
paged through, and keep paginating (`after:` cursor) until they match — never report a
count you haven't verified is complete.

## Output

One unresolved-thread list per PR, each entry carrying: the PR number, thread id, file
path + line, and full comment text/author/timestamp — everything `pr-review-sweep:classify`
needs to decide disposition and type without a second round-trip to GitHub.
