/**
 * Shared debug utility for EverMem hooks
 *
 * Usage:
 *   import { debug, setDebugPrefix } from './utils/debug.js';
 *   setDebugPrefix('inject');  // Optional: add prefix to log lines
 *   debug('hookInput:', data);
 *
 * Enable by setting EVERMEM_DEBUG=1 in .env file or environment.
 * Debug output is written to stderr so the invoking runtime can forward it to
 * its normal journal/logging pipeline.
 */

import './config.js';  // Loads the plugin .env before reading EVERMEM_DEBUG.

// Check debug flag (after config.js loads .env)
const DEBUG = process.env.EVERMEM_DEBUG === '1';

// Optional prefix for log lines (e.g., 'inject' or 'store')
let debugPrefix = '';

/**
 * Set a prefix for debug log lines
 * @param {string} prefix - Prefix to add (e.g., 'inject', 'store')
 */
export function setDebugPrefix(prefix) {
  debugPrefix = prefix ? `[${prefix}] ` : '';
}

/**
 * Write a debug message to stderr when EVERMEM_DEBUG=1.
 *
 * @param {...any} args - Arguments to log (objects are JSON stringified)
 */
export function debug(...args) {
  if (!DEBUG) return;

  const msg = args.map(a =>
    typeof a === 'object' ? JSON.stringify(a, null, 2) : a
  ).join(' ');

  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${debugPrefix}${msg}\n`;

  process.stderr.write(line);
}

/**
 * Check if debug mode is enabled
 * @returns {boolean}
 */
export function isDebugEnabled() {
  return DEBUG;
}