---
description: Explain and inspect EverMem hook diagnostics
---

# EverMem Diagnostics

EverMem emits debug diagnostics to stderr. It deliberately does not write a
shared file under `/tmp`: concurrent hooks would mix records, and host logging
already captures stderr.

## Instructions

1. Check whether `EVERMEM_DEBUG=1` is set in the plugin `.env`.
2. Explain that hook errors are always emitted to stderr, while verbose debug
   lines require `EVERMEM_DEBUG=1`.
3. Inspect the stderr/journal surface used by the current host (Claude Code or
   Prime Agent). On xinfty, query the relevant service logs through Loki first.
4. Filter for the stable prefixes `[inject]`, `[store]`, `[session-start]`,
   `[session-end]`, and `[EverMemAPI]`.
5. Report the exact failing request or parser error. Do not create a fallback
   debug file and do not hide a failure behind retries.

If the user asks to clear logs, explain that retention is owned by the host log
system rather than this plugin.
