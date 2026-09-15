# unfold

Read a pull request in the order it would have been built — contracts, then
what can call them, then what they do, then what they persist — one step at a
time, with the code beside it. The path is derived from the code. The model only
explains the step you are looking at, when you ask it to.

```bash
git clone git@github.com:DeveloperTheExplorer/unfold.git
cd unfold && npm install && npm link

cd ~/your-repo
unfold --pr 123      # or just `unfold` for the current branch
```

Needs Node 22.5 or newer, `git`, `ripgrep`, the `claude` CLI for explanations,
and `gh` for pull requests and posting. See [Requirements](#requirements).

## Why it works this way

Most review tools hand the whole diff to a model up front and ask it to decide
what matters. You then read the model's opinion instead of the code, and you
have no way back to the code on your own terms.

unfold splits those two jobs:

- **The path is deterministic.** The change is re-read in the order it would have
  been built — contracts, then what can call them, then what they do, then what
  they persist. Every stage is decided by a decorator, a path convention or a
  declaration kind. A node is a *symbol*, never a file, so one concept stays one
  step even when it spans several files.
- **The prose is on demand.** Press `e` on a step and one model call explains it,
  answering that stage's own question. Press `E` and everything under it is
  explained first, then composed upward. Answers cache against a content hash,
  so nothing is re-explained until the code changes.

```
OVERVIEW · Add node type policy project scope           +1468 −31
                                                    173 steps, 7 stages

1 · CONTRACTS — the shapes everything else agrees on         +19 −0
      2. class PutProjectPolicyDto                            +6 −0
      3. type ScopePolicy                                     +4 −0
      6. type NonDelegatingPolicyRule                          +3 −0

2 · ENTRY POINTS — what can be triggered, and what refuses it +50 −1
      8. class TypeAvailabilityPolicyProjectController        +43 −0
         10. GET  /projects/:projectId/node-type-policies/project
             auth session cookie · scope ProjectScope('nodeTypePolicy:manage')
             licence LICENSE_FEATURES.NODE_TYPE_POLICIES
             validates AuthenticatedRequest
         11. PUT  /projects/:projectId/node-type-policies/project
             validates PutProjectPolicyDto, AuthenticatedRequest

3 · SERVICES — what the change achieves                     +108 −7
4 · PERSISTENCE — what it reads and writes                   +53 −5
5 · TESTS — what is now pinned down                        +1012 −6
6 · IMPORTS AND TOP LEVEL                                   +174 −10
7 · EVERYTHING ELSE                                          +52 −2
```

## Facts, not prose, where facts exist

That endpoint block is not model output. It is read out of the decorator
arguments: the route from `@Post('/x')` plus the controller's `@RestController`
base, authorization from `@GlobalScope` / `@ProjectScope`, entitlement from
`@Licensed`, throttling from `ipRateLimit` / `keyedRateLimit`, and the contract
from the `@Body` DTO and the request type. Auth comes from the route's own
`skipAuth` / `allowUnauthenticated` / `apiKeyAuth` flags.

The model is given those facts and told not to restate them, so its three
sections — **Trigger**, **Refuses**, **Hands off to** — reason from them instead
of paraphrasing the diff.

Each stage asks its own question:

| Stage | Sections |
|---|---|
| Contracts | Shape · Consumers · Constraints |
| Entry points | Trigger · Refuses · Hands off to |
| Services | Achieves · Orchestrates · Unchanged |
| Persistence | Reads and writes · Consistency · Unchanged |
| External calls | Calls · Failure |
| Wiring | Registers · At boot |
| Surface | User sees · State |
| Tests | Pins · Gap |

The overview answers **Motivation · Outcome · Trigger surface · Where to look**,
and opens with the route table and the stage list before any model call runs.

## Nothing is hidden

Every hunk still lands in exactly one step. Anything the classifier cannot place
goes to **Everything else**, and import-only changes go to **Imports and top
level** so they stay out of the reading path without disappearing. The old
file-by-file tree is still there behind the **Files** button in the header, as a
second reading of the same diff — both views share node keys, so an explanation
written in one shows up in the other.

## The code that was already there

A diff shows you what changed. It does not show you what the change is standing
on. Every symbol node carries, found by ripgrep and the file's own import list:

- **The whole current body of the symbol**, with the changed lines marked, so
  you can see the branches the diff did not touch.
- **Resolved imports** the changed lines depend on, followed through relative
  paths and across workspace packages to the file and line that declares them.
- **Callers**, searched in the containing package — for a method, by its class.
- **Other uses in the same file**, and **tests** that name it.

## Notes, and three ways out

Click a line number to annotate; shift-click for a range. One note store, three
exits:

```bash
unfold notes list --status open            # what you wrote
unfold notes export --format xml           # for your coding agent
unfold notes export --format md --out r.md # for a file
unfold notes post --summary "…"            # as a real GitHub PR review
unfold notes reply <id> --body "…"         # the agent answers back
unfold notes resolve <id> --body "Fixed: …"
```

Notes are keyed to a scope hash, not to a run, so they survive re-running
`unfold` on the same diff after you edit the code.

## Memory

The browser tab never receives a syntax grammar, a theme, or a token array.
Highlighting happens on the server, per hunk, cached, and the tab gets finished
HTML for the lines it is showing. Only expanded tree rows exist in the DOM.

Measured on a 653-file, 46k-line diff (10,344 nodes): the tree builds in 1.1s
and costs 2.3 MB over the wire. Browser tab: 7 MB heap at rest, 17.5 MB after
walking 25 nodes, and the DOM falls back to 440 nodes on collapse — nothing is
retained — a collapsed tree is 160 DOM nodes. Server settles around 40 MB,
peaking near 400 MB while it serialises the tree. Tree rows are capped at 3,000
rendered at once.

## Commands

```
unfold                       current branch vs merge-base, uncommitted work included
unfold main..feature         an explicit range
unfold --pr 123              a pull request, by number or URL
unfold --ref branch          ignore uncommitted work
unfold path [refs]           print the build-order walk and exit
unfold tree [refs]           print the file tree instead
unfold tree --json           the tree as JSON
unfold notes <command>       see above
```

Options: `--port`, `--no-open`, `--model <name>`, `--tools synthesis|all|none`.

`--tools` controls whether the model may Read/Grep the repository while
explaining. `synthesis` (the default) allows it for file, package and root nodes
and withholds it for symbols and hunks, which already ship their full context.

Add `.unfoldignore` (gitignore syntax) to drop generated files from analysis.
They still appear under "Excluded from analysis" so nothing is silently hidden.

## Requirements

Node 22.5+ (for `node:sqlite`), `git`, `ripgrep`, the `claude` CLI for
explanations, and `gh` for `--pr` and posting. State lives in
`.git/unfold/unfold.sqlite`. Nothing leaves the machine until you explain a node
or post to GitHub.
