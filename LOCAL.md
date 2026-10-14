# Local build

This checkout is upstream `openchamber/opencode-claude` at tag `v1.3.7` plus
the local commits on the branch `local/steering` (two code commits, then notes
commits). Nothing here is meant to go upstream. The branch is kept in the fork
`longsman/opencode-claude`, which both machines use:

| | Linux (`~/docker-apps/opencode-claude`) | Mac (`~/opt/opencode-claude`) |
|---|---|---|
| upstream (`openchamber`) | `origin` (push disabled: `no_push`) | `upstream` |
| the fork | `fork` | `origin` |

Below, `git fetch --tags origin` means the upstream remote of the machine you
are on. After a rebase, `git push --force-with-lease` to the fork, then
`git pull --ff-only` (or reset) on the other machine and rebuild there. The Mac
config loads the checkout from `/Users/longsman/opt/opencode-claude`; the Mac
has no systemd, so restart its service with `opencode2 service restart` from
Terminal.app, not over SSH (the service would inherit the SSH session and could
not read the login keychain that holds the Claude credentials).

OpenCode v2 loads it through the `plugins` entry
`{"package": "/home/longsman/docker-apps/opencode-claude"}` in
`~/.config/opencode/opencode.json`. For a plugin directory OpenCode loads
`server.js`, which re-exports `dist/`.

## What the commits change

1. **Pin the Agent SDK and zod** to the versions the npm install of 1.3.0
   resolved on this machine (0.3.285 and 4.6.5), which upstream's ranges
   (`^0.3.224`, `^4.4.3`) still allow. `node_modules` has not changed since.
2. **Deliver mid-turn messages to Claude as user input.** A message sent
   while a tool runs used to be appended to the tool result, where Claude
   treats it as untrusted and does not act on it. It is now written to the
   running CLI as a user message, and OpenCode's own notices
   (`<system-update>` blocks) are sent as non-user messages.
   - `src/steering-delivery.ts`: all of the logic.
   - `src/query.ts`: three lines exposing the SDK's `streamInput` on the
     query handle as `sendUserMessage`.
   - `src/proxy.ts`: one block in the resume branch, marked
     `Local (steering-delivery.ts)`, that calls `deliverSteering`.
   - `test/steering-delivery-regression.ts`: its test. Upstream's tests are
     untouched and still pass.

## Rebuild

```bash
bun install && bun run build && bun run test
```

`dist/` is not tracked, and OpenCode reads `dist/`. A rebuild needs no server
restart: OpenCode watches every file the plugin imports outside
`node_modules` and, when the content of one changes, unloads the plugin and
loads the new files. Checked on OpenCode 2.0.26 with a small test plugin on
the scratch instance (2026-10-11): a changed imported file was live within a
second in the same server process, and a file that fails to load leaves the
previous copy running. Not yet tried with this plugin while a Claude turn
runs. By its own design (`acquireProxy` / `releaseProxy` in `src/proxy.ts`) a
turn waiting on a tool is picked up by the new copy within 10 seconds, and a
response that is streaming finishes on the old one.

The loader skips files under `node_modules`, so a changed dependency (a new
SDK version) still needs a restart. A restart ends every running session.
From inside an OpenCode session, schedule it with `systemd-run --user`: a
command started by the session is in the service's control group and dies
with it.

## Move to a newer upstream

```bash
git fetch --tags origin
git rebase --onto vX.Y.Z v1.3.7 local/steering
bun install && bun run build && bun run test
```

- The pin commit can conflict in `package.json` or `bun.lock`. Drop it and
  redo it: `bun add --exact @anthropic-ai/claude-agent-sdk@<v> zod@<v>`.
- The steering commit can only conflict in its two hook-ins. If upstream
  reworks steering itself, drop the `proxy.ts` block: without it nothing
  calls `deliverSteering` and the build behaves as upstream does.
- Moved from `v1.3.0` to `v1.3.7` on 2026-10-06 for upstream's compaction
  fixes: 1.3.1 stops a turn parked on a tool call when OpenCode compacts its
  chat (before, OpenCode compacted again after every step and re-ran the
  pending tool call each time), and 1.3.5 has the chat's own model write the
  summary instead of Haiku from a text copy cut to 400k characters. Both
  local commits applied without conflicts and all 31 test files passed.
- A third local commit, a cherry-pick of upstream's `917b293` (v1.3.3),
  conflicted in that rebase and was skipped, since `v1.3.7` contains it.

## Check that it works

In an OpenCode session on a `claude-code` model, start a long tool call
(`sleep 30`) and send a message while it runs. In Claude's transcript
(`~/.claude/projects/<project>/<session>.jsonl`) the message is an
`attachment` entry of type `queued_command` right after the tool result, with
`origin.kind` `human` (a notice has `unclassified` and `isMeta: true`). No
`tool_result` contains "While this tool was running".

When a message cannot be sent this way it rides the tool result as before,
and the bridge logs `could not send a mid-turn message as user input` to
`$XDG_DATA_HOME/opencode-claude/debug.log`.

## Go back to the published plugin

Set the `plugins` entry to `{"package": "@openchamber/opencode-claude@1.3.7"}`.

## Limits

- A PDF attached to a mid-turn message still rides the tool result; the CLI
  keeps only the text and images of a queued message.
- The rebuild path for tool results with no parked turn
  (`answeredToolStepPrompt`) is unchanged and still introduces a notice as
  something the user sent.
- The behavior depends on the Claude Code CLI (checked with 2.1.284): it
  queues a user message that arrives mid-turn and surfaces it at the next
  tool boundary.
