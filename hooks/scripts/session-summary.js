#!/usr/bin/env node

/**
 * EverMem SessionEnd Hook
 * Saves a local session summary without invoking an AI model.
 */

import { appendFileSync, readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getGroupId, getConfig } from './utils/config.js';
import { flushSession } from './utils/evermem-api.js';
import { debug, setDebugPrefix } from './utils/debug.js';
import { extractSessionStats, getCanonicalSessionId, isMarkedTestTurn, parseTranscript } from './utils/transcript.js';

setDebugPrefix('session-end');

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSIONS_FILE = process.env.EVERMEM_SESSIONS_FILE
  || resolve(__dirname, '../../data/sessions.jsonl');

function writeMessage(systemMessage) {
  process.stdout.write(JSON.stringify({ systemMessage }));
}

function reportFailure(error) {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  writeMessage(`⚠️ EverMem SessionEnd failed: ${detail}`);
}

function appendSummary(entry) {
  // A single append preserves concurrent SessionEnd records. Readers scan from the
  // end, so a repeated shutdown naturally supersedes an older record for a session.
  appendFileSync(SESSIONS_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
}

function formatDuration(firstTimestamp, lastTimestamp) {
  if (!firstTimestamp || !lastTimestamp) {
    return '';
  }

  const durationMs = new Date(lastTimestamp).getTime() - new Date(firstTimestamp).getTime();
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return '';
  }

  const minutes = Math.floor(durationMs / 60000);
  if (minutes < 1) return '<1min';
  if (minutes < 60) return `${minutes}min`;

  const hours = Math.floor(minutes / 60);
  const remainMins = minutes % 60;
  return remainMins > 0 ? `${hours}h${remainMins}m` : `${hours}h`;
}

async function readHookInput() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input ? JSON.parse(input) : {};
}

async function main() {
  const hookInput = await readHookInput();
  const fallbackSessionId = hookInput.session_id || hookInput.sessionId;
  const transcriptPath = hookInput.transcript_path || hookInput.transcriptPath;

  if (hookInput.cwd) {
    process.env.EVERMEM_CWD = hookInput.cwd;
  }
  if (!getConfig().isConfigured) {
    throw new Error('EverMem is not configured');
  }
  if (!fallbackSessionId) {
    throw new Error('Missing session_id');
  }
  if (!transcriptPath) {
    throw new Error('Missing transcript_path');
  }
  if (!existsSync(transcriptPath)) {
    throw new Error(`Transcript not found: ${transcriptPath}`);
  }

  const entries = parseTranscript(readFileSync(transcriptPath, 'utf8'));
  const sessionId = getCanonicalSessionId(entries, fallbackSessionId);
  const content = extractSessionStats(entries);
  debug('extracted session:', content);

  if (content.turnCount === 0) {
    writeMessage('⏭️ EverMem: Session has no user turns; summary skipped');
    return;
  }
  if (isMarkedTestTurn(content.firstUserPrompt)) {
    writeMessage('🧪 EverMem: Test session detected; summary skipped');
    return;
  }

  const summary = content.firstUserPrompt || 'Session with no text prompts';
  const durationStr = formatDuration(content.firstTimestamp, content.lastTimestamp);
  const displaySummary = summary.length > 50 ? summary.substring(0, 50) + '...' : summary;
  const parts = [`${content.turnCount} turns`];
  if (durationStr) parts.push(durationStr);

  appendSummary({
    sessionId,
    groupId: getGroupId(),
    summary,
    turnCount: content.turnCount,
    reason: hookInput.reason || 'unknown',
    startTime: content.firstTimestamp,
    endTime: content.lastTimestamp,
    timestamp: new Date().toISOString()
  });

  // Close the accumulation window of this session. This is the last moment it
  // can happen: the window is keyed by (group_id, session_id), and once the
  // session is over no later request carries this session id, so an unflushed
  // tail stays unconsumed forever. Reported in-band — a silently skipped flush
  // looks exactly like a successful one.
  const flush = await flushSession({ sessionId });
  debug('flush result', flush);

  let message = `📝 Session (${parts.join(', ')}): "${displaySummary}"`;
  if (flush.ok) {
    message += `\n🧹 Memory window closed (${flush.response?.data?.status || 'flushed'})`;
  } else {
    message += `\n⚠️ EverMem: Window flush failed (${flush.status})`;
    message += `\nRequest: ${JSON.stringify(flush.body)}`;
    message += `\nResponse: ${JSON.stringify(flush.response)}`;
  }

  debug('output', message);
  writeMessage(message);
}

main().catch(reportFailure);
