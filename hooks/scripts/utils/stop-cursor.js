/**
 * Per-session Stop-hook cursor.
 *
 * store-memories.js runs on every Stop and, before this fix, re-extracted the "last turn" from
 * the FULL transcript every time. Claude Code's turn boundary (`system`/`turn_duration`) is not
 * emitted reliably between every pair of Stops (measured 2026-09-25, session
 * ec541dbf-d9a8-40f9-9c40-44b8a4628809: one "turn" alone concatenated 88136 chars of user text
 * spanning dozens of real prompts and injected messages, because no boundary separated them from
 * an earlier prompt hours before), so the "last turn" kept growing and every Stop resent the
 * whole growing blob under a fresh messageId — quadratic request volume against a shared EverOS
 * deployment for content that was already stored.
 *
 * The cursor records the transcript entry (by its own `uuid`, see getClaudeEntryUuid in
 * transcript.js) up to which this session has already been stored successfully. Each Stop only
 * segments entries strictly after that point. The cursor advances only after a run's memory
 * calls succeed (see store-memories.js) — a failed run leaves it where it was so the same
 * entries are retried on the next Stop instead of being silently dropped.
 *
 * Storage is an append-only JSONL log, the same pattern session-summary.js already uses for
 * sessions.jsonl: a single append is safe under concurrent sessions, and a reader scans from the
 * end for the newest record matching a sessionId.
 */

import { appendFileSync, existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CURSOR_FILE = process.env.EVERMEM_STOP_CURSOR_FILE
  || resolve(__dirname, '../../../data/stop-cursors.jsonl');

/**
 * @param {string} sessionId
 * @param {string} [cursorFile]
 * @returns {{sessionId: string, entryUuid: string, timestamp: string}|null}
 */
export function readStopCursor(sessionId, cursorFile = CURSOR_FILE) {
  if (!existsSync(cursorFile)) return null;
  const lines = readFileSync(cursorFile, 'utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // A malformed line is a corrupted local cache, not a hook failure.
    }
    if (record.sessionId === sessionId && typeof record.entryUuid === 'string') {
      return record;
    }
  }
  return null;
}

/**
 * @param {string} sessionId
 * @param {string} entryUuid
 * @param {string} [cursorFile]
 */
export function writeStopCursor(sessionId, entryUuid, cursorFile = CURSOR_FILE) {
  appendFileSync(cursorFile, `${JSON.stringify({ sessionId, entryUuid, timestamp: new Date().toISOString() })}\n`, 'utf8');
}
