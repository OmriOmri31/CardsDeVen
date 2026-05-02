import { STANDUP_COMEDIAN_PHRASES_SORTED } from './standupComedianPhrases.generated.js';

/** Lowercase, strip nikud, collapse spaces — aligned with build script. */
function stripNikkud(s) {
  return s.replace(/[\u0591-\u05C7\u05BF\u05C0\u05C4\u05C5\u05C6]/g, '');
}

export function normalizeStandupMatchText(s) {
  return stripNikkud(String(s || ''))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const STANDUP_QUERY_SYNONYMS_LOWER = new Set(
  [
    'סטנדאפ', 'סטנד אפ', 'סטאנדאפ', 'סטנד', 'standup', 'stand-up', 'stand up', 'comedy', 'קומדיה',
    'מופע סטנדאפ', 'מופע קומדיה', 'בידור',
  ].map((x) => x.toLowerCase()),
);

export function dealBlobMentionsStandupComedian(deal) {
  const blob = normalizeStandupMatchText(`${deal.m} ${deal.d} ${deal.genre || ''}`);
  if (!blob) return false;
  for (const p of STANDUP_COMEDIAN_PHRASES_SORTED) {
    if (!p || p.length < 3) continue;
    if (blob.includes(p)) return true;
  }
  return false;
}

export function clubSearchTermsIncludeStandupTopic(terms) {
  return terms.some((t) => STANDUP_QUERY_SYNONYMS_LOWER.has(String(t).toLowerCase()));
}

export function queryMentionsStandupTopic(queryNorm, tokens, expanded) {
  for (const kw of STANDUP_QUERY_SYNONYMS_LOWER) {
    if (queryNorm.includes(kw)) return true;
    if (tokens.some((t) => t.length >= 2 && (kw.includes(t) || t.includes(kw)))) return true;
  }
  if (expanded.some((e) => STANDUP_QUERY_SYNONYMS_LOWER.has(String(e).toLowerCase()))) return true;
  return false;
}

/** Music / concert intent without explicit stand-up wording — downrank comedian-tagged deals in retrieval. */
export function queryMentionsMusicConcertIntent(combined) {
  const c = String(combined || '');
  if (/(סטנדאפ|סטנד|קומדיה|stand\s*-?\s*up|comedy)/i.test(c)) return false;
  return /(זמר|זמרת|זמרים|מוזיק|להקה|concert|singer|band\b|הופעה|כרטיסים\s+ל|סיבוב\s+הופעות)/i.test(c);
}

export function scoreDealForChatRetrieval(deal, tokens, expanded, queryNorm, combined, baseScore) {
  let s = baseScore;
  const standupQ = queryMentionsStandupTopic(queryNorm, tokens, expanded);
  const musicQ = queryMentionsMusicConcertIntent(combined);
  const comicHit = dealBlobMentionsStandupComedian(deal);
  if (standupQ && comicHit) s += 28;
  if (musicQ && comicHit) s = Math.max(0, s - 45);
  return s;
}
