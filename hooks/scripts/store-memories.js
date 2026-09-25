#!/usr/bin/env node

import { readFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { isConfigured } from './utils/config.js';
import { addMemory } from './utils/evermem-api.js';
import { debug, setDebugPrefix } from './utils/debug.js';
import { readStopCursor, writeStopCursor } from './utils/stop-cursor.js';
import {
  extractClaudeTurns,
  extractLastTurn,
  getCanonicalSessionId,
  getClaudeEntryUuid,
  isMarkedTestTurn,
  isPrimeTranscript,
  parseTranscript,
} from './utils/transcript.js';

setDebugPrefix('store');


function stableMessageId(sessionId, timestamp, role, content) {
  const source = JSON.stringify({ sessionId, timestamp, role, content });
  return `evermem_${createHash('sha256').update(source).digest('hex').slice(0, 32)}`;
}

function normalizeTimestamp(timestamp) {
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) return timestamp;
  if (typeof timestamp === 'string' && timestamp) {
    const parsed = new Date(timestamp).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function hasContent(text) {
  return typeof text === 'string' && text.trim().length > 0;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function writeMessage(systemMessage) {
  process.stdout.write(JSON.stringify({ systemMessage }));
}

function truncateBody(body) {
  if (!body) return body;
  const copy = { ...body };
  if (copy.content && typeof copy.content === 'string' && copy.content.length > 100) {
    copy.content = copy.content.substring(0, 100) + '... [truncated]';
  }
  return copy;
}

function reportFailure(error) {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  writeMessage(`💾 EverMem: Save failed\n${detail}`);
}

// Returns the new turns since the last successful store for this session, plus the cursor value
// to persist once (and only if) this run's memory calls succeed. Prime's turn segmentation
// already follows explicit parentId chains to a terminal stopReason and isolates just the latest
// completed turn on its own — it does not exhibit the unbounded-growth defect the Claude-format
// path below guards against, so it keeps using the full-transcript extraction unchanged.
function newTurnsSinceLastStore(entries, sessionId) {
  if (isPrimeTranscript(entries)) {
    const lastTurn = extractLastTurn(entries);
    const turns = hasContent(lastTurn.user) || hasContent(lastTurn.assistant) ? [lastTurn] : [];
    return { turns, cursorEntryUuid: null };
  }

  const previousCursor = readStopCursor(sessionId);
  let sliceStart = 0;
  if (previousCursor) {
    const idx = entries.findIndex(entry => getClaudeEntryUuid(entry) === previousCursor.entryUuid);
    if (idx === -1) {
      // The cursor entry is gone from this transcript (e.g. compaction rewrote it). Reprocessing
      // everything is the safe degrade — it can resend already-stored content, never lose it —
      // but it must stay visible instead of silently falling back.
      debug('cursor entry missing from transcript; reprocessing full transcript', previousCursor);
    } else {
      sliceStart = idx + 1;
    }
  }

  const slice = entries.slice(sliceStart);
  const turns = extractClaudeTurns(slice).map(turn => ({ ...turn, format: 'claude' }));

  let cursorEntryUuid = previousCursor?.entryUuid ?? null;
  for (let i = slice.length - 1; i >= 0; i--) {
    const uuid = getClaudeEntryUuid(slice[i]);
    if (uuid) {
      cursorEntryUuid = uuid;
      break;
    }
  }

  return { turns, cursorEntryUuid };
}

async function main() {
  const input = await readStdin();
  const hookInput = JSON.parse(input);
  const transcriptPath = hookInput.transcript_path || hookInput.transcriptPath;
  debug('hookInput:', hookInput);

  if (hookInput.cwd) {
    process.env.EVERMEM_CWD = hookInput.cwd;
  }

  if (!isConfigured()) {
    throw new Error('EverMem is not configured');
  }
  if (!transcriptPath) {
    throw new Error('Missing transcript_path');
  }
  if (!existsSync(transcriptPath)) {
    throw new Error(`Transcript not found: ${transcriptPath}`);
  }

  const entries = parseTranscript(readFileSync(transcriptPath, 'utf8'));
  const sessionId = getCanonicalSessionId(entries, hookInput.session_id || transcriptPath);
  const prime = isPrimeTranscript(entries);
  const { turns: newTurns, cursorEntryUuid } = newTurnsSinceLastStore(entries, sessionId);

  debug('new turns since last store:', { sessionId, count: newTurns.length, prime });

  if (newTurns.length === 0) {
    writeMessage('⏭️ EverMem: No new turns since last store');
    if (!prime && cursorEntryUuid) writeStopCursor(sessionId, cursorEntryUuid);
    return;
  }

  const results = [];
  const skipped = [];
  let testTurnsSkipped = 0;

  for (const turn of newTurns) {
    const lastUser = turn.user;
    const lastAssistant = turn.assistant;

    if (isMarkedTestTurn(lastUser)) {
      testTurnsSkipped += 1;
      continue;
    }

    const timestamp = normalizeTimestamp(turn.timestamp);
    const promises = [];

    debug('extracted turn:', {
      format: turn.format,
      userLength: lastUser.length,
      assistantLength: lastAssistant.length,
      userPreview: lastUser.slice(0, 100),
      assistantPreview: lastAssistant.slice(0, 100),
    });

    if (hasContent(lastUser)) {
      const len = lastUser.length;
      promises.push(
        addMemory({ content: lastUser, role: 'user', sessionId, timestamp, messageId: stableMessageId(sessionId, timestamp, 'user', lastUser) })
          .then(result => results.push({ type: 'USER', len, ...result }))
          .catch(error => results.push({ type: 'USER', len, ok: false, error: error.message }))
      );
    } else {
      skipped.push({ type: 'USER', reason: 'no visible operator text in turn' });
    }

    if (hasContent(lastAssistant)) {
      const len = lastAssistant.length;
      promises.push(
        addMemory({ content: lastAssistant, role: 'assistant', sessionId, timestamp, messageId: stableMessageId(sessionId, timestamp, 'assistant', lastAssistant) })
          .then(result => results.push({ type: 'ASSISTANT', len, ...result }))
          .catch(error => results.push({ type: 'ASSISTANT', len, ok: false, error: error.message }))
      );
    } else {
      skipped.push({ type: 'ASSISTANT', reason: 'no visible text in turn' });
    }

    await Promise.all(promises);
  }

  const allSuccess = results.length > 0 && results.every(result => result.ok && !result.error);
  const nothingLeftToRetry = results.length === 0 && testTurnsSkipped === newTurns.length;
  debug('results:', results);
  debug('skipped:', skipped);
  debug('test turns skipped:', testTurnsSkipped);

  // The cursor advances only when this run has nothing left that still needs a successful
  // store — either every memory call succeeded, or every new turn was a marked test turn and
  // there was nothing to call. A partial failure leaves the cursor where it was so the same
  // entries are retried on the next Stop instead of being dropped.
  if (!prime && cursorEntryUuid && (allSuccess || nothingLeftToRetry)) {
    writeStopCursor(sessionId, cursorEntryUuid);
  }

  if (nothingLeftToRetry) {
    writeMessage('🧪 EverMem: Test turn detected; memory storage skipped');
    return;
  }

  if (allSuccess) {
    const details = results.map(result => `${result.type.toLowerCase()}: ${result.len}`).join(', ');
    let output = `💾 Memory saved (${results.length}) [${details}]`;
    if (skipped.length > 0) {
      output += `\n⏭️ Skipped: ${skipped.map(item => `${item.type} (${item.reason})`).join(', ')}`;
    }
    if (testTurnsSkipped > 0) {
      output += `\n🧪 Skipped ${testTurnsSkipped} test turn(s)`;
    }
    writeMessage(output);
    return;
  }

  if (results.length === 0) {
    writeMessage(`⏭️ EverMem: No content to save\n${skipped.map(item => `  • ${item.type}: ${item.reason}`).join('\n')}`);
    return;
  }

  let output = '💾 EverMem: Save failed\n';
  for (const result of results) {
    if (result.error) {
      output += `${result.type}: ERROR - ${result.error}\n`;
    } else if (!result.ok) {
      output += `${result.type}: FAILED (${result.status})\n`;
      output += `Request: ${JSON.stringify(truncateBody(result.body), null, 2)}\n`;
      output += `Response: ${JSON.stringify(result.response, null, 2)}\n`;
    }
  }
  if (skipped.length > 0) {
    output += `⏭️ Skipped: ${skipped.map(item => `${item.type} (${item.reason})`).join(', ')}\n`;
  }
  writeMessage(output);
}

main().catch(reportFailure);
