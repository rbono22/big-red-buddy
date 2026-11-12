import {readFileSync} from 'node:fs';
import {HttpError} from './security.mjs';

export const JOB_SOURCE_LIMIT = 20;
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const BOARD = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const PROVIDERS = new Set(['greenhouse', 'ashby']);
const reserved = new Set(['admin', 'api', 'auth', 'embed', 'internal', 'jobs', 'login', 'signin', 'users']);
const canonicalURL = (provider, board) => `https://${provider === 'greenhouse' ? 'job-boards.greenhouse.io' : 'jobs.ashbyhq.com'}/${board}`;
const sourceKey = source => `${source.provider}:${source.board}`;
const fail = message => { throw new HttpError(400, message, 'invalid_job_sources'); };
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const projection = source => ({id:source.id,name:source.name,provider:source.provider,board:source.board,careersUrl:source.careersUrl,verifiedAt:source.verifiedAt});

// This local, reviewed resource is the only registry. No caller-controlled URL is fetched.
const catalog = JSON.parse(readFileSync(new URL('../resources/job-source-catalog.json', import.meta.url), 'utf8'));
if (!plainObject(catalog) || !/^\d+\.\d+\.\d+$/.test(catalog.version) || !Number.isFinite(Date.parse(catalog.checkedAt)) || !Array.isArray(catalog.sources) || catalog.sources.length !== 8 || typeof catalog.coverage !== 'string') throw new Error('Invalid starter employer catalog.');
const byId = new Map(), byBoard = new Map();
for (const source of catalog.sources) {
  if (!plainObject(source) || !ID.test(source.id) || typeof source.name !== 'string' || !source.name.trim() || source.name.length > 100 || !PROVIDERS.has(source.provider) || !BOARD.test(source.board) || reserved.has(source.board.toLowerCase()) || source.careersUrl !== canonicalURL(source.provider, source.board) || !Number.isFinite(Date.parse(source.verifiedAt)) || byId.has(source.id) || byBoard.has(sourceKey(source).toLowerCase())) throw new Error('Invalid or duplicate starter employer source.');
  const safe = Object.freeze(projection(source));
  byId.set(source.id, safe); byBoard.set(sourceKey(source).toLowerCase(), safe);
}

/** Snapshot metadata, not a live claim that every board or posting is available. */
export function listJobSources() {
  return {version:catalog.version,checkedAt:catalog.checkedAt,coverage:catalog.coverage,sources:[...byId.values()].map(projection)};
}

function existingSource(value) {
  if (!plainObject(value) || !PROVIDERS.has(value.provider) || typeof value.board !== 'string' || !BOARD.test(value.board) || reserved.has(value.board.toLowerCase())) fail('A saved employer board is invalid. Choose a supported employer source.');
  // Known aliases are normalized to the exact board that was verified. Unknown
  // board case is preserved rather than assuming all provider paths ignore case.
  const known = byBoard.get(sourceKey(value).toLowerCase());
  return known ? projection(known) : {provider:value.provider,board:value.board};
}

/** Empty selection means the eight starters, plus validated existing own boards.
 * Explicit selections accept catalog IDs only. No provider discovery or network I/O.
 * Exceeding the source cap fails rather than silently dropping a selected employer.
 */
export function resolveJobSearchSources(options = {}) {
  if (!plainObject(options) || Object.keys(options).some(key => !['sourceIds', 'existingBoards'].includes(key))) fail('Choose employer sources using sourceIds.');
  const {sourceIds = [], existingBoards = []} = options;
  if (!Array.isArray(sourceIds) || sourceIds.length > JOB_SOURCE_LIMIT || !Array.isArray(existingBoards) || existingBoards.length > JOB_SOURCE_LIMIT) fail('Choose at most 20 employer sources.');
  const ids = sourceIds.length ? sourceIds : [...byId.keys()];
  const selected = ids.map(id => {
    if (typeof id !== 'string' || !ID.test(id) || !byId.has(id)) fail('One or more employer sources are not in the starter catalog.');
    return projection(byId.get(id));
  });
  const result = new Map();
  for (const source of [...selected, ...existingBoards.map(existingSource)]) result.set(sourceKey(source), source);
  if (result.size > JOB_SOURCE_LIMIT) fail('Selected and saved employer boards exceed the 20-source limit. Choose fewer sources.');
  return [...result.values()];
}

/** Parse a hosted board or posting URL into a fixed provider endpoint identifier.
 * Queries and fragments are discarded. Arbitrary employer URLs and embed URLs
 * are rejected; this parser never follows redirects or makes a network request.
 */
export function parseJobBoardURL(value) {
  if (typeof value !== 'string' || value.length > 2048 || value !== value.trim() || !/^https:\/\/[^/?#]+(?:[/?#]|$)/i.test(value) || /[\s\\\u0000-\u001f\u007f]/.test(value)) fail('Paste a public HTTPS Greenhouse or Ashby job-board link.');
  let url; try { url = new URL(value); } catch { fail('Paste a valid public job-board link.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname.includes('%')) fail('Use a public HTTPS job-board link without credentials or a custom port.');
  // Inspect the original path as well: URL() normalizes dot segments before
  // pathname validation and must not turn an untrusted path into a valid board.
  const rawPath = value.replace(/^https:\/\/[^/?#]+/i, '').split(/[?#]/, 1)[0];
  if (rawPath.includes('%') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath)) fail('Use the direct public job-board link.');
  let provider, match;
  if (['boards.greenhouse.io', 'job-boards.greenhouse.io'].includes(url.hostname)) {
    provider = 'greenhouse'; match = /^\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,79})(?:\/jobs\/\d{1,20})?\/?$/.exec(url.pathname);
  } else if (url.hostname === 'jobs.ashbyhq.com') {
    provider = 'ashby'; match = /^\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,79})(?:\/[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}(?:\/application)?)?\/?$/i.exec(url.pathname);
  }
  if (!match || reserved.has(match[1].toLowerCase())) fail('Use a hosted Greenhouse or Ashby board or job-posting link.');
  const source = existingSource({provider,board:match[1]});
  return {provider:source.provider,board:source.board,careersUrl:canonicalURL(source.provider,source.board)};
}
