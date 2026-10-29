# fadedcode

A fork of [opencode](https://github.com/anomalyco/opencode) that restores and adds a few things the upstream maintainers decided against. It is a drop-in replacement: same config, same data, same TUI, plus the divergences below.

## why this exists

Upstream removed `TodoRead` from the tool registry and later shipped versions where `todowrite` silently failed to register even with explicit permission configuration ([#12680](https://github.com/anomalyco/opencode/issues/12680), [#29118](https://github.com/anomalyco/opencode/issues/29118)). The todo list is the backbone of long agent sessions here, so losing read access to it was not acceptable. From [the thread](https://github.com/anomalyco/opencode/issues/29118#issuecomment-4531080221) that started this fork (05/2026):

> this is more of a "I disagree with one decision `opencode` made" than a "I passionately want to develop my own, independent agent harness".

That is still the operating philosophy:

- **drop-in, not a divergent product.** The fork tracks upstream and pulls occasionally, when a missing feature or performance regression is solved there.
- **diverge only on disagreement.** Every delta below exists because the stock behavior got in the way of real sessions, not because a different design seemed nicer.
- **PRs and issues are welcome when they relate to the fork's own divergences.** Getting this into package managers is not a goal unless people actually use it.

## core differences from upstream

### todo tools restored

`todoread` is a first-class read-only tool again, wired through the agent, registry, permissions, ACP, and the TUI sidebar; `todowrite` reliably registers. Subagents deny `todoread` by default so todo state stays scoped unless explicitly granted.

### per-session MCP tool exposure (zero by default)

The biggest divergence. Upstream sends every connected MCP server's tool definitions to the model on every request; at ~40 servers / ~900 tools that made a bare "Hi" cost ~690k tokens, and any upstream server growing its catalogue silently raised the floor for every session.

Here, **sessions start with zero MCP tools exposed**:

- Servers still connect and their tools stay searchable, but nothing enters model context until shown.
- A built-in `mcp` tool lets the agent `search` / `show` / `hide` / `list`. Its description carries a compact catalogue of every reachable server, built from hand-written `advertisement` fields in the server profiles (string, or `{summary, facets}` for grab-bag servers where facets are tool-name prefixes exposable on their own). Search is lexical (BM25-ish with idf, plural folding, fuzzy server names) with facet and tool hits rolling up to their server.
- Toggles take effect on the **next model step**, so an agent can search, show, and use a server inside one turn. Exposure persists on the session row (survives compaction, restarts, and model switches); subagents inherit a snapshot at creation.
- `MCP_SERVERS` switchboard files (one plaintext file per directory, unioned from all ancestors of the cwd) decide which servers are catalogued; a `!name` or `!name:prefix` line pins something exposed at session start, and the deepest file wins per token so a project can un-pin a parent's pin.
- The ^p MCP dialog toggles per-session exposure with space; instance-wide connect/disconnect moved to ctrl+s. `GET/POST /mcp/exposure` exposes the same thing over the API, and per-request telemetry logs exposed tool count and estimated token cost.

Measured effect: first turn in a directory with 32 servers connected dropped from ~690k tokens to ~46k.

### MCP server profiles

`experimental.mcpProfilesPath` points at a directory of per-server JSON profile files (the same flat or `mcpServers`-wrapped shapes other MCP clients use, so the files stay portable). `{env:VAR}` and `{file:...}` references are expanded, letting profiles avoid hardcoded paths and secrets. The `MCP_SERVERS` switchboard, not the profile, decides what is enabled, so adding a profile never changes what starts up.

### edit tool: `replaceAll` removed

`replaceAll` caused file corruption often enough (especially with Dart) that it is gone: stripped from the JSON schema sent to the model, and a deprecation error if passed anyway. Batch edits route through `apply_patch` instead.

### TUI: open the transcript in `$EDITOR`

`<leader>v` and `/view` open the current session transcript in `$EDITOR`, reusing the existing transcript formatter.

## install

1. `bun install`
2. `./build.sh` to build the binary
3. `./install.sh` (assumes `darwin` and that you are fine with a new `opencode` script in `/usr/local/bin`)
4. `brew uninstall opencode` or `npm uninstall -g opencode-ai` to avoid shadowing

The wrapper launches the built `darwin-arm64` binary with `OPENCODE_DISABLE_CHANNEL_DB=true`. On other platforms, adjust the dist path in `wrapper.sh`.

## upstream documentation

Everything not listed above behaves like stock opencode: [docs](https://opencode.ai/docs), [upstream repo](https://github.com/anomalyco/opencode).
