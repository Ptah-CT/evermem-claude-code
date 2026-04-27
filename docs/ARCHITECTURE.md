# EverMem Plugin — System Architecture

**Plugin:** `evermem` for Claude Code
**Version:** 0.2.0
**Backend:** EverMind Cloud v1 API (`https://api.evermind.ai`)

The `evermem` plugin gives Claude Code a persistent, cross-session memory. Every conversation is automatically extracted into searchable memory, and relevant memories are automatically injected into Claude's context whenever the user submits a new prompt.

---

## 1. High-Level Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              Claude Code (CLI)                                │
│                                                                              │
│   ┌────────────┐   ┌──────────────────┐   ┌───────────┐   ┌──────────────┐  │
│   │   Hooks    │   │  Slash Commands  │   │MCP Server │   │ User Memory  │  │
│   │            │   │                  │   │           │   │     Hub      │  │
│   │ SessionStart│  │ /evermem:search  │   │evermem_   │   │  (Browser)   │  │
│   │ Prompt     │   │ /evermem:ask     │   │ search    │   │              │  │
│   │ Stop       │   │ /evermem:hub …   │   │           │   │              │  │
│   │ SessionEnd │   │                  │   │           │   │              │  │
│   └─────┬──────┘   └────────┬─────────┘   └─────┬─────┘   └──────┬───────┘  │
│         │                   │                   │                │          │
│         └───────────────────┴────────┬──────────┴────────────────┘          │
│                                      │                                       │
│                          ┌───────────▼────────────┐                          │
│                          │  evermem-api.js (v1)   │  shared API client       │
│                          └───────────┬────────────┘                          │
└──────────────────────────────────────┼───────────────────────────────────────┘
                                       │
                                       │ Bearer EVERMEM_API_KEY
                                       │
                          ┌────────────▼─────────────┐
                          │   EverMind Cloud (v1)    │
                          │  POST /api/v1/memories   │
                          │  POST .../search         │
                          │  POST .../get            │
                          └──────────────────────────┘

       ┌────────────────────────┐                ┌─────────────────────────┐
       │   data/groups.jsonl    │                │   data/sessions.jsonl   │
       │ (per-keyId group list  │                │ (one entry per session  │
       │  used by the Hub)      │                │  for diagnostics)       │
       └────────────────────────┘                └─────────────────────────┘
```

The plugin is intentionally thin: all heavy lifting (memory extraction, semantic search, ranking) happens in the EverMind Cloud. The plugin only orchestrates capture, retrieval, and rendering.

---

## 2. Repository Layout

```
memory-plugin/
├── plugin.json                       # Claude Code plugin manifest
├── .claude-plugin/marketplace.json   # Marketplace manifest (version + name)
├── install.sh                        # Public install script (curl | bash)
│
├── hooks/
│   ├── hooks.json                    # Hook bindings (4 events)
│   └── scripts/
│       ├── session-context.js        # SessionStart  → inject recent memories
│       ├── inject-memories.js        # UserPromptSubmit → search + inject
│       ├── store-memories.js         # Stop → persist last user/assistant turn
│       ├── session-summary.js        # SessionEnd → diagnostic line
│       └── utils/
│           ├── evermem-api.js        # Single API client (v1)
│           ├── config.js             # Env / .env / cwd-derived config
│           ├── groups-store.js       # data/groups.jsonl writer
│           ├── debug.js              # Conditional debug logging
│           └── formatter.js          # Output formatting helpers
│
├── commands/                         # Slash commands (/evermem:*)
│   ├── ask.md  search.md  hub.md  projects.md  debug.md  help.md
│   └── scripts/search-memories.js
│
├── mcp/server.js                     # stdio MCP server exposing evermem_search
│
├── server/proxy.js                   # Local HTTP proxy for the Memory Hub
├── assets/dashboard.html             # Memory Hub single-page app
│
├── skills/memory-tools.md            # Hint skill for Claude
│
└── data/
    ├── groups.jsonl                  # Tracked groups per keyId
    └── sessions.jsonl                # Session diagnostics
```

---

## 3. Identity & Scoping

Every memory is written under three identifiers:

| Identifier   | Source                                              | Purpose                                                  |
|--------------|-----------------------------------------------------|----------------------------------------------------------|
| `apiKey`     | `EVERMEM_API_KEY` env var (or `.env` in plugin dir) | Authenticates with the cloud (account-level scope)        |
| `keyId`      | First 12 hex chars of `sha256(apiKey)`              | Local identifier; partitions `data/*.jsonl` by account    |
| `userId`     | `EVERMEM_USER_ID` (default `claude-code-user`)       | Becomes the `sender_id` on each saved message             |
| `groupId`    | `EVERMEM_GROUP_ID` or 9-char hash of working dir    | Per-project memory namespace; one group per repo          |

The default `groupId` is computed from the current working directory: 4 lowercased alphanumeric chars from the directory name plus 5 chars of `sha256(cwd)`. This means each repository gets a stable, isolated memory space without any user setup.

---

## 4. Hook Lifecycle

Claude Code emits events at well-defined points. The plugin binds four:

```
   ┌──────────────┐     ┌───────────────────┐     ┌────────────┐    ┌───────────────┐
   │ SessionStart │ ──▶ │ UserPromptSubmit  │ ──▶ │   Stop     │ ─▶ │  SessionEnd   │
   └──────┬───────┘     └────────┬──────────┘     └─────┬──────┘    └──────┬────────┘
          │                       │                     │                   │
   session-context.js     inject-memories.js     store-memories.js   session-summary.js
          │                       │                     │                   │
          │                       │                     │                   │
   getMemories()           searchMemories()       addMemory()          (local only)
   POST /memories/get      POST /memories/search  POST /memories/group
          │                       │                     │
          ▼                       ▼                     ▼
   "Last session: …"      "Recalling N memories…"    (silent, async)
   shown to user           injected into context
```

### 4.1 SessionStart — `hooks/scripts/session-context.js`

- Fetches the most recent ~5 memories for the current `groupId`.
- Renders a brief "last session" summary as a `systemMessage` so the user sees that EverMem is active.
- Records the current group in `data/groups.jsonl` (so the Hub can list it).
- Always exits 0 — never blocks the session.

### 4.2 UserPromptSubmit — `hooks/scripts/inject-memories.js`

- Reads the user's prompt from stdin.
- Skips if the prompt is shorter than 3 words or the API key isn't configured.
- Calls `searchMemories(prompt, { topK: 5, method: 'hybrid' })`.
- Filters out memories with `score < 0.1`.
- Emits two outputs in the hook's JSON response:
  - `systemMessage`: a short "Recalling N memories…" notice for the user.
  - `additionalContext`: the actual memory snippets injected into Claude's context window.
- Has a 10-second timeout — if the cloud is slow, the prompt proceeds without memories.

### 4.3 Stop — `hooks/scripts/store-memories.js`

- Reads the transcript path from the hook input.
- Extracts the last user message and last assistant message of the just-finished turn.
- Calls `addMemory()` once per message (two API calls per turn).
- Uses `async_mode: true` so the cloud queues extraction asynchronously and the hook returns immediately.
- All errors are swallowed (`uncaughtException` / `unhandledRejection` → exit 0) so a transient failure can never break the user's flow.

### 4.4 SessionEnd — `hooks/scripts/session-summary.js`

- Appends a single diagnostic line to `data/sessions.jsonl` for the local Hub.
- Does not call the cloud.

---

## 5. Slash Commands

All commands live under the `/evermem:` namespace and are user-invoked.

| Command              | What it does                                                              |
|----------------------|---------------------------------------------------------------------------|
| `/evermem:search …`  | One-shot search; prints results in the terminal.                          |
| `/evermem:ask …`     | Searches memories and asks Claude to answer using them as context.        |
| `/evermem:hub`       | Boots the local dashboard proxy and opens the Memory Hub URL.             |
| `/evermem:projects`  | Lists groups tracked in `data/groups.jsonl`.                              |
| `/evermem:debug`     | Tails `~/.evermem-debug.log` (when `EVERMEM_DEBUG=1`).                    |
| `/evermem:help`      | Setup and troubleshooting help.                                           |

`/evermem:search` and `/evermem:ask` reuse the same `evermem-api.js` client as the hooks.

---

## 6. MCP Server — `mcp/server.js`

A small stdio MCP server that registers a single tool, `evermem_search`. Claude can call this tool autonomously when it judges that past context would help, independently of the auto-injection that happens on every prompt. Tool results are returned as a compact markdown table (rank, score, relative date, subject) so they're token-efficient.

The MCP server is a thin wrapper over `searchMemories()` — there is no second code path.

---

## 7. Memory Hub (Dashboard)

The Memory Hub is a single-page web app for browsing memories visually.

```
                      ┌──────────────────────────┐
                      │ User: /evermem:hub        │
                      └─────────────┬────────────┘
                                    │ launches
                                    ▼
   ┌────────────────────────────────────────────────────────────────┐
   │  server/proxy.js  (localhost:3456)                              │
   │  ┌─────────────────────────────────────────────────────────┐  │
   │  │  GET /                  → assets/dashboard.html         │  │
   │  │  GET /health            → liveness                       │  │
   │  │  GET /api/groups        → reads data/groups.jsonl,       │  │
   │  │                           filtered by keyId              │  │
   │  │  POST /api/v1/memories/search ─┐                         │  │
   │  │  POST /api/v1/memories/get    ─┴─→ forwards to cloud      │  │
   │  └─────────────────────────────────────────────────────────┘  │
   └────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Bearer key from browser
                                    ▼
                          api.evermind.ai (v1)
```

Why the proxy?

- The dashboard runs in the browser and shouldn't bake the API key into the page.
- It needs the local groups list (which the browser cannot read directly from disk).
- It must forward authenticated requests to the EverMind Cloud.

The dashboard:

1. Calls `GET /api/groups` to discover the user's tracked groups (filtered by `keyId`).
2. For each group, paginates `POST /api/v1/memories/get` with `filters: { group_id }` and `page_size: 100`.
3. Renders a unified timeline, project filter, search box, and per-memory detail view.

---

## 8. API Client — `hooks/scripts/utils/evermem-api.js`

This is the single point of contact with the cloud. Every other component in the plugin (hooks, MCP server, slash commands, smoke scripts, dashboard via proxy) routes through it.

```
                    evermem-api.js (v1)
   ┌───────────────────────────────────────────────────────────┐
   │                                                           │
   │  searchMemories(query, opts) ──▶ POST /api/v1/memories/search
   │  addMemory(message)          ──▶ POST /api/v1/memories/group
   │                                  POST /api/v1/memories      (no groupId)
   │  getMemories(opts)           ──▶ POST /api/v1/memories/get
   │                                                           │
   │  transformSearchResults(r)   ─── normalize data.episodes[]│
   │  transformGetMemoriesResults(r) ─ normalize data.episodes[]│
   │                                                           │
   └───────────────────────────────────────────────────────────┘
```

Key contracts:

- **`searchMemories(query, options) → response`** — returns the raw v1 envelope plus a `_debug` field on every code path so failures are diagnosable.
- **`addMemory({ content, role }) → { url, body, status, ok, response }`** — fire-and-forget; uses `async_mode: true`. The cloud responds with `202 Accepted` and a `task_id` for later inspection.
- **`getMemories({ page, pageSize, memoryType }) → response`** — paginated list. Throws on HTTP errors; success returns the raw envelope.
- **`transformSearchResults(response) → Memory[]`** — content is read from `episode.summary`; sorted by score desc.
- **`transformGetMemoriesResults(response) → Memory[]`** — content is read from `episode.episode`; sorted by timestamp desc.

These contracts have remained stable across the v0→v1 migration. Callers above this layer needed zero changes.

---

## 9. EverMind Cloud v1 API

The plugin uses six endpoints:

| Endpoint                              | Used by                          | Purpose                                                              |
|---------------------------------------|----------------------------------|----------------------------------------------------------------------|
| `POST /api/v1/memories/group`         | `addMemory` (when groupId set)   | Append a message to a group memory space                             |
| `POST /api/v1/memories`               | `addMemory` (personal fallback)  | Append a message to a personal memory space                          |
| `POST /api/v1/memories/search`        | `searchMemories`                  | Hybrid keyword/vector/agentic search returning ranked episodes       |
| `POST /api/v1/memories/get`           | `getMemories`                     | List episodes by `user_id`/`group_id` with pagination                |

All requests include `Authorization: Bearer ${EVERMEM_API_KEY}`. All bodies are JSON. Responses follow the v1 envelope `{ "data": { … } }` for success and `{ code, message, request_id, timestamp, path }` for errors.

For the canonical schema, see https://docs.evermind.ai/api-reference/introduction.

---

## 10. Local Persistence

The plugin keeps two small JSONL files under `data/`:

### `data/groups.jsonl`

One line per first-time observation of a `(keyId, groupId)` pair. Used by:

- The Hub proxy's `/api/groups` endpoint, to discover which groups belong to the current API key.
- `/evermem:projects`, to list known projects.

```json
{"keyId":"…","groupId":"memo7fda8","name":"memory-plugin","path":"/Users/…","timestamp":"2026-04-13T…"}
```

### `data/sessions.jsonl`

Append-only log of session-end events for diagnostics. Not read by any cloud-bound flow.

Both files are local-only and never leave the user's machine.

---

## 11. Configuration & Bootstrap

```
    EVERMEM_API_KEY (env or .env)
    EVERMEM_USER_ID (optional)               ┌────────────────┐
    EVERMEM_GROUP_ID (optional)        ─────▶│   config.js    │
    EVERMEM_API_URL (optional)               │ getConfig() →  │
    EVERMEM_CWD     (set by hook input)      │ { apiKey,      │
                                             │   userId,      │
                                             │   groupId,     │
                                             │   apiBaseUrl } │
                                             └────────────────┘
```

`config.js` first checks the process environment, then falls back to a `.env` file in the plugin root. The `.env` is read once on import and never written by the plugin. The `EVERMEM_CWD` variable is set from the hook input's `cwd` field so that `groupId` derivation works correctly even when the hook process inherits a different working directory.

The public install script (`install.sh`) handles three things:

1. Adds `EVERMEM_API_KEY` to the user's shell profile (`~/.zshrc`, `~/.bashrc`, etc.).
2. Adds the GitHub repo as a Claude Code marketplace.
3. Installs the plugin and runs `npm install` in the cached install directory.

---

## 12. Failure Modes & Resilience

| Scenario                                  | Behavior                                                              |
|-------------------------------------------|-----------------------------------------------------------------------|
| `EVERMEM_API_KEY` not set                 | All hooks no-op silently; commands print a setup hint.                |
| Network error on `searchMemories`         | Hook still completes, no memories injected, `_debug` envelope logged. |
| Cloud returns 4xx/5xx                      | Same as above — Claude proceeds without injected context.             |
| `Stop` hook crashes                        | `process.on('uncaughtException')` exits 0; the user never sees it.    |
| Hook exceeds timeout (10s prompt / 30s)    | Claude Code aborts the hook; the rest of the turn proceeds normally.  |
| `data/groups.jsonl` missing or corrupt    | Treated as empty; Hub shows the empty state.                          |

The plugin is built so that it can fail entirely silently and never block, slow down, or interrupt the Claude Code experience.

---

## 13. End-to-End Sequence Examples

### Saving a memory (Stop hook)

```
User finishes turn
        │
        ▼
Stop hook fires ─▶ store-memories.js
        │
        ├─ read transcript file (last user + last assistant message)
        ├─ for each message:
        │     addMemory({content, role})
        │       └─▶ POST /api/v1/memories/group
        │              { group_id, messages:[{sender_id, role, ts, content}], async_mode:true }
        │       ◀── 202 Accepted { task_id }
        │
        ▼
exit 0  (cloud extraction continues asynchronously)
```

### Recalling memories (UserPromptSubmit hook)

```
User submits prompt
        │
        ▼
UserPromptSubmit hook ─▶ inject-memories.js
        │
        ├─ if prompt < 3 words → exit 0
        ├─ searchMemories(prompt, {topK:5})
        │     └─▶ POST /api/v1/memories/search
        │            { query, filters:{group_id}, method:'hybrid', top_k:5 }
        │     ◀── { data: { episodes: [{summary, subject, score, …}] } }
        │
        ├─ filter score < 0.1
        ├─ emit JSON to stdout:
        │     {
        │       "systemMessage":     "Recalling 3 relevant memories…",
        │       "additionalContext": "<formatted memory snippets>"
        │     }
        ▼
Claude Code injects context, sends prompt to model
```

### Browsing memories (Memory Hub)

```
/evermem:hub
   │
   ▼
proxy.js boots on :3456
   │
   ▼
Browser ──▶ GET /                       ──▶ dashboard.html
        ──▶ GET /api/groups              ──▶ filtered groups.jsonl
        ──▶ for each group:
             POST /api/v1/memories/get   ──▶ proxy ──▶ cloud
                                         ◀── data.episodes[]
   │
   ▼
Render unified timeline, search, project filter
```

---

## 14. Versioning

- **Plugin version** lives in `plugin.json`.
- **Marketplace version** lives in `.claude-plugin/marketplace.json`. Both must move together — bumping only `plugin.json` will not surface a new version to existing users running `claude plugin update`.
- The current version is **0.2.0**, the first release on the v1 cloud API.
- Existing v0 deployments cannot interoperate with v1 — there is no compatibility shim.

---

## 15. Privacy

- The plugin never sends data anywhere except the EverMind Cloud, authenticated by the user's API key.
- All local state (`data/*.jsonl`, `~/.evermem-debug.log`) stays on the user's machine.
- Memory content equals the raw user/assistant messages of each conversation turn — anything Claude saw, the cloud sees. The cloud does not see system prompts, tool calls, or file contents Claude read but didn't echo back into chat.
- Logging out is a matter of removing `EVERMEM_API_KEY` from the shell profile; existing memories on the cloud can be deleted with the v1 delete-memories endpoint (not yet wired into the plugin UI).
