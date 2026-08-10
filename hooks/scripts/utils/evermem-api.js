/**
 * EverMem Cloud API client
 * Handles memory search and storage operations
 */

import { getConfig } from './config.js';
import { debug, setDebugPrefix } from './debug.js';

// Set debug prefix for this script
setDebugPrefix('EverMemAPI');

// Every request has a deployment-owned deadline from EVERMEM_REQUEST_TIMEOUT_MS.
// The value is required configuration rather than a hard-coded guess: xinfty derives
// it from EverMemOS's configured processing bound. Expiry aborts fetch and propagates
// as an explicit hook failure instead of leaving a lifecycle handler hung forever.

/**
 * Search memories from EverMem Cloud (v1)
 * @param {string} query - Search query text
 * @param {Object} options - Additional options
 * @param {number} options.topK - Max results (default: 10)
 * @param {string} options.retrieveMethod - Search method: keyword|vector|hybrid|agentic (default: 'hybrid')
 * @param {string[]} options.memoryTypes - Memory types (default: ['episodic_memory'])
 * @returns {Promise<Object>} Raw API response with _debug envelope
 */
export async function searchMemories(query, options = {}) {
  const config = getConfig();

  if (!config.isConfigured) {
    throw new Error('EverMem endpoint, user identity, or request deadline not configured');
  }

  const {
    topK = 10,
    retrieveMethod = 'hybrid',
    memoryTypes = ['episodic_memory']
  } = options;

  const url = `${config.apiBaseUrl}/api/v1/memories/search`;
  const filters = config.groupId
    ? { group_id: config.groupId }
    : { user_id: config.userId };

  const requestBody = {
    query,
    method: retrieveMethod,
    top_k: topK,
    memory_types: memoryTypes,
    filters
  };

  debug('searchMemories request body', requestBody);

  const debugEnvelope = {
    url,
    requestBody,
    apiKeyMasked: 'API_KEY_HIDDEN'
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(config.requestTimeoutMs),
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { _debug: { ...debugEnvelope, status: response.status, rawBody: text, error: 'non-JSON response' } };
    }

    if (!response.ok) {
      return { _debug: { ...debugEnvelope, status: response.status, error: data } };
    }

    data._debug = debugEnvelope;
    return data;
  } catch (error) {
    return { _debug: { ...debugEnvelope, error: error.message } };
  }
}

/**
 * Transform v1 search API response to plugin memory format.
 * v1 returns: { data: { episodes: [{ id, user_id, session_id, timestamp, summary, subject, score, participants, group_id? }], ... } }
 * @param {Object} apiResponse - Raw v1 API response
 * @returns {Object[]} Formatted memories sorted by score desc
 */
export function transformSearchResults(apiResponse) {
  const episodes = apiResponse?.data?.episodes;
  if (!Array.isArray(episodes)) {
    return [];
  }

  const memories = [];
  for (const ep of episodes) {
    const content = ep.summary || '';
    if (!content) continue;

    memories.push({
      text: content,
      subject: ep.subject || '',
      timestamp: ep.timestamp || new Date().toISOString(),
      memoryType: ep.memory_type || 'episodic_memory',
      score: ep.score || 0,
      metadata: {
        groupId: ep.group_id,
        type: ep.memory_type,
        participants: ep.participants
      }
    });
  }

  memories.sort((a, b) => b.score - a.score);
  return memories;
}


/**
 * Add a memory to EverMem Cloud (v1).
 * Uses /api/v1/memories/group when config.groupId is set, else /api/v1/memories (personal).
 * @param {Object} message - Message to store
 * @param {string} message.content - Message content
 * @param {string} message.role - 'user' or 'assistant'
 * @param {string} [message.messageId] - (unused in v1; accepted for backward compatibility)
 * @returns {Promise<Object>} Debug envelope { url, body, status, ok, response }
 */
export async function addMemory(message) {
  const config = getConfig();

  if (!config.isConfigured) {
    throw new Error('EverMem endpoint, user identity, or request deadline not configured');
  }

  const role = message.role === 'assistant' ? 'assistant' : 'user';
  const sender_id = role === 'assistant' ? 'claude-assistant' : config.userId;

  const baseMessage = {
    message_id: message.messageId || undefined,
    sender_id,
    role,
    timestamp: message.timestamp || Date.now(),
    content: message.content
  };

  let url;
  let requestBody;

  if (config.groupId) {
    url = `${config.apiBaseUrl}/api/v1/memories/group`;
    requestBody = {
      group_id: config.groupId,
      user_id: config.userId,
      session_id: message.sessionId || undefined,
      messages: [baseMessage],
      async_mode: true
    };
  } else {
    url = `${config.apiBaseUrl}/api/v1/memories`;
    requestBody = {
      user_id: config.userId,
      session_id: message.sessionId || undefined,
      messages: [baseMessage],
      async_mode: true
    };
  }

  let response, responseText, responseData, status, ok;

  try {
    response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(config.requestTimeoutMs),
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });
    status = response.status;
    ok = response.ok;
    responseText = await response.text();
    try {
      responseData = JSON.parse(responseText);
    } catch {}
  } catch (fetchError) {
    status = 0;
    ok = false;
    responseText = fetchError.message;
  }

  return {
    url,
    body: requestBody,
    status,
    ok,
    response: responseData || responseText
  };
}

/**
 * Close the accumulation window of a finished session (v1).
 * Uses /api/v1/memories/group/flush when config.groupId is set, else
 * /api/v1/memories/flush (personal).
 *
 * Why this exists: EverMemOS keys its accumulation window by
 * (group_id, session_id) and only closes it when boundary detection produces a
 * MemCell. A session id is never seen again once the session ends, so without
 * an explicit flush the tail of every finished session stays unconsumed
 * forever — present as raw rows, never turned into memory.
 *
 * Mirrors addMemory: HTTP errors are returned in the envelope rather than
 * thrown, so the caller decides how loud to be.
 *
 * @param {Object} options
 * @param {string} [options.sessionId] - Session whose window should be closed
 * @returns {Promise<Object>} Debug envelope { url, body, status, ok, response }
 */
export async function flushSession(options = {}) {
  const config = getConfig();

  if (!config.isConfigured) {
    throw new Error('EverMem endpoint, user identity, or request deadline not configured');
  }

  let url;
  let requestBody;

  if (config.groupId) {
    url = `${config.apiBaseUrl}/api/v1/memories/group/flush`;
    requestBody = { group_id: config.groupId };
  } else {
    url = `${config.apiBaseUrl}/api/v1/memories/flush`;
    requestBody = {
      user_id: config.userId,
      session_id: options.sessionId || undefined
    };
  }

  debug('flushSession request body', requestBody);

  let response, responseText, responseData, status, ok;

  try {
    response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(config.requestTimeoutMs),
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });
    status = response.status;
    ok = response.ok;
    responseText = await response.text();
    try {
      responseData = JSON.parse(responseText);
    } catch {}
  } catch (fetchError) {
    status = 0;
    ok = false;
    responseText = fetchError.message;
  }

  return {
    url,
    body: requestBody,
    status,
    ok,
    response: responseData || responseText
  };
}

/**
 * Get memories from EverMem Cloud (v1, ordered newest first by default).
 * @param {Object} options - Options
 * @param {number} options.page - Page number (default: 1)
 * @param {number} options.pageSize - Results per page (default: 100, max: 100)
 * @param {string} options.memoryType - Memory type filter (default: 'episodic_memory')
 * @returns {Promise<Object>} Raw v1 response { data: { episodes, total_count, count, ... } }
 */
export async function getMemories(options = {}) {
  const config = getConfig();

  if (!config.isConfigured) {
    throw new Error('EverMem endpoint, user identity, or request deadline not configured');
  }

  const {
    page = 1,
    pageSize = 100,
    memoryType = 'episodic_memory'
  } = options;

  const filters = config.groupId
    ? { group_id: config.groupId }
    : { user_id: config.userId };

  const url = `${config.apiBaseUrl}/api/v1/memories/get`;
  const requestBody = {
    memory_type: memoryType,
    filters,
    page,
    page_size: pageSize,
    rank_by: 'timestamp',
    rank_order: 'desc'
  };

  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(config.requestTimeoutMs),
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API error ${response.status}: ${errorText}`);
  }

  return await response.json();
}

/**
 * Transform v1 getMemories response to simple format.
 * @param {Object} apiResponse - Raw v1 API response
 * @returns {Object[]} Formatted memories newest-first
 */
export function transformGetMemoriesResults(apiResponse) {
  const episodes = apiResponse?.data?.episodes;
  if (!Array.isArray(episodes)) {
    return [];
  }

  const memories = episodes.map(ep => ({
    text: ep.episode || ep.summary || '',
    subject: ep.subject || '',
    timestamp: ep.timestamp || new Date().toISOString(),
    groupId: ep.group_id
  })).filter(m => m.text);

  memories.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return memories;
}
