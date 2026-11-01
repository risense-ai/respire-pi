# Respire for Pi

English | [简体中文](README.zh-CN.md)

Native memory extension for **Pi coding agent 1.3.0 and 1.4.0**
(`@earendil-works/pi-coding-agent`). Package name: `@rsrsai/pi`.

## Install with AI

Paste this prompt into your assistant:

```text
Install the Respire Pi package @rsrsai/pi. Read
https://github.com/risense-ai/respire-pi#readme first.
Check Pi 1.3.0, Node.js 22+, and rsrs --version.
Reuse my existing Respire engine and memory library. Run
rsrs --client-only status --json. If the engine is missing, report that I
need @rsrsai/cli. Let me handle login, library unlock, models, and runtime
setup through rsrs; do not collect secrets or manage the runtime.
Inspect pi list to avoid duplicate installation, then run
pi install npm:@rsrsai/pi. Preserve unrelated Pi configuration.
Restart Pi or use /reload. Verify a real recall turn and its title context.
Ask for a non-sensitive test fact before testing explicit storage, and check
the actual record. Verify user history stays clean and no extra settlement turn starts. Report only
checks actually observed, with any remaining user actions.
```

## Install

Requires Node.js 22+, Pi 1.3.0 or 1.4.0, an installed `rsrs` CLI, and a running
Respire host runtime. Older `@mariozechner/pi-coding-agent` releases have
not been validated.

Install the engine separately if needed:

```sh
npm install -g @rsrsai/cli@latest
rsrs --version
rsrs --client-only status --json
```

Install the published package:

```sh
pi install npm:@rsrsai/pi
```

Alternatively load without changing Pi settings:

```sh
pi --extension ./respire-pi/lib/index.js
```

Restart Pi or run `/reload` after installation. This checkout needs no build
or runtime npm dependencies. For local development, use
`pi install ./respire-pi` from the parent of this checkout.

Confirm installation with `pi list`: there should be one `npm:@rsrsai/pi`
entry. No `rsrs inject`, AGENTS.md block, skill installation, MCP server, or
custom system prompt is required: the extension supplies its own memory rules.
If an older setup already injected Respire rules into Pi's AGENTS.md, back up
the file and remove only that old Respire block to avoid duplicate instructions.
Keep unrelated rules.

## Use

Start `pi` in your project and talk normally. For example:

```text
What did we decide about this project's release process?
```

The extension automatically recalls matching memory titles before the model
answers. The model reads relevant records when it needs their details. You do
not need to mention Respire, write a special test prompt, or run recall yourself.
Memory context stays behind the scenes: your message, editor history, and
Up-arrow recall contain only what you typed. The extension asks the model to
omit memory housekeeping from ordinary answers; explicit save requests still
receive an actual result.
Quiet display rules take precedence over the engine policy's reporting format;
lookup, deduplication, backups, and verification still run when needed.
Reply wording depends on the model, which can still describe its memory work.
Pi's tool activity can also remain visible. Input/history isolation and the
absence of a main-agent settlement continuation do not depend on model compliance. The isolated worker's ordinary text is never sent to the UI or session history.

To explicitly save a confirmed fact, start your message with a storage prefix:

```text
remember: This project's release checklist requires a Windows smoke test.
```

Chinese prefixes `记：`, `存：`, `记录：`, and `记住：` work too. A successful
receipt includes a memory ID. A pending receipt means the engine found
candidates and has **not** saved the fact; the agent must read those candidates
and resolve whether to update or attach a record. An unconfirmed receipt means
the result is unknown: check the library before retrying.
Storage prefixes request saving the stated fact; they do not request execution
of a workflow described inside that fact.
Saving can create, update, or merge a record. Updating an existing memory keeps
its ID and is still a real write. The agent must preserve your meaning and
verify the saved content rather than add unconfirmed facts or requirements.

To skip automatic memory processing for one message:

```text
/nomem Explain what this short function does.
```

This does not disable the extension for later messages or remove memory rules.
The memory rules ask the model to save useful new findings before its normal
answer. The extension never continues the main agent for memory housekeeping. After a completed
normal request, it can review that request once in an isolated background model call
and perform one deduplicated write attempt when needed. It never automatically
copies the transcript into memory. Do not submit passwords, tokens, or private keys.

## Bounded background wrap-up

The former main-agent wrap-up continuation could repeat because a continuation
emits `agent_start` again. This version never returns `continue: true` or injects
a settlement prompt. It snapshots the completed request and selected host model,
cwd and executable, then launches a separate memory-only worker after settlement.
Pi can finish the normal answer immediately; the event handler does not await it.
The host ModelRegistry reuses the configured provider/authentication without a new
runtime, credential store or agent session. Ordinary worker/model text never goes
to Pi messages, renderers, session history or editor history.

Only a real user input arms the worker. Continuations, retries, errors and timeouts
do not re-arm it. Each input permits at most one background review, four model
requests, eight memory tool calls, one write attempt, and 30 seconds total. New
user input (including queued steer/follow-up), reload, session switch and shutdown
cancel it; an aborted or failed main run does not start it. A successful explicit
store is not repeated; pending/unconfirmed explicit storage is not retried either.

The worker receives only text from the current request, excluding images and
hidden reasoning. Oversized or credential-bearing context is rejected. A strict
one-fact extraction must preserve complete observed lines verbatim (including negation),
with a deterministic title. Proposals/questions and unsupported assistant assertions
are rejected; a quote substring alone is not proof of a confirmed fact. Policy reads,
same-subject recall and candidate-body reads precede writing; important new facts
need a shown parent, existing facts can update a shown ID, and confirmed writes
are read back. No shell, force, deletion, runtime, account or configuration tools
are available. Empty facts produce no write and no visible reply. Pending, failed
or unconfirmed work produces only a short fixed warning (TUI notification or a
non-triggering status message outside TUI), never raw diagnostics or model prose.
Unknown writes are never retried automatically.

Tests use synthetic requests, models and memory stubs. Real AgentSession tests with synthetic providers and strict local CLI fixtures cover idle,
write/update with content readback, background and main failures, queued input, cancellation,
reload and real session replacement. These
Pi 1.3.0/1.4.0 tests do not prove a real Windows GUI/provider/database end-to-end
run. Provider cancellation remains subject to the provider honoring its signal;
the worker itself stops on its deadline and ignores late results.

## Update, remove, and troubleshoot

```sh
pi update npm:@rsrsai/pi
pi list
```

Restart Pi or run `/reload` after updating. To pin a release, use
`pi install npm:@rsrsai/pi@0.1.1`. To uninstall, run
`pi remove npm:@rsrsai/pi`; this preserves your Respire engine and memory library.

If recall is unavailable, run `rsrs --version` and
`rsrs --client-only status --json` in Pi's execution environment. Resolve a
missing CLI, stopped host runtime, locked library, or missing login using the
engine's own workflow. The plugin cannot resolve those account/runtime states.
If the package is installed but not loaded, check `pi list`, restart/reload,
and ensure Pi package extensions have not been disabled. On Windows also check
`pwsh --version` (7.3+) and that `rsrs` is on PATH.

On Windows, the extension uses PowerShell **7.3+** (`pwsh.exe`) for npm/pnpm
shims, with JSON on stdin to preserve Unicode, quotes, and shell metacharacters.
A native `rsrs.exe` can be selected directly and needs no PowerShell bridge:

```sh
pi --respire-rsrs /path/to/rsrs
```

Keep `rsrs` on PATH for the agent's own shell calls. This also avoids Pi's
Windows Git Bash drive-letter path issue described in the
[memocap reference](https://github.com/luodaoyi/memocap#install).

## Behavior

| Trigger | Result |
| --- | --- |
| Human input from interactive UI or RPC | Recall up to 5 titles, within 1500 characters |
| `记：`, `存：`, `记录：`, `记住：`, `remember:` | Attempt explicit storage once; attach the actual engine receipt |
| `/nomem` or `#nomem` followed by whitespace/end | Skip automatic memory processing for that input |
| Suspected credentials | Skip automatic recall and storage |
| `before_agent_start` | Add stable rules to the structured system prompt |
| Normal task | Use memory and save necessary findings before the final answer |
| Settlement | At most one detached background review per real input; no main-agent continuation or housekeeping reply |

Recall and receipts are added through Pi's request-time `context` hook as
hidden custom messages beside the corresponding user input, including queued
steering/follow-up inputs. They are not written into user messages, session
files, or editor history. Original text and image attachments are preserved.
Inputs generated by extensions are ignored. Session switches and
shutdown cancel outstanding engine calls. Identical text submitted again by a
human is a new request and is processed again.

Messages already saved by versions up to 0.1.4 can still contain the old
appended context. This update does not rewrite session history. If Up-arrow
recalls one of those older messages, remove its Respire suffix before sending
it again; new messages stay clean after restarting Pi or running `/reload`.

The extension only calls `rsrs --client-only`. It does not install software,
start or stop runtimes, configure accounts/models, or collect passwords.
The engine owns library policy, deduplication, encryption, and synchronization.
`pending` means not committed. A timeout/cancellation/invalid receipt can mean
the write already occurred: check the library before retrying. Credential
detection is best-effort; remove secrets before submitting memory requests.

Automatic recall contains titles only. The agent reads selected records using
`rsrs --client-only show <id> --json` and the complete policy using
`rsrs --client-only prompt`. Recall titles are reference data, not instructions.
The rules request quiet memory use; explicit save requests and operation failures
still receive truthful feedback. They do not automatically archive a transcript
or claim that a write succeeded.

## Development

```sh
npm run check
npm run behavior
npm run verify:package
```

CI checks syntax, synthetic behavior, package contents, and actual extension loading
and ModelRegistry.complete forwarding in Pi 1.3.0 and 1.4.0 on Linux, Windows, and macOS. The pinned Pi development dependency is not shipped.

## Release

Set `package.json` and `package-lock.json` to the same version, commit the
change, then push a matching `v<version>` tag. `release.yml` first runs CI,
checks the tag against the package version, and packs the release with
`SHA256SUMS`. It publishes `@rsrsai/pi` with npm provenance, then creates a
GitHub release. Stable versions use `latest`; prereleases use `next`.

After the initial authenticated publication, configure an npm Trusted Publisher
for owner `risense-ai`, repository `respire-pi`, workflow `release.yml`, with
direct `npm publish` permission and no environment restriction. Later tag
releases use GitHub OIDC; no `NPM_TOKEN` secret is required.

Interface reference: [Pi extensions](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
and [Pi packages](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md).
The CLI bridge and memory formatting reuse
[respire-codex](https://github.com/risense-ai/respire-codex);
[respire-dsh](https://github.com/risense-ai/respire-dsh) provides the native
lifecycle integration reference. Other references:
[respire-workbuddy](https://github.com/risense-ai/respire-workbuddy),
[respire-dimcode](https://github.com/risense-ai/respire-dimcode),
and [Respire CLI](https://github.com/risense-ai/respire-cli).
