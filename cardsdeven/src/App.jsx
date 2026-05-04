import React, { useState, useMemo, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import {
  getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, onAuthStateChanged, signInAnonymously
} from 'firebase/auth';
import { getFirestore, collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc, setDoc, deleteField } from 'firebase/firestore';
import {
  clubSearchTermsIncludeStandupTopic,
  dealBlobMentionsStandupComedian,
  scoreDealForChatRetrieval,
} from './standupComedians';
import {
  CreditCard, LayoutDashboard, Receipt, Plus, Trash2, AlertCircle,
  CalendarDays, RefreshCw, Infinity as InfinityIcon, CheckCircle2,
  Edit2, Moon, Sun, PieChart, LogOut, Lock, Mail,
  Loader2, X, Search, ShieldAlert, Zap, Clock, CheckSquare, Square, Gift, Bot, Send, Info
} from 'lucide-react';

/** Default web app config (Firebase console → Project settings). Override with VITE_FIREBASE_* in .env for other envs. */
const DEFAULT_FIREBASE_WEB_CONFIG = {
  apiKey: 'AIzaSyBjn2oGHj-bT_O213csvNPLoEliTdWbS4M',
  authDomain: 'cardsdeven.firebaseapp.com',
  projectId: 'cardsdeven',
  storageBucket: 'cardsdeven.firebasestorage.app',
  messagingSenderId: '226004826296',
  appId: '1:226004826296:web:b1b173216ea6578ed29c4d',
};

/** Firebase web SDK: __firebase_config (hosted) → VITE_* from .env → defaults above. */
function resolveFirebaseConfig() {
  if (typeof __firebase_config !== 'undefined') {
    return JSON.parse(__firebase_config);
  }
  const fromEnv = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  };
  const envComplete = Object.values(fromEnv).every((v) => v && String(v).trim() !== '');
  if (envComplete) return fromEnv;
  return DEFAULT_FIREBASE_WEB_CONFIG;
}

const GRADIENTS = [
  'bg-gradient-to-br from-slate-700 to-slate-900',
];

// --- DOMAIN KNOWLEDGE: CATEGORIES & ICONS ---
const CATEGORY_ICONS = {
  "Supermarkets & Groceries": "🛒", "Fashion & Apparel": "👗", "Home & Household": "🛋️",
  "Hotels & Lodging": "🏨", "Spas & Wellness": "💆", "Electronics": "💻", "Cinemas": "🍿",
  "Food Chains & Restaurants": "🍔", "Online Retail & Delivery": "📦", "Pharmacy & Health": "💊",
  "Fuel & Transportation": "⛽", "Fitness & Gym": "🏋️", "Kids & Baby": "🧸", "Other": "🏷️"
};
const CATEGORIES = Object.keys(CATEGORY_ICONS);

// --- DOMAIN KNOWLEDGE: CATEGORY SEARCH ALIASES ---
const CATEGORY_ALIASES = {
  "Supermarkets & Groceries": ["supermarket", "grocery", "groceries", "סופר", "סופרמרקט", "מכולת", "מזון"],
  "Fashion & Apparel": ["fashion", "apparel", "clothing", "clothes", "shoes", "אופנה", "בגדים", "בגדי", "הנעלה", "נעליים", "לבוש"],
  "Home & Household": ["home", "household", "furniture", "kitchen", "בית", "ריהוט", "לבית", "עיצוב הבית", "מטבח", "כלי בית"],
  "Hotels & Lodging": ["hotel", "lodging", "vacation", "resort", "מלון", "מלונות", "נופש", "לינה", "חופשה"],
  "Spas & Wellness": ["spa", "wellness", "massage", "ספא", "עיסוי", "טיפולים"],
  "Electronics": ["electronics", "computers", "mobile", "phone", "חשמל", "אלקטרוניקה", "מחשבים", "מוצרי חשמל", "סלולר", "טלפון"],
  "Cinemas": ["cinema", "movie", "movies", "film", "קולנוע", "סרט", "סרטים", "סינמה"],
  "Food Chains & Restaurants": ["food", "restaurant", "dining", "cafe", "burger", "pizza", "אוכל", "מסעדה", "מסעדות", "בית קפה", "בתי קפה", "פיצה", "המבורגר", "סושי"],
  "Online Retail & Delivery": ["online", "delivery", "ecommerce", "אונליין", "משלוח", "משלוחים", "אינטרנט", "קניות ברשת"],
  "Pharmacy & Health": ["pharmacy", "health", "makeup", "פארם", "בית מרקחת", "בריאות", "תרופות", "איפור", "קוסמטיקה", "פארמה"],
  "Fuel & Transportation": ["fuel", "gas", "transportation", "דלק", "תחבורה", "תחנת דלק"],
  "Fitness & Gym": ["fitness", "gym", "workout", "כושר", "חדר כושר", "ספורט", "אימון", "מנוי"],
  "Kids & Baby": ["kids", "baby", "toys", "ילדים", "תינוקות", "צעצועים", "משחקים"],
  "Other": ["other", "אחר", "שונות", "ספרים"]
};

/** Synonym groups for club search + AI retrieval (e.g. standup vs performer-only titles). */
const CLUB_SEARCH_TOPIC_GROUPS = [
  ['סטנדאפ', 'סטנד אפ', 'סטאנדאפ', 'סטנד', 'standup', 'stand-up', 'stand up', 'comedy', 'קומדיה', 'מופע סטנדאפ', 'מופע קומדיה', 'בידור'],
];

function expandClubSearchQueryTerms(raw) {
  const qs = String(raw || '').toLowerCase().trim();
  const terms = new Set();
  if (qs.length) terms.add(qs);
  for (const group of CLUB_SEARCH_TOPIC_GROUPS) {
    const hit = group.some((t) => {
      const tl = t.toLowerCase();
      if (!tl) return false;
      if (qs.includes(tl) || tl.includes(qs)) return true;
      return qs.split(/[^\p{L}\p{N}]+/u).some((w) => w.length >= 2 && (tl.includes(w) || w.includes(tl)));
    });
    if (hit) group.forEach((t) => { if (t.length >= 1) terms.add(t.toLowerCase()); });
  }
  return [...terms];
}

function expandTokensFromTopicGroups(queryNorm, tokens) {
  const extra = new Set();
  for (const group of CLUB_SEARCH_TOPIC_GROUPS) {
    const hit = group.some((t) => {
      const tl = t.toLowerCase();
      return queryNorm.includes(tl) || tokens.some((w) => w.length >= 2 && (tl.includes(w) || w.includes(tl)));
    });
    if (hit) group.forEach((t) => { if (t.length >= 1) extra.add(t.toLowerCase()); });
  }
  return [...extra];
}

// --- DOMAIN KNOWLEDGE: ISRAELI BENEFIT PROGRAMS ---
const PROGRAMS = {
  HG: { id: 'HG', name: 'HappyGift Global', type: 'open_loop', color: 'bg-gradient-to-br from-pink-500 to-rose-600', description: 'Mastercard. Works almost everywhere.' },
  FTR: { id: 'FTR', name: 'Fighter (Miluim)', type: 'mcc', color: 'bg-gradient-to-br from-stone-700 to-stone-900', description: 'MCC Restricted. Restaurants, Leisure, Fashion.' },
  FTR_VAC: { id: 'FTR_VAC', name: 'Fighter Vacation', type: 'mcc', color: 'bg-gradient-to-br from-cyan-600 to-blue-700', description: 'Lodging only.' },
  CB: { id: 'CB', name: 'Cibus', type: 'network', color: 'bg-gradient-to-br from-orange-400 to-orange-500', description: 'Food network & specific grocers.' },
  BM: { id: 'BM', name: 'BUYME / BuyMeAll', type: 'network', color: 'bg-gradient-to-br from-blue-400 to-blue-600', description: 'Redeemed in BUYME app.' },
  GT: { id: 'GT', name: 'Global Tov Plus', type: 'network', color: 'bg-gradient-to-br from-purple-500 to-indigo-600', description: 'Raayonit network voucher.' },
  TH: { id: 'TH', name: 'Tav Hazahav', type: 'network', color: 'bg-gradient-to-br from-yellow-500 to-amber-600', description: 'Shufersal and partners.' },
  TP: { id: 'TP', name: 'Tav Plus', type: 'network', color: 'bg-gradient-to-br from-emerald-400 to-emerald-600', description: 'Carrefour & partners.' },
  DC: { id: 'DC', name: 'Dream Card', type: 'network', color: 'bg-gradient-to-br from-slate-800 to-black', description: 'Fox Group brands only.' },
  FLEX: { id: 'FLEX', name: 'FlexBenefits', type: 'open_loop', color: 'bg-gradient-to-br from-indigo-500 to-purple-600', description: 'Visa. Conditional on employer.' },
  CUSTOM: { id: 'CUSTOM', name: 'Custom / Standard Card', type: 'custom', color: 'bg-gradient-to-br from-slate-400 to-slate-600', description: 'Manually pick categories.' }
};

/** Credit-card plastic gradient per program (Cibus = salmon pink). */
const WALLET_CARD_CHROME = {
  HG: 'linear-gradient(135deg, #db2777 0%, #9f1239 100%)',
  FTR: 'linear-gradient(135deg, #57534e 0%, #1c1917 100%)',
  FTR_VAC: 'linear-gradient(135deg, #0891b2 0%, #1d4ed8 100%)',
  CB: 'linear-gradient(135deg, #fa8072 0%, #e11d48 95%)',
  BM: 'linear-gradient(135deg, #60a5fa 0%, #1d4ed8 100%)',
  GT: 'linear-gradient(135deg, #a855f7 0%, #4338ca 100%)',
  TH: 'linear-gradient(135deg, #eab308 0%, #ca8a04 100%)',
  TP: 'linear-gradient(135deg, #4ade80 0%, #059669 100%)',
  DC: 'linear-gradient(135deg, #1e293b 0%, #020617 100%)',
  FLEX: 'linear-gradient(135deg, #6366f1 0%, #6d28d9 100%)',
  CUSTOM: 'linear-gradient(135deg, #94a3b8 0%, #475569 100%)',
};

function hexToRgb(hex) {
  const h = String(hex || '').trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Builds a darkened gradient for wallet plastic from a single #RRGGBB color. */
function buildPlasticGradientFromHex(hex) {
  const raw = String(hex || '').trim();
  const normalized = raw.startsWith('#') ? raw : (raw ? `#${raw}` : '');
  const rgb = hexToRgb(normalized);
  if (!rgb) return null;
  const { r, g, b } = rgb;
  const r2 = Math.round(r * 0.52);
  const g2 = Math.round(g * 0.52);
  const b2 = Math.round(b * 0.52);
  return `linear-gradient(135deg, ${normalized} 0%, rgb(${r2},${g2},${b2}) 100%)`;
}

const CLUBS = {
  BEHATSDAA: { id: 'BEHATSDAA', name: 'בהצדעה', color: 'bg-blue-600' },
  PAIS_PLUS: { id: 'PAIS_PLUS', name: 'פיס פלוס', color: 'bg-red-500' },
  DREAMCARD: { id: 'DREAMCARD', name: 'DreamCard', color: 'bg-slate-900' }
};

/** Fallback בהצדעה rows when /data.json is missing or empty; scraped deals replace these when present. */
const STATIC_BEHATSDAA_FALLBACK = [
  { m: "Domino's Pizza (דומינוס פיצה)", c: "BEHATSDAA", d: "משפחתית באיסוף מ-39 ₪, שובר 100 ב-65 ₪, ארוחות מ-65 ₪" },
  { m: "Pizza Hut (פיצה האט)", c: "BEHATSDAA", d: "אישית מ-20 ₪, משפחתית מ-54 ₪, 2 משפחתיות מ-89 ₪" },
  { m: "Papa John's (פאפא ג'ונס)", c: "BEHATSDAA", d: "מגשי פיצה החל מ-38 ₪" },
  { m: "Pizza Shemesh (פיצה שמש)", c: "BEHATSDAA", d: "מגשי פיצה החל מ-39 ₪" },
  { m: "Cinema City (סינמה סיטי)", c: "BEHATSDAA", d: "כרטיס סרט החל מ-33 ₪" },
  { m: "Planet (פלאנט)", c: "BEHATSDAA", d: "כרטיס סרט החל מ-30 ₪" },
  { m: "HOT Cinema (הוט סינמה)", c: "BEHATSDAA", d: "כרטיס סרט החל מ-32 ₪" },
  { m: "Movieland (מובילנד)", c: "BEHATSDAA", d: "כרטיס סרט החל מ-28 ₪" },
  { m: "Mishloha (משלוחה)", c: "BEHATSDAA", d: "שובר 100 ₪ לניצול באפליקציה ב-70 ₪" },
  { m: "FOX (פוקס)", c: "BEHATSDAA", d: "שובר קנייה 150 ₪ ב-100 ₪" },
  { m: "FOX Home (פוקס הום)", c: "BEHATSDAA", d: "שובר קנייה 150 ₪ ב-100 ₪" },
  { m: "Mega Sport (מגה ספורט)", c: "BEHATSDAA", d: "שובר קנייה 150 ₪ ב-100 ₪" },
  { m: "Aluf Sport (אלוף ספורט)", c: "BEHATSDAA", d: "שובר קנייה 150 ₪ ב-100 ₪" },
  { m: "Holmes Place (הולמס פלייס)", c: "BEHATSDAA", d: "כרטיסיית 10 כניסות מ-432 ₪ / מנוי חצי שנתי מ-1,012 ₪" },
];

const STATIC_DREAMCARD_FALLBACK = [
  { m: "American Eagle (אמריקן איגל)", c: "DREAMCARD", d: "פריט שני ב-50% הנחה" },
  { m: "FOX Home (פוקס הום)", c: "DREAMCARD", d: "25% הנחה על כל החנות" },
  { m: "Laline (ללין)", c: "DREAMCARD", d: "מבצע 3+3 מתנה" },
  { m: "Terminal X (טרמינל איקס)", c: "DREAMCARD", d: "20% הנחה על סניקרס (קוד TXAPR20)" },
  { m: "Billabong (בילבונג)", c: "DREAMCARD", d: "40% הנחה (קוד BILLAAPR40)" },
  { m: "Jumbo (ג'מבו)", c: "DREAMCARD", d: "15% הנחה על צעצועים" },
  { m: "FOX (פוקס)", c: "DREAMCARD", d: "15% קאשבק, מתנת הצטרפות 200 ש\"ח, 30% יומולדת" },
  { m: "Mango (מנגו)", c: "DREAMCARD", d: "15% קאשבק, מתנת הצטרפות 200 ש\"ח, 30% יומולדת" },
  { m: "Quiksilver (קווילסילבר)", c: "DREAMCARD", d: "40% הנחה (קוד BILLAAPR40)" },
  { m: "Ruby Bay (רובי ביי)", c: "DREAMCARD", d: "30% הנחה (קוד RUBYAPR30)" },
  { m: "Aerie (אירי)", c: "DREAMCARD", d: "פריט שני ב-50% הנחה" },
  { m: "The Children's Place (דה צ'ילדרנס פלייס)", c: "DREAMCARD", d: "פריט שני ב-50% הנחה (קוד TCPAPR40)" },
  { m: "Shilav (שילב)", c: "DREAMCARD", d: "15% קאשבק וצבירה" },
  { m: "Flying Tiger (פליינג טייגר)", c: "DREAMCARD", d: "2+3 מתנה בחנויות" },
  { m: "Foot Locker (פוט לוקר)", c: "DREAMCARD", d: "צבירת קאשבק VIP" },
  { m: "Sunglass Hut (סאנגלס האט)", c: "DREAMCARD", d: "10% הנחה נוספת על מבצעי החנות" }
];

/** Nested shape from scraper `data` field: category → venue → show → [{ title, price, address, url? }]. */
function flattenBehatsdaaDealsFromNested(nested) {
  if (!nested || typeof nested !== 'object') return [];
  const out = [];
  let seq = 0;
  for (const category of Object.keys(nested)) {
    const venues = nested[category];
    if (!venues || typeof venues !== 'object') continue;
    for (const venue of Object.keys(venues)) {
      const shows = venues[venue];
      if (!shows || typeof shows !== 'object') continue;
      for (const showName of Object.keys(shows)) {
        const deals = shows[showName];
        if (!Array.isArray(deals)) continue;
        for (const deal of deals) {
          const title = deal?.title != null ? String(deal.title) : '';
          const price = deal?.price != null ? String(deal.price) : '';
          const url = typeof deal?.url === 'string' ? deal.url.trim() : '';
          const base = `${title} (${price})`.replace(/\s+/g, ' ').trim();
          const sn = String(showName || '').trim();
          let d = base;
          if (sn && sn !== 'כללי' && !(title || '').toLowerCase().includes(sn.toLowerCase())) {
            d = base ? `${sn}: ${base}` : sn;
          }
          out.push({
            m: venue,
            c: 'BEHATSDAA',
            d: d || title || price || 'Deal',
            ...(url ? { url } : {}),
            _bhKey: `bh-${seq++}`,
          });
        }
      }
    }
  }
  return out;
}

function DealLink({ url, className, children }) {
  const u = typeof url === 'string' ? url.trim() : '';
  if (u && /^https?:\/\//i.test(u)) {
    return (
      <a href={u} target="_blank" rel="noopener noreferrer" className={className}>
        {children}
      </a>
    );
  }
  return <span className={className}>{children}</span>;
}

function normalizeDealMatchText(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokenizeForDealSearch(text) {
  const n = normalizeDealMatchText(text);
  return [...new Set(n.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2))];
}

function expandTokensFromCategoryAliases(queryNorm, tokens) {
  const extra = new Set();
  for (const aliases of Object.values(CATEGORY_ALIASES)) {
    const hit = aliases.some((a) => {
      const al = a.toLowerCase();
      return queryNorm.includes(al) || tokens.some((t) => al.includes(t) || t.includes(al));
    });
    if (hit) aliases.forEach((a) => { if (a.length >= 2) extra.add(a.toLowerCase()); });
  }
  return [...extra];
}

function formatDealLineForChat(d) {
  const u = (d.url || d.product_url || '').trim();
  const m = String(d.m).replace(/\s+/g, ' ').trim();
  const desc = String(d.d).replace(/\s+/g, ' ').trim();
  return u ? `${d.c} | ${m} | ${desc} | ${u}` : `${d.c} | ${m} | ${desc}`;
}

function dealKeyForDedup(d) {
  return `${d.c}\0${d.m}\0${d.d}\0${d.product_id || ''}\0${d._bhKey || ''}`;
}

function uniqueDealsByKey(list) {
  const seen = new Set();
  const out = [];
  for (const d of list) {
    const k = dealKeyForDedup(d);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(d);
  }
  return out;
}

function scoreDealAgainstTokens(deal, tokens, expandedTokens) {
  const blob = normalizeDealMatchText(`${deal.m} ${deal.d} ${deal.genre || ''}`);
  let score = 0;
  for (const t of tokens) {
    if (t.length < 2) continue;
    if (blob.includes(t)) score += Math.min(16, 5 + t.length);
  }
  for (const t of expandedTokens) {
    if (tokens.includes(t)) continue;
    if (t.length < 2) continue;
    if (blob.includes(t)) score += 4;
  }
  return score;
}

function stratifiedDealSample(rows, userClubs, capPerClub) {
  const buckets = {};
  userClubs.forEach((c) => { buckets[c] = []; });
  for (const d of rows) {
    if (buckets[d.c]) buckets[d.c].push(d);
  }
  const out = [];
  const taken = {};
  userClubs.forEach((c) => { taken[c] = 0; });
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const c of userClubs) {
      if (taken[c] >= capPerClub) continue;
      const b = buckets[c];
      if (taken[c] < b.length) {
        out.push(b[taken[c]]);
        taken[c] += 1;
        progressed = true;
      }
    }
  }
  return out;
}

const BROAD_DEAL_QUERY_RE = /(מה\s+יש|כל\s+(ה)?מבצע|הכל|מבצעים|רשימה|סיכום|what\s+deals|all\s+(my\s+)?deals|show\s+me(\s+everything)?|everything|any\s+deals)/i;

/**
 * Lexical retrieval over in-memory discounts (same JSON as the UI). Small prompt chunk per turn.
 */
function retrieveRelevantDealsForChat(discountsData, userClubs, userText, priorUserTexts, maxBlockChars = 18000) {
  const clubSet = new Set(userClubs);
  const pool = discountsData.filter((d) => clubSet.has(d.c));

  if (pool.length === 0) {
    return 'RETRIEVED_DEALS: No deals loaded for the user\'s active clubs. Suggest they enable clubs or refresh data.';
  }

  const combined = [...(priorUserTexts || []), userText].filter(Boolean).join(' ');
  const queryNorm = normalizeDealMatchText(combined);
  const tokens = tokenizeForDealSearch(combined);
  const expanded = [...new Set([...expandTokensFromCategoryAliases(queryNorm, tokens), ...expandTokensFromTopicGroups(queryNorm, tokens)])];

  const isBroad = tokens.length === 0
    || BROAD_DEAL_QUERY_RE.test(combined)
    || (tokens.length <= 2 && combined.length < 48 && /מבצע|deal|discount|הנחה/i.test(combined));

  let picked = [];
  let mode = 'retrieval';

  if (isBroad) {
    mode = 'broad_sample';
    picked = stratifiedDealSample(pool, userClubs, 20);
  } else {
    const scored = pool
      .map((d) => ({
        d,
        s: scoreDealForChatRetrieval(d, tokens, expanded, queryNorm, combined, scoreDealAgainstTokens(d, tokens, expanded)),
      }))
      .sort((a, b) => b.s - a.s);
    const minScore = 5;
    picked = scored.filter((x) => x.s >= minScore).slice(0, 72).map((x) => x.d);
    if (picked.length < 14) {
      picked = scored.filter((x) => x.s > 0).slice(0, 48).map((x) => x.d);
    }
    if (picked.length < 10) {
      const have = new Set(picked.map(dealKeyForDedup));
      const filler = stratifiedDealSample(
        pool.filter((d) => !have.has(dealKeyForDedup(d))),
        userClubs,
        8,
      );
      picked = [...picked, ...filler];
    }
  }

  picked = uniqueDealsByKey(picked);
  const lines = picked.map(formatDealLineForChat);
  let body = lines.join('\n');
  const header = mode === 'broad_sample'
    ? `RETRIEVED_DEALS (broad question—stratified sample across clubs; NOT the full catalog—the Clubs tab lists everything):`
    : `RETRIEVED_DEALS_FOR_THIS_QUESTION (use only these lines for concrete club deal facts; include URLs when recommending a specific sale):`;
  let block = `${header}\n${body}`;
  if (block.length > maxBlockChars) {
    block = `${block.slice(0, maxBlockChars)}\n...[retrieval block trimmed for length]`;
  }
  return block;
}

/** Pais+ and other deals often use titles that are not exact KNOWN_MERCHANTS keys. */
function dealMatchesInsightMerchant(deal, searchMatch, rawQuery) {
  if (deal.m === searchMatch) return true;
  const blob = `${deal.m} ${deal.d}`.toLowerCase();
  const n = searchMatch.toLowerCase();
  if (n.length >= 2 && blob.includes(n)) return true;
  const short = searchMatch.split('(')[0].trim().toLowerCase();
  if (short.length >= 2 && blob.includes(short)) return true;
  const q = (rawQuery || '').trim().toLowerCase();
  if (q.length >= 2 && blob.includes(q)) return true;
  return false;
}

const KNOWN_MERCHANTS = {
  "Zara (זארה)": { cat: "Fashion & Apparel", networks: ['TH', 'TP'], aliases: ["zara", "זארה"], logo: "zara.png" },
  "Pull and Bear (פול אנד בר)": { cat: "Fashion & Apparel", networks: ['TH', 'TP'], aliases: ["pull", "bear", "פול", "בר"], logo: "pull_and_bear.png" },
  "Bershka (ברשקה)": { cat: "Fashion & Apparel", networks: ['TH', 'TP'], aliases: ["bershka", "ברשקה"] },
  "Renuar (רנואר)": { cat: "Fashion & Apparel", networks: ['TH', 'TP', 'GT', 'BM'], aliases: ["renuar", "רנואר"] },
  "Terminal X (טרמינל איקס)": { cat: "Fashion & Apparel", networks: ['DC'], aliases: ["terminal x", "טרמינל"] },
  "Factory 54 (פקטורי 54)": { cat: "Fashion & Apparel", networks: [], aliases: ["פקטורי", "factory 54"] },
  "Mega Sport (מגה ספורט)": { cat: "Fashion & Apparel", networks: ['TH', 'BM', 'GT'], aliases: ["mega sport", "מגה ספורט", "מגה"] },
  "Aluf Sport (אלוף ספורט)": { cat: "Fashion & Apparel", networks: [], aliases: ["אלוף ספורט", "aluf sport"] },
  "Delta (דלתא)": { cat: "Fashion & Apparel", networks: ['BM', 'GT'], aliases: ["delta", "דלתא"] },
  "Hamashbir (המשביר לצרכן)": { cat: "Fashion & Apparel", networks: ['TH', 'GT', 'BM'], aliases: ["hamashbir", "המשביר", "המשביר לצרכן"] },
  "Twenty Four Seven (טוונטי פור סבן)": { cat: "Fashion & Apparel", networks: ['TH', 'BM', 'GT'], aliases: ["twenty four seven", "24/7", "טוונטי פור סבן", "טוונטי"] },
  "Carolina Lemke (קרולינה למקה)": { cat: "Fashion & Apparel", networks: ['GT', 'BM'], aliases: ["carolina lemke", "קרולינה למקה", "קרולינה"] },
  "Stradivarius (סטראדיבריוס)": { cat: "Fashion & Apparel", networks: ['TH', 'TP'], aliases: ["stradivarius", "סטראדיבריוס", "סטרדיבריוס"] },
  "Gali (גלי)": { cat: "Fashion & Apparel", networks: ['TH', 'GT'], aliases: ["gali", "גלי"] },
  "Adidas (אדידס)": { cat: "Fashion & Apparel", networks: ['BM', 'TH', 'TP'], aliases: ["adidas", "אדידס"] },
  "H&M (אייץ' אנד אם)": { cat: "Fashion & Apparel", networks: ['BM', 'TH'], aliases: ["h&m", "h and m", "אייץ"] },
  "FOX (פוקס)": { cat: "Fashion & Apparel", networks: ['BM', 'GT', 'TP', 'DC'], aliases: ["פוקס", "פוק"] },
  "Castro (קסטרו)": { cat: "Fashion & Apparel", networks: ['TH', 'TP'], aliases: ["קסטרו"] },
  "Mango (מנגו)": { cat: "Fashion & Apparel", networks: ['GT', 'TP', 'DC'], aliases: ["מנגו"] },
  "American Eagle (אמריקן איגל)": { cat: "Fashion & Apparel", networks: ['GT', 'TP', 'DC'], aliases: ["אמריקן איגל"] },
  "Foot Locker (פוט לוקר)": { cat: "Fashion & Apparel", networks: ['GT', 'TH', 'TP', 'DC', 'BM'], aliases: ["פוט לוקר"] },
  "Billabong (בילבונג)": { cat: "Fashion & Apparel", networks: ['GT', 'TP', 'DC'], aliases: ["בילבונג"] },
  "Timberland (טימברלנד)": { cat: "Fashion & Apparel", networks: ['GT', 'TH', 'TP'], aliases: ["טימברלנד"] },
  "Nautica (נאוטיקה)": { cat: "Fashion & Apparel", networks: ['GT', 'TH', 'TP'], aliases: ["נאוטיקה"] },
  "Guess (גס)": { cat: "Fashion & Apparel", networks: ['GT', 'TP'], aliases: ["גס"] },
  "DKNY (דקני)": { cat: "Fashion & Apparel", networks: ['GT'], aliases: ["דקני"] },
  "H&O (אייץ' אנד או)": { cat: "Fashion & Apparel", networks: ['GT', 'TP'], aliases: ["אייץ אנד או"] },
  "Vans (ואנס)": { cat: "Fashion & Apparel", networks: ['TH'], aliases: ["ואנס"] },
  "The Children's Place (דה צ'ילדרנס פלייס)": { cat: "Fashion & Apparel", networks: ['GT', 'DC'], aliases: ["דה צילדרנס פלייס", "צילדרנס פלייס"] },
  "Quiksilver (קווילסילבר)": { cat: "Fashion & Apparel", networks: ['DC'], aliases: ["quiksilver", "קויקסילבר", "קווילסילבר"] },
  "Ruby Bay (רובי ביי)": { cat: "Fashion & Apparel", networks: ['DC'], aliases: ["ruby bay", "רובי ביי"] },
  "Aerie (אירי)": { cat: "Fashion & Apparel", networks: ['DC'], aliases: ["aerie", "אירי"] },
  "Sunglass Hut (סאנגלס האט)": { cat: "Fashion & Apparel", networks: ['DC'], aliases: ["sunglass hut", "סאנגלס האט"] },
  "Shufersal (שופרסל)": { cat: "Supermarkets & Groceries", networks: ['CB', 'TH'], aliases: ["שופרסל"] },
  "Carrefour (קרפור)": { cat: "Supermarkets & Groceries", networks: ['CB', 'GT', 'TP'], aliases: ["קרפור"] },
  "Rami Levy (רמי לוי)": { cat: "Supermarkets & Groceries", networks: [], aliases: ["rami levy", "רמי לוי", "רמי"] },
  "Yohananof (יוחננוף)": { cat: "Supermarkets & Groceries", networks: ['TP'], aliases: ["yohananof", "יוחננוף"] },
  "Osher Ad (אושר עד)": { cat: "Supermarkets & Groceries", networks: [], aliases: ["osher ad", "אושר עד"] },
  "Victory (ויקטורי)": { cat: "Supermarkets & Groceries", networks: ['CB'], aliases: ["ויקטורי"] },
  "Tiv Taam (טיב טעם)": { cat: "Supermarkets & Groceries", networks: ['CB', 'GT', 'BM'], aliases: ["טיב טעם"] },
  "Machsanei Hashuk (מחסני השוק)": { cat: "Supermarkets & Groceries", networks: ['CB', 'GT'], aliases: ["מחסני השוק", "מחסני שוק"] },
  "King Store (קינג סטור)": { cat: "Supermarkets & Groceries", networks: ['CB'], aliases: ["קינג סטור"] },
  "Super Yuda (סופר יודה)": { cat: "Supermarkets & Groceries", networks: ['CB'], aliases: ["סופר יודה", "סופר יהודה"] },
  "Shuk HaIr (שוק העיר)": { cat: "Supermarkets & Groceries", networks: ['CB'], aliases: ["שוק העיר"] },
  "Teva Castel (טבע קסטל)": { cat: "Supermarkets & Groceries", networks: ['CB'], aliases: ["טבע קסטל"] },
  "Nitzat Haduvdevan (ניצת הדובדבן)": { cat: "Supermarkets & Groceries", networks: ['CB', 'GT'], aliases: ["ניצת הדובדבן"] },
  "AMPM (אמ:פמ)": { cat: "Supermarkets & Groceries", networks: ['CB'], aliases: ["אמפמ", "אי אם פי אם", "am pm"] },
  "Super-Pharm (סופר פארם)": { cat: "Pharmacy & Health", networks: ['TH'], aliases: ["super pharm", "סופר פארם", "סופרפארם"] },
  "Be Pharm (בי פארם)": { cat: "Pharmacy & Health", networks: ['CB', 'TH'], aliases: ["be", "בי", "בי פארם"] },
  "Laline (ללין)": { cat: "Pharmacy & Health", networks: ['DC', 'BM', 'GT'], aliases: ["laline", "ללין"] },
  "Sabon (סבון)": { cat: "Pharmacy & Health", networks: ['TH', 'GT'], aliases: ["sabon", "סבון"] },
  "IKEA (איקאה)": { cat: "Home & Household", networks: ['TP'], aliases: ["ikea", "איקאה"] },
  "Home Center (הום סנטר)": { cat: "Home & Household", networks: ['GT', 'TH'], aliases: ["הום סנטר"] },
  "FOX Home (פוקס הום)": { cat: "Home & Household", networks: ['BM', 'GT', 'TP', 'DC'], aliases: ["פוקס הום", "פוק"] },
  "Naaman (נעמן)": { cat: "Home & Household", networks: ['GT', 'TP'], aliases: ["נעמן"] },
  "Vardinon (ורדינון)": { cat: "Home & Household", networks: ['GT', 'TH', 'TP'], aliases: ["ורדינון"] },
  "Soltam (סולתם)": { cat: "Home & Household", networks: ['TH'], aliases: ["סולתם"] },
  "4Chef (פור שף)": { cat: "Home & Household", networks: ['GT'], aliases: ["פור שף"] },
  "Golf & Co (גולף)": { cat: "Home & Household", networks: ['GT', 'TP'], aliases: ["גולף"] },
  "ACE (אייס)": { cat: "Home & Household", networks: ['TP'], aliases: ["אייס"] },
  "Flying Tiger (פליינג טייגר)": { cat: "Home & Household", networks: ['TP', 'DC'], aliases: ["פליינג טייגר", "טייגר"] },
  "Hastok (הסטוק)": { cat: "Home & Household", networks: ['GT'], aliases: ["הסטוק", "סטוק"] },
  "Arcosteel (ארקוסטיל)": { cat: "Home & Household", networks: ['TP'], aliases: ["ארקוסטיל"] },
  "Auto Depot (אוטו דיפו)": { cat: "Home & Household", networks: ['TP'], aliases: ["אוטו דיפו"] },
  "Tzemer Carpets (צמר שטיחים)": { cat: "Home & Household", networks: ['GT'], aliases: ["צמר שטיחים", "צמר"] },
  "Jumbo (ג'מבו)": { cat: "Kids & Baby", networks: ['DC'], aliases: ["גמבו", "jumbo", "ג'מבו"] },
  "Shilav (שילב)": { cat: "Kids & Baby", networks: ['DC'], aliases: ["shilav", "שילב"] },
  "The Saul Hotel (מלון סאול)": { cat: "Hotels & Lodging", networks: ['BM'], aliases: ["הסאול", "מלון סאול"] },
  "Renoma Hotel (מלון רנומה)": { cat: "Hotels & Lodging", networks: ['BM'], aliases: ["מלון רנומה", "רנומה"] },
  "Fabric Hotel (מלון פבריק)": { cat: "Hotels & Lodging", networks: ['BM'], aliases: ["מלון פבריק", "פבריק"] },
  "Market House Hotel (מלון מרקט האוס)": { cat: "Hotels & Lodging", networks: ['BM'], aliases: ["מלון מרקט האוס", "מרקט האוס"] },
  "Brown Hotels (מלונות בראון)": { cat: "Hotels & Lodging", networks: ['GT'], aliases: ["מלונות בראון", "מלון בראון", "בראון"] },
  "Adam Hotels (מלונות אדם)": { cat: "Hotels & Lodging", networks: ['GT'], aliases: ["מלונות אדם", "מלון אדם", "אדם"] },
  "ShareSpa (שאר ספא)": { cat: "Spas & Wellness", networks: ['GT'], aliases: ["שאר ספא", "שייר ספא"] },
  "Mila Spa (מילה ספא)": { cat: "Spas & Wellness", networks: ['GT'], aliases: ["מילה ספא"] },
  "Spa at Brown Hotels (ספא בראון)": { cat: "Spas & Wellness", networks: ['GT'], aliases: ["ספא בראון", "ספא במלונות בראון"] },
  "Tilia Clinic (טיליה)": { cat: "Spas & Wellness", networks: ['GT'], aliases: ["טיליה", "קליניקת טיליה"] },
  "Spa My Touch (ספא מיי טאצ')": { cat: "Spas & Wellness", networks: ['BM'], aliases: ["ספא מיי טאצ", "מיי טאצ"] },
  "Holmes Place (הולמס פלייס)": { cat: "Fitness & Gym", networks: [], aliases: ["הולמס פלייס", "holmes place", "גו אקטיב", "go active"] },
  "Bug (באג)": { cat: "Electronics", networks: ['BM', 'GT'], aliases: ["bug", "באג"] },
  "KSP (קיי אס פי)": { cat: "Electronics", networks: [], aliases: ["ksp", "קיי אס פי", "קספ"] },
  "Ivory (אייבורי)": { cat: "Electronics", networks: [], aliases: ["ivory", "אייבורי"] },
  "Traklin Hashmal (טרקלין חשמל)": { cat: "Electronics", networks: ['GT'], aliases: ["טרקלין חשמל"] },
  "Machsanei Hashmal (מחסני חשמל)": { cat: "Electronics", networks: ['TP'], aliases: ["מחסני חשמל"] },
  "Shekem Electric (שקם אלקטריק)": { cat: "Electronics", networks: ['TH'], aliases: ["שקם אלקטריק"] },
  "Dynamica Cellular (דינמיקה סלולר)": { cat: "Electronics", networks: ['TH'], aliases: ["דינמיקה סלולר", "דינמיקה"] },
  "A.L.M (א.ל.מ)": { cat: "Electronics", networks: ['BM'], aliases: ["אלמ", "א.ל.מ"] },
  "Hashmal Neto (חשמל נטו)": { cat: "Electronics", networks: ['BM'], aliases: ["חשמל נטו"] },
  "Cinema City (סינמה סיטי)": { cat: "Cinemas", networks: ['GT', 'TP'], aliases: ["סינמה סיטי"], logo: "cinema_city.png" },
  "HOT Cinema (הוט סינמה)": { cat: "Cinemas", networks: ['TP'], aliases: ["הוט סינמה", "הוט"], logo: "hot_cinema.png" },
  "Planet (פלאנט)": { cat: "Cinemas", networks: [], aliases: ["planet", "פלאנט", "יס פלאנט"] },
  "Movieland (מובילנד)": { cat: "Cinemas", networks: [], aliases: ["movieland", "מובילנד"] },
  "Rebar (ריבר)": { cat: "Food Chains & Restaurants", networks: ['CB', 'BM'], aliases: ["rebar", "ריבר"] },
  "Golda (גולדה)": { cat: "Food Chains & Restaurants", networks: ['CB', 'BM'], aliases: ["golda", "גולדה"] },
  "Pizza Hut (פיצה האט)": { cat: "Food Chains & Restaurants", networks: ['CB'], aliases: ["פיצה האט", "האט"] },
  "Domino's Pizza (דומינוס פיצה)": { cat: "Food Chains & Restaurants", networks: ['CB'], aliases: ["פיצה דומינוס", "דומינוס"], logo: "dominos.png" },
  "Pizza Shemesh (פיצה שמש)": { cat: "Food Chains & Restaurants", networks: [], aliases: ["פיצה שמש", "שמש"] },
  "Papa John's (פאפא ג'ונס)": { cat: "Food Chains & Restaurants", networks: [], aliases: ["פאפא", "papa johns", "פאפא גונס", "ג'ונס"] },
  "Pizza Prego (פיצה פרגו)": { cat: "Food Chains & Restaurants", networks: [], aliases: ["פרגו", "פיצה פרגו", "prego"] },
  "McDonald's (מקדונלדס)": { cat: "Food Chains & Restaurants", networks: ['CB', 'GT'], aliases: ["מקדונלדס", "מק"] },
  "CafeCafe (קפה קפה)": { cat: "Food Chains & Restaurants", networks: ['GT'], aliases: ["קפה קפה"] },
  "Japanika (ג'פניקה)": { cat: "Food Chains & Restaurants", networks: ['CB'], aliases: ["גפאניקה", "ג'פניקה"] },
  "Japan Japan (ג'פן ג'פן)": { cat: "Food Chains & Restaurants", networks: ['GT'], aliases: ["גפאן גפאן", "ג'פן ג'פן"] },
  "Mexicana (מקסיקנה)": { cat: "Food Chains & Restaurants", networks: ['GT'], aliases: ["מקסיקנה"] },
  "Max Brenner (מקס ברנר)": { cat: "Food Chains & Restaurants", networks: ['GT'], aliases: ["מקס ברנר"] },
  "Burgerim (בורגרים)": { cat: "Food Chains & Restaurants", networks: ['CB'], aliases: ["בורגרים"] },
  "Aroma (ארומה)": { cat: "Food Chains & Restaurants", networks: ['CB'], aliases: ["ארומה"] },
  "Arcaffe (ארקפה)": { cat: "Food Chains & Restaurants", networks: ['CB'], aliases: ["ארקפה"] },
  "Greg (קפה גרג)": { cat: "Food Chains & Restaurants", networks: ['CB'], aliases: ["קפה גרג", "גרג"] },
  "Landwer (קפה לנדוור)": { cat: "Food Chains & Restaurants", networks: ['CB'], aliases: ["לנדוור", "קפה לנדוור"] },
  "BBB (בי.בי.בי)": { cat: "Food Chains & Restaurants", networks: ['CB'], aliases: ["ביביבי", "בי בי בי", "בורגוס"] },
  "Moses (מוזס)": { cat: "Food Chains & Restaurants", networks: ['CB'], aliases: ["מוזס"] },
  "Giraffe (ג'ירף)": { cat: "Food Chains & Restaurants", networks: ['CB'], aliases: ["גירף", "ג'ירף"] },
  "Roladin (רולדין)": { cat: "Food Chains & Restaurants", networks: ['CB'], aliases: ["רולדין"] },
  "Wolt (וולט)": { cat: "Online Retail & Delivery", networks: ['CB'], aliases: ["וולט"] },
  "10bis (תן ביס)": { cat: "Online Retail & Delivery", networks: [], aliases: ["תן ביס", "10bis"] },
  "Last Price (לאסט פרייס)": { cat: "Online Retail & Delivery", networks: [], aliases: ["לאסט פרייס", "last price"] },
  "Boxil (בוקסיל)": { cat: "Online Retail & Delivery", networks: [], aliases: ["boxil", "בוקסיל"] },
  "Shrolik (שרוליק)": { cat: "Online Retail & Delivery", networks: [], aliases: ["shrolik", "שרוליק"] },
  "ASOS (אסוס)": { cat: "Online Retail & Delivery", networks: [], aliases: ["asos", "אסוס"] },
  "SHEIN (שיין)": { cat: "Online Retail & Delivery", networks: [], aliases: ["shein", "שיין", "שאין"], logo: "shein.png" },
  "Amazon (אמזון)": { cat: "Online Retail & Delivery", networks: [], aliases: ["אמזון"], logo: "amazon.png" },
  "AliExpress (עלי אקספרס)": { cat: "Online Retail & Delivery", networks: [], aliases: ["אליאקספרס", "עלי אקספרס", "אלי אקספרס"], logo: "ali_express.png" },
  "Temu (טמו)": { cat: "Online Retail & Delivery", networks: [], aliases: ["טאמו", "טמו"] },
  "Etsy (אטסי)": { cat: "Online Retail & Delivery", networks: [], aliases: ["אטסי", "אטצי"] },
  "Yango Deli (יאנגו Deli)": { cat: "Online Retail & Delivery", networks: ['CB'], aliases: ["יאנגו דלי", "יאנגו"] },
  "Mishloha (משלוחה)": { cat: "Online Retail & Delivery", networks: ['CB'], aliases: ["משלוחה"] },
  "Super Yuda Online (סופר יודה אונליין)": { cat: "Online Retail & Delivery", networks: ['CB'], aliases: ["סופר יודה אונליין", "סופר יהודה אונליין"] },
  "Carrefour Online (קרפור אונליין)": { cat: "Online Retail & Delivery", networks: ['TP'], aliases: ["קרפור אונליין"] },
  "Steimatzky (סטימצקי)": { cat: "Other", networks: ['TH', 'BM', 'GT'], aliases: ["steimatzky", "סטימצקי"] },
  "Tzomet Sfarim (צומת ספרים)": { cat: "Other", networks: ['TP', 'BM', 'GT'], aliases: ["tzomet sfarim", "צומת ספרים", "צומת"] },
  "Kravitz (קרביץ)": { cat: "Other", networks: ['TH', 'GT'], aliases: ["kravitz", "קרביץ"] },
};

function dealMatchesClubSearch(deal, clubSearchRaw) {
  if (!clubSearchRaw?.trim()) return true;
  const qs = clubSearchRaw.toLowerCase().trim();
  const terms = expandClubSearchQueryTerms(clubSearchRaw);
  const blob = `${deal.m} ${deal.d} ${deal.genre || ''}`.toLowerCase();
  const blobCompact = blob.replace(/\s/g, '');
  const termHit = terms.some((t) => {
    if (t.length < 2) return false;
    const tl = t.toLowerCase();
    if (blob.includes(tl)) return true;
    const compact = tl.replace(/\s/g, '');
    if (compact.length >= 3 && blobCompact.includes(compact)) return true;
    return false;
  });
  if (termHit) return true;

  if (clubSearchTermsIncludeStandupTopic(terms) && dealBlobMentionsStandupComedian(deal)) return true;

  const cat = KNOWN_MERCHANTS[deal.m]?.cat || '';
  const catAliases = CATEGORY_ALIASES[cat] || [];
  const genreLo = deal.genre ? String(deal.genre).toLowerCase() : '';
  return (
    blob.includes(qs)
    || cat.toLowerCase().includes(qs)
    || (genreLo && (genreLo.includes(qs) || terms.some((t) => t.length >= 2 && genreLo.includes(t))))
    || catAliases.some((a) => {
      const al = a.toLowerCase();
      return al.includes(qs) || qs.includes(al) || terms.some((t) => al.includes(t) || t.includes(al));
    })
  );
}

const getLogoPath = (merchantString) => {
  if (!merchantString) return '';
  const merchData = KNOWN_MERCHANTS[merchantString];
  if (merchData && merchData.logo) return `/assets/logos/${merchData.logo}`;
  const englishPart = merchantString.split('(')[0].trim().toLowerCase();
  const filename = englishPart.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `/assets/logos/${filename}.png`;
};

const getDaysUntilExpiry = (dateString) => {
  if (!dateString) return Infinity;
  return Math.ceil((new Date(dateString) - new Date()) / (1000 * 60 * 60 * 24));
};

const getCalendarMonthKey = (dateInput) => {
  const d = dateInput ? new Date(dateInput) : new Date();
  if (Number.isNaN(d.getTime())) return getCalendarMonthKey(new Date());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const getExpenseMonthKey = (expense) => {
  if (expense.scheduledFor) return getCalendarMonthKey(expense.scheduledFor);
  if (expense.updatedAt) return getCalendarMonthKey(expense.updatedAt);
  return getCalendarMonthKey(new Date());
};

/** Firestore may return Timestamp; date input needs YYYY-MM-DD */
const toScheduledForInputValue = (v) => {
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 10);
  if (typeof v.toDate === 'function') {
    const d = v.toDate();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return '';
};

const checkCompatibility = (card, category, merchantName) => {
  const pId = card.programId || 'CUSTOM';
  const merchData = KNOWN_MERCHANTS[merchantName];

  if (pId === 'HG') {
    if (['Fuel & Transportation', 'Pharmacy & Health'].includes(category)) return { allowed: false, reason: "Blocked category" };
    return { allowed: true, reason: "Allowed (Mastercard Network)" };
  }
  if (pId === 'FLEX') return { allowed: true, reason: "Usually allowed (Check policy)" };
  if (pId === 'FTR') {
    if (["Food Chains & Restaurants", "Fashion & Apparel", "Cinemas", "Spas & Wellness", "Online Retail & Delivery", "Hotels & Lodging"].includes(category)) return { allowed: true, reason: "MCC Allowed" };
    return { allowed: false, reason: "MCC Restricted" };
  }
  if (pId === 'FTR_VAC') {
    if (category === "Hotels & Lodging") return { allowed: true, reason: "Lodging Allowed" };
    return { allowed: false, reason: "Lodging Only" };
  }
  if (pId === 'CB') {
    if (category === "Food Chains & Restaurants") return { allowed: true, reason: "Cibus Food Network" };
    if (merchData && merchData.networks.includes('CB')) return { allowed: true, reason: "Explicit Partner" };
    return { allowed: false, reason: "Not in partner network" };
  }
  if (['BM', 'GT', 'TH', 'TP', 'DC'].includes(pId)) {
    if (!merchantName) return { allowed: false, reason: "Specific merchant required" };
    if (merchData && merchData.networks.includes(pId)) return { allowed: true, reason: `Explicit Partner` };
    return { allowed: false, reason: "Merchant not in network" };
  }
  if (pId === 'CUSTOM') {
    if ((card.categories || []).includes(category)) return { allowed: true, reason: "Allowed Category" };
    return { allowed: false, reason: "Category not assigned" };
  }
  return { allowed: false, reason: "Unknown compatibility" };
};

/** Card must satisfy every selected merchant (with its catalog category) and every extra category without a matching merchant. */
const cardMatchesExpenseSelection = (card, categories, merchants) => {
  const cats = [...new Set((categories || []).filter(Boolean))];
  const merchs = [...new Set((merchants || []).filter(Boolean))];
  if (cats.length === 0) return false;
  const coveredCats = new Set();
  for (const m of merchs) {
    const mdata = KNOWN_MERCHANTS[m];
    const catForMerchant = mdata?.cat || cats[0];
    coveredCats.add(catForMerchant);
    if (!checkCompatibility(card, catForMerchant, m).allowed) return false;
  }
  for (const cat of cats) {
    if (coveredCats.has(cat)) continue;
    if (!checkCompatibility(card, cat, '').allowed) return false;
  }
  return true;
};

function pickExpenseCardId(cardBalances, categories, merchants, previousCardId, anchorCardId) {
  if (!categories || categories.length === 0) {
    for (const id of [previousCardId, anchorCardId]) {
      if (!id) continue;
      if (cardBalances.some((c) => c.id === id)) return id;
    }
    return '';
  }
  for (const id of [previousCardId, anchorCardId]) {
    if (!id) continue;
    const card = cardBalances.find((c) => c.id === id);
    if (card && cardMatchesExpenseSelection(card, categories, merchants)) return id;
  }
  return '';
}

const expenseCategoriesForDisplay = (e) =>
  (Array.isArray(e.expenseCategories) && e.expenseCategories.length ? e.expenseCategories : e.category ? [e.category] : []);
const expenseMerchantsForDisplay = (e) =>
  (Array.isArray(e.expenseMerchants) && e.expenseMerchants.length ? e.expenseMerchants : e.merchantName ? [e.merchantName] : []);

const getDerivedCategories = (card) => {
  const pId = card.programId || 'CUSTOM';
  if (pId === 'CUSTOM') return card.categories || [];
  if (pId === 'HG' || pId === 'FLEX') return CATEGORIES.filter(c => !['Fuel & Transportation', 'Pharmacy & Health'].includes(c));
  if (pId === 'FTR') return ["Food Chains & Restaurants", "Fashion & Apparel", "Cinemas", "Spas & Wellness", "Online Retail & Delivery", "Hotels & Lodging"];
  if (pId === 'FTR_VAC') return ["Hotels & Lodging"];

  const derived = new Set();
  if (pId === 'CB') derived.add("Food Chains & Restaurants");
  Object.values(KNOWN_MERCHANTS).forEach((m) => {
    if (m.networks.includes(pId)) derived.add(m.cat);
  });
  return Array.from(derived);
};

const getSmartMatches = (query, maxResults = 15) => {
  if (!query) return [];
  const q = query.toLowerCase().trim();

  return Object.entries(KNOWN_MERCHANTS)
    .filter(([name, data]) => {
      const cleanName = name.toLowerCase().replace(/[()]/g, '');
      const matchName = cleanName.includes(q) || cleanName.split(/\s+/).some((w) => w.startsWith(q));

      const matchAlias = (data.aliases || []).some((alias) => {
        const a = alias.toLowerCase().replace(/[()]/g, '');
        return a.includes(q) || a.split(/\s+/).some((w) => w.startsWith(q));
      });

      const catAliases = CATEGORY_ALIASES[data.cat] || [];
      const matchCat = catAliases.some((alias) => {
        const a = alias.toLowerCase();
        return a.includes(q) || a.split(/\s+/).some((w) => w.startsWith(q));
      }) || data.cat.toLowerCase().includes(q);

      return matchName || matchAlias || matchCat;
    })
    .sort(([nameA, dataA], [nameB, dataB]) => {
      const getScore = (name, data) => {
        const clean = name.toLowerCase().replace(/[()]/g, '');
        if (clean === q) return 0;
        if (clean.startsWith(q)) return 1;
        if (clean.split(/\s+/).some((w) => w.startsWith(q))) return 2;
        if ((data.aliases || []).some((a) => a.toLowerCase().replace(/[()]/g, '') === q)) return 3;
        if ((data.aliases || []).some((a) => a.toLowerCase().replace(/[()]/g, '').startsWith(q))) return 4;
        return 5;
      };

      const scoreA = getScore(nameA, dataA);
      const scoreB = getScore(nameB, dataB);

      if (scoreA !== scoreB) return scoreA - scoreB;
      return nameA.localeCompare(nameB);
    }).slice(0, maxResults);
};

const fetchGeminiAIResponse = async (query, history, systemInstruction, signal) => {
  try {
    const response = await fetch('/.netlify/functions/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, history, systemInstruction }),
      signal
    });

    if (!response.ok) {
      const errorDetails = await response.text();
      throw new Error(`Status ${response.status}: ${errorDetails}`);
    }

    const data = await response.json();
    return data.result;
  } catch (error) {
    if (error.name === 'AbortError') return null;
    throw error;
  }
};

const detectInputLanguage = (text) => {
  if (!text) return 'he';
  const hebrewMatches = (text.match(/[\u0590-\u05FF]/g) || []).length;
  const latinMatches = (text.match(/[A-Za-z]/g) || []).length;
  if (latinMatches > hebrewMatches) return 'en';
  return 'he';
};

/** Visible link text in chat; full URL kept in title for hover/accessibility. */
function hebrewAnchorLabelForUrl(href) {
  const u = href.toLowerCase();
  if (/(hatava|benefit|cal\.co|\/benefit|\/hatava|מועדון|members|club\.|credit-card)/i.test(u)) return 'להטבה';
  return 'למבצע';
}

function linkifyTextSegment(segment, keyPrefix) {
  if (!segment) return null;
  const re = /https?:\/\/[^\s\])>'"ֿ\]]+|www\.[^\s\])>'"ֿ\]]+/gi;
  const out = [];
  let last = 0;
  let m;
  let partIdx = 0;
  while ((m = re.exec(segment)) !== null) {
    if (m.index > last) {
      out.push(<React.Fragment key={`${keyPrefix}-t-${partIdx++}`}>{segment.slice(last, m.index)}</React.Fragment>);
    }
    let href = m[0].replace(/[),.;:]+$/g, '');
    if (href.toLowerCase().startsWith('www.')) href = `https://${href}`;
    const label = hebrewAnchorLabelForUrl(href);
    out.push(
      <a
        key={`${keyPrefix}-a-${partIdx++}`}
        href={href}
        title={href}
        target="_blank"
        rel="noopener noreferrer"
        className="underline text-sky-600 dark:text-sky-400 font-medium whitespace-nowrap"
      >
        {label}
      </a>
    );
    last = m.index + m[0].length;
  }
  if (last < segment.length) {
    out.push(<React.Fragment key={`${keyPrefix}-t-${partIdx}`}>{segment.slice(last)}</React.Fragment>);
  }
  return out.length ? out : segment;
}

const renderChatText = (text) => {
  if (!text) return null;
  const lines = String(text).split('\n');
  return lines.map((line, lineIdx) => {
    const parts = line.split(/(\*\*.*?\*\*)/g);
    return (
      <React.Fragment key={`line-${lineIdx}`}>
        {parts.map((part, partIdx) => {
          const isBold = part.startsWith('**') && part.endsWith('**') && part.length > 4;
          const content = isBold ? part.slice(2, -2) : part;
          if (isBold) {
            return <strong key={`part-${lineIdx}-${partIdx}`}>{linkifyTextSegment(content, `b-${lineIdx}-${partIdx}`)}</strong>;
          }
          return <React.Fragment key={`part-${lineIdx}-${partIdx}`}>{linkifyTextSegment(content, `p-${lineIdx}-${partIdx}`)}</React.Fragment>;
        })}
        {lineIdx < lines.length - 1 && <br />}
      </React.Fragment>
    );
  });
};

function linkifyForAdvisor(segment, keyPrefix) {
  if (!segment) return null;
  const re = /https?:\/\/[^\s\])>'"ֿ\]]+|www\.[^\s\])>'"ֿ\]]+/gi;
  const out = [];
  let last = 0;
  let m;
  let partIdx = 0;
  while ((m = re.exec(segment)) !== null) {
    if (m.index > last) {
      out.push(<React.Fragment key={`${keyPrefix}-t-${partIdx++}`}>{segment.slice(last, m.index)}</React.Fragment>);
    }
    let href = m[0].replace(/[),.;:]+$/g, '');
    if (href.toLowerCase().startsWith('www.')) href = `https://${href}`;
    const label = hebrewAnchorLabelForUrl(href);
    out.push(
      <a key={`${keyPrefix}-a-${partIdx++}`} href={href} title={href} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    );
    last = m.index + m[0].length;
  }
  if (last < segment.length) {
    out.push(<React.Fragment key={`${keyPrefix}-t-${partIdx}`}>{segment.slice(last)}</React.Fragment>);
  }
  return out.length ? out : segment;
}

function stripChatMarkdown(s) {
  return String(s)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1');
}

function parseAdvisorCardFields(body) {
  const fields = {};
  const lines = String(body).trim().split(/\r?\n/);
  let cur = null;
  for (const line of lines) {
    const km = line.match(/^([A-Za-z]+):\s*(.*)$/);
    if (km) {
      cur = km[1].toUpperCase();
      fields[cur] = km[2].trim();
    } else if (cur && line.trim()) {
      fields[cur] = fields[cur] ? `${fields[cur]}\n${line.trim()}` : line.trim();
    }
  }
  return fields;
}

function splitAdvisorSegments(text) {
  const str = String(text);
  const out = [];
  const re = /---CARD---\s*([\s\S]*?)---END---/g;
  let last = 0;
  let m;
  while ((m = re.exec(str)) !== null) {
    if (m.index > last) {
      const content = str.slice(last, m.index).trim();
      if (content) out.push({ type: 'text', content });
    }
    out.push({ type: 'card', fields: parseAdvisorCardFields(m[1]) });
    last = re.lastIndex;
  }
  const tail = str.slice(last).trim();
  if (tail) out.push({ type: 'text', content: tail });
  if (out.length === 0 && str.trim()) out.push({ type: 'text', content: str.trim() });
  return out;
}

function renderAdvisorProse(text) {
  const cleaned = stripChatMarkdown(text).trim();
  if (!cleaned) return null;
  const paras = cleaned.split(/\n\n+/).filter(Boolean);
  return paras.map((p, i) => (
    <p key={`adv-p-${i}`} className="ai-advisor-prose__p">
      {linkifyForAdvisor(p.replace(/\n/g, ' '), `adv-${i}`)}
    </p>
  ));
}

function advisorFieldLabels(lang) {
  return lang === 'en'
    ? { price: 'Price', why: 'Why it fits', pay: 'How to pay' }
    : { price: 'מחיר', why: 'למה כדאי', pay: 'איך לשלם' };
}

function precedingUserLang(messages, modelIndex) {
  for (let i = modelIndex - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return detectInputLanguage(messages[i].text);
  }
  return 'he';
}

function renderAdvisorMessage(text, lang) {
  const lab = advisorFieldLabels(lang);
  const segments = splitAdvisorSegments(text);
  return (
    <div className="ai-advisor-root space-y-3">
      {segments.map((seg, i) => {
        if (seg.type === 'card') {
          const f = seg.fields || {};
          const heading = (f.HEADING || '').trim();
          const price = stripChatMarkdown(f.PRICE || '').trim();
          const why = stripChatMarkdown(f.WHY || '').trim();
          const pay = stripChatMarkdown(f.PAY || '').trim();
          const url = (f.URL || '').trim();
          return (
            <div key={`c-${i}`} className="ai-advisor-card" dir={lang === 'en' ? 'ltr' : 'rtl'}>
              {heading ? <h3 className="ai-advisor-card__title" dir="auto">{heading}</h3> : null}
              {price ? (
                <div>
                  <div className="ai-advisor-card__label">{lab.price}</div>
                  <p className="ai-advisor-card__row">
                    <span className="text-white font-extrabold text-[1.05em]">{price}</span>
                  </p>
                </div>
              ) : null}
              {why ? (
                <div>
                  <div className="ai-advisor-card__label">{lab.why}</div>
                  <p className="ai-advisor-card__row" dir="auto">{why}</p>
                </div>
              ) : null}
              {pay ? (
                <div>
                  <div className="ai-advisor-card__label">{lab.pay}</div>
                  <div className="ai-advisor-card__pay" dir="auto">{linkifyForAdvisor(pay, `pay-${i}`)}</div>
                </div>
              ) : null}
              {url && /^https?:\/\//i.test(url) ? (
                <a href={url} target="_blank" rel="noopener noreferrer" className="ai-advisor-card__action" title={url}>
                  {hebrewAnchorLabelForUrl(url)}
                </a>
              ) : null}
            </div>
          );
        }
        return (
          <div key={`t-${i}`} className="ai-advisor-prose">
            {renderAdvisorProse(seg.content)}
          </div>
        );
      })}
    </div>
  );
}

function formatPlasticExpiry(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function WalletCreditPlastic({ balanceRemaining, balanceLimit, programName, chromeGradient, ruleType, expiryDate, isExpiringSoon }) {
  const showExpiry = ruleType === 'expires' && expiryDate;
  return (
    <div className="wallet-credit-card-wrap wallet-credit-card-wrap--lg-scale">
      <div className="wallet-credit-card" style={{ '--wcc-bg': chromeGradient }}>
        <div className="wcc-top-row">
          <div className="wcc-chip" aria-hidden />
          <div className="wcc-top-right">
            <div className="wcc-contactless" aria-hidden />
            <div className="wcc-mc" aria-hidden>
              <span className="wcc-mc-circle wcc-mc-circle--red" />
              <span className="wcc-mc-circle wcc-mc-circle--orange" />
            </div>
          </div>
        </div>
        <div className="wcc-program" title={programName}>{programName}</div>
        {showExpiry ? (
          <div className={`wcc-expiry${isExpiringSoon ? ' wcc-expiry--soon' : ''}`}>
            <span className="wcc-expiry-label">Expires</span>
            <span className="wcc-expiry-date">{formatPlasticExpiry(expiryDate)}</span>
          </div>
        ) : null}
        <div className="wcc-amounts">
          <div className="wcc-original">ORIGINAL VALUE ₪{balanceLimit.toLocaleString()}</div>
          <div className="wcc-current-block">
            <span className="wcc-current-label">Remaining</span>
            <div className="wcc-current">₪{balanceRemaining.toLocaleString()}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

const AI_CHAT_STORAGE_KEY = 'cardsdeven_ai_chat_v1';
const DEFAULT_AI_WELCOME_TEXT = 'היי! אני העוזר החכם שלך. תגיד לי מה אתה רוצה לקנות, ואמצא את המבצעים הכי שווים בשבילך! 😎';

/** Random epigraph while the model is typing (Office, HIMYM, Modern Family). */
const AI_LOADER_QUOTES = [
  'Would I rather be feared or loved? Easy. Both. I want people to be afraid of how much they love me. M.Scott',
  "I'm not superstitious, but I am a little stitious. M.Scott",
  "That's what she said. M.Scott",
  'Identity theft is not a joke, Jim! Millions of families suffer every year. D.Schrute',
  'I just want to lie on the beach and eat hot dogs. K.Malone',
  'Bears. Beets. Battlestar Galactica. J.Halpert',
  "Sometimes I'll start a sentence and I don't even know where it's going. I just hope I find it along the way. M.Scott",
  'I am Beyoncé, always. M.Scott',
  'I am running away from my responsibilities. And it feels good. M.Scott',
  'I talk a lot, so I\'ve learned to just tune myself out. K.Kapoor',
  'Sometimes the clothes at Gap Kids are too flashy, so I’m forced to go to the American Girl store and order clothes for large colonial dolls. A.Martin',
  'I declare bankruptcy! M.Scott',
  'The worst thing about prison was the dementors. M.Scott',
  "I'm an early bird and I'm a night owl. So I'm wise and I have worms. M.Scott",
  "I miss the days when there was only one party I didn't want to go to. R.Howard",
  'Legen—wait for it—dary! B.Stinson',
  'Suit up! B.Stinson',
  "Whenever I'm sad, I stop being sad and be awesome instead. B.Stinson",
  "You can't cling to the past. Because no matter how tightly you hold on, it's already gone. T.Mosby",
  "If you're not scared, you're not taking a chance, and if you're not taking a chance, then what the hell are you doing? T.Mosby",
  "Because sometimes even if you know how something's gonna end, that doesn't mean you can't enjoy the ride. T.Mosby",
  'And that, kids, is how I met your mother. T.Mosby',
  "If I ask you to change too many things about yourself, you're not gonna be the man I fell in love with. R.Scherbatsky",
  "Nothing good happens after 2:00 A.M. T.Mosby",
  'Have you met Ted? B.Stinson',
  'It’s only once you’ve stopped that you realize how hard it is to start again. T.Mosby',
  "The great moments of your life won't necessarily be the things you do; they'll also be the things that happen to you. T.Mosby",
  "Whatever you do in this life, it's not legendary unless your friends are there to see it. B.Stinson",
  'We struggle so hard to hold on to these things that we know are gonna disappear eventually. L.Aldrin',
  'Challenge accepted! B.Stinson',
  "I'm the cool dad. That's my thing. I'm hip. I surf the Web. I text. LOL. P.Dunphy",
  "I've always said that if my son thinks of me as one of his idiot friends, I've succeeded as a dad. P.Dunphy",
  "The iPad comes out on my actual birthday. It's like Steve Jobs and God got together to say, 'We love you, Phil.' P.Dunphy",
  "When life gives you lemonade, make lemons. Life will be all like 'Whaaaat?!' P.Dunphy",
  'Success is 1% inspiration, 98% perspiration, and 2% attention to detail. P.Dunphy',
  "Always look people in the eye, even if they're blind. Just say 'I'm looking you in the eye, but it doesn't seem to be doing much.' P.Dunphy",
  'When in doubt, dance it out. It\'s scientifically proven to make everything better. P.Dunphy',
  'Watch a sunrise at least once a day. P.Dunphy',
  'If you want to be truly happy in life, surround yourself with people who make you laugh. And also, people who bring snacks. P.Dunphy',
  "I always felt bad for people with emotionally distant fathers. It turns out I'm one of them. It's a miracle I didn't end up a stripper. P.Dunphy",
  'We had no more dishes, so we were eating cereal out of a goldfish bowl. P.Dunphy',
];

function loadAiChatFromStorage() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(AI_CHAT_STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!Array.isArray(p) || p.length === 0) return null;
    if (!p.every((m) => m && (m.role === 'user' || m.role === 'model') && typeof m.text === 'string')) return null;
    return p;
  } catch {
    return null;
  }
}

function HamsterWheelLoader() {
  return (
    <div className="wheel-and-hamster" aria-label="Loading assistant" role="status">
      <div className="wheel" aria-hidden />
      <div className="hamster">
        <div className="hamster__body" />
        <div className="hamster__head">
          <div className="hamster__ear" />
          <div className="hamster__eye" />
          <div className="hamster__nose" />
        </div>
        <div className="hamster__limb hamster__limb--fr" />
        <div className="hamster__limb hamster__limb--fl" />
        <div className="hamster__limb hamster__limb--br" />
        <div className="hamster__limb hamster__limb--bl" />
        <div className="hamster__tail" />
      </div>
      <div className="spoke" aria-hidden />
    </div>
  );
}

const RULE_TYPES = {
  PERMANENT: { id: 'permanent', label: 'Permanent', icon: InfinityIcon },
  MONTHLY: { id: 'monthly', label: 'Monthly Reset', icon: RefreshCw },
  EXPIRES: { id: 'expires', label: 'Expires On', icon: CalendarDays }
};

const Modal = ({ isOpen, onClose, title, children }) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white dark:bg-slate-900 rounded-t-[2rem] sm:rounded-[2rem] w-full max-w-xl shadow-2xl animate-in slide-in-from-bottom-10 sm:zoom-in-95 duration-200 overflow-hidden flex flex-col max-h-[90vh] sm:max-h-[85vh] border-t sm:border border-slate-200 dark:border-slate-800">
        <div className="px-6 py-4 sm:py-5 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center sticky top-0 bg-white/90 dark:bg-slate-900/90 backdrop-blur-md z-20">
          <h3 className="font-bold text-xl text-slate-800 dark:text-slate-100">{title}</h3>
          <button type="button" onClick={onClose} className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 bg-slate-100 dark:bg-slate-800 rounded-full transition-colors"><X size={20} /></button>
        </div>
        <div className="p-6 pb-10 sm:pb-6 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
};

const MerchantIcon = ({ merchantName, category, className = "w-8 h-8 rounded-full" }) => {
  const fallbackEmoji = CATEGORY_ICONS[category] || "🏷️";
  return (
    <div className={`relative flex items-center justify-center bg-slate-100 dark:bg-slate-800 shrink-0 ${className} overflow-hidden shadow-sm border border-slate-200 dark:border-slate-700`}>
      <img
        src={getLogoPath(merchantName)}
        alt={merchantName}
        className="w-full h-full object-cover"
        onError={(e) => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'flex'; }}
      />
      <span className="absolute text-sm" style={{ display: 'none' }}>{fallbackEmoji}</span>
    </div>
  );
};

export default function App() {
  const [user, setUser] = useState(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [toast, setToast] = useState({ visible: false, message: '', type: 'success' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoginMode, setIsLoginMode] = useState(true);
  const [authError, setAuthError] = useState('');
  const [isProcessingAuth, setIsProcessingAuth] = useState(false);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [cards, setCards] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [userClubs, setUserClubs] = useState([]);
  const [aiMessages, setAiMessages] = useState(() => loadAiChatFromStorage() ?? [{ role: 'model', text: DEFAULT_AI_WELCOME_TEXT }]);
  const [aiInput, setAiInput] = useState('');
  const [isAiTyping, setIsAiTyping] = useState(false);
  const [aiLoadingQuote, setAiLoadingQuote] = useState('');
  const chatEndRef = useRef(null);
  const abortControllerRef = useRef(null);
  const aiRequestInFlightRef = useRef(false);
  const quickSpendAnchorCardIdRef = useRef(null);
  const [showCardForm, setShowCardForm] = useState(false);
  const [editingCardId, setEditingCardId] = useState(null);
  const [newCard, setNewCard] = useState({ name: '', balance: '', programId: 'CUSTOM', ruleType: 'permanent', expiryDate: '', categories: [], plasticAccentHex: '' });
  const [showExpenseForm, setShowExpenseForm] = useState(false);
  const [editingExpenseId, setEditingExpenseId] = useState(null);
  const [newExpense, setNewExpense] = useState({ name: '', amount: '', expenseCategories: [], expenseMerchants: [], cardId: '', isCompleted: false, isManualSplit: false, chargeAmount: '', scheduledFor: '' });
  const [merchantSearch, setMerchantSearch] = useState('');
  const [showMerchantSuggestions, setShowMerchantSuggestions] = useState(false);
  const [insightSearch, setInsightSearch] = useState('');
  const [clubSearch, setClubSearch] = useState('');
  const [paisPlusDiscounts, setPaisPlusDiscounts] = useState([]);
  const [behatsdaaScrapedDiscounts, setBehatsdaaScrapedDiscounts] = useState([]);
  const [dreamcardScrapedDiscounts, setDreamcardScrapedDiscounts] = useState([]);

  useEffect(() => {
    let cancelled = false;
    fetch(`${import.meta.env.BASE_URL}pais_plus_deals.json`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => {
        if (cancelled) return;
        const rows = Array.isArray(data?.deals) ? data.deals : [];
        setPaisPlusDiscounts(
          rows.map((row) => ({
            m: row.m,
            c: row.c || 'PAIS_PLUS',
            d: row.d,
            genre: row.genre,
            product_id: row.product_id,
            product_url: row.product_url,
            url: row.url || row.product_url,
          }))
        );
      })
      .catch((err) => {
        console.warn('CardsDeVen: could not load pais_plus_deals.json', err);
        if (!cancelled) setPaisPlusDiscounts([]);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`${import.meta.env.BASE_URL}behatsdaa_deals.json`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((payload) => {
        if (cancelled) return;
        const fromDeals = Array.isArray(payload?.deals) ? payload.deals : [];
        const nested = payload?.data;
        const flat = fromDeals.length > 0 ? fromDeals : flattenBehatsdaaDealsFromNested(nested);
        setBehatsdaaScrapedDiscounts(flat);
      })
      .catch((err) => {
        console.warn('CardsDeVen: could not load behatsdaa_deals.json (בהצדעה)', err);
        if (!cancelled) setBehatsdaaScrapedDiscounts([]);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`${import.meta.env.BASE_URL}dreamcard_deals.json`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((payload) => {
        if (cancelled) return;
        const deals = Array.isArray(payload?.deals) ? payload.deals : [];
        setDreamcardScrapedDiscounts(
          deals.map((row) => ({
            m: row.m,
            c: row.c || 'DREAMCARD',
            d: row.d,
            ...(typeof row.url === 'string' && row.url.trim() ? { url: row.url.trim() } : {}),
          }))
        );
      })
      .catch((err) => {
        console.warn('CardsDeVen: could not load dreamcard_deals.json (DreamCard)', err);
        if (!cancelled) setDreamcardScrapedDiscounts([]);
      });
    return () => { cancelled = true; };
  }, []);

  const discountsData = useMemo(() => {
    const behatsdaa = behatsdaaScrapedDiscounts.length > 0 ? behatsdaaScrapedDiscounts : STATIC_BEHATSDAA_FALLBACK;
    const dreamcard = dreamcardScrapedDiscounts.length > 0 ? dreamcardScrapedDiscounts : STATIC_DREAMCARD_FALLBACK;
    return [...behatsdaa, ...dreamcard, ...paisPlusDiscounts];
  }, [behatsdaaScrapedDiscounts, dreamcardScrapedDiscounts, paisPlusDiscounts]);

  useEffect(() => {
    if (isDarkMode) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }, [isDarkMode]);

  useEffect(() => {
    try {
      localStorage.setItem(AI_CHAT_STORAGE_KEY, JSON.stringify(aiMessages));
    } catch {
      /* private mode / quota */
    }
  }, [aiMessages]);

  const showToastMsg = (message, type = 'success') => {
    setToast({ visible: true, message, type });
    setTimeout(() => setToast({ visible: false, message: '', type: 'success' }), 3000);
  };

  const getCollectionPath = (uid, collectionName) => {
    if (typeof __app_id !== 'undefined') return `artifacts/${__app_id}/users/${uid}/${collectionName}`;
    return `users/${uid}/${collectionName}`;
  };

  useEffect(() => {
    let unsubscribe = () => {};
    try {
      const firebaseConfig = resolveFirebaseConfig();
      const app = initializeApp(firebaseConfig);
      const auth = getAuth(app);
      unsubscribe = onAuthStateChanged(auth, (currentUser) => { setUser(currentUser); setLoadingAuth(false); });
    } catch (e) {
      console.error(e);
      setAuthError(e?.message || 'Firebase configuration error');
      setLoadingAuth(false);
    }
    return () => { unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!user) { setCards([]); setExpenses([]); setUserClubs([]); return; }
    let unsubCards = () => {};
    let unsubExpenses = () => {};
    let unsubClubs = () => {};
    try {
      const db = getFirestore();
      unsubCards = onSnapshot(collection(db, getCollectionPath(user.uid, 'cards')), (snapshot) => setCards(snapshot.docs.map((d) => ({ id: d.id, ...d.data() }))));
      unsubExpenses = onSnapshot(collection(db, getCollectionPath(user.uid, 'expenses')), (snapshot) => setExpenses(snapshot.docs.map((d) => ({ id: d.id, ...d.data() }))));
      unsubClubs = onSnapshot(doc(db, getCollectionPath(user.uid, 'settings'), 'clubsProfile'), (docSnap) => { if (docSnap.exists()) setUserClubs(docSnap.data().activeClubs || []); });
    } catch (e) {
      console.error('Firestore', e);
    }
    return () => { unsubCards(); unsubExpenses(); unsubClubs(); };
  }, [user]);

  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    setAuthError('');
    setIsProcessingAuth(true);
    const auth = getAuth();
    try {
      if (isLoginMode) await signInWithEmailAndPassword(auth, email, password);
      else await createUserWithEmailAndPassword(auth, email, password);
      setEmail('');
      setPassword('');
    } catch (error) {
      if (typeof __app_id !== 'undefined' && error.code === 'auth/operation-not-allowed') {
        try { await signInAnonymously(auth); } catch (_fallbackErr) { setAuthError("Email auth disabled."); }
      } else {
        setAuthError("Authentication failed. Please check credentials.");
      }
    } finally { setIsProcessingAuth(false); }
  };

  const handleSignOut = () => signOut(getAuth());
  const handleToggleClub = async (clubId) => {
    if (!user) return;
    const newClubs = userClubs.includes(clubId) ? userClubs.filter((id) => id !== clubId) : [...userClubs, clubId];
    await setDoc(doc(getFirestore(), getCollectionPath(user.uid, 'settings'), 'clubsProfile'), { activeClubs: newClubs }, { merge: true });
  };

  const cardBalances = useMemo(() => {
    const monthKey = getCalendarMonthKey(new Date());
    return cards.map((card) => {
      const spent = expenses.reduce((sum, e) => {
        if (e.cardId !== card.id) return sum;
        if (card.ruleType === 'monthly') {
          if (getExpenseMonthKey(e) !== monthKey) return sum;
        }
        return sum + parseFloat(e.amount || 0);
      }, 0);
      const derivedCats = getDerivedCategories(card);
      return { ...card, spent, remaining: parseFloat(card.balance) - spent, derivedCats };
    });
  }, [cards, expenses]);

  const getRemainingForCardMonth = (card, monthKey) => {
    const spent = expenses.reduce((sum, e) => {
      if (e.cardId !== card.id) return sum;
      if (card.ruleType === 'monthly') {
        if (getExpenseMonthKey(e) !== monthKey) return sum;
      }
      return sum + parseFloat(e.amount || 0);
    }, 0);
    return parseFloat(card.balance) - spent;
  };

  const uniqueCoverageCategories = useMemo(
    () => [...new Set(cardBalances.flatMap((c) => c.derivedCats || []))].sort(),
    [cardBalances]
  );

  const sortedCardBalances = useMemo(() => [...cardBalances].sort((a, b) => {
    const aDays = a.ruleType === 'expires' ? getDaysUntilExpiry(a.expiryDate) : Infinity;
    const bDays = b.ruleType === 'expires' ? getDaysUntilExpiry(b.expiryDate) : Infinity;
    return aDays - bDays;
  }), [cardBalances]);

  const totalInitialBalance = useMemo(() => cards.reduce((sum, card) => sum + parseFloat(card.balance || 0), 0), [cards]);
  const totalRemainingBalance = useMemo(() => cardBalances.reduce((sum, card) => sum + card.remaining, 0), [cardBalances]);
  const totalPlannedExpenses = useMemo(() => expenses.reduce((sum, e) => sum + parseFloat(e.amount || 0), 0), [expenses]);
  const expiringAlerts = useMemo(() => cardBalances.filter((c) => c.ruleType === 'expires' && c.remaining > 0 && getDaysUntilExpiry(c.expiryDate) <= 30).sort((a, b) => getDaysUntilExpiry(a.expiryDate) - getDaysUntilExpiry(b.expiryDate)), [cardBalances]);

  const fundsByCategory = useMemo(() => {
    const grouped = {};
    CATEGORIES.forEach((cat) => { grouped[cat] = { total: 0, sources: [] }; });
    cardBalances.forEach((card) => {
      if (card.remaining > 0) {
        card.derivedCats.forEach((cat) => {
          if (!grouped[cat]) grouped[cat] = { total: 0, sources: [] };
          grouped[cat].total += card.remaining;
          grouped[cat].sources.push(card.name);
        });
      }
    });
    return Object.entries(grouped).filter(([_, data]) => data.total > 0).sort((a, b) => b[1].total - a[1].total);
  }, [cardBalances]);

  const sortedExpenses = useMemo(() => [...expenses].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)), [expenses]);

  useEffect(() => {
    if (activeTab === 'ai') chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [aiMessages, activeTab]);

  useEffect(() => {
    if (!isAiTyping) return undefined;
    const tick = () => {
      setAiLoadingQuote((prev) => {
        let next = AI_LOADER_QUOTES[Math.floor(Math.random() * AI_LOADER_QUOTES.length)];
        let guard = 0;
        while (next === prev && AI_LOADER_QUOTES.length > 1 && guard < 12) {
          next = AI_LOADER_QUOTES[Math.floor(Math.random() * AI_LOADER_QUOTES.length)];
          guard += 1;
        }
        return next;
      });
    };
    const id = window.setInterval(tick, 10000);
    return () => window.clearInterval(id);
  }, [isAiTyping]);

  const handleSendAI = async (e) => {
    e.preventDefault();
    if (!aiInput.trim() || isAiTyping || aiRequestInFlightRef.current) return;
    aiRequestInFlightRef.current = true;
    if (abortControllerRef.current) abortControllerRef.current.abort();
    abortControllerRef.current = new AbortController();
    const userText = aiInput.trim();
    const preferredLanguage = detectInputLanguage(userText);
    const newMessages = [...aiMessages, { role: 'user', text: userText }];
    setAiMessages(newMessages);
    setAiInput('');
    setAiLoadingQuote(AI_LOADER_QUOTES[Math.floor(Math.random() * AI_LOADER_QUOTES.length)]);
    setIsAiTyping(true);
    const activeClubsList = userClubs.map((c) => CLUBS[c].name).join(', ');
    const priorUserTexts = aiMessages.filter((m) => m.role === 'user').slice(-2).map((m) => m.text);
    const dealCatalog = retrieveRelevantDealsForChat(discountsData, userClubs, userText, priorUserTexts, 18000);
    const walletString = cardBalances.map((c) => {
      let line = `${c.name}:₪${c.remaining} (limit ₪${parseFloat(c.balance).toLocaleString()})`;
      if (c.ruleType === 'monthly') line += ' [MONTHLY: balance resets on the 1st; spending counts per calendar month]';
      return line;
    }).join(' | ');
    const futurePlansSummary = expenses
      .filter((e) => e.scheduledFor && new Date(e.scheduledFor) > new Date())
      .slice(0, 12)
      .map((e) => `${e.name}:₪${e.amount} on ${e.scheduledFor}${e.cardId ? ` (card ${cards.find((c) => c.id === e.cardId)?.name || e.cardId})` : ''}`)
      .join(' | ') || 'None';
    const systemInstruction = `You are a sharp, witty, and highly practical Israeli shopping assistant.
Your goal is to save the user money by cross-referencing what they want to buy with their specific digital wallet balances and active discount clubs.

USER'S DATA:
- Clubs: ${activeClubsList || 'None'}
- Wallet Cards (with balances): ${walletString || 'Empty'}
- Future-dated purchase plans (scheduled): ${futurePlansSummary}
- ${dealCatalog}
- For concrete מבצעים / prices / URLs, rely ONLY on the RETRIEVED block above—not on memory. If the user wants the full list, tell them to open the Clubs tab in the app.
- When the retrieved lines do not name a chain explicitly, you may still map the request to well-known Israeli retail / dining / cinema brands and combine with their wallet cards.
- Show / ticket lines: If a performer name in RETRIEVED matches the app’s embedded Israeli stand‑up roster (same list the Clubs tab uses for סטנדאפ search), treat the event as סטנדאפ / קומדיה. If the name is not on that roster and the line does not mention סטנדאפ/קומדיה, assume a music act (זמר/להקה) unless the text clearly says otherwise.

### MONTHLY & FUTURE PLANNING RULES:
- Cards marked MONTHLY reset to their full limit on the 1st of each calendar month; only expenses in that month (by "planned for" date or logged date) reduce that month's balance.
- If the user plans a purchase for a future month, treat that month's refilled balance when recommending combos (e.g. they can wait until after the 1st).
- Mention split payment at checkout when a single card cannot cover the full amount this month but another card or cash/card can cover the gap.

### TONE & PERSONALITY:
- MANDATORY OUTPUT LANGUAGE: ${preferredLanguage === 'en' ? 'English' : 'Hebrew'} only. Do not mix languages unless user asks.
- Reply natively in the EXACT language the user used.
- Be energetic, direct, and practical (Israeli style). Avoid decorative emojis unless one short icon truly clarifies tone; default to none.
- DO NOT be generic. Be a decisive advisor on money and cards.

### OUTPUT FORMAT (CRITICAL — UI parses this):
- Do NOT use markdown headings (#/##), asterisk bullets, or **bold** anywhere. No raw [text](url) markdown—only the URL: line below.
- For each distinct deal/product recommendation, output exactly one block using these KEYs (English keys only). Values are in the user's language:

---CARD---
HEADING: One line title (product + hook). Latin/English brand names are fine inside the line; keep it one readable sentence.
PRICE: One line (e.g. estimated ₪ or "לפי המבצע ב-RETRIEVED").
WHY: 1–2 short sentences.
PAY: The important part: which card(s), balances, split payment—short lines, plain text.
URL: Full https:// URL copied from RETRIEVED, or the word NONE
---END---

- Repeat the block for multiple picks. Optional: 1 short intro sentence before the first card; optional 1 short closing line (e.g. offer more options). Nothing else between blocks.
- For exhaustive "give me everything / הכל / רשימה מלאה" replies, you MAY skip CARD blocks and use a compact numbered plain list (still no ** or ###).

### RESPONSE LENGTH & LIST DEPTH:
- If the user asks for a suggestion, "what's good", "a good …", or similar—and did NOT ask for the full list—use about 3 CARD blocks. Then one short line offering more options if they want.
- If they ask for all / every / full list / הכל / רשימה מלאה / כל ה… — list everything from RETRIEVED (numbered plain list OK).
- If unclear, default to ~3 CARD blocks and offer to expand.

### DECISION LOGIC:
1. INTENT: What does the user want to buy or know?
2. MATCH: Which lines in the RETRIEVED block fit the request (and common Israeli brand names when needed)? For ambiguous solo names, use stand‑up roster vs music default as above.
3. DEALS + PAYMENT: Prefer facts from RETRIEVED only. Match with Wallet Cards balances. Every sale with a URL in RETRIEVED must appear in a CARD block with that full URL on the URL: line.
4. Do not end every reply with a forced question—only when it helps.`;
    try {
      const responseText = await fetchGeminiAIResponse(userText, aiMessages, systemInstruction, abortControllerRef.current.signal);
      if (responseText) setAiMessages([...newMessages, { role: 'model', text: responseText }]);
    } catch (err) {
      if (err.name !== 'AbortError') setAiMessages([...newMessages, { role: 'model', text: `אופס, משהו השתבש בחיבור שלי. 😅\n\n${err.message}` }]);
    } finally {
      setIsAiTyping(false);
      aiRequestInFlightRef.current = false;
    }
  };

  const resetCardForm = () => { setNewCard({ name: '', balance: '', programId: 'CUSTOM', ruleType: 'permanent', expiryDate: '', categories: [], plasticAccentHex: '' }); setEditingCardId(null); setShowCardForm(false); };
  const resetExpenseForm = () => {
    quickSpendAnchorCardIdRef.current = null;
    setNewExpense({ name: '', amount: '', expenseCategories: [], expenseMerchants: [], cardId: '', isCompleted: false, isManualSplit: false, chargeAmount: '', scheduledFor: '' });
    setMerchantSearch('');
    setEditingExpenseId(null);
    setShowExpenseForm(false);
  };

  const handleSaveCard = async (e) => {
    e.preventDefault();
    if (!user || !newCard.name || !newCard.balance) return;
    const program = PROGRAMS[newCard.programId];
    const cardData = {
      name: newCard.name, balance: parseFloat(newCard.balance), programId: newCard.programId,
      ruleType: newCard.ruleType, expiryDate: newCard.ruleType === 'expires' ? newCard.expiryDate : '',
      categories: newCard.programId === 'CUSTOM' ? newCard.categories : [], color: program.color, updatedAt: new Date().toISOString()
    };
    const hexRaw = (newCard.plasticAccentHex || '').trim();
    const normalizedHex = hexRaw.startsWith('#') ? hexRaw : (hexRaw ? `#${hexRaw}` : '');
    if (hexToRgb(normalizedHex)) cardData.plasticAccentHex = normalizedHex;
    else if (editingCardId) cardData.plasticAccentHex = deleteField();
    if (editingCardId) await updateDoc(doc(getFirestore(), getCollectionPath(user.uid, 'cards'), editingCardId), cardData);
    else await addDoc(collection(getFirestore(), getCollectionPath(user.uid, 'cards')), cardData);
    showToastMsg(editingCardId ? 'Card updated' : 'Card added to wallet');
    resetCardForm();
  };

  const handleSaveExpense = async (e) => {
    e.preventDefault();
    if (!user || !newExpense.name || !newExpense.amount || !newExpense.expenseCategories?.length || !newExpense.cardId) return;
    const reqAmount = parseFloat(newExpense.amount);
    const selectedCard = cardBalances.find((c) => c.id === newExpense.cardId);
    const planningMonthKey = newExpense.scheduledFor
      ? getCalendarMonthKey(newExpense.scheduledFor)
      : getCalendarMonthKey(new Date());
    const planningRemaining = selectedCard
      ? getRemainingForCardMonth(selectedCard, planningMonthKey)
      : 0;
    let saveAmount = reqAmount;
    let isSplit = false;
    if (selectedCard && !editingExpenseId) {
      if (newExpense.isManualSplit && newExpense.chargeAmount) saveAmount = parseFloat(newExpense.chargeAmount);
      if (saveAmount > planningRemaining) saveAmount = planningRemaining;
      if (saveAmount < reqAmount) isSplit = true;
    }
    const primaryCat = newExpense.expenseCategories[0];
    const primaryMerch = newExpense.expenseMerchants[0] || '';
    const expenseData = {
      name: isSplit ? (newExpense.name.includes('(Part') ? newExpense.name : `${newExpense.name} (Part 1)`) : newExpense.name,
      amount: saveAmount,
      category: primaryCat,
      merchantName: primaryMerch,
      expenseCategories: newExpense.expenseCategories,
      expenseMerchants: newExpense.expenseMerchants,
      cardId: newExpense.cardId,
      isCompleted: newExpense.isCompleted || false,
      scheduledFor: newExpense.scheduledFor ? new Date(`${newExpense.scheduledFor}T12:00:00`).toISOString() : null,
      updatedAt: editingExpenseId ? (newExpense.updatedAt || new Date().toISOString()) : new Date().toISOString()
    };
    if (editingExpenseId) await updateDoc(doc(getFirestore(), getCollectionPath(user.uid, 'expenses'), editingExpenseId), expenseData);
    else await addDoc(collection(getFirestore(), getCollectionPath(user.uid, 'expenses')), expenseData);
    if (isSplit) {
      showToastMsg(`Saved ₪${saveAmount}. Pick next card for remaining ₪${(reqAmount - saveAmount).toFixed(2)}`);
      setNewExpense((prev) => {
        const next = {
          ...prev,
          name: prev.name.match(/\(Part \d+\)/) ? prev.name.replace(/\(Part (\d+)\)/, (_match, p1) => `(Part ${parseInt(p1, 10) + 1})`) : `${prev.name} (Part 2)`,
          amount: (reqAmount - saveAmount).toFixed(2),
          isManualSplit: false,
          chargeAmount: '',
        };
        const cardId = pickExpenseCardId(cardBalances, next.expenseCategories, next.expenseMerchants, '', quickSpendAnchorCardIdRef.current);
        return { ...next, cardId };
      });
    } else {
      showToastMsg(editingExpenseId ? 'Update saved' : 'Purchase logged successfully');
      resetExpenseForm();
    }
  };

  const toggleExpenseCompletion = async (expense) => {
    await updateDoc(doc(getFirestore(), getCollectionPath(user.uid, 'expenses'), expense.id), { isCompleted: !expense.isCompleted });
    showToastMsg(expense.isCompleted ? 'Marked as Planned' : 'Marked as Completed');
  };

  const deleteCard = async (id) => { if (user) { await deleteDoc(doc(getFirestore(), getCollectionPath(user.uid, 'cards'), id)); showToastMsg('Card removed'); } };
  const deleteExpense = async (id) => { if (user) { await deleteDoc(doc(getFirestore(), getCollectionPath(user.uid, 'expenses'), id)); showToastMsg('Expense removed'); } };
  const startEditCard = (card) => { setNewCard({ ...card, programId: card.programId || 'CUSTOM', expiryDate: card.expiryDate || '', categories: card.categories || [], plasticAccentHex: card.plasticAccentHex || '' }); setEditingCardId(card.id); setShowCardForm(true); };
  const startEditExpense = (expense) => {
    quickSpendAnchorCardIdRef.current = null;
    const expenseCategories = expenseCategoriesForDisplay(expense);
    const expenseMerchants = expenseMerchantsForDisplay(expense);
    setNewExpense({
      ...expense,
      expenseCategories,
      expenseMerchants,
      amount: expense.amount != null ? String(expense.amount) : '',
      scheduledFor: toScheduledForInputValue(expense.scheduledFor),
      isManualSplit: false,
      chargeAmount: '',
    });
    setMerchantSearch('');
    setEditingExpenseId(expense.id);
    setShowExpenseForm(true);
  };
  const startQuickExpense = (cardId) => {
    quickSpendAnchorCardIdRef.current = cardId;
    setNewExpense({ name: '', amount: '', expenseCategories: [], expenseMerchants: [], cardId, isCompleted: false, isManualSplit: false, chargeAmount: '', scheduledFor: '' });
    setMerchantSearch('');
    setEditingExpenseId(null);
    setShowExpenseForm(true);
  };
  const addExpenseMerchantFromList = (name, cat) => {
    setNewExpense((prev) => {
      const merchants = prev.expenseMerchants.includes(name) ? prev.expenseMerchants : [...prev.expenseMerchants, name];
      const categories = prev.expenseCategories.includes(cat) ? prev.expenseCategories : [...prev.expenseCategories, cat];
      const cardId = pickExpenseCardId(cardBalances, categories, merchants, prev.cardId, quickSpendAnchorCardIdRef.current);
      return { ...prev, expenseMerchants: merchants, expenseCategories: categories, cardId };
    });
    setMerchantSearch('');
    setShowMerchantSuggestions(false);
  };
  const addExpenseMerchantFreeText = () => {
    const t = merchantSearch.trim();
    if (!t) return;
    setNewExpense((prev) => {
      if (prev.expenseMerchants.includes(t)) return prev;
      const merchants = [...prev.expenseMerchants, t];
      const cardId = pickExpenseCardId(cardBalances, prev.expenseCategories, merchants, prev.cardId, quickSpendAnchorCardIdRef.current);
      return { ...prev, expenseMerchants: merchants, cardId };
    });
    setMerchantSearch('');
    setShowMerchantSuggestions(false);
  };
  const removeExpenseMerchant = (name) => {
    setNewExpense((prev) => {
      const merchants = prev.expenseMerchants.filter((m) => m !== name);
      const cardId = pickExpenseCardId(cardBalances, prev.expenseCategories, merchants, prev.cardId, quickSpendAnchorCardIdRef.current);
      return { ...prev, expenseMerchants: merchants, cardId };
    });
  };
  const toggleExpenseCategory = (cat) => {
    setNewExpense((prev) => {
      const has = prev.expenseCategories.includes(cat);
      const categories = has ? prev.expenseCategories.filter((c) => c !== cat) : [...prev.expenseCategories, cat];
      const cardId = pickExpenseCardId(cardBalances, categories, prev.expenseMerchants, prev.cardId, quickSpendAnchorCardIdRef.current);
      return { ...prev, expenseCategories: categories, cardId };
    });
  };
  const toggleCategorySelection = (cat) => {
    setNewCard((prev) => {
      const currentCategories = prev.categories || [];
      if (currentCategories.includes(cat)) return { ...prev, categories: currentCategories.filter((c) => c !== cat) };
      return { ...prev, categories: [...currentCategories, cat] };
    });
  };

  if (loadingAuth) return <div className={`min-h-screen ${isDarkMode ? 'dark' : ''}`}><div className="min-h-screen cdv-comic-bg flex items-center justify-center text-indigo-600 dark:text-indigo-400"><Loader2 className="animate-spin" size={40} /></div></div>;

  if (!user) {
    return (
      <div className={`min-h-screen ${isDarkMode ? 'dark' : ''}`}>
        <div className="min-h-screen cdv-comic-bg flex flex-col items-center justify-center p-4 transition-colors duration-300">
          <div className="mb-10 text-center animate-in slide-in-from-bottom-4 fade-in duration-500">
            <div className="bg-gradient-to-tr from-indigo-600 to-violet-600 p-5 rounded-3xl border-[3px] border-slate-900 dark:border-slate-600 shadow-[8px_8px_0_#312e81] mb-6 inline-block"><CreditCard size={48} className="text-white" /></div>
            <h1 className="cdv-comic-title text-4xl text-slate-900 dark:text-white mb-3 tracking-tight">CardsDeVen</h1>
            <p className="text-slate-600 dark:text-slate-400 max-w-sm text-lg font-medium">Smart logic for Israeli gift cards.</p>
          </div>
          <div className="w-full max-w-md cdv-comic-panel p-8 rounded-[2rem] animate-in slide-in-from-bottom-8 fade-in duration-700 delay-150">
            <h2 className="cdv-comic-title text-2xl text-slate-900 dark:text-white mb-6 text-center">{isLoginMode ? 'Welcome Back' : 'Create Account'}</h2>
            {authError && <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 p-4 rounded-2xl mb-6 text-sm text-center border border-red-100 dark:border-red-800/50">{authError}</div>}
            <form onSubmit={handleAuthSubmit} className="space-y-5">
              <div>
                <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Email Address</label>
                <div className="relative group">
                  <Mail className="absolute left-4 top-3.5 text-slate-400 group-focus-within:text-blue-500 transition-colors" size={20} />
                  <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-full pl-12 p-3.5 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white rounded-2xl focus:ring-4 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all" placeholder="you@example.com" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Password</label>
                <div className="relative group">
                  <Lock className="absolute left-4 top-3.5 text-slate-400 group-focus-within:text-blue-500 transition-colors" size={20} />
                  <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} className="w-full pl-12 p-3.5 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white rounded-2xl focus:ring-4 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all" placeholder="••••••••" />
                </div>
              </div>
              <button type="submit" disabled={isProcessingAuth} className="w-full bg-slate-900 dark:bg-blue-600 hover:bg-slate-800 dark:hover:bg-blue-500 text-white font-bold py-4 rounded-2xl transition-all shadow-lg hover:shadow-xl disabled:opacity-70 mt-8 flex justify-center items-center active:scale-[0.98]">
                {isProcessingAuth ? <Loader2 className="animate-spin" size={20} /> : (isLoginMode ? 'Sign In' : 'Create Account')}
              </button>
            </form>
            <div className="mt-8 text-center text-sm text-slate-500 dark:text-slate-400">
              <button type="button" onClick={() => { setIsLoginMode(!isLoginMode); setAuthError(''); }} className="text-blue-600 dark:text-blue-400 font-bold hover:underline">{isLoginMode ? 'Switch to Sign Up' : 'Switch to Sign In'}</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`min-h-screen ${isDarkMode ? 'dark' : ''} font-sans pb-28 transition-colors duration-300`}>
      <div className="min-h-screen cdv-comic-bg text-slate-800 dark:text-slate-200 transition-colors duration-300 relative">
        {toast.visible && (
          <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[200] animate-in slide-in-from-top-4 fade-in duration-300 max-w-[calc(100vw-2rem)]">
            <div className={`${toast.type === 'error' ? 'bg-red-600' : 'bg-slate-900 dark:bg-white text-white dark:text-slate-900'} px-6 py-3 rounded-full shadow-2xl font-medium flex items-center gap-2`}>
              {toast.type === 'success' ? <CheckCircle2 size={18} className="text-emerald-400 dark:text-emerald-500" /> : <AlertCircle size={18} className="text-white" />}
              {toast.message}
            </div>
          </div>
        )}

        <div className="fixed top-3 right-3 z-50 flex flex-col items-end gap-2">
          <div className="flex items-center gap-2 rounded-2xl border-[3px] border-slate-900 dark:border-slate-600 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md px-2 py-2 shadow-[4px_4px_0_#6366f1] dark:shadow-[4px_4px_0_#4f46e5]">
            <button type="button" onClick={() => setIsDarkMode(!isDarkMode)} className="p-2.5 bg-slate-100 dark:bg-slate-800 rounded-xl hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors text-slate-600 dark:text-slate-300" aria-label={isDarkMode ? 'Light mode' : 'Dark mode'}>{isDarkMode ? <Sun size={18} /> : <Moon size={18} />}</button>
            <button type="button" onClick={handleSignOut} className="p-2.5 bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-xl hover:bg-red-100 dark:hover:bg-red-900/50 transition-colors" aria-label="Sign out"><LogOut size={18} /></button>
          </div>
          <p className="text-[10px] sm:text-xs font-medium text-slate-600 dark:text-slate-400 max-w-[12rem] truncate text-right px-1" title={user.email}>{user.email}</p>
        </div>

        <main className="max-w-6xl mx-auto p-4 sm:p-6 pt-4 sm:pt-6">
          {/* Dashboard */}
          {activeTab === 'dashboard' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
              {expiringAlerts.length > 0 && (
                <div className="bg-gradient-to-r from-orange-500 to-red-600 rounded-[2rem] p-6 border-[3px] border-slate-900 dark:border-slate-800 shadow-[8px_8px_0_#431407] text-white flex flex-col sm:flex-row items-center gap-4 sm:justify-between animate-in zoom-in-95">
                  <div className="flex items-center gap-4">
                    <div className="bg-white/20 p-3 rounded-full border-2 border-white/30"><Clock size={28} /></div>
                    <div><h3 className="cdv-comic-title text-lg">Use It Or Lose It</h3><p className="text-white/85 text-sm font-medium">{expiringAlerts.length} card(s) expiring within 30 days!</p></div>
                  </div>
                  <div className="w-full sm:w-auto space-y-2">
                    {expiringAlerts.map((card) => (
                      <div key={card.id} className="bg-black/20 px-4 py-2 rounded-xl flex justify-between items-center gap-6 backdrop-blur-md">
                        <span className="font-bold">{card.name}</span>
                        <div className="text-right"><div className="font-black">₪{card.remaining.toLocaleString()}</div><div className="text-[10px] uppercase tracking-wider text-orange-200">In {getDaysUntilExpiry(card.expiryDate)} Days</div></div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-gradient-to-br from-slate-900 to-slate-800 text-white p-8 rounded-[2rem] border-[3px] border-slate-900 dark:border-slate-600 shadow-[8px_8px_0_#6366f1] relative overflow-hidden group hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-[6px_6px_0_#6366f1] transition-all">
                  <div className="relative z-10"><div className="text-slate-300 text-sm font-bold mb-2 uppercase tracking-widest font-mono">Total Portfolio</div><div className="cdv-comic-title text-5xl mb-1">₪{totalInitialBalance.toLocaleString()}</div><div className="text-slate-400 text-sm">Initial setup across {cards.length} cards</div></div>
                  <div className="absolute -right-8 -bottom-8 bg-white/5 p-8 rounded-full group-hover:scale-110 transition-transform duration-500"><CreditCard size={100} className="text-white/10" /></div>
                </div>
                <div className="bg-gradient-to-br from-emerald-500 to-emerald-700 text-white p-8 rounded-[2rem] border-[3px] border-emerald-950 shadow-[8px_8px_0_#065f46] relative overflow-hidden group hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-[6px_6px_0_#065f46] transition-all">
                  <div className="relative z-10"><div className="text-emerald-100 text-sm font-bold mb-2 uppercase tracking-widest font-mono">Available Power</div><div className="cdv-comic-title text-5xl mb-1">₪{totalRemainingBalance.toLocaleString()}</div><div className="text-emerald-100 text-sm">After ₪{totalPlannedExpenses.toLocaleString()} total expenses</div></div>
                  <div className="absolute -right-8 -bottom-8 bg-black/5 p-8 rounded-full group-hover:scale-110 transition-transform duration-500"><Receipt size={100} className="text-black/10" /></div>
                </div>
              </div>

              <div>
                <h2 className="cdv-comic-title text-2xl text-slate-900 dark:text-white mb-6">Budget by Category</h2>
                {fundsByCategory.length === 0 ? (
                  <div className="cdv-comic-panel cdv-comic-panel--dashed text-center p-12 rounded-[2rem]"><PieChart size={48} className="mx-auto mb-4 text-indigo-400 dark:text-indigo-500" /><p className="text-slate-600 dark:text-slate-400 font-medium">Add cards to populate your category breakdown.</p></div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                    {fundsByCategory.map(([category, data]) => (
                      <div key={category} className="cdv-comic-panel p-6 rounded-[1.5rem] hover:-translate-y-1 transition-transform group">
                        <div className="flex justify-between items-start mb-4">
                          <div className="font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2 font-mono text-sm"><span>{CATEGORY_ICONS[category]}</span><span className="leading-tight">{category}</span></div>
                          <div className="bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-300 px-3 py-1 border-2 border-emerald-700/30 text-xs font-extrabold uppercase">Available</div>
                        </div>
                        <div className="cdv-comic-title text-3xl text-slate-900 dark:text-white mb-3">₪{data.total.toLocaleString()}</div>
                        <div className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed"><span className="font-bold">Sources:</span> {data.sources.join(', ')}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Wallets */}
          {activeTab === 'wallets' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="flex flex-col sm:flex-row sm:justify-between sm:items-end gap-4">
                <div>
                  <h2 className="cdv-comic-title text-3xl text-slate-900 dark:text-white tracking-tight">Digital Wallet</h2>
                  <p className="text-slate-600 dark:text-slate-400 mt-1 font-medium">Manage your active gift cards and budgets.</p>
                </div>
                <button
                  type="button"
                  onClick={() => { resetCardForm(); setShowCardForm(true); }}
                  className="border-[3px] border-slate-900 dark:border-slate-500 bg-indigo-600 text-white px-5 py-3 font-extrabold flex items-center justify-center gap-2 shadow-[6px_6px_0_#312e81] hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-[4px_4px_0_#312e81] transition-all font-mono text-sm uppercase tracking-wide"
                >
                  <Plus size={20} /> Add Card
                </button>
              </div>

              {cards.length === 0 ? (
                <div className="cdv-comic-panel cdv-comic-panel--dashed text-center p-16 rounded-[2rem]">
                  <CreditCard size={64} className="mx-auto mb-6 text-indigo-500 dark:text-indigo-400" />
                  <h3 className="cdv-comic-title text-xl text-slate-900 dark:text-white mb-2">Your wallet is empty</h3>
                  <p className="text-slate-600 dark:text-slate-400 max-w-sm mx-auto">Add your first funding source or gift card.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
                  {cardBalances.map((card) => {
                    const ruleData = RULE_TYPES[card.ruleType?.toUpperCase()] || RULE_TYPES.PERMANENT;
                    const progData = PROGRAMS[card.programId || 'CUSTOM'] || PROGRAMS.CUSTOM;
                    const chromeGradient = buildPlasticGradientFromHex(card.plasticAccentHex) || (WALLET_CARD_CHROME[card.programId] || WALLET_CARD_CHROME.CUSTOM);
                    const percentRemaining = Math.max(0, Math.min(100, (card.remaining / parseFloat(card.balance)) * 100));
                    const isExpiringSoon = card.ruleType === 'expires' && getDaysUntilExpiry(card.expiryDate) <= 30;
                    return (
                      <div
                        key={card.id}
                        className={`cdv-comic-panel rounded-[2rem] p-6 flex flex-col gap-6 ${isExpiringSoon ? 'ring-4 ring-orange-500 ring-offset-2 dark:ring-offset-[#020617]' : ''}`}
                      >
                        <div className="flex flex-col lg:flex-row gap-6 lg:gap-8 lg:items-start">
                          <WalletCreditPlastic
                            balanceRemaining={card.remaining}
                            balanceLimit={parseFloat(card.balance)}
                            programName={progData.name}
                            chromeGradient={chromeGradient}
                            ruleType={card.ruleType}
                            expiryDate={card.expiryDate}
                            isExpiringSoon={isExpiringSoon}
                          />
                          <div className="flex-1 min-w-0 flex flex-col gap-4">
                            <div className="flex flex-col gap-3">
                              <h3 className="cdv-comic-title text-xl sm:text-2xl text-slate-900 dark:text-white tracking-tight leading-snug break-words pr-1">{card.name}</h3>
                              <div className="flex flex-wrap items-center justify-between gap-3">
                                <div className={`flex flex-wrap items-center gap-2 text-xs font-bold uppercase tracking-wider font-mono min-w-0 ${isExpiringSoon ? 'text-orange-600 dark:text-orange-400' : 'text-slate-600 dark:text-slate-400'}`}>
                                  <ruleData.icon size={14} className="shrink-0" />
                                  <span>{ruleData.label}</span>
                                  {card.ruleType === 'expires' && card.expiryDate && <span>• {new Date(card.expiryDate).toLocaleDateString()}</span>}
                                  {isExpiringSoon && <span className="text-orange-500">• EXPIRING</span>}
                                </div>
                                <div className="flex items-center gap-1 shrink-0 border-[3px] border-slate-900 dark:border-slate-600 shadow-[3px_3px_0_#6366f1] bg-slate-100 dark:bg-slate-800/80 p-1 self-start sm:self-center">
                                  <button type="button" title="Edit card" onClick={() => startEditCard(card)} className="p-2.5 hover:bg-indigo-100 dark:hover:bg-slate-700 rounded-md transition-colors text-slate-900 dark:text-slate-100"><Edit2 size={17} /></button>
                                  <span className="w-px h-5 bg-slate-300 dark:bg-slate-600" aria-hidden />
                                  <button type="button" title="Delete card" onClick={() => { if (window.confirm('Delete this card?')) deleteCard(card.id); }} className="p-2.5 hover:bg-red-100 dark:hover:bg-red-950/50 rounded-md transition-colors text-red-600 dark:text-red-400"><Trash2 size={17} /></button>
                                </div>
                              </div>
                            </div>
                            <div className="w-full bg-slate-200 dark:bg-slate-800 h-2.5 border-2 border-slate-900/10 dark:border-slate-700 overflow-hidden">
                              <div className="bg-gradient-to-r from-indigo-500 to-violet-500 h-full transition-all duration-1000 ease-out" style={{ width: `${percentRemaining}%` }} />
                            </div>
                            <button
                              type="button"
                              onClick={() => startQuickExpense(card.id)}
                              className="w-full flex items-center justify-center gap-2 py-3 border-[3px] border-slate-900 dark:border-slate-600 bg-indigo-600 text-white font-extrabold text-sm uppercase tracking-wide shadow-[4px_4px_0_#312e81] hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-[2px_2px_0_#312e81] transition-all font-mono"
                            >
                              <Zap size={18} className="fill-current shrink-0" />
                              <span>Quick spend</span>
                            </button>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2 pt-1 border-t-[3px] border-slate-200 dark:border-slate-700">
                          {card.derivedCats.map((cat) => (
                            <span key={cat} className="bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-[2px] border-slate-900/15 dark:border-slate-600 px-3 py-1.5 text-xs font-bold shadow-[2px_2px_0_#6366f1] flex items-center gap-1.5 font-mono">
                              {CATEGORY_ICONS[cat]} {cat}
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Planner */}
          {activeTab === 'planner' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="flex justify-between items-end">
                <div><h2 className="text-3xl font-bold text-slate-900 dark:text-white tracking-tight">Expense Planner</h2><p className="text-slate-500 dark:text-slate-400 mt-1">Plan and verify purchases against your wallet rules.</p></div>
                <button onClick={() => { resetExpenseForm(); setShowExpenseForm(true); }} className="bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-3 rounded-xl font-bold flex items-center gap-2 hover:scale-105 active:scale-95 transition-all shadow-lg hover:shadow-xl"><Plus size={20} /> Plan Purchase</button>
              </div>
              <div className="bg-white dark:bg-slate-900 rounded-[2rem] shadow-sm border border-slate-100 dark:border-slate-800 overflow-hidden">
                <div className="p-6 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 flex justify-between items-center"><h3 className="font-bold text-lg text-slate-800 dark:text-slate-100">Ledger</h3><span className="bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 px-4 py-1.5 rounded-full text-sm font-bold">Total: ₪{totalPlannedExpenses.toLocaleString()}</span></div>
                {expenses.length === 0 ? (
                  <div className="p-16 text-center text-slate-500 dark:text-slate-400 flex flex-col items-center"><Receipt size={48} className="text-slate-200 dark:text-slate-800 mb-4" /><p className="font-medium text-lg">No purchases planned yet.</p><p className="text-sm">Plan a purchase to reserve funds.</p></div>
                ) : (
                  <div className="divide-y divide-slate-100 dark:divide-slate-800">
                    {sortedExpenses.map((expense) => {
                      const sourceCard = cards.find((c) => c.id === expense.cardId);
                      const progColor = sourceCard ? (PROGRAMS[sourceCard.programId || 'CUSTOM'] || PROGRAMS.CUSTOM).color : 'bg-slate-200';
                      return (
                        <div key={expense.id} className={`p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4 transition-colors group ${expense.isCompleted ? 'bg-emerald-50/30 dark:bg-emerald-900/10' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}>
                          <div className="flex items-center gap-4 sm:gap-5">
                            <button onClick={() => toggleExpenseCompletion(expense)} className={`w-12 h-12 sm:w-14 sm:h-14 shrink-0 rounded-2xl flex flex-col items-center justify-center transition-all shadow-sm ${expense.isCompleted ? 'bg-emerald-500 text-white' : 'bg-white dark:bg-slate-800 border-2 border-dashed border-slate-300 dark:border-slate-600 text-slate-400 hover:border-emerald-400 hover:text-emerald-500'}`}>{expense.isCompleted ? <CheckSquare size={20} className="sm:w-6 sm:h-6" /> : <Square size={20} className="sm:w-6 sm:h-6" />}<span className="text-[8px] sm:text-[9px] font-bold uppercase mt-0.5">{expense.isCompleted ? 'Paid' : 'Plan'}</span></button>
                            <div>
                              <div className={`font-bold text-base sm:text-lg mb-1 flex flex-wrap items-center gap-2 ${expense.isCompleted ? 'text-slate-900 dark:text-white' : 'text-slate-700 dark:text-slate-300'}`}>
                                {expense.name}
                                {expense.scheduledFor && (() => {
                                  const d = new Date(expense.scheduledFor);
                                  const isFuture = d > new Date();
                                  return (
                                    <span className={`text-[9px] sm:text-[10px] px-2 py-0.5 rounded font-bold uppercase tracking-wider ${isFuture ? 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300' : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'}`}>
                                      {isFuture ? 'Planned ' : ''}{d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                                    </span>
                                  );
                                })()}
                                {expenseMerchantsForDisplay(expense).map((m) => {
                                  const mc = KNOWN_MERCHANTS[m]?.cat || expenseCategoriesForDisplay(expense)[0] || expense.category;
                                  return (
                                    <span key={m} className="bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-[9px] sm:text-[10px] px-2 py-0.5 rounded font-bold uppercase tracking-wider flex items-center gap-1">
                                      <MerchantIcon merchantName={m} category={mc} className="w-4 h-4 rounded-sm border-0" />
                                      {m.split('(')[0].trim()}
                                    </span>
                                  );
                                })}
                              </div>
                              <div className="flex flex-wrap items-center gap-2 text-xs">
                                <span className="font-medium text-slate-500">{expenseCategoriesForDisplay(expense).map((cat) => `${CATEGORY_ICONS[cat]} ${cat}`).join(' · ') || '—'}</span>
                                <span className="text-slate-300 dark:text-slate-600">•</span>
                                <span className="font-bold flex items-center gap-1"><span className={`w-2 h-2 rounded-full ${progColor}`}></span>{sourceCard?.name || 'Deleted Card'}</span>
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center justify-between sm:justify-end gap-6 w-full sm:w-auto pl-16 sm:pl-0">
                            <div className={`font-black text-xl sm:text-2xl ${expense.isCompleted ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-600 dark:text-slate-400'}`}>₪{parseFloat(expense.amount).toLocaleString()}</div>
                            <div className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 flex gap-1 transition-opacity">
                              <button onClick={() => startEditExpense(expense)} className="p-2.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-slate-800 rounded-xl transition-all"><Edit2 size={18} /></button>
                              <button onClick={() => deleteExpense(expense.id)} className="p-2.5 text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-slate-800 rounded-xl transition-all"><Trash2 size={18} /></button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Insights */}
          {activeTab === 'insights' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div><h2 className="text-3xl font-bold text-slate-900 dark:text-white tracking-tight">Smart Merchant Search</h2><p className="text-slate-500 dark:text-slate-400 mt-1">Find out exactly which cards & discounts to use at the checkout counter.</p></div>

              {cardBalances.length > 0 && uniqueCoverageCategories.length > 0 && (
                <div className="rounded-[2rem] bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 shadow-lg shadow-slate-200/50 dark:shadow-none overflow-hidden">
                  <div className="px-5 sm:px-8 py-5 sm:py-6 border-b border-slate-100 dark:border-slate-800 bg-gradient-to-r from-slate-50 to-emerald-50/30 dark:from-slate-800/50 dark:to-emerald-950/20">
                    <h3 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-white tracking-tight">Broad Category Coverage</h3>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 max-w-2xl">See which wallet cards support each shopping category. On small screens, categories stack; on larger screens, use the matrix with horizontal scroll if you have many cards.</p>
                  </div>
                  <div className="p-4 sm:p-6">
                    <div className="sm:hidden space-y-4">
                      {uniqueCoverageCategories.map((category) => {
                        const supporting = cardBalances.filter((c) => (c.derivedCats || []).includes(category));
                        return (
                          <div key={category} className="rounded-2xl bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-700 p-4 shadow-sm">
                            <div className="flex items-center gap-2 mb-3 font-bold text-slate-800 dark:text-slate-100">
                              <span className="text-xl" aria-hidden>{CATEGORY_ICONS[category] || '🏷️'}</span>
                              <span className="leading-tight text-sm sm:text-base">{category}</span>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {supporting.length === 0 ? (
                                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500 bg-slate-200/60 dark:bg-slate-700/50 px-2.5 py-1 rounded-full">No coverage</span>
                              ) : (
                                supporting.map((c) => (
                                  <span key={c.id} className="text-xs font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-900/40 border border-emerald-200/80 dark:border-emerald-800/60 px-2.5 py-1 rounded-full">{c.name}</span>
                                ))
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="hidden sm:block overflow-x-auto rounded-xl border border-slate-100 dark:border-slate-800">
                      <table className="min-w-[800px] w-full border-collapse text-sm">
                        <thead>
                          <tr className="bg-slate-100 dark:bg-slate-800/80">
                            <th scope="col" className="sticky left-0 z-30 px-4 py-3 text-left font-bold text-slate-700 dark:text-slate-200 border-b border-r border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 min-w-[200px] shadow-[4px_0_12px_-4px_rgba(0,0,0,0.12)] dark:shadow-[4px_0_12px_-4px_rgba(0,0,0,0.4)]">Coverage Areas</th>
                            {cardBalances.map((card) => {
                              const prog = PROGRAMS[card.programId || 'CUSTOM'] || PROGRAMS.CUSTOM;
                              return (
                                <th key={card.id} scope="col" className="px-3 py-3 text-center font-bold text-slate-800 dark:text-slate-100 border-b border-slate-200 dark:border-slate-700 align-bottom min-w-[120px]">
                                  <div className="flex flex-col items-center gap-1.5">
                                    <span className={`h-3 w-3 rounded-full shrink-0 ring-2 ring-white/30 shadow-sm ${card.color || GRADIENTS[0]}`} title="" aria-hidden />
                                    <span className="text-xs sm:text-sm leading-tight">{card.name}</span>
                                    <span className="text-[9px] font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500 max-w-[140px] truncate">{prog.name}</span>
                                  </div>
                                </th>
                              );
                            })}
                          </tr>
                        </thead>
                        <tbody>
                          {uniqueCoverageCategories.map((category) => (
                            <tr key={category} className="group border-b border-slate-100 dark:border-slate-800/80 hover:bg-slate-50/90 dark:hover:bg-slate-800/40 transition-colors">
                              <th scope="row" className="sticky left-0 z-20 px-4 py-3 text-left font-semibold text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-900 group-hover:bg-slate-50 dark:group-hover:bg-slate-800/80 border-r border-slate-100 dark:border-slate-800 shadow-[4px_0_12px_-4px_rgba(0,0,0,0.08)] dark:shadow-[4px_0_12px_-4px_rgba(0,0,0,0.35)]">
                                <span className="inline-flex items-center gap-2">
                                  <span className="text-lg" aria-hidden>{CATEGORY_ICONS[category] || '🏷️'}</span>
                                  <span className="leading-tight">{category}</span>
                                </span>
                              </th>
                              {cardBalances.map((card) => (
                                <td key={`${category}-${card.id}`} className="p-2 text-center align-middle border-l border-slate-50 dark:border-slate-800/50">
                                  {(card.derivedCats || []).includes(category) ? (
                                    <div className="flex justify-center"><CheckCircle2 className="text-emerald-500 dark:text-emerald-400" size={22} strokeWidth={2.25} aria-label="Covered" /></div>
                                  ) : (
                                    <div className="flex justify-center"><span className="block w-2 h-2 rounded-full bg-slate-200 dark:bg-slate-600" aria-hidden /></div>
                                  )}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              <div className="bg-gradient-to-r from-blue-600 to-indigo-600 rounded-[2rem] p-6 sm:p-8 shadow-xl text-white">
                <h3 className="text-xl font-bold mb-4 flex items-center gap-2"><Search size={24} /> Where are you paying?</h3>
                <input type="text" value={insightSearch} onChange={(e) => setInsightSearch(e.target.value)} placeholder="e.g. Zara, Pizza, Cinema, ASOS..." className="w-full pl-5 pr-12 py-4 rounded-2xl bg-white/10 backdrop-blur-md border border-white/20 text-white placeholder-white/60 focus:ring-4 focus:ring-white/30 outline-none font-medium text-lg transition-all" />
                {insightSearch && (
                  <div className="mt-6 space-y-4">
                    {(() => {
                      const matches = getSmartMatches(insightSearch, 5);
                      if (matches.length === 0) return <div className="text-white/80 font-medium bg-white/10 p-4 rounded-2xl border border-white/20">Merchant not found in official database. Generic category rules will apply.</div>;
                      return matches.map(([searchMatch, mData]) => {
                        const acceptedCards = sortedCardBalances.filter((c) => checkCompatibility(c, mData.cat, searchMatch).allowed && c.remaining > 0);
                        const merchantDeals = discountsData.filter(
                          (d) => userClubs.includes(d.c) && dealMatchesInsightMerchant(d, searchMatch, insightSearch)
                        );
                        return (
                          <div key={searchMatch} className="animate-in slide-in-from-bottom-2 fade-in bg-white/10 p-5 rounded-2xl border border-white/20 shadow-md">
                            <div className="flex items-center gap-3 mb-4"><MerchantIcon merchantName={searchMatch} category={mData.cat} className="w-10 h-10 rounded-full" /><div><div className="text-base sm:text-lg font-bold text-white leading-tight">{searchMatch}</div><div className="text-[10px] sm:text-xs uppercase tracking-widest text-blue-200 mt-0.5">{CATEGORY_ICONS[mData.cat]} {mData.cat}</div></div></div>
                            {acceptedCards.length > 0 ? (
                              <div className="flex flex-wrap gap-2 sm:gap-3">
                                {acceptedCards.map((c) => {
                                  const isExpiringSoon = c.ruleType === 'expires' && getDaysUntilExpiry(c.expiryDate) <= 30;
                                  return <div key={c.id} className={`flex items-center gap-1.5 px-3 py-2 rounded-xl font-bold shadow-md text-sm ${isExpiringSoon ? 'bg-orange-100 text-orange-900 border-2 border-orange-500' : 'bg-white text-slate-900'}`}>{isExpiringSoon ? <Clock size={16} className="text-orange-600" /> : <CheckCircle2 size={16} className="text-emerald-500" />} <span className="truncate max-w-[100px] sm:max-w-none">{c.name}</span><span className={`${isExpiringSoon ? 'bg-orange-200 text-orange-900' : 'bg-emerald-100 text-emerald-800'} px-1.5 py-0.5 rounded text-xs ml-0.5`}>₪{c.remaining.toLocaleString()}</span></div>;
                                })}
                              </div>
                            ) : (
                              <div className="bg-red-500/20 border border-red-500/50 text-white px-4 py-3 rounded-xl inline-flex items-start sm:items-center gap-2 font-medium text-sm sm:text-base"><AlertCircle size={18} className="shrink-0 mt-0.5 sm:mt-0" /><span>No active cards have funds for this merchant.</span></div>
                            )}
                            {merchantDeals.length > 0 && (
                              <div className="mt-4 pt-4 border-t border-white/20">
                                <div className="text-[10px] font-bold uppercase tracking-wider text-amber-200 mb-3 flex items-center gap-1.5"><Gift size={14} /> Club Deals Available</div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                  {merchantDeals.map((deal, idx) => (
                                    <div key={deal._bhKey || deal.product_id || idx} className="bg-black/20 border border-white/10 rounded-xl p-3 text-sm flex gap-3 items-start backdrop-blur-sm">
                                      <span className={`px-2 py-1 rounded text-[10px] font-bold text-white whitespace-nowrap ${CLUBS[deal.c].color}`}>{CLUBS[deal.c].name}</span>
                                      <DealLink url={deal.url || deal.product_url} className="text-amber-50 font-medium text-sm leading-tight hover:underline">{deal.d}</DealLink>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      });
                    })()}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Clubs */}
          {activeTab === 'clubs' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div><h2 className="text-3xl font-bold text-slate-900 dark:text-white tracking-tight">Discount Clubs</h2><p className="text-slate-500 dark:text-slate-400 mt-1">Select your clubs to unlock exclusive deals.</p></div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {Object.values(CLUBS).map((club) => {
                  const isActive = userClubs.includes(club.id);
                  return <button key={club.id} onClick={() => handleToggleClub(club.id)} className={`p-4 rounded-2xl border-2 transition-all flex items-center justify-between shadow-sm ${isActive ? `border-transparent ${club.color} text-white shadow-lg transform scale-105` : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-500 hover:border-slate-300 dark:hover:border-slate-600'}`}><span className="font-bold text-lg">{club.name}</span>{isActive ? <CheckCircle2 size={24} /> : <Plus size={24} />}</button>;
                })}
              </div>
              <div className="bg-white dark:bg-slate-900 rounded-[2rem] shadow-sm border border-slate-100 dark:border-slate-800 overflow-hidden">
                <div className="p-6 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                  <div className="relative max-w-md"><Search className="absolute left-3.5 top-3.5 text-slate-400" size={18} /><input type="text" value={clubSearch} onChange={(e) => setClubSearch(e.target.value)} placeholder="Search discounts (e.g. Pizza, FOX)..." className="w-full pl-10 p-3.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white rounded-xl focus:ring-4 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all font-medium" /></div>
                </div>
                <div className="p-6">
                  {userClubs.length === 0 ? (
                    <div className="text-center p-8"><Gift size={48} className="mx-auto mb-4 text-slate-200 dark:text-slate-800" /><p className="text-slate-500 font-medium">Select a club above to see your available deals.</p></div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {discountsData.filter((d) => userClubs.includes(d.c) && dealMatchesClubSearch(d, clubSearch)).map((deal, idx) => (
                        <div key={deal.product_id ? `pais-${deal.product_id}` : deal._bhKey || `${deal.c}-${idx}-${deal.m.slice(0, 40)}`} className="flex gap-4 items-start p-4 border border-slate-100 dark:border-slate-800 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors group">
                          <MerchantIcon merchantName={deal.m} category={KNOWN_MERCHANTS[deal.m]?.cat || 'Other'} className="w-12 h-12 rounded-lg" />
                          <div>
                            <div className="font-bold text-slate-900 dark:text-white flex items-center gap-2 mb-1">{deal.m.split('(')[0].trim()}<span className={`text-[9px] px-1.5 py-0.5 rounded text-white ${CLUBS[deal.c].color}`}>{CLUBS[deal.c].name}</span></div>
                            <DealLink url={deal.url || deal.product_url} className="text-sm font-medium text-emerald-600 dark:text-emerald-400 leading-tight hover:underline inline-block">{deal.d}</DealLink>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* AI — brutalist chat (scoped styles in aiChatBrutalist.css) */}
          {activeTab === 'ai' && (
            <div
              className="ai-chat-brutalist mx-auto w-full max-w-[19.5rem] sm:max-w-[22rem] space-y-4 sm:space-y-5 animate-in fade-in slide-in-from-bottom-4 duration-500 flex flex-col text-left h-[calc(100dvh-7rem)] min-h-[26rem] mb-1"
            >
              <div className="ai-brutalist-header-row">
                <div>
                  <h2 className="ai-brutalist-title">SMART ASSISTANT</h2>
                  <p className="ai-brutalist-sub">Ask what to buy — I’ll match clubs + wallet.</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (abortControllerRef.current) abortControllerRef.current.abort();
                    const fresh = [{ role: 'model', text: 'היסטוריית הצ\'אט נמחקה! אז מה קונים היום? 😎' }];
                    setAiMessages(fresh);
                    try { localStorage.setItem(AI_CHAT_STORAGE_KEY, JSON.stringify(fresh)); } catch { /* ignore */ }
                    setIsAiTyping(false);
                  }}
                  className="ai-brutalist-clear"
                  title="Clear Chat History"
                >
                  <Trash2 size={20} className="text-violet-100" />
                </button>
              </div>
              <div className="ai-brutalist-shell min-h-0">
                <div className="ai-brutalist-tip">TIP: Budget + item + area = sharper combos.</div>
                <div className="ai-brutalist-scroll space-y-4">
                  {aiMessages.map((msg, idx) => {
                    const replyLang = msg.role === 'model' ? precedingUserLang(aiMessages, idx) : 'he';
                    return (
                      <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        {msg.role === 'model' && (
                          <div className="ai-brutalist-avatar">
                            <Bot size={16} className="text-violet-200" aria-hidden />
                          </div>
                        )}
                        <div
                          className={`ai-brutalist-bubble break-words ${msg.role === 'user' ? 'ai-brutalist-bubble--user text-left whitespace-pre-wrap' : `ai-brutalist-bubble--model ${replyLang === 'en' ? 'text-left' : 'text-right'}`}`}
                          dir={msg.role === 'model' ? (replyLang === 'en' ? 'ltr' : 'rtl') : 'auto'}
                        >
                          <div className="ai-brutalist-meta">{msg.role === 'user' ? 'You' : 'Advisor'}</div>
                          <div dir="auto">
                            {msg.role === 'model' ? renderAdvisorMessage(msg.text, replyLang) : renderChatText(msg.text)}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {isAiTyping && (
                    <div className="flex justify-start items-start gap-2">
                      <div className="ai-brutalist-avatar">
                        <Bot size={16} className="text-violet-200 opacity-60" aria-hidden />
                      </div>
                      <div className="ai-loader-card">
                        <HamsterWheelLoader />
                        {aiLoadingQuote && <p className="ai-loader-quote">{aiLoadingQuote}</p>}
                      </div>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>
                <div className="ai-brutalist-form-footer">
                  <form onSubmit={handleSendAI} className="brutalist-container">
                    <div className="brutalist-input-wrap smooth-type">
                      <input
                        id="ai-brutalist-input"
                        type="text"
                        value={aiInput}
                        onChange={(e) => setAiInput(e.target.value)}
                        placeholder="e.g. I need pizza for 10 people…"
                        disabled={isAiTyping}
                        className="brutalist-input"
                        autoComplete="off"
                      />
                      <label htmlFor="ai-brutalist-input" className="brutalist-label">MESSAGE</label>
                      <button type="submit" disabled={!aiInput.trim() || isAiTyping} className="brutalist-send-btn" aria-label="Send">
                        <Send size={18} />
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            </div>
          )}
        </main>

        <nav className="cdv-comic-nav fixed bottom-0 left-0 right-0 backdrop-blur-xl px-2 sm:px-6 py-4 flex justify-around sm:justify-center sm:gap-8 lg:gap-16 z-40 transition-colors overflow-x-auto">
          {[{ id: 'dashboard', icon: LayoutDashboard, label: 'Dashboard' }, { id: 'wallets', icon: CreditCard, label: 'Wallet' }, { id: 'planner', icon: Receipt, label: 'Planner' }, { id: 'insights', icon: Search, label: 'Search' }, { id: 'clubs', icon: Gift, label: 'Clubs' }, { id: 'ai', icon: Bot, label: 'Smart AI' }].map((item) => (
            <button key={item.id} onClick={() => setActiveTab(item.id)} className={`flex flex-col items-center gap-1.5 transition-all duration-300 min-w-[50px] ${activeTab === item.id ? 'text-indigo-600 dark:text-violet-400 scale-110' : 'text-slate-500 dark:text-slate-500 hover:text-slate-800 dark:hover:text-slate-300 hover:scale-105'}`}>
              <item.icon size={24} className={activeTab === item.id ? 'stroke-[2.5px]' : ''} />
              <span className="text-[9px] sm:text-xs font-bold uppercase tracking-widest mt-1 opacity-80 whitespace-nowrap">{item.label}</span>
            </button>
          ))}
        </nav>

        <Modal isOpen={showCardForm} onClose={resetCardForm} title={editingCardId ? 'Edit Card' : 'Add Program Card'}>
          <form onSubmit={handleSaveCard} className="space-y-6">
            <div>
              <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-3">Select Program Type</label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {Object.values(PROGRAMS).map((prog) => (
                  <div key={prog.id} onClick={() => setNewCard({ ...newCard, programId: prog.id, categories: [] })} className={`cursor-pointer p-3 rounded-xl border-2 flex flex-col justify-center text-center gap-1 transition-all ${newCard.programId === prog.id ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 shadow-md' : 'border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-600'}`}>
                    <span className="font-bold text-sm leading-tight">{prog.name}</span>
                    <span className="text-[10px] opacity-70 leading-tight">{prog.description}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div><label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">Display Name</label><input type="text" required value={newCard.name} onChange={(e) => setNewCard({ ...newCard, name: e.target.value })} className="w-full p-3.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white rounded-xl focus:ring-4 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all font-medium" placeholder="e.g. My Cibus Card" /></div>
              <div><label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">Total Limit (₪)</label><input type="number" required min="0" step="0.01" value={newCard.balance} onChange={(e) => setNewCard({ ...newCard, balance: e.target.value })} className="w-full p-3.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white rounded-xl focus:ring-4 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all font-mono font-bold text-lg" placeholder="0.00" /></div>
            </div>

            <div className="p-4 rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-800/50 space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <input
                  id="cdv-custom-plastic"
                  type="checkbox"
                  checked={!!newCard.plasticAccentHex}
                  onChange={(e) => {
                    if (e.target.checked) {
                      const cur = (newCard.plasticAccentHex || '').trim();
                      const norm = cur.startsWith('#') ? cur : (cur ? `#${cur}` : '');
                      setNewCard({ ...newCard, plasticAccentHex: hexToRgb(norm) ? norm : '#6366f1' });
                    } else setNewCard({ ...newCard, plasticAccentHex: '' });
                  }}
                  className="w-5 h-5 rounded border-slate-400 text-indigo-600 focus:ring-indigo-500"
                />
                <label htmlFor="cdv-custom-plastic" className="font-bold text-slate-800 dark:text-slate-200 cursor-pointer">Custom card color</label>
              </div>
              {newCard.plasticAccentHex ? (
                <div className="flex flex-wrap items-center gap-4">
                  <input
                    type="color"
                    aria-label="Plastic gradient base color"
                    value={(() => {
                      const c = (newCard.plasticAccentHex || '').trim();
                      const n = c.startsWith('#') ? c : `#${c}`;
                      return hexToRgb(n) ? n : '#6366f1';
                    })()}
                    onChange={(ev) => setNewCard({ ...newCard, plasticAccentHex: ev.target.value })}
                    className="h-12 w-24 cursor-pointer rounded-lg border-2 border-slate-300 dark:border-slate-600 bg-transparent"
                  />
                  <p className="text-xs text-slate-600 dark:text-slate-400 max-w-xs">Overrides the program default on the wallet plastic. Uncheck to use the built-in program colors.</p>
                </div>
              ) : (
                <p className="text-xs text-slate-600 dark:text-slate-400">Wallet preview uses each program’s default plastic gradient.</p>
              )}
            </div>

            <div>
              <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-3">Card Rules</label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {Object.values(RULE_TYPES).map((rule) => (
                  <div key={rule.id} onClick={() => setNewCard({ ...newCard, ruleType: rule.id })} className={`cursor-pointer p-4 rounded-xl border-2 flex flex-col items-center text-center gap-2 transition-all font-semibold ${newCard.ruleType === rule.id ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 shadow-md' : 'border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400 hover:border-slate-300'}`}><rule.icon size={20} /><span className="text-sm">{rule.label}</span></div>
                ))}
              </div>
            </div>

            {newCard.ruleType === 'expires' && <div className="animate-in slide-in-from-top-2 fade-in"><label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">Expiration Date</label><input type="date" required value={newCard.expiryDate || ''} onChange={(e) => setNewCard({ ...newCard, expiryDate: e.target.value })} className="w-full sm:w-1/2 p-3.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white rounded-xl focus:ring-4 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all" /></div>}

            {newCard.programId === 'CUSTOM' ? (
              <div className="animate-in fade-in">
                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-3">Allowed Categories (Custom)</label>
                <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto p-2 -m-2">
                  {CATEGORIES.map((cat) => {
                    const isSelected = newCard.categories.includes(cat);
                    return <button type="button" key={cat} onClick={() => toggleCategorySelection(cat)} className={`px-4 py-2 rounded-xl text-sm font-bold transition-all border-2 flex items-center gap-1.5 ${isSelected ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900 border-slate-900 dark:border-white shadow-md transform scale-[1.02]' : 'bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400 border-slate-100 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>{CATEGORY_ICONS[cat]} {cat}</button>;
                  })}
                </div>
              </div>
            ) : (
              <div className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800 rounded-xl flex items-start gap-3"><Info className="text-blue-500 shrink-0 mt-0.5" size={20} /><div><div className="font-bold text-blue-800 dark:text-blue-300 text-sm">Auto-Managed Logic</div><div className="text-xs text-blue-600 dark:text-blue-400 mt-1">Categories and accepted merchants for {PROGRAMS[newCard.programId].name} are managed automatically by the system engine.</div></div></div>
            )}
            <div className="pt-6 border-t border-slate-100 dark:border-slate-800"><button type="submit" disabled={newCard.programId === 'CUSTOM' && newCard.categories.length === 0} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-4 rounded-xl disabled:opacity-50 transition-all shadow-lg hover:shadow-xl active:scale-[0.98] text-lg">{editingCardId ? 'Update Wallet' : 'Add to Wallet'}</button></div>
          </form>
        </Modal>

        <Modal isOpen={showExpenseForm} onClose={resetExpenseForm} title={editingExpenseId ? 'Edit Plan' : 'Plan a Purchase'}>
          <form onSubmit={handleSaveExpense} className="space-y-6">
            <div className="flex items-center gap-4 bg-slate-50 dark:bg-slate-800 p-4 rounded-xl border border-slate-200 dark:border-slate-700">
              <input type="checkbox" id="isCompleted" checked={newExpense.isCompleted} onChange={(e) => setNewExpense({ ...newExpense, isCompleted: e.target.checked })} className="w-6 h-6 text-emerald-600 bg-white border-slate-300 rounded focus:ring-emerald-500" />
              <label htmlFor="isCompleted" className="cursor-pointer"><div className="font-bold text-slate-800 dark:text-slate-200">Already Spent?</div><div className="text-xs text-slate-500 dark:text-slate-400">Check this if you have already completed this purchase at the store.</div></label>
            </div>

            <div><label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">Item / Purpose</label><input type="text" required value={newExpense.name} onChange={(e) => setNewExpense({ ...newExpense, name: e.target.value })} className="w-full p-3.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white rounded-xl focus:ring-4 focus:ring-emerald-500/20 focus:border-emerald-500 outline-none transition-all font-medium" placeholder="e.g. Cinema Tickets" /></div>

            <div>
              <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">Categories</label>
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">Select every category this purchase touches (one or more).</p>
              <div className="flex flex-wrap gap-2 max-h-44 overflow-y-auto p-1 -m-1">
                {CATEGORIES.map((cat) => {
                  const isSelected = newExpense.expenseCategories.includes(cat);
                  return (
                    <button type="button" key={cat} onClick={() => toggleExpenseCategory(cat)} className={`px-3 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all border-2 flex items-center gap-1.5 ${isSelected ? 'bg-emerald-600 text-white border-emerald-600 shadow-md' : 'bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400 border-slate-100 dark:border-slate-800 hover:border-slate-300'}`}>
                      {CATEGORY_ICONS[cat]} {cat}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">Retailers (optional)</label>
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">Add several stores for the same trip or basket. Pick from search or type and press Add.</p>
              {newExpense.expenseMerchants.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-3">
                  {newExpense.expenseMerchants.map((name) => {
                    const iconCat = KNOWN_MERCHANTS[name]?.cat || newExpense.expenseCategories[0] || CATEGORIES[0];
                    return (
                      <span key={name} className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-[11px] sm:text-xs font-bold text-slate-700 dark:text-slate-200">
                        <MerchantIcon merchantName={name} category={iconCat} className="w-5 h-5 rounded border-0 bg-transparent" />
                        <span className="max-w-[10rem] truncate">{name.split('(')[0].trim()}</span>
                        <button type="button" onClick={() => removeExpenseMerchant(name)} className="p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500" aria-label={`Remove ${name}`}><X size={14} /></button>
                      </span>
                    );
                  })}
                </div>
              )}
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-3.5 top-3.5 text-slate-400" size={18} />
                  <input type="text" value={merchantSearch} onChange={(e) => { setMerchantSearch(e.target.value); setShowMerchantSuggestions(true); }} onFocus={() => setShowMerchantSuggestions(true)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addExpenseMerchantFreeText(); } }} className="w-full pl-10 pr-3 p-3.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white rounded-xl focus:ring-4 focus:ring-emerald-500/20 focus:border-emerald-500 outline-none transition-all font-medium" placeholder="e.g. Wolt, FOX..." />
                  {showMerchantSuggestions && merchantSearch && (
                    <div className="absolute z-50 w-full mt-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl max-h-48 overflow-y-auto">
                      {getSmartMatches(merchantSearch).map(([name, data]) => (
                        <div key={name} onMouseDown={() => addExpenseMerchantFromList(name, data.cat)} className="p-3 hover:bg-slate-50 dark:hover:bg-slate-700 cursor-pointer border-b border-slate-100 dark:border-slate-700/50 last:border-0 flex justify-between items-center">
                          <div className="flex items-center gap-2"><MerchantIcon merchantName={name} category={data.cat} className="w-6 h-6 rounded border-0 bg-transparent" /><span className="font-bold text-slate-800 dark:text-slate-200">{name}</span></div>
                          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 bg-slate-100 dark:bg-slate-900 px-2 py-1 rounded">{data.cat}</span>
                        </div>
                      ))}
                      {getSmartMatches(merchantSearch).length === 0 && <div className="p-3 text-sm text-slate-500 text-center">No catalog match — use Add for a custom name.</div>}
                    </div>
                  )}
                </div>
                <button type="button" onClick={addExpenseMerchantFreeText} className="shrink-0 px-4 py-3 rounded-xl border-2 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 font-bold text-sm hover:bg-emerald-50 dark:hover:bg-emerald-950/40 transition-colors">Add</button>
              </div>
            </div>

            <div>
              <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">Plan for month (optional)</label>
              <input type="date" value={newExpense.scheduledFor || ''} onChange={(e) => setNewExpense({ ...newExpense, scheduledFor: e.target.value })} className="w-full sm:w-64 p-3.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white rounded-xl focus:ring-4 focus:ring-emerald-500/20 focus:border-emerald-500 outline-none transition-all font-medium" />
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-2 leading-relaxed">Pick a date in the month you intend to pay. <strong className="font-semibold text-slate-600 dark:text-slate-300">Monthly</strong> cards count spending per calendar month and refill on the 1st; future dates let you plan against that month&apos;s balance.</p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div>
                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">Estimated Cost (₪)</label>
                <input type="number" required min="0.01" step="0.01" value={newExpense.amount} onChange={(e) => setNewExpense({ ...newExpense, amount: e.target.value })} className="w-full p-3.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white rounded-xl focus:ring-4 focus:ring-emerald-500/20 focus:border-emerald-500 outline-none transition-all font-mono font-bold text-lg text-emerald-600 dark:text-emerald-400" placeholder="0.00" />
                {!editingExpenseId && newExpense.amount && <div className="mt-3 flex items-center gap-2"><input type="checkbox" id="isManualSplit" checked={newExpense.isManualSplit || false} onChange={(e) => setNewExpense({ ...newExpense, isManualSplit: e.target.checked, chargeAmount: e.target.checked ? newExpense.amount : '' })} className="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500 bg-white border-slate-300" /><label htmlFor="isManualSplit" className="text-xs font-semibold text-slate-500 dark:text-slate-400 cursor-pointer">Split this payment across multiple cards?</label></div>}
              </div>
              <div>
                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">Pay With</label>
                <select required value={newExpense.cardId} onChange={(e) => setNewExpense({ ...newExpense, cardId: e.target.value })} className="w-full p-3.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white rounded-xl focus:ring-4 focus:ring-emerald-500/20 focus:border-emerald-500 outline-none transition-all font-medium appearance-none">
                  <option value="" disabled>{!newExpense.expenseCategories?.length ? 'Choose a card (add categories to filter by rules)' : '-- Evaluated Cards --'}</option>
                  {sortedCardBalances.map((card) => {
                    const noCatsYet = !newExpense.expenseCategories?.length;
                    const isAllowedByRules = noCatsYet || cardMatchesExpenseSelection(card, newExpense.expenseCategories, newExpense.expenseMerchants);
                    const isEditingCurrent = editingExpenseId && card.id === newExpense.cardId;
                    const targetMonthKey = newExpense.scheduledFor
                      ? getCalendarMonthKey(newExpense.scheduledFor)
                      : getCalendarMonthKey(new Date());
                    const editingExpenseRow = editingExpenseId ? expenses.find((ex) => ex.id === editingExpenseId) : null;
                    let rem = getRemainingForCardMonth(card, targetMonthKey);
                    if (editingExpenseRow && editingExpenseRow.cardId === card.id) {
                      const oldBucket = getExpenseMonthKey(editingExpenseRow);
                      if (card.ruleType !== 'monthly' || oldBucket === targetMonthKey) {
                        rem += parseFloat(editingExpenseRow.amount || 0);
                      }
                    }
                    const canAfford = isEditingCurrent || rem >= parseFloat(newExpense.amount || 0);
                    const isAnchorOrSelected = card.id === newExpense.cardId;
                    const isSelectable = noCatsYet
                      ? (isAnchorOrSelected || rem > 0)
                      : (isAllowedByRules && (rem > 0 || isEditingCurrent));
                    const expiringTag = card.ruleType === 'expires' && getDaysUntilExpiry(card.expiryDate) <= 30 ? '[EXPIRING!] ' : '';
                    const ruleHint = noCatsYet ? '' : (!isAllowedByRules ? ' - Rule Blocked' : (!canAfford ? ' - Requires Split' : ''));
                    return <option key={card.id} value={card.id} disabled={!isSelectable}>{expiringTag}{card.name} (Available: ₪{rem.toLocaleString()}){ruleHint}</option>;
                  })}
                </select>
                {newExpense.expenseCategories?.length > 0 && cardBalances.filter((c) => cardMatchesExpenseSelection(c, newExpense.expenseCategories, newExpense.expenseMerchants)).length === 0 && <p className="text-red-500 dark:text-red-400 text-[10px] mt-1.5 font-bold uppercase tracking-wider flex items-center gap-1"><ShieldAlert size={12} /> No valid cards for this combination.</p>}
              </div>
            </div>

            {newExpense.isManualSplit && !editingExpenseId && newExpense.cardId && (() => {
              const splitCard = cardBalances.find((c) => c.id === newExpense.cardId);
              const splitMonthKey = newExpense.scheduledFor
                ? getCalendarMonthKey(newExpense.scheduledFor)
                : getCalendarMonthKey(new Date());
              const splitCap = splitCard ? getRemainingForCardMonth(splitCard, splitMonthKey) : 0;
              return (
                <div className="animate-in fade-in slide-in-from-top-2 bg-blue-50 dark:bg-blue-900/10 p-4 rounded-xl border border-blue-100 dark:border-blue-800/50">
                  <label className="block text-sm font-bold text-blue-800 dark:text-blue-300 mb-2">Amount to charge to selected card (₪)</label>
                  <input type="number" required min="0.01" max={Math.min(parseFloat(newExpense.amount || Infinity), splitCap || Infinity)} step="0.01" value={newExpense.chargeAmount} onChange={(e) => setNewExpense({ ...newExpense, chargeAmount: e.target.value })} className="w-full p-3.5 bg-white dark:bg-slate-800 border border-blue-200 dark:border-blue-700 text-slate-900 dark:text-white rounded-xl focus:ring-4 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all font-mono font-bold text-lg" placeholder="0.00" />
                </div>
              );
            })()}

            <div className="pt-6 border-t border-slate-100 dark:border-slate-800">
              {(() => {
                const selectedCard = cardBalances.find((c) => c.id === newExpense.cardId);
                const planMonthKey = newExpense.scheduledFor
                  ? getCalendarMonthKey(newExpense.scheduledFor)
                  : getCalendarMonthKey(new Date());
                const planRemaining = selectedCard ? getRemainingForCardMonth(selectedCard, planMonthKey) : 0;
                const reqAmount = parseFloat(newExpense.amount || 0);
                let actualLogAmount = reqAmount;
                let isSplitNeeded = false;
                if (selectedCard && !editingExpenseId) {
                  if (newExpense.isManualSplit && newExpense.chargeAmount) actualLogAmount = parseFloat(newExpense.chargeAmount || 0);
                  if (actualLogAmount > planRemaining) actualLogAmount = planRemaining;
                  if (actualLogAmount < reqAmount && actualLogAmount > 0) isSplitNeeded = true;
                }
                return <button type="submit" className={`w-full text-white font-bold py-4 rounded-xl transition-all shadow-lg hover:shadow-xl active:scale-[0.98] text-lg ${isSplitNeeded ? 'bg-orange-500 hover:bg-orange-600' : 'bg-emerald-600 hover:bg-emerald-700'}`}>{isSplitNeeded ? `Split Payment (Log ₪${actualLogAmount} & Continue)` : (editingExpenseId ? 'Update Purchase' : 'Confirm Plan')}</button>;
              })()}
            </div>
          </form>
        </Modal>
      </div>
    </div>
  );
}
