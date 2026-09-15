---
name: unfold-resolve
description: Pick up the review notes left in the unfold UI for the current diff, act on each open note, and resolve it. Use when the user says /unfold-resolve or asks you to handle their unfold notes.
user-invocable: true
---

# unfold-resolve

Reads the review notes the user wrote in the unfold browser UI, acts on each
open one, and resolves it. `unfold notes` reads and writes the same SQLite file
the UI uses, so the review server does not need to be running and the UI picks
up your replies on its own.

Every note you write through the CLI is attributed to the agent, so the user can
tell your replies from their own.

## Prerequisites

Run this first. If it fails, stop and say so.

```bash
which unfold
```

If it is missing, tell the user to run `npm install -g <path-to-unfold>` and stop.

## Arguments

- **Diff selectors.** Pass through whatever refs the user gave (`--pr 123`,
  `--base main`, `main..feature`) to every `list` call, exactly as given. They
  select the same diff the UI showed. With no arguments the CLI uses the same
  default scope the UI used.
- **A single note id** (full UUID or a prefix of 6+ characters). When given,
  handle only that note and skip the listing step.

## Step 1 — List the open notes

Do this **before editing anything**, and keep the ids:

```bash
unfold notes list --status open --format json [refs…]
```

Each note carries `id`, `file`, `side` (`additions` = new lines,
`deletions` = old lines), `startLine`, `endLine`, the `code` it was anchored to,
`body`, and any `replies` oldest first.

If the list is empty, say there are no open notes for this diff and stop.

> `resolve`, `reply` and `show` take ids and are not scope-filtered, so address
> notes by id. Do not commit while working through them unless asked.

## Step 2 — Handle each note

For each open note, in order:

1. **Read the whole thread.** The first body is the request; replies may refine it.
2. **Skip notes waiting on the user.** If the last reply is yours and asks a
   question they have not answered, leave it and mention it in your summary.
3. **Decide what it asks for.**
   - An instruction ("rename this", "add a null check") → make the change.
   - A question that implies an action ("should this be a constant?") → treat it
     as a request and make the change.
   - A pure question ("why does this fall back to the primary org?") → answer it
     and resolve:
     ```bash
     unfold notes resolve <id> --body "<answer>"
     ```
   - Genuinely unclear → do not guess and do not silently skip:
     ```bash
     unfold notes reply <id> --body "<specific question>"
     ```
4. **Read the surrounding source before editing**, not just the anchored lines.
   The note is anchored to a line range, but the right fix may live nearby.
   Follow the repository's own guidelines (`AGENTS.md`, `CLAUDE.md`) and the
   conventions already in the file.
5. **Make the change**, then run the project's checks for the files you touched.
6. **Resolve with what changed**, in one or two sentences. Do not paste files:
   ```bash
   unfold notes resolve <id> --body "Fixed: <what changed and where>"
   ```

To read one note in full at any point:

```bash
unfold notes show <id>
```

## Step 3 — Report back

Re-run the listing from Step 1, then tell the user:

- which notes you resolved, one line each on what changed;
- which notes you replied to with a question and are waiting on;
- that the unfold UI has already picked up your replies.

## Leaving your own notes

If you notice something worth flagging while working — a risk, a follow-up, a
question about intent — put it on the diff rather than burying it in chat:

```bash
unfold notes create --file <path> --line <n> [--end-line <n>] \
  [--side additions|deletions] --body "<text>" [refs…]
```

Line numbers are new-file lines for `additions` (the default) and old-file lines
for `deletions`.
