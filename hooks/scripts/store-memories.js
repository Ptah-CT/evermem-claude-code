#!/usr/bin/env node

import { readFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { isConfigured } from './utils/config.js';
import { addMemory } from './utils/evermem-api.js';
import { debug, setDebugPrefix } from './utils/debug.js';
import { extractLastTurn, getCanonicalSessionId, isMarkedTestTurn, parseTranscript } from './utils/transcript.js';

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
  const lastTurn = extractLastTurn(entries);
  const lastUser = lastTurn.user;
  const lastAssistant = lastTurn.assistant;
  const sessionId = getCanonicalSessionId(entries, hookInput.session_id || transcriptPath);
  const timestamp = normalizeTimestamp(lastTurn.timestamp);

  debug('extracted:', {
    format: lastTurn.format,
    entries: entries.length,
    userLength: lastUser.length,
    assistantLength: lastAssistant.length,
    userPreview: lastUser.slice(0, 100),
    assistantPreview: lastAssistant.slice(0, 100)
  });

  if (isMarkedTestTurn(lastUser)) {
    writeMessage('🧪 EverMem: Test turn detected; memory storage skipped');
    return;
  }

  const promises = [];
  const results = [];
  const skipped = [];

  if (hasContent(lastUser)) {
    const len = lastUser.length;
    promises.push(
      addMemory({ content: lastUser, role: 'user', sessionId, timestamp, messageId: stableMessageId(sessionId, timestamp, 'user', lastUser) })
        .then(result => results.push({ type: 'USER', len, ...result }))
        .catch(error => results.push({ type: 'USER', len, ok: false, error: error.message }))
    );
  } else {
    skipped.push({ type: 'USER', reason: 'no visible text in latest turn' });
  }

  if (hasContent(lastAssistant)) {
    const len = lastAssistant.length;
    promises.push(
      addMemory({ content: lastAssistant, role: 'assistant', sessionId, timestamp, messageId: stableMessageId(sessionId, timestamp, 'assistant', lastAssistant) })
        .then(result => results.push({ type: 'ASSISTANT', len, ...result }))
        .catch(error => results.push({ type: 'ASSISTANT', len, ok: false, error: error.message }))
    );
  } else {
    skipped.push({ type: 'ASSISTANT', reason: 'no visible text in latest turn' });
  }

  await Promise.all(promises);
  const allSuccess = results.length > 0 && results.every(result => result.ok && !result.error);
  debug('results:', results);
  debug('skipped:', skipped);

  if (allSuccess) {
    const details = results.map(result => `${result.type.toLowerCase()}: ${result.len}`).join(', ');
    let output = `💾 Memory saved (${results.length}) [${details}]`;
    if (skipped.length > 0) {
      output += `\n⏭️ Skipped: ${skipped.map(item => `${item.type} (${item.reason})`).join(', ')}`;
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
