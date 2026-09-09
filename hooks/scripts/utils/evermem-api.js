/**
 * EverMem Cloud API client
 * Handles memory search and storage operations
 */

import { request as httpAnfrage } from 'node:http';
import { request as httpsAnfrage } from 'node:https';
import { getConfig } from './config.js';
import { debug, setDebugPrefix } from './debug.js';

// Set debug prefix for this script
setDebugPrefix('EverMemAPI');

// Every request has a deployment-owned deadline from EVERMEM_REQUEST_TIMEOUT_MS.
// The value is required configuration rather than a hard-coded guess: it is derived
// from EverMemOS's configured processing bound. Expiry aborts the request and
// propagates as an explicit hook failure instead of leaving a lifecycle handler
// hung forever.
//
// UND ES IST DIE EINZIGE FRIST — seit dem 2026-09-09 auch wirklich.
//
// Bis dahin liefen diese Aufrufe über `fetch`, und darunter sitzen DREI
// unsichtbare Fristen der Bibliothek, jede mit einem Vorgabewert, den niemand
// gewählt hat. Gemessen an Node v22.21.1, je mit einem Aufbau, der genau eine
// davon auslöst und sonst nichts:
//
//     connectTimeout    10.504 ms   Ziel nimmt die Verbindung nie an
//     headersTimeout   300.762 ms   Server nimmt an, liest, antwortet nie
//     bodyTimeout      300.xxx ms   Kopfzeilen ja, Rumpf nie
//
// DIE KONFIGURIERTE FRIST WAR DAMIT EIN VERSPRECHEN OHNE REICHWEITE: Sie stand
// auf 3.600.000 ms, und der Aufruf starb nach 300.762 ms — zwölfmal früher, als
// die sichtbare Zahl zusagte. Dieselbe Klasse wie ein Feld ohne Leser: Es steht
// da, es liest sich wie eine Zusage, und es wirkt nicht.
//
// WAS DAS KOSTETE, gemessen: Die `add`-Anfrage des Dienstes läuft synchron
// 293–323 s (Journal, `stage_timer`). Die Frist von 300,76 s liegt MITTEN
// DARIN. Jede Ablage, die etwas länger brauchte als üblich, war per
// Konstruktion eine Fehlermeldung — bei 2.207 gelungenen Ablagen lag keine
// einzige über 267 s, und drei Fehlschläge sitzen auf 300,9 / 300,9 / 301,2 s.
//
// DESHALB `node:http` STATT `fetch`, und das ist der Kern der Änderung: Der
// Kern-Klient bringt KEINE eigene Antwortfrist mit. Es gibt hier nichts zu
// überschreiben und keinen Vorgabewert, der beim nächsten Aktualisieren der
// Laufzeit zurückkommt — es gibt nur die eine Zahl unten, und die steht in der
// Konfiguration. Eine größere Zahl an derselben Stelle wäre keine Herleitung
// gewesen, sondern eine erfundene Zahl gegen eine andere getauscht.
//
// WAS EIN WIRKLICH HÄNGENDER AUFRUF JETZT TUT — bewusst so, nicht nebenbei:
// Er wartet die volle konfigurierte Frist ab (im Bestand eine Stunde) und
// scheitert dann laut mit `EVERMEM_DEADLINE`, das die Zahl im Text nennt. Der
// Stop-Hook läuft asynchron mit einer Harness-Frist von 86.400 s, ein
// hängender Aufruf hält also einen Node-Prozess, keine Sitzung. Das ist die
// Entscheidung, die in `EVERMEM_REQUEST_TIMEOUT_MS` steht: lieber lange warten
// als eine laufende Ablage abschneiden — „gut Ding braucht Weile, und Fehler
// werden geworfen". Wer das anders will, ändert die Zahl, nicht den Code.

/**
 * Schickt eine JSON-Anfrage und wartet auf die VOLLSTÄNDIGE Antwort.
 *
 * Genau eine Frist, und zwar die übergebene: ein Zeitgeber über den ganzen
 * Vorgang — Verbindungsaufbau, Kopfzeilen und Rumpf zusammen. Kein
 * Wiederholungsversuch, kein Ersatzweg, keine Umleitung.
 *
 * @param {string} url - Vollständige Zieladresse
 * @param {Object} optionen
 * @param {string} [optionen.method] - HTTP-Verfahren, Vorgabe `POST`
 * @param {string} [optionen.body] - Bereits serialisierter Rumpf
 * @param {number} optionen.timeoutMs - Die Frist; Pflicht, kein Vorgabewert
 * @returns {Promise<{status: number, ok: boolean, text: string}>}
 * @throws bei Transportfehler oder Fristablauf — mit `code`, `errno`,
 *   `syscall`, `address` und `port`, soweit das Betriebssystem sie liefert.
 *   `beschreibtFehler` macht daraus die Meldung.
 */
function sendetJson(url, { method = 'POST', body, timeoutMs }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`sendetJson: unbrauchbare Frist ${timeoutMs}`);
  }

  return new Promise((resolve, reject) => {
    const ziel = new URL(url);
    const anfragen = ziel.protocol === 'https:' ? httpsAnfrage : httpAnfrage;
    const nutzlast = body === undefined ? undefined : Buffer.from(body, 'utf8');

    const req = anfragen(ziel, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...nutzlast === undefined ? {} : { 'Content-Length': nutzlast.byteLength },
      },
    });

    let erledigt = false;
    const uhr = setTimeout(() => {
      req.destroy(Object.assign(
        new Error(`EverMem: keine vollständige Antwort binnen ${timeoutMs} ms`),
        { code: 'EVERMEM_DEADLINE', timeoutMs, address: ziel.hostname, port: ziel.port },
      ));
    }, timeoutMs);

    const fertig = (fn, wert) => {
      if (erledigt) return;
      erledigt = true;
      clearTimeout(uhr);
      fn(wert);
    };

    req.on('response', res => {
      const teile = [];
      res.on('data', stueck => teile.push(stueck));
      res.on('end', () => fertig(resolve, {
        status: res.statusCode,
        ok: res.statusCode >= 200 && res.statusCode < 300,
        text: Buffer.concat(teile).toString('utf8'),
      }));
      res.on('error', fehler => fertig(reject, fehler));
    });
    req.on('error', fehler => fertig(reject, fehler));

    if (nutzlast !== undefined) req.write(nutzlast);
    req.end();
  });
}

/**
 * Beschreibt einen Transportfehler SPRECHEND.
 *
 * WARUM DAS HIER STEHT. `fetch` wirft für JEDEN Transportfehler denselben
 * nichtssagenden Text: `TypeError: fetch failed`. Die Unterscheidung —
 * abgelehnte Verbindung, zurückgesetzte Verbindung, unerreichbares Netz,
 * unbekannter Name — lebt ausschliesslich in `error.cause`. Bis zum
 * 2026-09-09 haben die drei `catch`-Blöcke unten nur `error.message`
 * übernommen und `cause` verworfen.
 *
 * WAS DAS GEKOSTET HAT, gemessen an 123 Transkripten einer Installation:
 * 31 von 2.228 Ablagen scheiterten (1,4 %), vierzehn davon mit Status 0 und
 * dem Text `"fetch failed"` — und alle vierzehn sind nachträglich
 * ununterscheidbar. In einem der Fälle belegte das Protokoll des Dienstes,
 * dass die Anfrage die Anwendung nie erreichte; WARUM die Verbindung
 * ausblieb, konnte nicht mehr geklärt werden, weil genau diese Zeile die
 * Antwort weggeworfen hatte. Eine Meldung, die nicht sagt, was passiert ist,
 * ist kein Alarm.
 *
 * DIE URSACHE IST VERSCHACHTELT, deshalb wird die Kette abgelaufen und nicht
 * nur die erste Ebene genommen: Node hängt bei `autoSelectFamily` einen
 * `AggregateError` ein, dessen `errors` je Adressfamilie einen eigenen
 * Fehler tragen. Genau dieser Fall trat auf: Ein Name löst auf mehrere
 * Adressfamilien auf, und das Ziel nimmt nur auf einer davon an — dann steht
 * die entscheidende Auskunft ausschliesslich im inneren Fehler.
 *
 * KEINE BEHANDLUNG. Diese Funktion beschreibt und heilt nicht: keine Frist,
 * kein Wiederholungsversuch, kein Ersatzweg. Der Fehler bleibt ein Fehler.
 *
 * @param {unknown} error - Der gefangene Fehler
 * @returns {string} Eine Zeile, die Typ, Text und alle bekannten
 *   Betriebssystem-Felder der Ursachenkette nennt
 */
export function beschreibtFehler(error) {
  const teile = [];
  const gesehen = new Set();

  const lauf = (e, tiefe) => {
    if (!e || typeof e !== 'object' || gesehen.has(e) || tiefe > 8) {
      if (typeof e === 'string' && e) teile.push(e);
      return;
    }
    gesehen.add(e);

    const kopf = e.name && e.message ? `${e.name}: ${e.message}`
      : e.message || e.name || String(e);
    // Die Felder, die das Betriebssystem liefert — jedes einzeln benannt,
    // damit im Protokoll steht, WOHIN die Verbindung ging und woran sie lag.
    const felder = ['code', 'errno', 'syscall', 'address', 'port', 'hostname'];
    const vorhanden = felder
      .filter(f => e[f] !== undefined && e[f] !== null && e[f] !== '')
      .map(f => `${f}=${e[f]}`);
    teile.push(vorhanden.length > 0 ? `${kopf} (${vorhanden.join(' ')})` : kopf);

    // `AggregateError.errors`: je Adressfamilie ein eigener Fehler.
    if (Array.isArray(e.errors)) {
      for (const einzeln of e.errors) lauf(einzeln, tiefe + 1);
    }
    if (e.cause !== undefined && e.cause !== null) lauf(e.cause, tiefe + 1);
  };

  lauf(error, 0);
  if (teile.length === 0) return String(error);
  // Von aussen nach innen: der nichtssagende Kopf zuerst, dann die Ursache,
  // die ihn erklärt. Wer nur den Anfang liest, verliert nichts Bekanntes.
  return teile.join(' <- ');
}

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
    const response = await sendetJson(url, {
      method: 'POST',
      body: JSON.stringify(requestBody),
      timeoutMs: config.requestTimeoutMs,
    });

    const text = response.text;
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
    return { _debug: { ...debugEnvelope, error: beschreibtFehler(error) } };
  }
}

/**
 * Transform v1 search API response to plugin memory format.
 *
 * v1 answers a hybrid search from two paths, and THEY CARRY DIFFERENT FIELDS.
 * Measured 2026-09-02 against a live EverMemOS deployment, twenty hits per
 * method:
 *
 *     method     summary   subject   episode   timestamp
 *     keyword      20/20     20/20     20/20       0/20
 *     vector        0/20      0/20     20/20      20/20
 *     hybrid        5/20      5/20     20/20      15/20
 *
 * Two consequences used to fall out of that, and both are fixed here.
 *
 * 1. EVERY VECTOR HIT WAS DISCARDED. This function read `ep.summary` and
 *    skipped the entry when it was absent — which is every single vector
 *    hit. The five memories a hybrid search surfaced were the keyword hits;
 *    the vector path had been inert for as long as it existed, silently.
 *    What that cost, measured on one real prompt: six of the discarded
 *    vector hits sat at ranks 6, 8, 15, 23, 44 and 45, scoring 0.5036 down
 *    to 0.4418, against 0.5479 for the rank-1 keyword hit that did survive.
 *    The lowest-scoring discarded hit was still nearer the prompt than that
 *    survivor, across a span of 0.10 — the same magnitude as the null
 *    distribution's standard deviation on a comparable store (sigma =
 *    0.1024). The ranking was sorting inside its own noise while the client
 *    threw away the half that answered the question. `episode` carries the
 *    full text and is present on every hit, so it is the fallback.
 *
 * 2. THE DATE WAS INVENTED. `ep.timestamp || new Date().toISOString()`
 *    turned a missing timestamp into "now" — indistinguishable from a real
 *    one. Memories from April and August were shown as "(just now)". A
 *    missing value is now `null` and stays that way; the caller decides how
 *    to render "unknown", and cannot mistake it for a fact.
 *
 * The two paths also return THE SAME DOCUMENT TWICE under different ids: a
 * Mongo ObjectId from the keyword path, a UUID from the vector path, both
 * with the same `parent_id`. They are two views of one memory, one holding
 * subject/summary, the other holding the timestamp — so they are MERGED on
 * `parent_id` rather than deduplicated, and the merged entry is complete
 * where neither view was. Ordering keeps the better score of the two.
 *
 * @param {Object} apiResponse - Raw v1 API response
 * @returns {Object[]} Formatted memories sorted by score desc
 */
export function transformSearchResults(apiResponse) {
  const episodes = apiResponse?.data?.episodes;
  if (!Array.isArray(episodes)) {
    return [];
  }

  const byDocument = new Map();
  const ohneText = [];

  for (const ep of episodes) {
    const content = ep.summary || ep.episode || '';
    if (!content) {
      // Not skipped in silence: an entry with no text at all is a finding
      // about the store, and the caller is told how many there were.
      ohneText.push(ep.id ?? ep.parent_id ?? '<no id>');
      continue;
    }

    // parent_id identifies the memory across both id spaces; fall back to
    // the path-local id when it is absent so nothing is dropped.
    const schluessel = ep.parent_id || ep.id || Symbol('unkeyed');
    const vorhanden = byDocument.get(schluessel);

    const eintrag = {
      text: vorhanden?.text || content,
      subject: vorhanden?.subject || ep.subject || '',
      timestamp: vorhanden?.timestamp ?? ep.timestamp ?? null,
      memoryType: ep.memory_type || vorhanden?.memoryType || 'episodic_memory',
      score: Math.max(ep.score || 0, vorhanden?.score || 0),
      metadata: {
        groupId: ep.group_id ?? vorhanden?.metadata?.groupId,
        type: ep.memory_type ?? vorhanden?.metadata?.type,
        participants: ep.participants ?? vorhanden?.metadata?.participants
      }
    };

    // A summary is the better display text than the full episode; take it
    // whenever either view supplies one.
    if (ep.summary) eintrag.text = ep.summary;
    if (ep.subject) eintrag.subject = ep.subject;
    if (ep.timestamp) eintrag.timestamp = ep.timestamp;

    byDocument.set(schluessel, eintrag);
  }

  if (ohneText.length > 0) {
    debug(`transformSearchResults: ${ohneText.length} von ${episodes.length} ` +
          `Treffern tragen weder summary noch episode`, ohneText.slice(0, 10));
  }

  const memories = [...byDocument.values()];

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
    response = await sendetJson(url, {
      method: 'POST',
      body: JSON.stringify(requestBody),
      timeoutMs: config.requestTimeoutMs,
    });
    status = response.status;
    ok = response.ok;
    responseText = response.text;
    try {
      responseData = JSON.parse(responseText);
    } catch {}
  } catch (fetchError) {
    status = 0;
    ok = false;
    // `fetchError.message` allein ist immer "fetch failed" — siehe
    // `beschreibtFehler`. Die Ursachenkette gehört in die Meldung.
    responseText = beschreibtFehler(fetchError);
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
    response = await sendetJson(url, {
      method: 'POST',
      body: JSON.stringify(requestBody),
      timeoutMs: config.requestTimeoutMs,
    });
    status = response.status;
    ok = response.ok;
    responseText = response.text;
    try {
      responseData = JSON.parse(responseText);
    } catch {}
  } catch (fetchError) {
    status = 0;
    ok = false;
    // `fetchError.message` allein ist immer "fetch failed" — siehe
    // `beschreibtFehler`. Die Ursachenkette gehört in die Meldung.
    responseText = beschreibtFehler(fetchError);
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

  const response = await sendetJson(url, {
    method: 'POST',
    body: JSON.stringify(requestBody),
    timeoutMs: config.requestTimeoutMs,
  });

  if (!response.ok) {
    throw new Error(`API error ${response.status}: ${response.text}`);
  }

  return JSON.parse(response.text);
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

  // No invented timestamps here either — see transformSearchResults. A
  // missing value stays null; entries without one sort last rather than
  // pretending to be from today.
  const memories = episodes.map(ep => ({
    text: ep.episode || ep.summary || '',
    subject: ep.subject || '',
    timestamp: ep.timestamp ?? null,
    groupId: ep.group_id
  })).filter(m => m.text);

  memories.sort((a, b) => {
    if (a.timestamp === b.timestamp) return 0;
    if (a.timestamp === null) return 1;
    if (b.timestamp === null) return -1;
    return new Date(b.timestamp) - new Date(a.timestamp);
  });
  return memories;
}
