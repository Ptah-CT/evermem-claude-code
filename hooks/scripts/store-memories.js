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

/** Wie viel vom Nachrichtenkörper eine Fehlermeldung zeigt. */
const KOERPER_GRENZE = 500;

/**
 * Kürzt den Nachrichtenkörper einer gescheiterten Anfrage — DORT, WO DER TEXT
 * WIRKLICH LIEGT.
 *
 * HIER STAND EINE SCHERE, DIE NIE GESCHNITTEN HAT. Die alte Fassung prüfte
 * `body.content`; die Nutzlast dieses Endpunkts trägt den Text aber in
 * `body.messages[].content`. Das Feld `body.content` gibt es nicht und hat es
 * nie gegeben, also griff die Kürzung auf KEINER Nutzlast, und jede
 * Fehlermeldung trug die vollständige Nachricht wortwörtlich ins Transkript.
 *
 * GEMESSEN am 2026-09-09, echter Ende-zu-Ende-Lauf mit dem Transkript dieser
 * Sitzung: die erzeugte `systemMessage` war **527 KB** groß (Nutzer 306.506 +
 * Assistent 183.181 Zeichen). Sie ist in einer laufenden Sitzung angekommen
 * und hat dort den Kontext verdrängt, der für die Arbeit gebraucht wurde. Ein
 * Alarm, der so groß ist, dass er seinen Leser verdrängt, ist kein Alarm.
 *
 * DIESELBE KLASSE wie der `error.code`-Zweig in `session-context.js`, am
 * selben Abend gefunden: eine Vorrichtung, die an einem angenommenen Feld
 * hängt und nie gegen die echte Form gefahren wurde.
 *
 * DIE KÜRZUNG SAGT SICH AN. Eine stille Kürzung wäre wieder eine Vorrichtung,
 * die schweigt — der Leser muss sehen, dass er einen Ausschnitt liest, und um
 * wie viel er gekürzt ist.
 *
 * WAS HIER NICHT GEKÜRZT WIRD: die Fehlerursache. Sie steht in `response`,
 * nicht im Körper, und wird von dieser Funktion nicht angefasst — siehe die
 * Reihenfolge der Ausgabe in `main()`.
 *
 * @param {Object} body - Die gesendete Nutzlast
 * @returns {Object} Eine Kopie; Originale werden nicht verändert
 */
function kuerztKoerper(body) {
  if (!body || typeof body !== 'object') return body;
  const copy = { ...body };
  if (!Array.isArray(copy.messages)) return copy;

  copy.messages = copy.messages.map(message => {
    if (!message || typeof message.content !== 'string') return message;
    const laenge = message.content.length;
    if (laenge <= KOERPER_GRENZE) return message;
    const fehlend = laenge - KOERPER_GRENZE;
    return {
      ...message,
      content: `${message.content.slice(0, KOERPER_GRENZE)}`
        + `… [gekürzt: ${fehlend} von ${laenge} Zeichen nicht gezeigt]`,
    };
  });
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
      // URSACHE ZUERST, KÖRPER DANACH — und das ist keine Kosmetik.
      // Der ganze Sinn von `beschreibtFehler` ist, dass `ECONNREFUSED` samt
      // Adresse und Port ankommt. Stünde die Antwort hinter einem 500-KB-Rumpf,
      // wäre sie genau das, was ein Leser (Mensch wie Modell) nicht mehr
      // erreicht — der Defekt wäre einmal behoben und einmal wieder eingesetzt.
      // Was weichen darf, ist der Nachrichtenkörper; die Ursache nie.
      output += `${result.type}: FAILED (${result.status})\n`;
      output += `Response: ${JSON.stringify(result.response, null, 2)}\n`;
      output += `Request: ${JSON.stringify(kuerztKoerper(result.body), null, 2)}\n`;
    }
  }
  if (skipped.length > 0) {
    output += `⏭️ Skipped: ${skipped.map(item => `${item.type} (${item.reason})`).join(', ')}\n`;
  }
  writeMessage(output);
}

main().catch(reportFailure);
