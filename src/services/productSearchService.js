import { PrismaClient } from '@prisma/client';

/*
 * Ranked product search shared by every product search endpoint.
 *
 * Tiers (higher wins, quality/bonuses only order results inside a tier):
 *   10 exact barcode / case barcode
 *    8 exact title
 *    7 title starts with the query (6.5 when the query ends mid-word)
 *    6 barcode prefix         5 every word matches a whole title word
 *    4 every word matches a word prefix
 *    3 every word matches as a substring (>= 4 chars), or as a common spelling of a rare word
 *    2 barcode substring, or a multi-word query matched only by 1-2 letter fragments
 *    1 typo (fuzzy) matches
 *    0 one word missing from a 3+ word query
 * Results below tier 3 are dropped whenever a tier 3+ result exists.
 */

const MIN_INFIX_LENGTH = 4;
const FUZZY_GATE_DOCS = 3;
const DOMINANT_TYPO_RATIO = 10;
const MIN_PARTIAL_QUALITY = 0.6;
const MAX_RANKED_RESULTS = 5000;

const DIACRITICS = /[\u0300-\u036f]/g;

export function normalizeSearchText(value) {
  if (value == null) return '';
  return String(value)
    .normalize('NFKD')
    .replace(DIACRITICS, '')
    .toLowerCase()
    .replace(/['’‘`´]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9.]+/g, ' ')
    // Keep decimal points (1.25l) but drop every other dot.
    .replace(/\.(?!\d)|(?<!\d)\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const normalizeCode = (value) =>
  value == null ? '' : String(value).toLowerCase().replace(/[^a-z0-9]/g, '');

function parseQuery(raw) {
  const norm = normalizeSearchText(raw);
  const tokens = norm ? norm.split(' ') : [];
  return { norm, tokens, compact: tokens.join(''), code: normalizeCode(raw) };
}

// Scanners report UPC-A both with and without the leading 0.
function codeVariants(code) {
  const variants = [code];
  if (/^0\d{12}$/.test(code)) variants.push(code.slice(1));
  if (/^\d{12}$/.test(code)) variants.push(`0${code}`);
  return variants;
}

// Elasticsearch-style AUTO fuzziness.
const allowedEdits = (length) => (length < 3 ? 0 : length <= 5 ? 1 : 2);

// Optimal string alignment distance (counts transpositions as one edit), bounded by `max`.
function editDistance(a, b, max) {
  const al = a.length;
  const bl = b.length;
  if (Math.abs(al - bl) > max) return max + 1;
  let prevPrev = new Array(bl + 1).fill(0);
  let prev = new Array(bl + 1);
  let curr = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, prevPrev[j - 2] + 1);
      }
      curr[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    [prevPrev, prev, curr] = [prev, curr, prevPrev];
  }
  return prev[bl];
}

function commonPrefixLength(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const KEY_POSITIONS = new Map();
KEYBOARD_ROWS.forEach((row, r) => [...row].forEach((key, c) => KEY_POSITIONS.set(key, [r, c + r * 0.5])));

function keysAdjacent(a, b) {
  const pa = KEY_POSITIONS.get(a);
  const pb = KEY_POSITIONS.get(b);
  return !!pa && !!pb && Math.abs(pa[0] - pb[0]) <= 1 && Math.abs(pa[1] - pb[1]) <= 1;
}

// "cpke" is far more likely a slip for "coke" (o/p are neighbours) than for "cake".
function neighbourKeyTypo(token, word) {
  if (token.length !== word.length) return false;
  let diff = -1;
  for (let i = 0; i < token.length; i++) {
    if (token[i] === word[i]) continue;
    if (diff !== -1) return false;
    diff = i;
  }
  return diff !== -1 && keysAdjacent(token[diff], word[diff]);
}

function fuzzyQuality(token, word, edits) {
  const prefixBonus = 0.02 * Math.min(commonPrefixLength(token, word), 3);
  if (Math.abs(word.length - token.length) <= edits) {
    const distance = editDistance(token, word, edits);
    if (distance <= edits) {
      return 0.75 - 0.1 * (distance - 1) + prefixBonus + (neighbourKeyTypo(token, word) ? 0.06 : 0);
    }
  }
  // Typo inside a partially typed word ("pepsl" -> "pepsi max").
  if (token.length >= 5 && word.length > token.length) {
    for (let len = token.length; len <= Math.min(word.length, token.length + 1); len++) {
      if (editDistance(token, word.slice(0, len), 1) <= 1) return 0.6 + prefixBonus;
    }
  }
  return 0;
}

function makeDoc(row) {
  const norm = normalizeSearchText(row.title);
  const words = norm ? norm.split(' ') : [];
  const wordStarts = [];
  let offset = 0;
  for (const word of words) {
    wordStarts.push(offset);
    offset += word.length;
  }
  return {
    id: row.id,
    title: row.title || '',
    norm,
    words,
    wordStarts,
    compact: words.join(''),
    codes: [...new Set([normalizeCode(row.barcode), normalizeCode(row.caseBarcode)].filter(Boolean))],
  };
}

function wordIndexAt(doc, position) {
  let index = 0;
  while (index + 1 < doc.wordStarts.length && doc.wordStarts[index + 1] <= position) index++;
  return index;
}

function wordEnd(doc, index) {
  return doc.wordStarts[index] + doc.words[index].length;
}

// Substrings only count at the end of a compound word ("dcoke", "cupcakes", "dairymilk"),
// never in the middle ("cola" must not match "chocolate").
function endsCompoundWord(word, token) {
  return word.endsWith(token) || word.endsWith(`${token}s`);
}

// A compact prefix may span several words, but must not end on a single stray character
// of the next word ("cok" must not match "co kitchen").
function compactPrefixAllowed(doc, length) {
  const last = wordIndexAt(doc, length - 1);
  return last === 0 || length === wordEnd(doc, last) || length - doc.wordStarts[last] >= 2;
}

// Matches a token against the title with spaces removed, so "cocacola", "6pk" or "500ml"
// still match "Coca Cola", "6 PK" and "500 ML". Matches must start on a word boundary
// or end a single compound word.
function compactMatch(doc, token) {
  let best = null;
  let from = 0;
  for (;;) {
    const position = doc.compact.indexOf(token, from);
    if (position === -1) break;
    from = position + 1;
    const end = position + token.length;
    const first = wordIndexAt(doc, position);
    let match = null;
    if (position === doc.wordStarts[first]) {
      const last = wordIndexAt(doc, end - 1);
      if (end === wordEnd(doc, last)) match = { q: 0.9, kind: 3, pos: first };
      else if (last === first || end - doc.wordStarts[last] >= 2) match = { q: 0.75, kind: 2, pos: first };
    } else if (token.length >= MIN_INFIX_LENGTH) {
      // Same rule as endsCompoundWord(): the token must finish the word (optionally + "s").
      const wEnd = wordEnd(doc, first);
      if (end === wEnd || (end === wEnd - 1 && doc.compact[end] === 's')) {
        match = { q: 0.5, kind: 1, pos: first };
      }
    }
    if (match && (!best || match.q > best.q)) best = match;
    if (best?.kind === 3) break;
  }
  return best;
}

function addToSetMap(map, key, value) {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(value);
}

function removeFromSetMap(map, key, value) {
  const set = map.get(key);
  if (!set) return;
  set.delete(value);
  if (set.size === 0) map.delete(key);
}

export class ProductSearchIndex {
  constructor(rows = []) {
    this.docs = new Map();
    this.vocab = new Map();
    this.codes = new Map();
    for (const row of rows) this.upsert(row);
  }

  get size() {
    return this.docs.size;
  }

  upsert(row) {
    if (!row?.id) return;
    this.remove(row.id);
    const doc = makeDoc(row);
    this.docs.set(doc.id, doc);
    for (const word of new Set(doc.words)) addToSetMap(this.vocab, word, doc);
    for (const code of doc.codes) addToSetMap(this.codes, code, doc);
  }

  remove(id) {
    const doc = this.docs.get(id);
    if (!doc) return;
    this.docs.delete(id);
    for (const word of new Set(doc.words)) removeFromSetMap(this.vocab, word, doc);
    for (const code of doc.codes) removeFromSetMap(this.codes, code, doc);
  }

  /**
   * Title words that match `token`, with match quality (q) and kind (3 exact … 0 fuzzy).
   * fuzzy: 'never' | 'gated' (only when the word is unknown) | 'always'.
   */
  matchToken(token, { fuzzy }) {
    const matches = new Map();
    const stem = token.length >= 4 && token.endsWith('s') ? token.slice(0, -1) : null;
    let strongDocs = 0;

    for (const [word, docs] of this.vocab) {
      let match = null;
      if (word === token) match = { q: 1, kind: 3 };
      else if (stem && word === stem) match = { q: 0.95, kind: 3 };
      else if (word.startsWith(token)) {
        match = { q: 0.8 + (0.15 * token.length) / word.length, kind: 2 };
      } else if (token.length >= MIN_INFIX_LENGTH && endsCompoundWord(word, token)) {
        match = { q: 0.55, kind: 1 };
      }
      if (match) {
        matches.set(word, match);
        if (match.kind >= 2) strongDocs += docs.size;
      }
    }

    // Typos are only considered when the word itself is (almost) unknown, so a correctly
    // spelled "coke" never pulls in "cake" or "core". A known but rare word ("hienz", a
    // misspelt title) still gets corrections that are far more common in the catalogue.
    const edits = allowedEdits(token.length);
    if (edits === 0 || /\d/.test(token) || fuzzy === 'never') return matches;
    const openFuzzy = fuzzy === 'always' || strongDocs < FUZZY_GATE_DOCS;
    if (!openFuzzy && token.length < MIN_INFIX_LENGTH) return matches;
    for (const [word, docs] of this.vocab) {
      if (matches.has(word) || /\d/.test(word)) continue;
      if (!openFuzzy && docs.size < DOMINANT_TYPO_RATIO * strongDocs) continue;
      const q = fuzzyQuality(token, word, edits);
      if (q > 0) matches.set(word, { q, kind: openFuzzy ? 0 : 1 });
    }
    return matches;
  }

  search(rawQuery, { limit = 20 } = {}) {
    const query = parseQuery(rawQuery);
    if (query.compact.length < 2 && query.code.length < 2) return [];

    let { results, bestTier } = this.rank(query, 'gated');
    // Nothing solid found (e.g. the typo is itself a rare catalogue word): retry with typo
    // tolerance on every word and keep the better score per product.
    if (bestTier < 3 && query.tokens.some((token) => allowedEdits(token.length) > 0)) {
      const retry = this.rank(query, 'always');
      const byDoc = new Map(results.map((result) => [result.doc, result]));
      for (const result of retry.results) {
        const existing = byDoc.get(result.doc);
        if (!existing || result.score > existing.score) byDoc.set(result.doc, result);
      }
      results = [...byDoc.values()];
      bestTier = Math.max(bestTier, retry.bestTier);
    }

    return results
      .filter((result) => result.tier >= 3 || bestTier < 3)
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.doc.title.length - b.doc.title.length ||
          a.doc.title.localeCompare(b.doc.title),
      )
      .slice(0, Math.min(limit, MAX_RANKED_RESULTS))
      .map(({ doc, score }) => ({ id: doc.id, score: Math.round(score * 100) / 100 }));
  }

  rank(query, fuzzy) {
    const interpretations = [];
    if (query.tokens.length) {
      interpretations.push({
        tokens: query.tokens,
        matches: query.tokens.map((token) => this.matchToken(token, { fuzzy })),
      });
    }
    // Spacing-insensitive reading of the query ("co ke" -> "coke").
    if (query.tokens.length > 1) {
      interpretations.push({
        tokens: [query.compact],
        matches: [this.matchToken(query.compact, { fuzzy: 'never' })],
      });
    }

    const candidates = new Set();
    for (const { matches } of interpretations) {
      for (const tokenMatches of matches) {
        for (const word of tokenMatches.keys()) {
          for (const doc of this.vocab.get(word)) candidates.add(doc);
        }
      }
    }

    const exactCodeDocs = new Set();
    // Short numbers ("500") are sizes, not barcodes.
    for (const variant of query.code.length >= 5 ? codeVariants(query.code) : []) {
      for (const doc of this.codes.get(variant) ?? []) {
        exactCodeDocs.add(doc);
        candidates.add(doc);
      }
    }

    const partialCode = /^\d{6,}$/.test(query.code);
    if (query.compact.length >= 2 || partialCode) {
      for (const doc of this.docs.values()) {
        if (query.compact.length >= 2 && doc.compact.includes(query.compact)) candidates.add(doc);
        else if (partialCode && doc.codes.some((code) => code.includes(query.code))) candidates.add(doc);
      }
    }

    const results = [];
    let bestTier = -1;
    for (const doc of candidates) {
      const result = scoreDoc(doc, query, interpretations, exactCodeDocs.has(doc), partialCode);
      if (!result) continue;
      results.push(result);
      if (result.tier > bestTier) bestTier = result.tier;
    }
    return { results, bestTier };
  }
}

function evaluateTokens(doc, tokens, tokenMatches) {
  let weightSum = 0;
  let qualitySum = 0;
  let minKind = 3;
  let unmatched = 0;
  let firstWordHit = false;
  let anchored = tokens.length === 1;
  const positions = [];

  tokens.forEach((token, i) => {
    const weight = Math.min(token.length, 8);
    weightSum += weight;
    let best = null;
    doc.words.forEach((word, position) => {
      const match = tokenMatches[i].get(word);
      if (match && (!best || match.q > best.q)) best = { ...match, pos: position };
    });
    if (token.length >= 3 && (!best || best.kind < 3)) {
      const compact = compactMatch(doc, token);
      if (compact && (!best || compact.q > best.q)) best = compact;
    }
    if (!best) {
      unmatched++;
      return;
    }
    qualitySum += best.q * weight;
    minKind = Math.min(minKind, best.kind);
    if (token.length >= 3) anchored = true;
    positions.push(best.pos);
    if (i === 0 && best.pos === 0) firstWordHit = true;
  });

  if (unmatched > Math.floor(tokens.length / 3)) return null;
  const quality = qualitySum / weightSum;
  if (unmatched > 0 && quality < MIN_PARTIAL_QUALITY) return null;

  let tier = unmatched > 0 ? 0 : [1, 3, 4, 5][minKind];
  // Only 1-2 letter fragments matched, not all as whole words ("co ke" -> "CO-OP KETCHUP"): weak.
  if (!anchored && minKind < 3) tier = Math.min(tier, 2);
  const inOrder = positions.length > 1 && positions.every((p, i) => i === 0 || p > positions[i - 1]);
  const specificity = doc.words.length ? Math.min(1, positions.length / doc.words.length) : 0;
  const bonus = (firstWordHit ? 10 : 0) + (inOrder ? 6 : 0) + 15 * specificity;
  return { tier, quality, bonus };
}

function phraseTier(doc, query) {
  if (!query.compact || !doc.compact) return -1;
  if (doc.norm === query.norm || doc.compact === query.compact) return 8;
  // Whole-word starts ("tea" -> "TEA BUN") outrank mid-word starts ("tea" -> "TEASE").
  if (doc.norm.startsWith(`${query.norm} `)) return 7;
  const length = query.compact.length;
  if (doc.compact.startsWith(query.compact) && compactPrefixAllowed(doc, length)) {
    return length === wordEnd(doc, wordIndexAt(doc, length - 1)) ? 7 : 6.5;
  }
  return doc.norm.startsWith(query.norm) ? 6.5 : -1;
}

function scoreDoc(doc, query, interpretations, exactCode, partialCode) {
  let best = null;
  for (const { tokens, matches } of interpretations) {
    const evaluation = evaluateTokens(doc, tokens, matches);
    if (
      evaluation &&
      (!best || evaluation.tier > best.tier || (evaluation.tier === best.tier && evaluation.quality > best.quality))
    ) {
      best = evaluation;
    }
  }

  let tier = best ? best.tier : -1;
  tier = Math.max(tier, phraseTier(doc, query));
  if (exactCode) tier = 10;
  else if (partialCode) {
    if (doc.codes.some((code) => code.startsWith(query.code))) tier = Math.max(tier, 6);
    else if (doc.codes.some((code) => code.includes(query.code))) tier = Math.max(tier, 2);
  }
  if (tier < 0) return null;

  const quality = best ? best.quality : 0.5;
  return { doc, tier, score: tier * 100 + quality * 50 + (best ? best.bonus : 0) };
}

/* ---------------------------------------------------------------------------------------
 * Shared catalogue index (loaded once, refreshed in the background, patched on writes).
 * ------------------------------------------------------------------------------------- */

const prisma = new PrismaClient();
const INDEX_TTL_MS = 30 * 60 * 1000;
const FALLBACK_CANDIDATE_LIMIT = 3000;
const INDEX_SELECT = { id: true, title: true, barcode: true, caseBarcode: true };

let activeIndex = null;
let builtAt = 0;
let buildPromise = null;
let pendingOps = null;

function rebuildIndex() {
  if (buildPromise) return buildPromise;
  pendingOps = [];
  const startedAt = Date.now();
  buildPromise = prisma.product
    .findMany({ select: INDEX_SELECT })
    .then((rows) => {
      const next = new ProductSearchIndex(rows);
      // Replay writes that happened while the snapshot was loading.
      for (const op of pendingOps) op(next);
      activeIndex = next;
      builtAt = Date.now();
      console.log(`[productSearch] indexed ${next.size} products in ${builtAt - startedAt}ms`);
    })
    .catch((error) => console.error('[productSearch] index build failed:', error.message))
    .finally(() => {
      buildPromise = null;
      pendingOps = null;
    });
  return buildPromise;
}

export function warmProductSearchIndex() {
  return rebuildIndex();
}

// Used only until the first full index is ready: a broad DB pre-filter ranked by the same engine.
async function loadFallbackCandidates(rawQuery) {
  const query = parseQuery(rawQuery);
  const or = [];
  const prefixes = query.tokens.filter((t) => t.length >= 2).map((t) => t.slice(0, 3));
  if (prefixes.length) {
    or.push({ AND: prefixes.map((p) => ({ title: { contains: p, mode: 'insensitive' } })) });
  }
  if (query.tokens.length > 1 && query.compact.length >= 2) {
    or.push({ title: { contains: query.compact.slice(0, 3), mode: 'insensitive' } });
  }
  if (query.code.length >= 4) {
    or.push(
      { barcode: { contains: query.code, mode: 'insensitive' } },
      { caseBarcode: { contains: query.code, mode: 'insensitive' } },
    );
  }
  if (!or.length) return [];
  return prisma.product.findMany({ where: { OR: or }, select: INDEX_SELECT, take: FALLBACK_CANDIDATE_LIMIT });
}

/**
 * Ranked product ids for a free-text / barcode query, best match first.
 * @returns {Promise<Array<{ id: string, score: number }>>}
 */
export async function searchProductIds(rawQuery, { limit = 20 } = {}) {
  if (!rawQuery || typeof rawQuery !== 'string') return [];
  if (activeIndex) {
    if (Date.now() - builtAt > INDEX_TTL_MS) rebuildIndex();
    return activeIndex.search(rawQuery, { limit });
  }
  rebuildIndex();
  const rows = await loadFallbackCandidates(rawQuery);
  return new ProductSearchIndex(rows).search(rawQuery, { limit });
}

export const MAX_SEARCH_RESULTS = MAX_RANKED_RESULTS;

/** Re-orders rows to follow `rankedIds`, dropping rows that are not ranked. */
export function orderByRank(rows, rankedIds, getId = (row) => row.id) {
  const byId = new Map(rows.map((row) => [getId(row), row]));
  return rankedIds.map((id) => byId.get(id)).filter(Boolean);
}

function applyToIndexes(op) {
  if (activeIndex) op(activeIndex);
  if (pendingOps) pendingOps.push(op);
}

/** Adds/updates a product in the search index (row needs id, title, barcode, caseBarcode). */
export function indexProduct(row) {
  if (!row?.id) return;
  const snapshot = { id: row.id, title: row.title, barcode: row.barcode, caseBarcode: row.caseBarcode };
  applyToIndexes((index) => index.upsert(snapshot));
}

export function removeIndexedProduct(id) {
  if (!id) return;
  applyToIndexes((index) => index.remove(id));
}

/** Re-reads a product from the DB into the index; never throws. */
export async function refreshIndexedProduct(id) {
  if (!id) return;
  try {
    const row = await prisma.product.findUnique({ where: { id }, select: INDEX_SELECT });
    if (row) indexProduct(row);
    else removeIndexedProduct(id);
  } catch (error) {
    console.error('[productSearch] failed to refresh product in index:', error.message);
  }
}
