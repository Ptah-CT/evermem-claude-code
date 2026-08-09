/**
 * Transcript compatibility helpers for Claude Code and Prime Agent JSONL files.
 */

export function parseTranscript(text) {
  const entries = [];
  for (const [index, rawLine] of text.split('\n').entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`Malformed transcript JSON at line ${index + 1}: ${error.message}`);
    }
  }
  return entries;
}

function extractVisibleText(content) {
  if (typeof content === 'string') {
    return content.trim() ? [content] : [];
  }
  if (!Array.isArray(content)) return [];
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string' && block.text.trim())
    .map(block => block.text);
}

function getPrimeActiveBranch(entries) {
  const linked = entries.filter(entry => entry?.id);
  if (linked.length === 0) return entries;

  const byId = new Map();
  for (const entry of linked) {
    if (byId.has(entry.id)) {
      throw new Error(`Duplicate Prime transcript entry id: ${entry.id}`);
    }
    byId.set(entry.id, entry);
  }

  const branch = [];
  const visited = new Set();
  let current = linked.at(-1);
  while (current) {
    if (visited.has(current.id)) {
      throw new Error(`Cycle in Prime transcript at entry: ${current.id}`);
    }
    visited.add(current.id);
    branch.push(current);

    if (!current.parentId) break;
    const parent = byId.get(current.parentId);
    if (!parent) {
      throw new Error(`Orphaned Prime transcript entry ${current.id}: missing parent ${current.parentId}`);
    }
    current = parent;
  }

  return branch.reverse();
}

function normalizePrimeMessages(messages) {
  return messages
    .map(item => item?.type === 'message' ? item.message : item)
    .filter(message => message && typeof message.role === 'string');
}

function primeTerminalKind(message) {
  const reason = message?.stopReason || message?.stop_reason;
  if (reason === 'stop' || reason === 'length') return 'success';
  if (reason === 'error' || reason === 'aborted') return 'failure';
  return null;
}

function extractPrimeTurnState(messages) {
  const turns = [];
  let current = null;

  function beginTurn() {
    return { userTexts: [], assistantTexts: [], terminal: null, timestamp: null };
  }

  function finishCurrent() {
    if (!current || current.userTexts.length === 0 || current.terminal !== 'success') return;
    turns.push({
      user: current.userTexts.join('\n\n'),
      assistant: current.assistantTexts.join('\n\n'),
      timestamp: current.timestamp,
    });
  }

  for (const message of normalizePrimeMessages(messages)) {
    if (message.role === 'user') {
      if (current?.terminal) {
        finishCurrent();
        current = null;
      }
      current ||= beginTurn();
      current.userTexts.push(...extractVisibleText(message.content));
      current.timestamp = message.timestamp ?? current.timestamp;
      continue;
    }

    if (message.role !== 'assistant' || !current) continue;
    current.assistantTexts.push(...extractVisibleText(message.content));
    current.timestamp = message.timestamp ?? current.timestamp;
    const terminal = primeTerminalKind(message);
    if (terminal) current.terminal = terminal;
  }

  finishCurrent();
  const latestTurn = current?.terminal === 'success' && current.userTexts.length > 0
    ? turns.at(-1)
    : null;
  return { turns, latestTurn };
}

function extractClaudeTurns(entries) {
  const turns = [];
  let current = { userTexts: [], assistantTexts: [], timestamp: null };

  function finishCurrent() {
    if (current.userTexts.length > 0 && current.assistantTexts.length > 0) {
      turns.push({
        user: current.userTexts.join('\n\n'),
        assistant: current.assistantTexts.join('\n\n'),
        timestamp: current.timestamp,
      });
    }
    current = { userTexts: [], assistantTexts: [], timestamp: null };
  }

  for (const entry of entries) {
    if (entry?.type === 'system' && entry.subtype === 'turn_duration') {
      finishCurrent();
      continue;
    }
    if (entry?.type === 'user' && entry.message?.role === 'user') {
      current.userTexts.push(...extractVisibleText(entry.message.content));
      current.timestamp = entry.timestamp ?? current.timestamp;
    } else if (entry?.type === 'assistant' && entry.message?.role === 'assistant') {
      current.assistantTexts.push(...extractVisibleText(entry.message.content));
      current.timestamp = entry.timestamp ?? current.timestamp;
    }
  }

  finishCurrent();
  return turns;
}

export function extractLastTurn(entries) {
  const isPrime = entries.some(entry => entry?.type === 'session' || entry?.type === 'message');
  const primeState = isPrime ? extractPrimeTurnState(getPrimeActiveBranch(entries)) : null;
  const turns = primeState?.turns || extractClaudeTurns(entries);
  const turn = primeState ? primeState.latestTurn : turns.at(-1);
  return turn
    ? { ...turn, format: isPrime ? 'prime' : 'claude' }
    : { user: '', assistant: '', timestamp: null, format: isPrime ? 'prime' : entries.length ? 'claude' : 'unknown' };
}

export function extractSessionStats(entries) {
  const isPrime = entries.some(entry => entry?.type === 'session' || entry?.type === 'message');
  const activeEntries = isPrime ? getPrimeActiveBranch(entries) : entries;
  const turns = isPrime
    ? extractPrimeTurnState(activeEntries).turns
    : extractClaudeTurns(activeEntries);
  const timestamps = activeEntries
    .map(entry => entry?.timestamp)
    .filter(timestamp => typeof timestamp === 'string' || typeof timestamp === 'number');

  return {
    firstUserPrompt: turns[0]?.user.substring(0, 200) || '',
    lastUserPrompt: turns.at(-1)?.user.substring(0, 200) || '',
    turnCount: turns.length,
    firstTimestamp: timestamps[0] ?? null,
    lastTimestamp: timestamps.at(-1) ?? null,
    format: isPrime ? 'prime' : entries.length ? 'claude' : 'unknown'
  };
}

export function getCanonicalSessionId(entries, fallback) {
  const primeSession = entries.find(entry => entry?.type === 'session' && typeof entry.id === 'string');
  if (primeSession) return primeSession.id;
  const claudeSession = entries.find(entry => typeof entry?.sessionId === 'string');
  return claudeSession?.sessionId || fallback;
}

export function isMarkedTestTurn(userText) {
  return /\[TEST-[^\]]+\]/i.test(userText || '');
}
