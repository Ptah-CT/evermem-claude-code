import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  extractLastTurn,
  extractSessionStats,
  isMarkedTestTurn,
  parseTranscript,
} from '../hooks/scripts/utils/transcript.js';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const nodeBin = process.execPath;
const pluginRoot = resolve(testDirectory, '..');
const extensionPath = join(pluginRoot, 'prime', 'evermem.ts');

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'evermem-hooks-'));
}

function writeTranscript(directory, name, entries) {
  const file = join(directory, name);
  writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  return file;
}

async function runHook(script, payload, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBin, [join(pluginRoot, 'hooks/scripts', script)], {
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', EVERMEM_REQUEST_TIMEOUT_MS: '3600000', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`${script} exited ${code}: ${stderr}`));
        return;
      }
      resolve(stdout.trim() ? JSON.parse(stdout.trim()) : null);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function startFakeEvermem() {
  const requests = [];
  const server = createServer(async (request, response) => {
    let rawBody = '';
    for await (const chunk of request) rawBody += chunk;
    const body = rawBody ? JSON.parse(rawBody) : null;
    requests.push({ path: request.url, method: request.method, body });

    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/v1/memories/get') {
      response.end(JSON.stringify({
        data: {
          episodes: [{
            id: 'session-memory',
            summary: 'Session memory from a previous run',
            subject: 'Previous session',
            timestamp: '2026-08-07T12:00:00.000Z',
          }],
        },
      }));
      return;
    }
    if (request.url === '/api/v1/memories/search') {
      response.end(JSON.stringify({
        data: {
          episodes: [{
            id: 'relevant-memory',
            summary: 'Relevant memory for the current prompt',
            subject: 'Relevant decision',
            timestamp: '2026-08-06T12:00:00.000Z',
            score: 0.92,
          }],
        },
      }));
      return;
    }

    response.end(JSON.stringify({ ok: true }));
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

const primeEntries = [
  { type: 'session', id: 'session-1', timestamp: '2026-08-08T10:00:00.000Z' },
  {
    type: 'message', id: 'user-1', parentId: 'session-1', timestamp: '2026-08-08T10:01:00.000Z',
    message: { role: 'user', timestamp: 1786183260000, content: [{ type: 'text', text: 'Prime user question' }] },
  },
  {
    type: 'message', id: 'assistant-thinking', parentId: 'user-1', timestamp: '2026-08-08T10:01:10.000Z',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }] },
  },
  {
    type: 'message', id: 'tool-result', parentId: 'assistant-thinking', timestamp: '2026-08-08T10:01:20.000Z',
    message: { role: 'toolResult', content: [{ type: 'text', text: 'tool output' }] },
  },
  {
    type: 'message', id: 'assistant-1', parentId: 'tool-result', timestamp: '2026-08-08T10:02:00.000Z',
    message: { role: 'assistant', stopReason: 'stop', timestamp: 1786183320000, content: [{ type: 'text', text: 'Prime assistant answer' }] },
  },
];

const claudeEntries = [
  {
    type: 'user', timestamp: '2026-08-08T09:00:00.000Z',
    message: { role: 'user', content: 'Earlier Claude question' },
  },
  {
    type: 'assistant', timestamp: '2026-08-08T09:01:00.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }] },
  },
  { type: 'system', subtype: 'turn_duration', timestamp: '2026-08-08T09:01:01.000Z' },
  {
    type: 'user', timestamp: '2026-08-08T09:02:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'Latest Claude question' }] },
  },
  {
    type: 'assistant', timestamp: '2026-08-08T09:03:00.000Z',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'Latest Claude answer' }] },
  },
];

test('transcript parser extracts Prime and Claude turns without tool/thinking content', () => {
  assert.deepEqual(extractLastTurn(primeEntries), {
    user: 'Prime user question', assistant: 'Prime assistant answer', timestamp: 1786183320000, format: 'prime',
  });
  assert.deepEqual(extractLastTurn(claudeEntries), {
    user: 'Latest Claude question', assistant: 'Latest Claude answer', timestamp: '2026-08-08T09:03:00.000Z', format: 'claude',
  });
  assert.throws(() => parseTranscript('{"type":"message"}\nnot-json\n'), /Malformed transcript JSON/);
});

test('Prime segmentation keeps queued user input in one turn and follows the active branch', () => {
  const entries = [
    { type: 'session', id: 's', timestamp: '2026-08-08T10:00:00Z' },
    { type: 'message', id: 'u1', parentId: 's', timestamp: '2026-08-08T10:01:00Z', message: { role: 'user', content: 'Initial request' } },
    { type: 'message', id: 'a-tool', parentId: 'u1', timestamp: '2026-08-08T10:01:10Z', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: 'Working' }, { type: 'toolCall', name: 'x' }] } },
    { type: 'message', id: 'u2', parentId: 'a-tool', timestamp: '2026-08-08T10:01:20Z', message: { role: 'user', content: 'Queued correction' } },
    { type: 'message', id: 'a1', parentId: 'u2', timestamp: '2026-08-08T10:02:00Z', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Finished' }] } },
    { type: 'message', id: 'abandoned-u', parentId: 'a1', timestamp: '2026-08-08T10:03:00Z', message: { role: 'user', content: 'Abandoned branch' } },
    { type: 'message', id: 'abandoned-a', parentId: 'abandoned-u', timestamp: '2026-08-08T10:04:00Z', message: { role: 'assistant', stopReason: 'stop', content: 'Abandoned answer' } },
    { type: 'message', id: 'active-u', parentId: 'a1', timestamp: '2026-08-08T10:05:00Z', message: { role: 'user', content: 'Active branch request' } },
    { type: 'message', id: 'active-a', parentId: 'active-u', timestamp: '2026-08-08T10:06:00Z', message: { role: 'assistant', stopReason: 'stop', content: 'Active answer' } },
  ];

  const stats = extractSessionStats(entries);
  assert.equal(stats.turnCount, 2);
  assert.equal(stats.firstUserPrompt, 'Initial request\n\nQueued correction');
  assert.equal(stats.lastUserPrompt, 'Active branch request');
  assert.equal(extractLastTurn(entries).assistant, 'Active answer');
});

test('Prime failed or aborted turns are not treated as completed memories', () => {
  const failed = [
    { type: 'session', id: 'failed-session' },
    { type: 'message', id: 'failed-user', parentId: 'failed-session', message: { role: 'user', content: 'Do work' } },
    { type: 'message', id: 'failed-assistant', parentId: 'failed-user', message: { role: 'assistant', stopReason: 'error', content: 'Partial answer' } },
  ];
  assert.equal(extractSessionStats(failed).turnCount, 0);
  assert.equal(extractLastTurn(failed).assistant, '');

  const failedAfterSuccess = [
    ...primeEntries,
    { type: 'message', id: 'failed-user-2', parentId: 'assistant-1', message: { role: 'user', content: 'Later work' } },
    { type: 'message', id: 'failed-assistant-2', parentId: 'failed-user-2', message: { role: 'assistant', stopReason: 'error', content: 'Later partial answer' } },
  ];
  assert.equal(extractSessionStats(failedAfterSuccess).turnCount, 1);
  assert.equal(extractLastTurn(failedAfterSuccess).assistant, '');
});

test('session stats count user turns for both transcript formats', () => {
  const primeStats = extractSessionStats(primeEntries);
  assert.equal(primeStats.turnCount, 1);
  assert.equal(primeStats.firstUserPrompt, 'Prime user question');
  assert.equal(primeStats.format, 'prime');

  const claudeStats = extractSessionStats(claudeEntries);
  assert.equal(claudeStats.turnCount, 2);
  assert.equal(claudeStats.lastUserPrompt, 'Latest Claude question');
  assert.equal(claudeStats.format, 'claude');
});

test('test marker detection catches markers anywhere in the user turn', () => {
  assert.equal(isMarkedTestTurn('[TEST-HOMEASSISTANT-3-20260808T220000Z] probe'), true);
  assert.equal(isMarkedTestTurn('Discuss [TEST-example] syntax'), true);
});

test('session context exposes the same context through Claude and generic hook fields', async () => {
  const fake = await startFakeEvermem();
  try {
    const result = await runHook('session-context.js', {
      session_id: 'session-context-test', cwd: pluginRoot, source: 'startup',
    }, {
      EVERMEM_API_URL: fake.url,
      EVERMEM_DISABLE_PROJECT_SCOPE: '1',
      EVERMEM_USER_ID: 'fixture-user',
      EVERMEM_SESSIONS_FILE: join(makeTempDir(), 'sessions.jsonl'),
    });

    assert.match(result.systemPrompt, /Session memory from a previous run/);
    assert.equal(result.additionalContext, result.systemPrompt);
  } finally {
    await fake.close();
  }
});

test('store hook uses the canonical transcript even when a Prime message snapshot is empty', async () => {
  const fake = await startFakeEvermem();
  const directory = makeTempDir();
  try {
    const env = { EVERMEM_API_URL: fake.url, EVERMEM_DISABLE_PROJECT_SCOPE: '1', EVERMEM_USER_ID: 'fixture-user' };
    const primeFile = writeTranscript(directory, 'prime.jsonl', primeEntries);
    const primeResult = await runHook('store-memories.js', { transcript_path: primeFile, prime_messages: [], cwd: pluginRoot }, env);
    assert.match(primeResult.systemMessage, /Memory saved \(2\)/);

    const claudeFile = writeTranscript(directory, 'claude.jsonl', claudeEntries);
    const claudeResult = await runHook('store-memories.js', { transcript_path: claudeFile, cwd: pluginRoot }, env);
    assert.match(claudeResult.systemMessage, /Memory saved \(2\)/);

    const stored = fake.requests.filter(request => request.path === '/api/v1/memories');
    assert.deepEqual(stored.map(request => request.body.messages[0].content).sort(), [
      'Latest Claude answer', 'Latest Claude question', 'Prime assistant answer', 'Prime user question',
    ]);
  } finally {
    await fake.close();
  }
});

test('store and summary hooks do not persist marked test turns', async () => {
  const fake = await startFakeEvermem();
  const directory = makeTempDir();
  try {
    const testEntries = structuredClone(primeEntries);
    testEntries[1].message.content[0].text = '[TEST-HOMEASSISTANT-3-20260808T220000Z] probe';
    const transcript = writeTranscript(directory, 'test-prime.jsonl', testEntries);
    const sessionsFile = join(directory, 'sessions.jsonl');
    const env = {
      EVERMEM_API_URL: fake.url,
      EVERMEM_DISABLE_PROJECT_SCOPE: '1',
      EVERMEM_USER_ID: 'fixture-user',
      EVERMEM_SESSIONS_FILE: sessionsFile,
    };

    const storeResult = await runHook('store-memories.js', { transcript_path: transcript, cwd: pluginRoot }, env);
    assert.match(storeResult.systemMessage, /Test turn detected/);
    assert.equal(fake.requests.filter(request => request.path === '/api/v1/memories').length, 0);

    const summaryResult = await runHook('session-summary.js', {
      session_id: transcript, transcript_path: transcript, cwd: pluginRoot, reason: 'quit',
    }, env);
    assert.match(summaryResult.systemMessage, /Test session detected/);
    assert.throws(() => readFileSync(sessionsFile, 'utf8'));
  } finally {
    await fake.close();
  }
});

test('Prime extension injects session and prompt memories, stores the turn, and summarizes the session', async () => {
  const fake = await startFakeEvermem();
  const directory = makeTempDir();
  const transcript = writeTranscript(directory, 'prime-extension.jsonl', primeEntries);
  const sessionsFile = join(directory, 'sessions.jsonl');
  const previousEnv = {
    EVERMEM_API_URL: process.env.EVERMEM_API_URL,
    EVERMEM_USER_ID: process.env.EVERMEM_USER_ID,
    EVERMEM_DISABLE_PROJECT_SCOPE: process.env.EVERMEM_DISABLE_PROJECT_SCOPE,
    EVERMEM_REQUEST_TIMEOUT_MS: process.env.EVERMEM_REQUEST_TIMEOUT_MS,
    EVERMEM_SESSIONS_FILE: process.env.EVERMEM_SESSIONS_FILE,
  };
  process.env.EVERMEM_API_URL = fake.url;
  process.env.EVERMEM_USER_ID = 'fixture-user';
  process.env.EVERMEM_DISABLE_PROJECT_SCOPE = '1';
  process.env.EVERMEM_REQUEST_TIMEOUT_MS = '3600000';
  process.env.EVERMEM_SESSIONS_FILE = sessionsFile;

  try {
    const module = await import(`${pathToFileURL(extensionPath).href}?test=${Date.now()}`);
    const handlers = new Map();
    module.default({ on: (event, handler) => handlers.set(event, handler) });
    assert.deepEqual([...handlers.keys()], ['session_start', 'before_agent_start', 'agent_end', 'session_shutdown']);

    const notifications = [];
    const ctx = {
      cwd: pluginRoot,
      sessionManager: { getSessionFile: () => transcript },
      ui: { notify: (message, level) => notifications.push({ message, level }) },
    };

    await handlers.get('session_start')({ type: 'session_start', reason: 'startup' }, ctx);
    const beforeResult = await handlers.get('before_agent_start')({
      type: 'before_agent_start', prompt: 'A sufficiently long user prompt', systemPrompt: 'BASE SYSTEM',
    }, ctx);
    assert.match(beforeResult.systemPrompt, /^BASE SYSTEM/);
    assert.match(beforeResult.systemPrompt, /Session memory from a previous run/);
    assert.match(beforeResult.systemPrompt, /Relevant memory for the current prompt/);

    await handlers.get('agent_end')({
      type: 'agent_end', messages: [],
    }, ctx);
    assert.equal(fake.requests.filter(request => request.path === '/api/v1/memories').length, 2);

    await handlers.get('session_shutdown')({ type: 'session_shutdown', reason: 'quit' }, ctx);
    const savedSummary = JSON.parse(readFileSync(sessionsFile, 'utf8').trim());
    assert.equal(savedSummary.turnCount, 1);
    assert.equal(savedSummary.summary, 'Prime user question');
    assert.ok(notifications.some(item => item.message.includes('Memory Retrieved')));
    assert.ok(notifications.some(item => item.message.includes('Memory saved')));
  } finally {
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fake.close();
  }
});

test('session summaries preserve concurrent shutdown records', async () => {
  const directory = makeTempDir();
  const sessionsFile = join(directory, 'sessions.jsonl');
  const env = {
    EVERMEM_API_URL: 'http://127.0.0.1:1',
    EVERMEM_USER_ID: 'fixture-user',
    EVERMEM_DISABLE_PROJECT_SCOPE: '1',
    EVERMEM_SESSIONS_FILE: sessionsFile,
  };
  const makeEntries = (sessionId, prompt) => [
    { type: 'session', id: sessionId, timestamp: '2026-08-08T10:00:00.000Z' },
    { type: 'message', id: `${sessionId}-user`, parentId: sessionId, timestamp: '2026-08-08T10:01:00.000Z', message: { role: 'user', content: prompt } },
    { type: 'message', id: `${sessionId}-assistant`, parentId: `${sessionId}-user`, timestamp: '2026-08-08T10:02:00.000Z', message: { role: 'assistant', stopReason: 'stop', content: 'Done' } },
  ];
  const firstTranscript = writeTranscript(directory, 'first.jsonl', makeEntries('first-session', 'First summary'));
  const secondTranscript = writeTranscript(directory, 'second.jsonl', makeEntries('second-session', 'Second summary'));

  await Promise.all([
    runHook('session-summary.js', { session_id: 'first-session', transcript_path: firstTranscript, cwd: pluginRoot }, env),
    runHook('session-summary.js', { session_id: 'second-session', transcript_path: secondTranscript, cwd: pluginRoot }, env),
  ]);

  const summaries = readFileSync(sessionsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(summaries.map(summary => summary.sessionId).sort(), ['first-session', 'second-session']);
});


test('hooks fail immediately when the deployment request deadline is invalid', async () => {
  const result = await runHook('inject-memories.js', {
    prompt: 'Configuration check prompt', cwd: pluginRoot,
  }, {
    EVERMEM_API_URL: 'http://127.0.0.1:1',
    EVERMEM_USER_ID: 'fixture-user',
    EVERMEM_REQUEST_TIMEOUT_MS: 'not-a-number',
  });
  assert.match(result.systemMessage, /positive integer/);
});

test('Prime lifecycle cancellation terminates an EverMem subprocess loudly', async () => {
  const previousEnv = {
    EVERMEM_API_URL: process.env.EVERMEM_API_URL,
    EVERMEM_USER_ID: process.env.EVERMEM_USER_ID,
    EVERMEM_DISABLE_PROJECT_SCOPE: process.env.EVERMEM_DISABLE_PROJECT_SCOPE,
    EVERMEM_REQUEST_TIMEOUT_MS: process.env.EVERMEM_REQUEST_TIMEOUT_MS,
  };
  process.env.EVERMEM_API_URL = 'http://127.0.0.1:1';
  process.env.EVERMEM_USER_ID = 'fixture-user';
  process.env.EVERMEM_DISABLE_PROJECT_SCOPE = '1';
  process.env.EVERMEM_REQUEST_TIMEOUT_MS = '3600000';

  try {
    const module = await import(`${pathToFileURL(extensionPath).href}?cancel-test=${Date.now()}`);
    const handlers = new Map();
    module.default({ on: (event, handler) => handlers.set(event, handler) });
    const controller = new AbortController();
    const pending = handlers.get('before_agent_start')({
      type: 'before_agent_start', prompt: 'Cancelled recall', systemPrompt: 'BASE',
    }, {
      cwd: pluginRoot,
      signal: controller.signal,
      sessionManager: { getSessionFile: () => '' },
      ui: { notify: () => {} },
    });
    controller.abort();
    await assert.rejects(pending, /cancelled with the Prime lifecycle/);
  } finally {
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
