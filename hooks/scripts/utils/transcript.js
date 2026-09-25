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

// The harness delivers content from three sources besides the operator's own words, and each can
// land as a plain `user`-role transcript entry indistinguishable from a real prompt without
// inspecting the text: a message relayed from another Claude Code session
// (`<cross-session-message>`), a teammate/subagent report relayed into this session
// (`<agent-message>`, `<teammate-message>`), and a background task's completion notice
// (`<task-notification>`). None of these are the operator speaking. Storing them as role:'user'
// content misattributes them to the operator (measured 2026-09-25 against session
// ec541dbf-d9a8-40f9-9c40-44b8a4628809: a queued `<agent-message from="vikunja-atlas">` report
// landed inside the stored "user" turn next to a real prompt). This mirrors the detection
// dev-team-erinnerung already carries for the same transcript format
// (internal/transkript/transkript.go, commit 7479229 "Nachrichten anderer Sitzungen nicht der
// empfangenden zuschreiben") — same markers, generalized to the other relay forms it doesn't see.
const FOREIGN_MESSAGE_TAGS = ['<cross-session-message', '<agent-message', '<teammate-message', '<task-notification>'];
const FOREIGN_MESSAGE_INTRO = /^(Another Claude session sent a message:|A teammate sent a message:)\s*/;

export function isForeignInjectedText(text) {
  if (typeof text !== 'string') return false;
  const stripped = text.trim().replace(FOREIGN_MESSAGE_INTRO, '');
  return FOREIGN_MESSAGE_TAGS.some(tag => stripped.startsWith(tag));
}

function extractOperatorTexts(content) {
  return extractVisibleText(content).filter(text => !isForeignInjectedText(text));
}

// Whether a transcript entry belongs to the Claude Code JSONL format or the Prime Agent format.
// Both formats can appear in a transcript file over its lifetime (Prime entries carry `id`/
// `type: 'session'|'message'`); this check is shared by every function below that branches on it.
export function isPrimeTranscript(entries) {
  return entries.some(entry => entry?.type === 'session' || entry?.type === 'message');
}

// The stable per-entry identity Claude Code JSONL lines carry. Used as a Stop-hook cursor so a
// transcript can be resumed from a known point instead of being re-walked from the start.
export function getClaudeEntryUuid(entry) {
  return typeof entry?.uuid === 'string' && entry.uuid ? entry.uuid : null;
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
      current.userTexts.push(...extractOperatorTexts(message.content));
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

// Exported so store-memories.js can segment just the slice of entries a Stop-hook cursor has not
// stored yet, instead of re-walking (and re-accumulating) the full transcript on every Stop.
export function extractClaudeTurns(entries) {
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
      current.userTexts.push(...extractOperatorTexts(entry.message.content));
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
  const isPrime = isPrimeTranscript(entries);
  const primeState = isPrime ? extractPrimeTurnState(getPrimeActiveBranch(entries)) : null;
  const turns = primeState?.turns || extractClaudeTurns(entries);
  const turn = primeState ? primeState.latestTurn : turns.at(-1);
  return turn
    ? { ...turn, format: isPrime ? 'prime' : 'claude' }
    : { user: '', assistant: '', timestamp: null, format: isPrime ? 'prime' : entries.length ? 'claude' : 'unknown' };
}

export function extractSessionStats(entries) {
  const isPrime = isPrimeTranscript(entries);
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
