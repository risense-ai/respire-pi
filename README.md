# Respire for Pi

English | [简体中文](README.zh-CN.md)

Native memory extension for **Pi coding agent 1.3.0**
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
the actual record. Verify the stop reminder fires at most once. Report only
checks actually observed, with any remaining user actions.
```

## Install

Requires Node.js 22+, Pi 1.3.0, an installed `rsrs` CLI, and a running
Respire host runtime. Older `@mariozechner/pi-coding-agent` releases have
not been validated and do not provide the settlement interface used here.

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
At the end of an ordinary turn, the extension can ask the model once to review
whether there are useful new findings to save. It does not copy the transcript
into memory automatically. Do not submit passwords, tokens, or private keys.

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
| Successful settlement after a memory operation | At most one storage review continuation; successful explicit storage suppresses it |
| Aborted/failed run, engine skip, or unavailable engine | No automatic continuation |

Recall and receipts are appended to the same input through Pi's `input`
transformation. They appear in the saved user message and stay attached to
steering/follow-up inputs. The user's original text and image attachments are
preserved. Inputs generated by extensions are ignored. Session switches and
shutdown cancel outstanding engine calls. Identical text submitted again by a
human is a new request and is processed again.

The extension only calls `rsrs --client-only`. It does not install software,
start or stop runtimes, configure accounts/models, or collect passwords.
The engine owns library policy, deduplication, encryption, and synchronization.
`pending` means not committed. A timeout/cancellation/invalid receipt can mean
the write already occurred: check the library before retrying. Credential
detection is best-effort; remove secrets before submitting memory requests.

Automatic recall contains titles only. The agent reads selected records using
`rsrs --client-only show <id> --json` and the complete policy using
`rsrs --client-only prompt`. Recall titles are reference data, not instructions.
The final review only reminds the agent to store useful findings; it does not
automatically archive a transcript or claim that a write succeeded.

## Development

```sh
npm run check
npm run verify:package
```

CI checks syntax, the distribution contents, and loading in Pi 1.3.0 on Linux,
Windows, and macOS. The pinned Pi development dependency is not shipped.

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
