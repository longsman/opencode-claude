# Local build

This checkout is upstream `openchamber/opencode-claude` at tag `v1.3.0` plus
three commits on the branch `local/steering`. Nothing here is meant to go
upstream; pushing is disabled (`git remote get-url --push origin` prints
`no_push`).

OpenCode v2 loads it through the `plugins` entry
`{"package": "/home/longsman/docker-apps/opencode-claude"}` in
`~/.config/opencode/opencode.v2.json`. For a plugin directory OpenCode loads
`server.js`, which re-exports `dist/`.

## What the commits change

1. **Pin the Agent SDK and zod** to the versions the npm install of 1.3.0
   resolved on this machine (0.3.285 and 4.6.5). An unmodified build of this
   tag is byte-identical to the published 1.3.0 `dist/`, so with the pin the
   only differences from the plugin that ran before are commits 2 and 3.
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
3. **Upstream's fix for the "third-party app" refusal**, cherry-picked from
   v1.3.3 (`917b293`, upstream issue #33). In 1.3.0 the bridge copied
   OpenCode's system prompt into Claude's from `# Code Mode` to the next
   `# ` heading. Without such a heading that reached OpenCode's environment
   block, and Anthropic refused the request with `400 Third-party apps now
   draw from your extra usage`. The copy now ends with the tool list.

## Rebuild

```bash
bun install && bun run build && bun run test
```

`dist/` is not tracked, and OpenCode reads `dist/`. After a rebuild, restart
the OpenCode server so it imports the new files.

## Move to a newer upstream

```bash
git fetch --tags origin
git rebase --onto vX.Y.Z v1.3.0 local/steering
bun install && bun run build && bun run test
```

- The pin commit can conflict in `package.json` or `bun.lock`. Drop it and
  redo it: `bun add --exact @anthropic-ai/claude-agent-sdk@<v> zod@<v>`.
- The steering commit can only conflict in its two hook-ins. If upstream
  reworks steering itself, drop the `proxy.ts` block: without it nothing
  calls `deliverSteering` and the build behaves as upstream does.
- The cherry-picked commit is already in v1.3.3 and later; the rebase drops
  it by itself.
- Checked on 2026-10-05: the two local commits apply cleanly to `v1.3.6` and
  all its tests pass.

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

Set the `plugins` entry to `{"package": "@openchamber/opencode-claude@1.3.0"}`.

## Limits

- A PDF attached to a mid-turn message still rides the tool result; the CLI
  keeps only the text and images of a queued message.
- The rebuild path for tool results with no parked turn
  (`answeredToolStepPrompt`) is unchanged and still introduces a notice as
  something the user sent.
- The behavior depends on the Claude Code CLI (checked with 2.1.284): it
  queues a user message that arrives mid-turn and surfaces it at the next
  tool boundary.
