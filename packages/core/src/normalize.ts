/**
 * Name normalisation for entity resolution and search. Produces a lowercase ASCII key
 * without punctuation so that "Zürich HB", "Zurich Hb" and "ZURICH-HB" share a key.
 * Normalised keys are used for *matching candidates*; whether two records are the same
 * physical stop is decided by geography (see ingest/entity-resolution).
 */

const REPLACEMENTS: Array<[RegExp, string]> = [
  [/ß/g, 'ss'],
  [/æ/g, 'ae'],
  [/ø/g, 'o'],
  [/œ/g, 'oe'],
  [/ł/g, 'l'],
  [/đ/g, 'd'],
];

/** Common station words, expanded to one canonical token. */
const TOKEN_SYNONYMS: Record<string, string> = {
  hbf: 'hauptbahnhof',
  hb: 'hauptbahnhof',
  bf: 'bahnhof',
  stazione: 'station',
  gare: 'station',
  estacion: 'station',
  stn: 'station',
  st: 'saint',
  ste: 'sainte',
  'st.': 'saint',
  zob: 'busbahnhof',
  autostazione: 'busstation',
  autobusni: 'bus',
  bus: 'bus',
  busbf: 'busbahnhof',
};

export function stripDiacritics(value: string): string {
  let v = value.toLowerCase();
  for (const [re, rep] of REPLACEMENTS) v = v.replace(re, rep);
  return v.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function normalizeName(value: string): string {
  const base = stripDiacritics(value)
    .replace(/[’'`´]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!base) return '';
  return base
    .split(/\s+/)
    .map((t) => TOKEN_SYNONYMS[t] ?? t)
    .join(' ');
}

/** Generic station vocabulary that says nothing about *which* place a name refers to. */
const GENERIC_TOKENS = new Set([
  'bus', 'busstation', 'busbahnhof', 'bahnhof', 'hauptbahnhof', 'station', 'terminal', 'stop', 'central', 'centrale',
  'centre', 'center', 'zentrum', 'centro', 'fs', 'sncf', 'db', 'sbb', 'cff', 'ffs', 'the', 'de', 'di', 'la', 'le', 'am', 'im',
]);

function tokens(v: string): Set<string> {
  const all = normalizeName(v).split(' ').filter(Boolean);
  const specific = all.filter((t) => !GENERIC_TOKENS.has(t));
  return new Set(specific.length ? specific : all);
}

/** Token-set similarity in [0, 1] (Jaccard on distinctive tokens, with prefix credit: Milan ~ Milano). */
export function nameSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) {
    if (tb.has(t)) inter += 1;
    else if ([...tb].some((u) => (u.length >= 4 && t.startsWith(u)) || (t.length >= 4 && u.startsWith(t))))
      inter += 0.5;
  }
  return inter / (ta.size + tb.size - inter);
}

/** Extracts the likely city part of operator stop names like "Milan (Lampugnano)" or "Zurich, Sihlquai". */
export function cityPartOfStopName(name: string): string {
  const cut = name.split(/[(,/–—]| - /)[0] ?? name;
  return cut.trim();
}
