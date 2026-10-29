# Local build

This checkout is upstream `openchamber/opencode-claude` at tag `v1.6.0` plus
one code commit (the dependency pin) and the notes commits on the branch
`local/steering`. Nothing here is meant to go upstream. The branch is kept in
the fork `longsman/opencode-claude`, which every machine uses.

Every machine has the checkout at `~/docker-apps/opencode-claude`: this host
(minilongsman2), `minilongsman`, the MacBook and `omarchymac133` (its
`opencode.service` is normally off). The remote names differ:

| | Linux hosts | Mac |
|---|---|---|
| upstream (`openchamber`) | `origin` (push disabled on minilongsman2: `no_push`) | `upstream` |
| the fork | `fork` (`origin` on omarchymac133) | `origin` |

Below, `git fetch --tags origin` means the upstream remote of the machine you
are on. After a rebase, `git push --force-with-lease` to the fork, then on each
other machine `git fetch <fork remote> local/steering`, `git reset --hard
FETCH_HEAD` and rebuild. The machines do not carry upstream's tags unless they
fetched them, so `git describe` there can show an older tag. The Mac has no
systemd, so restart its service from Terminal.app or the OpenCode app, not over SSH (the service would inherit the SSH session and could
not read the login keychain that holds the Claude credentials).

OpenCode v2 loads it through the `plugins` entry
`{"package": "../../docker-apps/opencode-claude"}` in
`~/.config/opencode/opencode.json`. For a plugin directory OpenCode loads
`server.js`, which re-exports `dist/`.

## What the commits change

**Pin the Agent SDK and zod** to the versions the npm install of 1.3.0
resolved on this machine (0.3.285 and 4.6.5), which upstream's ranges
(`^0.3.224`, `^4.4.3`) still allow. `node_modules` has not changed since.

The branch used to carry a second code commit that delivered mid-turn
messages to Claude as user input (`src/steering-delivery.ts`). Upstream 1.5.0
does the same (`bf4c32f`: the turn keeps its SDK input open and steering goes
in as a user message), so it was dropped on 2026-10-28 when moving to 1.6.0.
The branch name `local/steering` is a leftover. The old build is kept as the branch
`local/steering-v1.3.7` in the fork if it is ever needed.

## Rebuild

```bash
bun install && bun run build && bun run test
```

`dist/` is not tracked, and OpenCode reads `dist/`. A rebuild needs no server
restart: OpenCode watches the plugin's whole directory (`.git` included, so
even `git status`, `commit` or `fetch` reloads every plugin once; seen on
2026-10-14) and, on a change, unloads the plugin and loads the new files. The
build deletes `dist/` first, so a plugin load can fail for a moment during a
rebuild and succeed on the next change event. Checked on OpenCode 2.0.26 with
a small test plugin on the scratch instance (2026-10-11): a changed imported
file was live within a second in the same server process, and a file that
fails to load leaves the previous copy running. By its own design
(`acquireProxy` / `releaseProxy` in `src/proxy.ts`) a turn waiting on a tool
is picked up by the new copy within 10 seconds, and a response that is
streaming finishes on the old one.

The loader skips files under `node_modules`, so a changed dependency (a new
SDK version) still needs a restart. A restart ends every running session.
From inside an OpenCode session, schedule it with `systemd-run --user`: a
command started by the session is in the service's control group and dies
with it.

## Move to a newer upstream

```bash
git fetch --tags origin
git rebase --onto vX.Y.Z v1.6.0 local/steering
bun install && bun run build && bun run test
```

- The pin commit can conflict in `package.json` or `bun.lock`. Drop it and
  redo it: `bun add --exact @anthropic-ai/claude-agent-sdk@<v> zod@<v>`.
- Moved from `v1.3.0` to `v1.3.7` on 2026-10-06 and to `v1.6.0` on
  2026-10-28. The steering commit conflicted in `src/proxy.ts` in the second
  move; the conflict was settled by taking upstream's files and keeping only
  `LOCAL.md` from that commit.

## Go back to the published plugin

Set the `plugins` entry to `{"package": "@openchamber/opencode-claude@1.6.0"}`.
