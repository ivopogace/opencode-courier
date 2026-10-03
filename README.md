# opencode-courier

An [OpenCode](https://github.com/anomalyco/opencode) V2 plugin that lets one session start other
sessions, message them, and be woken by them, without polling.

A parent session calls `courier_spawn`, gets a session id back immediately and ends its turn. The
child works on its own and, when it is done or stuck, calls `courier_send` with the parent's id.
That message lands in the parent's inbox and OpenCode starts a new turn for the parent if it is
idle.

> **Status: early scaffold.** Typechecked and unit-tested against
> `@opencode-ai/plugin@0.0.0-beta-19271`; not yet run inside a live OpenCode V2 server.

## How the wake works

There is no polling anywhere. `courier_send` calls the plugin API's `session.synthetic`, which
admits a message into the target session's inbox and, unless `resume: false` is passed, calls
`execution.wake` on it (`packages/core/src/session/session.ts` on OpenCode's `beta` branch).
OpenCode's own background subagents report to their parent the same way
(`packages/core/src/session/subagent-completion.ts`).

Delivery is `steer` by default (injected into the target's running turn, or starts one if idle);
`queue: true` waits until the current turn ends.

## Tools

| Tool | Does |
|---|---|
| `courier_spawn` | Creates a session (optionally in its own git worktree with `isolate: true`), sends it the task plus a brief naming the parent and how to report back, and returns at once. |
| `courier_send` | Delivers a message to a session, signed with the sender's id, waking it if idle. |
| `courier_status` | One look at a session: outcome, idle time and last reply. For check-ins, not for waiting. |

## Install

Requires OpenCode V2 (`npm install -g @opencode-ai/cli@beta`, command `opencode2`).

```bash
git clone <this repo> && cd opencode-courier
bun install && npm run build
```

Then list it in `opencode.json` (V2 uses `plugins`, plural):

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-courier/dist/index.js"]
}
```

Once published to npm, `opencode2 plugin add opencode-courier` installs it and adds it to the
global configuration.

## Using it

1. Keep the background server running so sessions can be woken while you are away
   (`opencode2 service start`; `opencode2 service status` to check).
2. Give the agents that run children permissions that don't need a human; a child waiting on an
   approval prompt never reports back.
3. Use `isolate: true` whenever children edit files in parallel.
4. A child that crashes before calling `courier_send` never wakes the parent. Until the scheduler
   below exists, pair long runs with a scheduled check-in (for example the `opencode-cron` plugin)
   that calls `courier_status`.

## Roadmap

- **Scheduled self-messages**: a `courier_later` tool (deliver a message to a session at a time),
  stored with the plugin `storage` API so it survives restarts. The safety net for silent children.
- **Webhook receiver**: a small service that turns GitHub (or any) webhooks into `courier_send`s.
- **Roster**: record spawned children per parent in plugin storage, so a parent can list them
  after a compaction or restart.
- **Worktree cleanup** when an isolated child finishes.

## Development

```bash
bun install
bun test           # unit tests, with a fake plugin context
npm run typecheck
npm run build      # emits dist/
```

The plugin API is still beta and pinned to an exact version in `package.json`; bump it
deliberately and re-run the typecheck.
