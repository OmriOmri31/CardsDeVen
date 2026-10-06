import React, { useState, useMemo, useEffect, useRef, useId } from 'react';
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
  CYCLE_MONTHS,
  RECURRING_PRESETS,
  asOfDate,
  computeCardFunds,
  cycleBadgeLabel,
  describeCycle,
  getCycleSpec,
  isRecurringRule,
  isUnitCard,
  recurringPresetId,
  remainingForPlan,
  specFromRecurringForm,
} from './cardCycle';
import {
  CreditCard, LayoutDashboard, Receipt, Plus, Trash2, AlertCircle,
  CalendarDays, RefreshCw, Infinity as InfinityIcon, CheckCircle2,
  Edit2, Moon, Sun, PieChart, LogOut, Lock, Mail,
  Loader2, X, Search, ShieldAlert, Zap, Clock, CheckSquare, Square, Gift, Bot, Send, Info, ExternalLink, ChevronDown
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

/** The club catalogue runs to thousands of rows; page it instead of mounting all of them. */
const DEALS_PAGE_SIZE = 60;

const AI_STARTER_PROMPTS = [
  'Which card should I use for groceries this week?',
  'I need pizza for 10 people under ₪300',
  'What expires soonest and how do I spend it?',
  'Best fashion deal across my active clubs',
];

/* --- FORMATTING ---------------------------------------------------------- */

const shekelWhole = new Intl.NumberFormat('en-IL', {
  style: 'currency', currency: 'ILS', minimumFractionDigits: 0, maximumFractionDigits: 0,
});
const shekelPrecise = new Intl.NumberFormat('en-IL', {
  style: 'currency', currency: 'ILS', minimumFractionDigits: 2, maximumFractionDigits: 2,
});

/** Agorot are shown only when the amount actually has them, never as a stray ".2". */
function formatShekels(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return shekelWhole.format(0);
  return Number.isInteger(n) ? shekelWhole.format(n) : shekelPrecise.format(n);
}

const dayMonthYear = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const dayMonth = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

function formatDate(value, { withYear = true } = {}) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return (withYear ? dayMonthYear : dayMonth).format(d);
}

/** Tabular, shekel-capable numerals. The display face has no U+20AA glyph. */
function Money({ value, className = '' }) {
  return <span className={`cdv-amount ${className}`}>{formatShekels(value)}</span>;
}

/** The label is whatever the user typed (`massages`, `flight ticket`). No plural guessing. */
function formatUses(count, label) {
  const n = Number(count);
  const shown = Number.isFinite(n) ? Math.round(n) : 0;
  const word = String(label || 'uses').trim() || 'uses';
  return `${shown} ${word}`;
}

function isUseLedgerRow(expense, card) {
  if (isUnitCard(card)) return true;
  return expense?.units != null && expense.units !== '' && Number.isFinite(Number(expense.units));
}

function unitCardMatchesQuery(card, query) {
  if (!isUnitCard(card) || !(Number(card.remaining) > 0)) return false;
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return false;
  const hay = [card.name, card.unitLabel, card.venue].filter(Boolean).join('\n').toLowerCase();
  if (hay.includes(q)) return true;
  const words = q.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
  return words.length > 0 && words.every((w) => hay.includes(w));
}

// --- DOMAIN KNOWLEDGE: CATEGORIES & ICONS ---
const CATEGORY_ICONS = {
  "Supermarkets & Groceries": "🛒", "Fashion & Apparel": "👗", "Home & Household": "🛋️",
  "Hotels & Lodging": "🏨", "Spas & Wellness": "💆", "Electronics": "💻", "Cinemas": "🍿",
  "Food Chains & Restaurants": "🍔", "Online Retail & Delivery": "📦", "Pharmacy & Health": "💊",
  "Fuel & Transportation": "⛽", "Fitness & Gym": "🏋️", "Kids & Baby": "🧸", "Other": "🏷️"
};
const CATEGORIES = Object.keys(CATEGORY_ICONS);

/** Hue per category, so spending reads by colour as well as by name. */
const CATEGORY_HUE = {
  'Supermarkets & Groceries': 152,
  'Fashion & Apparel': 332,
  'Home & Household': 28,
  'Hotels & Lodging': 214,
  'Spas & Wellness': 174,
  'Electronics': 228,
  'Cinemas': 8,
  'Food Chains & Restaurants': 22,
  'Online Retail & Delivery': 262,
  'Pharmacy & Health': 348,
  'Fuel & Transportation': 42,
  'Fitness & Gym': 88,
  'Kids & Baby': 312,
  'Other': 250,
};

function categoryHueStyle(category) {
  const h = CATEGORY_HUE[category];
  return h == null ? undefined : { '--cat-h': h };
}

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
  BEHATSDAA: { id: 'BEHATSDAA', name: 'בהצדעה', hue: 214 },
  PAIS_PLUS: { id: 'PAIS_PLUS', name: 'פיס פלוס', hue: 4 },
  DREAMCARD: { id: 'DREAMCARD', name: 'DreamCard', hue: 268 },
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

function storeNameKey(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function acceptedStoreNames(card) {
  if (!Array.isArray(card?.acceptedStores)) return [];
  return [...new Set(card.acceptedStores.map((s) => String(s || '').trim()).filter(Boolean))];
}

function storeLimitSummary(card) {
  const names = acceptedStoreNames(card).map((n) => n.split('(')[0].trim());
  if (!names.length) return '';
  if (names.length <= 2) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

/** Built-in merchants plus stores this user has typed in. */
function catalogEntries(customStores = []) {
  const entries = Object.entries(KNOWN_MERCHANTS);
  const seen = new Set(entries.map(([name]) => storeNameKey(name)));
  for (const store of customStores || []) {
    const name = String(store?.name || '').trim();
    if (!name) continue;
    const key = storeNameKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    const cat = CATEGORIES.includes(store.cat) ? store.cat : 'Other';
    entries.push([name, { cat, networks: [], aliases: [], custom: true }]);
  }
  return entries;
}

function merchantMeta(name, customStores = []) {
  if (!name) return null;
  if (KNOWN_MERCHANTS[name]) return KNOWN_MERCHANTS[name];
  const key = storeNameKey(name);
  const custom = (customStores || []).find((s) => storeNameKey(s.name) === key);
  if (!custom) return null;
  return { cat: CATEGORIES.includes(custom.cat) ? custom.cat : 'Other', networks: [], aliases: [], custom: true };
}

/** Keep a typed name when it is new. Otherwise return the catalog spelling. */
function resolveCatalogStoreName(raw, customStores = []) {
  const trimmed = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  const key = storeNameKey(trimmed);
  const entries = catalogEntries(customStores);
  const exact = entries.find(([name]) => {
    if (storeNameKey(name) === key) return true;
    const short = storeNameKey(name.split('(')[0]);
    return short.length >= 2 && short === key;
  });
  if (exact) return exact[0];
  const alias = entries.find(([, data]) => (data.aliases || []).some((a) => storeNameKey(a) === key));
  return alias ? alias[0] : trimmed;
}

function cleanStoreCatalog(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const name = String(entry?.name || '').trim().replace(/\s+/g, ' ');
    if (!name || KNOWN_MERCHANTS[name]) continue;
    const key = storeNameKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, cat: CATEGORIES.includes(entry?.cat) ? entry.cat : 'Other' });
  }
  return out;
}

const checkCompatibility = (card, category, merchantName) => {
  const limited = acceptedStoreNames(card);
  if (limited.length > 0) {
    const wanted = storeNameKey(merchantName);
    if (!wanted || !limited.some((s) => storeNameKey(s) === wanted)) {
      return { allowed: false, reason: 'Limited to specific stores' };
    }
  }
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
const cardMatchesExpenseSelection = (card, categories, merchants, customStores = []) => {
  const cats = [...new Set((categories || []).filter(Boolean))];
  const merchs = [...new Set((merchants || []).filter(Boolean))];
  if (cats.length === 0) return false;
  const coveredCats = new Set();
  for (const m of merchs) {
    const mdata = merchantMeta(m, customStores) || KNOWN_MERCHANTS[m];
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

function pickExpenseCardId(cardBalances, categories, merchants, previousCardId, anchorCardId, customStores = []) {
  const moneyCards = cardBalances.filter((c) => !isUnitCard(c));
  if (!categories || categories.length === 0) {
    for (const id of [previousCardId, anchorCardId]) {
      if (!id) continue;
      if (moneyCards.some((c) => c.id === id)) return id;
    }
    return '';
  }
  for (const id of [previousCardId, anchorCardId]) {
    if (!id) continue;
    const card = moneyCards.find((c) => c.id === id);
    if (card && cardMatchesExpenseSelection(card, categories, merchants, customStores)) return id;
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

const getSmartMatches = (query, maxResults = 15, customStores = []) => {
  if (!query) return [];
  const q = query.toLowerCase().trim();

  return catalogEntries(customStores)
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

/** Every known store when the query is empty, otherwise the same search as checkout. */
function listStoresForPicker(query, customStores = []) {
  const q = String(query || '').trim();
  if (!q) {
    return [...catalogEntries(customStores)].sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }
  return getSmartMatches(q, 40, customStores);
}

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
      <a
        key={`${keyPrefix}-a-${partIdx++}`}
        href={href}
        title={href}
        target="_blank"
        rel="noopener noreferrer"
        className="ai-advisor-inline-link"
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

/** http(s) balance-page URL, or empty when missing / not a web link. */
function normalizeCardLink(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.href;
  } catch {
    return '';
  }
}

function WalletCreditPlastic({ balanceRemaining, balanceLimit, limitCaption = 'Loaded', programName, chromeGradient, ruleType, expiryDate, isExpiringSoon, valueKind = 'money', unitLabel = '' }) {
  const units = valueKind === 'units';
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
          <div className="wcc-original">{limitCaption} <span className="cdv-amount">{units ? formatUses(balanceLimit, unitLabel) : formatShekels(balanceLimit)}</span></div>
          <div className="wcc-current-block">
            <span className="wcc-current-label">Remaining</span>
            {units ? (
              <>
                <div className="wcc-current cdv-amount">{Number.isFinite(Number(balanceRemaining)) ? Math.round(Number(balanceRemaining)) : 0}</div>
                <div className="wcc-unit-label">{unitLabel || 'uses'}</div>
              </>
            ) : (
              <div className="wcc-current cdv-amount">{formatShekels(balanceRemaining)}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function OpenWalletCard({ card, detailRef, onEdit, onDelete, onSpend, onSetBalance }) {
  const units = isUnitCard(card);
  const ruleData = RULE_TYPES[card.ruleType?.toUpperCase()] || RULE_TYPES.PERMANENT;
  const progData = PROGRAMS[card.programId || 'CUSTOM'] || PROGRAMS.CUSTOM;
  const chromeGradient = buildPlasticGradientFromHex(card.plasticAccentHex) || (WALLET_CARD_CHROME[card.programId] || WALLET_CARD_CHROME.CUSTOM);
  const pool = Number(card.loaded) || 0;
  const percentRemaining = pool > 0 ? Math.max(0, Math.min(100, (card.remaining / pool) * 100)) : 0;
  const isExpiringSoon = card.ruleType === 'expires' && getDaysUntilExpiry(card.expiryDate) <= 30;
  const cardBalanceUrl = normalizeCardLink(card.cardLink);
  const behaviorLabel = cycleBadgeLabel(card);
  const scheduleLine = recurringStatusLine(card);
  const placeLabel = units ? (card.venue || 'Uses') : progData.name;
  return (
    <article
      id="cdv-wallet-detail"
      ref={detailRef}
      className="cdv-panel cdv-wallet-detail flex flex-col gap-6 p-5 sm:p-6"
      style={isExpiringSoon ? { borderColor: 'var(--cdv-warning)' } : undefined}
    >
      <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
        <WalletCreditPlastic
          balanceRemaining={card.remaining}
          balanceLimit={pool}
          limitCaption={card.balanceOverride ? 'Current' : (units ? 'Loaded' : (card.ruleType === 'cycle' ? 'This cycle' : 'Loaded'))}
          programName={placeLabel}
          chromeGradient={chromeGradient}
          ruleType={card.ruleType}
          expiryDate={card.expiryDate}
          isExpiringSoon={isExpiringSoon}
          valueKind={units ? 'units' : 'money'}
          unitLabel={card.unitLabel}
        />
        <div className="flex min-h-full flex-1 min-w-0 flex-col gap-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="cdv-display text-xl leading-snug break-words">{card.name}</h3>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className={`cdv-badge ${isExpiringSoon ? 'cdv-badge--warning' : 'cdv-badge--neutral'}`}>
                  <ruleData.icon size={11} className="shrink-0" aria-hidden />
                  {card.ruleType === 'expires' && card.expiryDate
                    ? (isExpiringSoon
                      ? `${getDaysUntilExpiry(card.expiryDate)} days left`
                      : `Expires ${formatDate(card.expiryDate)}`)
                    : (behaviorLabel || ruleData.label)}
                </span>
                <span className="cdv-badge cdv-badge--neutral">{placeLabel}</span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <button type="button" onClick={() => onEdit(card)} className="cdv-icon-btn" aria-label={`Edit ${card.name}`}><Edit2 size={16} aria-hidden /></button>
              <button type="button" onClick={() => onDelete(card)} className="cdv-icon-btn cdv-icon-btn--danger" aria-label={`Delete ${card.name}`}><Trash2 size={16} aria-hidden /></button>
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-baseline justify-between gap-3">
              {units
                ? <span className="text-lg font-semibold text-[var(--cdv-ink)]">{formatUses(card.remaining, card.unitLabel)}</span>
                : <Money value={card.remaining} className="text-lg font-semibold text-[var(--cdv-ink)]" />}
              <span className="text-xs text-[var(--cdv-faint)]">of {units ? formatUses(pool, card.unitLabel) : formatShekels(pool)}</span>
            </div>
            <div
              className="cdv-meter"
              role="progressbar"
              aria-label={units ? `${card.name}: ${formatUses(card.remaining, card.unitLabel)} remaining` : `${card.name} balance remaining`}
              aria-valuenow={Math.round(percentRemaining)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className={`cdv-meter__fill ${isExpiringSoon ? 'cdv-meter__fill--warning' : ''}`} style={{ width: `${percentRemaining}%` }} />
            </div>
            {scheduleLine ? <p className="mt-2 text-xs leading-relaxed text-[var(--cdv-mute)]">{scheduleLine}</p> : null}
            {balanceSetLine(card) ? <p className="mt-2 text-xs leading-relaxed text-[var(--cdv-mute)]">{balanceSetLine(card)}</p> : null}
          </div>

          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => onSpend(card.id)} className="cdv-btn cdv-btn--primary">
              <Zap size={16} className="shrink-0" aria-hidden />
              {units ? 'Log a use' : 'Quick spend'}
            </button>
            <button type="button" onClick={() => onSetBalance(card)} className="cdv-btn cdv-btn--outline">
              {units ? 'Set remaining' : 'Set balance'}
            </button>
            {cardBalanceUrl ? (
              <a href={cardBalanceUrl} target="_blank" rel="noopener noreferrer" className="cdv-btn cdv-btn--outline">
                <ExternalLink size={15} className="shrink-0" aria-hidden />
                Check balance
              </a>
            ) : null}
            {normalizeCardLink(card.storeListLink) ? (
              <a href={normalizeCardLink(card.storeListLink)} target="_blank" rel="noopener noreferrer" className="cdv-btn cdv-btn--outline">
                <ExternalLink size={15} className="shrink-0" aria-hidden />
                Store list
              </a>
            ) : null}
          </div>
        </div>
      </div>
      {units ? (
        <p className="border-t border-[var(--cdv-hairline)] pt-4 text-sm text-[var(--cdv-mute)]">
          Redeem as {card.unitLabel || 'uses'}{card.venue ? ` at ${card.venue}` : ''}.
        </p>
      ) : (
        <div className="space-y-3 border-t border-[var(--cdv-hairline)] pt-4">
          {acceptedStoreNames(card).length > 0 && (
            <div>
              <p className="mb-2 text-xs text-[var(--cdv-mute)]">Pays only at</p>
              <div className="flex flex-wrap gap-1.5">
                {acceptedStoreNames(card).map((name) => (
                  <span key={name} className="cdv-chip">
                    <MerchantIcon merchantName={name} category={KNOWN_MERCHANTS[name]?.cat || 'Other'} className="h-5 w-5 rounded border-0 bg-transparent" />
                    <span className="max-w-[14rem] truncate" dir="auto">{name.split('(')[0].trim()}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            {card.derivedCats.map((cat) => (
              <span key={cat} className="cdv-chip cdv-cat" style={categoryHueStyle(cat)}>
                <span aria-hidden>{CATEGORY_ICONS[cat]}</span> {cat}
              </span>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}

function useMatchMedia(query) {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [query]);
  return matches;
}

const AI_CHAT_STORAGE_KEY = 'cardsdeven_ai_chat_v1';
const AI_TIP_BAR_DISMISSED_KEY = 'cardsdeven_ai_tip_bar_dismissed_v1';
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
  CYCLE: { id: 'cycle', label: 'Recurring grant', icon: RefreshCw },
  EXPIRES: { id: 'expires', label: 'Expires On', icon: CalendarDays }
};

const BALANCE_BEHAVIORS = [
  { id: 'permanent', label: 'Permanent', icon: InfinityIcon },
  { id: 'recurring', label: 'Recurring grant', icon: RefreshCw },
  { id: 'expires', label: 'Expires On', icon: CalendarDays },
];

const EMPTY_CARD_FORM = {
  name: '',
  balance: '',
  valueKind: 'money',
  unitCount: '',
  unitLabel: '',
  venue: '',
  programId: 'CUSTOM',
  ruleType: 'permanent',
  recurringPreset: 'monthly',
  refillEveryMonths: 3,
  resetEveryMonths: 12,
  cycleStartMonth: 1,
  expiryDate: '',
  categories: [],
  acceptedStores: [],
  plasticAccentHex: '',
  cardLink: '',
  storeListLink: '',
};

const EMPTY_EXPENSE_FORM = {
  name: '',
  amount: '',
  units: '',
  expenseCategories: [],
  expenseMerchants: [],
  cardId: '',
  isCompleted: false,
  isManualSplit: false,
  chargeAmount: '',
  scheduledFor: '',
};

function planDateFromInput(scheduledFor) {
  return scheduledFor ? asOfDate(scheduledFor) : new Date();
}

function recurringStatusLine(card, asOf = new Date()) {
  const spec = getCycleSpec(card);
  if (!spec) return '';
  const snap = describeCycle(spec, asOf);
  const grant = formatShekels(spec.grant);
  if (spec.refillEveryMonths === 1 && spec.resetEveryMonths === 1) {
    return `${grant} each calendar month. Unused balance does not carry past the 1st.`;
  }
  const cadence = spec.refillEveryMonths === 12 ? 'year' : `${spec.refillEveryMonths} months`;
  const resetOn = formatDate(snap.nextReset);
  if (snap.grantsPerCycle <= 1) return `${grant} every ${cadence}. Resets ${resetOn}.`;
  const nextBit = snap.nextRefill ? ` · next ${grant} ${formatDate(snap.nextRefill)}` : '';
  return `${grant} every ${cadence} · ${snap.grants} of ${snap.grantsPerCycle} loaded · resets ${resetOn}${nextBit}`;
}

function walletLineForAdvisor(card) {
  if (isUnitCard(card)) {
    const left = formatUses(card.remaining, card.unitLabel);
    const loaded = formatUses(card.loaded ?? card.unitCount, card.unitLabel);
    const place = card.venue ? ` at ${card.venue}` : '';
    let line = `${card.name}: ${left} left of ${loaded}${place}. NOT MONEY — redeem only as ${card.unitLabel || 'uses'}${place}.`;
    if (card.balanceOverride) {
      const when = formatDate(card.balanceOverride.at);
      line += ` [USES LEFT were set on ${when} to ${formatUses(card.balanceOverride.amount, card.unitLabel)}. Uses before that moment are already included. Later uses reduce this figure.]`;
    }
    return appendStoreListLink(card, line);
  }
  const spec = getCycleSpec(card);
  const remaining = Number(card.remaining);
  let line;
  if (!spec) {
    line = `${card.name}:₪${remaining} (limit ₪${parseFloat(card.balance).toLocaleString()})`;
  } else {
    const snap = card.cycle || describeCycle(spec, new Date());
    if (spec.refillEveryMonths === 1 && spec.resetEveryMonths === 1) {
      line = `${card.name}:₪${remaining} available now [MONTHLY: ₪${spec.grant} refills on the 1st; unused balance resets; only spending in that calendar month counts]`;
    } else {
      const resetOn = formatDate(snap.nextReset);
      line = `${card.name}:₪${remaining} available now [CYCLE: ₪${spec.grant} added every ${spec.refillEveryMonths} months; ${snap.grants} of ${snap.grantsPerCycle} grants loaded (₪${snap.loaded} before spending, ₪${snap.cycleCap} by the end of the cycle); unused balance stacks and resets to zero on ${resetOn}. A future plan date includes grants that will have arrived by then. Spending in the same reset window reduces that balance.]`;
    }
  }
  if (card.balanceOverride) {
    const when = formatDate(card.balanceOverride.at);
    line += ` [CURRENT BALANCE was set on ${when} to ₪${card.balanceOverride.amount}. Spending before that moment is already included. Later spending reduces this figure. A recurring card returns to its normal refill at the next reset.]`;
  }
  const onlyAt = acceptedStoreNames(card);
  if (onlyAt.length) line += ` [GIFT CARD STORES ONLY: ${onlyAt.join(', ')}. Do not use this card at any other store.]`;
  return appendStoreListLink(card, line);
}

function appendStoreListLink(card, line) {
  const storeList = normalizeCardLink(card.storeListLink);
  if (!storeList) return line;
  return `${line} [STORE LIST of places this card can pay: ${storeList}]`;
}

function balanceSetLine(card) {
  if (!card.balanceOverride) return '';
  const when = formatDate(card.balanceOverride.at);
  if (isUnitCard(card)) return `Uses left set ${when}. Plans from before that moment are already included.`;
  const resumes = getCycleSpec(card) ? ' The normal refill takes over again at the next reset.' : '';
  return `Balance set ${when}. Plans from before that moment are already included.${resumes}`;
}

const Modal = ({ isOpen, onClose, title, children }) => {
  const titleId = useId();

  /* Escape closes, and the page behind must not scroll while a sheet is open. */
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKeyDown = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;
  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-[rgba(10,12,13,0.55)] p-0 backdrop-blur-[3px] animate-in fade-in duration-200 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[92dvh] w-full max-w-xl flex-col overflow-hidden rounded-t-[var(--cdv-r-xl)] border border-[var(--cdv-hairline)] bg-[var(--cdv-surface)] shadow-[var(--cdv-shadow-float)] animate-in slide-in-from-bottom-8 duration-200 sm:max-h-[86dvh] sm:rounded-[var(--cdv-r-xl)] sm:zoom-in-95"
        style={{ overscrollBehavior: 'contain', paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        <div className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b border-[var(--cdv-hairline)] bg-[var(--cdv-surface)] px-6 py-4">
          <h3 id={titleId} className="cdv-display text-lg min-w-0 break-words">{title}</h3>
          <button type="button" onClick={onClose} className="cdv-icon-btn shrink-0" aria-label="Close dialog"><X size={18} aria-hidden /></button>
        </div>
        <div className="overflow-y-auto px-6 py-6" style={{ overscrollBehavior: 'contain' }}>{children}</div>
      </div>
    </div>
  );
};

const MerchantIcon = ({ merchantName, category, className = "w-8 h-8 rounded-[8px]" }) => {
  const [failed, setFailed] = useState(false);
  const fallbackEmoji = CATEGORY_ICONS[category] || "🏷️";
  return (
    <div className={`relative flex shrink-0 items-center justify-center overflow-hidden border border-[var(--cdv-hairline)] bg-[var(--cdv-surface-sunken)] ${className}`}>
      {failed ? (
        <span className="text-sm" aria-hidden>{fallbackEmoji}</span>
      ) : (
        <img
          src={getLogoPath(merchantName)}
          alt=""
          width={40}
          height={40}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
};

function StoreLimitPicker({ selected, customStores, defaultCategory, onAdd, onCreate, onRemove }) {
  const listId = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [newCat, setNewCat] = useState(defaultCategory || 'Other');
  const [trackedDefaultCategory, setTrackedDefaultCategory] = useState(defaultCategory);
  const boxRef = useRef(null);
  if (defaultCategory !== trackedDefaultCategory) {
    setTrackedDefaultCategory(defaultCategory);
    setNewCat(defaultCategory || 'Other');
  }

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const queryTrim = query.trim();
  const resolved = queryTrim ? resolveCatalogStoreName(queryTrim, customStores) : '';
  const inCatalog = Boolean(resolved) && catalogEntries(customStores).some(([name]) => name === resolved);
  const alreadySelected = Boolean(resolved) && selected.some((s) => storeNameKey(s) === storeNameKey(resolved));
  const matches = listStoresForPicker(query, customStores).filter(([name]) => !selected.some((s) => storeNameKey(s) === storeNameKey(name)));
  const showCreate = Boolean(queryTrim) && !inCatalog && matches.length === 0 && !alreadySelected;

  const commit = () => {
    if (!queryTrim || alreadySelected) return;
    if (inCatalog) {
      const cat = catalogEntries(customStores).find(([name]) => name === resolved)?.[1]?.cat;
      onAdd(resolved, cat);
    } else if (matches.length === 1) {
      onAdd(matches[0][0], matches[0][1].cat);
    } else if (matches.length === 0) {
      onCreate(queryTrim.replace(/\s+/g, ' '), newCat);
    } else {
      return;
    }
    setQuery('');
    setOpen(false);
  };

  return (
    <fieldset ref={boxRef} className="min-w-0">
      <legend className="cdv-label">Only these stores</legend>
      <p className="mb-2 text-xs leading-relaxed text-[var(--cdv-mute)]">Optional. Leave empty and the card follows its program or categories. Pick one or more stores and it pays only at those, still within that program or those categories. Search the list, or add a name that is not in it — that store is saved for next time.</p>
      {selected.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {selected.map((name) => {
            const cat = merchantMeta(name, customStores)?.cat || KNOWN_MERCHANTS[name]?.cat || 'Other';
            return (
              <span key={name} className="cdv-chip !pr-1">
                <MerchantIcon merchantName={name} category={cat} className="h-5 w-5 rounded border-0 bg-transparent" />
                <span className="max-w-[12rem] truncate" dir="auto">{name.split('(')[0].trim()}</span>
                <button type="button" onClick={() => onRemove(name)} className="rounded-full p-1 text-[var(--cdv-faint)] transition-colors duration-150 hover:bg-[var(--cdv-hairline)] hover:text-[var(--cdv-ink)]" aria-label={`Remove ${name}`}><X size={14} /></button>
              </span>
            );
          })}
        </div>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--cdv-faint)]" size={17} aria-hidden />
          <input
            id="card-stores"
            type="search"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit(); }
              if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
            }}
            className="cdv-input !pl-10"
            placeholder="Search stores, or type a new one"
          />
        </div>
        {showCreate && (
          <select
            aria-label="Category for the new store"
            value={newCat}
            onChange={(e) => setNewCat(e.target.value)}
            className="cdv-input appearance-none sm:max-w-[14rem]"
          >
            {CATEGORIES.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
          </select>
        )}
        <button type="button" onClick={commit} disabled={!queryTrim || alreadySelected || (!inCatalog && matches.length > 1)} className="cdv-btn cdv-btn--outline shrink-0">
          {showCreate ? 'Add store' : 'Add'}
        </button>
      </div>
      {alreadySelected && queryTrim ? <p className="mt-2 text-xs text-[var(--cdv-mute)]">That store is already on this card.</p> : null}
      {queryTrim && !alreadySelected && !inCatalog && matches.length > 1 ? (
        <p className="mt-2 text-xs text-[var(--cdv-mute)]">Several stores match. Pick one from the list, or keep typing a new name.</p>
      ) : null}
      {open && (
        <div id={listId} role="listbox" aria-label="Known stores" className="mt-1 max-h-56 overflow-y-auto rounded-[var(--cdv-r-md)] border border-[var(--cdv-hairline-strong)] bg-[var(--cdv-surface)] shadow-[var(--cdv-shadow-lg)]">
          {matches.map(([name, data]) => (
            <button
              type="button"
              role="option"
              key={name}
              onMouseDown={(e) => {
                e.preventDefault();
                onAdd(name, data.cat);
                setQuery('');
                setOpen(false);
              }}
              className="flex w-full items-center justify-between gap-3 border-b border-[var(--cdv-hairline)] p-3 text-left transition-colors duration-150 last:border-0 hover:bg-[var(--cdv-surface-sunken)]"
            >
              <span className="flex min-w-0 items-center gap-2">
                <MerchantIcon merchantName={name} category={data.cat} className="h-6 w-6 rounded border-0 bg-transparent" />
                <span className="min-w-0 truncate font-medium text-[var(--cdv-ink)]" dir="auto">{name}</span>
              </span>
              <span className="cdv-chip cdv-cat shrink-0" style={categoryHueStyle(data.cat)}>{data.cat}</span>
            </button>
          ))}
          {matches.length === 0 && (
            <p className="p-3 text-center text-sm text-[var(--cdv-mute)]">
              {showCreate ? `No match. Add “${queryTrim}” to save it.` : 'No stores match.'}
            </p>
          )}
        </div>
      )}
    </fieldset>
  );
}

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
  const [openWalletCardId, setOpenWalletCardId] = useState(null);
  const [expenses, setExpenses] = useState([]);
  const [userClubs, setUserClubs] = useState([]);
  const [customStores, setCustomStores] = useState([]);
  const [aiMessages, setAiMessages] = useState(() => loadAiChatFromStorage() ?? [{ role: 'model', text: DEFAULT_AI_WELCOME_TEXT }]);
  const [aiInput, setAiInput] = useState('');
  const [isAiTyping, setIsAiTyping] = useState(false);
  const [aiLoadingQuote, setAiLoadingQuote] = useState('');
  const [aiTipBarOpen, setAiTipBarOpen] = useState(() => {
    try {
      return localStorage.getItem(AI_TIP_BAR_DISMISSED_KEY) !== '1';
    } catch {
      return true;
    }
  });
  const chatEndRef = useRef(null);
  const abortControllerRef = useRef(null);
  const aiRequestInFlightRef = useRef(false);
  const quickSpendAnchorCardIdRef = useRef(null);
  const walletDetailRef = useRef(null);
  const customStoresRef = useRef([]);
  const pendingStoresRef = useRef([]);
  const storeWriteRef = useRef(Promise.resolve());
  const [showCardForm, setShowCardForm] = useState(false);
  const [cardPendingDelete, setCardPendingDelete] = useState(null);
  const [balanceEditCardId, setBalanceEditCardId] = useState(null);
  const [balanceEditValue, setBalanceEditValue] = useState('');
  const [editingCardId, setEditingCardId] = useState(null);
  const [newCard, setNewCard] = useState(EMPTY_CARD_FORM);
  const [showExpenseForm, setShowExpenseForm] = useState(false);
  const [editingExpenseId, setEditingExpenseId] = useState(null);
  const [expenseValueKind, setExpenseValueKind] = useState('money');
  const [newExpense, setNewExpense] = useState(EMPTY_EXPENSE_FORM);
  const [merchantSearch, setMerchantSearch] = useState('');
  const [showMerchantSuggestions, setShowMerchantSuggestions] = useState(false);
  const [insightSearch, setInsightSearch] = useState('');
  const [clubSearch, setClubSearch] = useState('');
  const [dealsShown, setDealsShown] = useState(DEALS_PAGE_SIZE);
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
    if (activeTab !== 'ai') return undefined;
    const { documentElement: html, body } = document;
    const prevHtml = html.style.overflow;
    const prevBody = body.style.overflow;
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    return () => {
      html.style.overflow = prevHtml;
      body.style.overflow = prevBody;
    };
  }, [activeTab]);

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
    if (!user) {
      setCards([]);
      setExpenses([]);
      setUserClubs([]);
      setCustomStores([]);
      customStoresRef.current = [];
      pendingStoresRef.current = [];
      return;
    }
    let unsubCards = () => {};
    let unsubExpenses = () => {};
    let unsubClubs = () => {};
    let unsubStores = () => {};
    pendingStoresRef.current = [];
    try {
      const db = getFirestore();
      unsubCards = onSnapshot(collection(db, getCollectionPath(user.uid, 'cards')), (snapshot) => setCards(snapshot.docs.map((d) => ({ id: d.id, ...d.data() }))));
      unsubExpenses = onSnapshot(collection(db, getCollectionPath(user.uid, 'expenses')), (snapshot) => setExpenses(snapshot.docs.map((d) => ({ id: d.id, ...d.data() }))));
      unsubClubs = onSnapshot(doc(db, getCollectionPath(user.uid, 'settings'), 'clubsProfile'), (docSnap) => { if (docSnap.exists()) setUserClubs(docSnap.data().activeClubs || []); });
      unsubStores = onSnapshot(doc(db, getCollectionPath(user.uid, 'settings'), 'storeCatalog'), (docSnap) => {
        const clean = cleanStoreCatalog(docSnap.exists() ? docSnap.data().entries : []);
        const pending = pendingStoresRef.current.filter((s) => !clean.some((row) => storeNameKey(row.name) === storeNameKey(s.name)));
        pendingStoresRef.current = pending;
        const merged = [...clean, ...pending];
        customStoresRef.current = merged;
        setCustomStores(merged);
      });
    } catch (e) {
      console.error('Firestore', e);
    }
    return () => { unsubCards(); unsubExpenses(); unsubClubs(); unsubStores(); };
  }, [user]);

  const rememberStore = (name, cat) => {
    const trimmed = String(name || '').trim().replace(/\s+/g, ' ');
    if (!trimmed || !user) return Promise.resolve('');
    const resolved = resolveCatalogStoreName(trimmed, customStoresRef.current);
    if (catalogEntries(customStoresRef.current).some(([entryName]) => entryName === resolved)) return Promise.resolve(resolved);
    const category = CATEGORIES.includes(cat) ? cat : 'Other';
    const entry = { name: trimmed, cat: category };
    const next = [...customStoresRef.current, entry];
    customStoresRef.current = next;
    pendingStoresRef.current = [...pendingStoresRef.current, entry];
    setCustomStores(next);
    const write = storeWriteRef.current.then(() => setDoc(
      doc(getFirestore(), getCollectionPath(user.uid, 'settings'), 'storeCatalog'),
      { entries: customStoresRef.current.filter((row) => row?.name && !KNOWN_MERCHANTS[row.name]) },
      { merge: true },
    ));
    storeWriteRef.current = write.catch((err) => { console.error('store catalog', err); });
    return write.then(() => trimmed).catch(() => trimmed);
  };
  const rememberStoreRef = useRef(rememberStore);
  rememberStoreRef.current = rememberStore;

  useEffect(() => {
    if (!user) return;
    for (const card of cards) {
      const fallbackCat = (card.categories || [])[0] || 'Other';
      for (const name of acceptedStoreNames(card)) {
        if (KNOWN_MERCHANTS[name]) continue;
        if (customStoresRef.current.some((row) => storeNameKey(row.name) === storeNameKey(name))) continue;
        rememberStoreRef.current(name, fallbackCat);
      }
    }
  }, [user, cards]);

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
    const asOf = new Date();
    return cards.map((card) => {
      const funds = computeCardFunds(card, expenses, asOf);
      return { ...card, ...funds, derivedCats: getDerivedCategories(card) };
    });
  }, [cards, expenses]);

  const getRemainingForCardAt = (card, asOf, editingExpense = null) => (
    remainingForPlan(card, expenses, asOf, editingExpense)
  );

  const uniqueCoverageCategories = useMemo(
    () => [...new Set(cardBalances.flatMap((c) => c.derivedCats || []))].sort(),
    [cardBalances]
  );

  const sortedCardBalances = useMemo(() => [...cardBalances].sort((a, b) => {
    const aDays = a.ruleType === 'expires' ? getDaysUntilExpiry(a.expiryDate) : Infinity;
    const bDays = b.ruleType === 'expires' ? getDaysUntilExpiry(b.expiryDate) : Infinity;
    return aDays - bDays;
  }), [cardBalances]);

  const moneyCardBalances = useMemo(() => cardBalances.filter((c) => !isUnitCard(c)), [cardBalances]);
  const unitCardBalances = useMemo(() => cardBalances.filter((c) => isUnitCard(c)), [cardBalances]);
  const totalLoadedBalance = useMemo(() => moneyCardBalances.reduce((sum, card) => sum + (Number(card.loaded) || 0), 0), [moneyCardBalances]);
  const totalRemainingBalance = useMemo(() => moneyCardBalances.reduce((sum, card) => sum + card.remaining, 0), [moneyCardBalances]);
  const totalPlannedExpenses = useMemo(() => {
    const unitIds = new Set(cards.filter((c) => isUnitCard(c)).map((c) => c.id));
    return expenses.reduce((sum, e) => {
      if (unitIds.has(e.cardId) || (e.units != null && e.units !== '')) return sum;
      return sum + parseFloat(e.amount || 0);
    }, 0);
  }, [expenses, cards]);
  const expiringAlerts = useMemo(() => cardBalances.filter((c) => c.ruleType === 'expires' && c.remaining > 0 && getDaysUntilExpiry(c.expiryDate) <= 30).sort((a, b) => getDaysUntilExpiry(a.expiryDate) - getDaysUntilExpiry(b.expiryDate)), [cardBalances]);
  const walletSplit = useMatchMedia('(min-width: 840px)');
  const openWalletCard = cardBalances.find((c) => c.id === openWalletCardId) ?? null;
  useEffect(() => {
    if (walletSplit || !openWalletCardId || !walletDetailRef.current) return;
    walletDetailRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [openWalletCardId, walletSplit]);

  const fundsByCategory = useMemo(() => {
    const grouped = {};
    CATEGORIES.forEach((cat) => { grouped[cat] = { total: 0, sources: [] }; });
    moneyCardBalances.forEach((card) => {
      if (card.remaining > 0) {
        card.derivedCats.forEach((cat) => {
          if (!grouped[cat]) grouped[cat] = { total: 0, sources: [] };
          grouped[cat].total += card.remaining;
          grouped[cat].sources.push(card.name);
        });
      }
    });
    return Object.entries(grouped).filter(([_, data]) => data.total > 0).sort((a, b) => b[1].total - a[1].total);
  }, [moneyCardBalances]);

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
    const walletString = cardBalances.map((c) => walletLineForAdvisor(c)).join(' | ');
    const futurePlansSummary = expenses
      .filter((e) => e.scheduledFor && new Date(e.scheduledFor) > new Date())
      .slice(0, 12)
      .map((e) => {
        const card = cards.find((c) => c.id === e.cardId);
        const cardBit = card ? ` (card ${card.name})` : (e.cardId ? ` (card ${e.cardId})` : '');
        if (isUseLedgerRow(e, card)) return `${e.name}: ${formatUses(e.units, card?.unitLabel || e.unitLabel)} on ${e.scheduledFor}${cardBit}`;
        return `${e.name}:₪${e.amount} on ${e.scheduledFor}${cardBit}`;
      })
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

### RECURRING BALANCES & FUTURE PLANNING:
- MONTHLY cards refill to their full grant on the 1st of each calendar month. Only expenses in that same month reduce that month's balance. Unused money does not carry over.
- CYCLE cards add their grant on a schedule (for example every 3 months). Grants stack until a reset (for example once a year), when the balance returns to zero and the schedule starts again. Only expenses inside the current reset window reduce the balance. "Available now" includes only grants that have already landed. Do not treat the full cycle cap as spendable today.
- EXPERIENCE cards are marked NOT MONEY. Their numbers are uses of one thing, often at one place (massages, a flight, smoothies). Never treat that count as shekels, never use one to pay a store bill, and mention it only when the user is asking about that thing or that place.
- A card marked GIFT CARD STORES ONLY pays only at those named stores, even if its categories are broader. A STORE LIST URL is the page of places that card can be used.
- If the user plans a purchase for a future date, use the balance as of that date. Monthly cards are full again after the 1st. Cycle cards include every grant that will have arrived by then, minus other plans in the same reset window.
- Mention split payment at checkout when a single card cannot cover the full amount but another card or cash can cover the gap.

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

  const clearAiChatHistory = () => {
    if (abortControllerRef.current) abortControllerRef.current.abort();
    const fresh = [{ role: 'model', text: 'היסטוריית הצ\'אט נמחקה! אז מה קונים היום? 😎' }];
    setAiMessages(fresh);
    try {
      localStorage.setItem(AI_CHAT_STORAGE_KEY, JSON.stringify(fresh));
    } catch {
      /* ignore */
    }
    setIsAiTyping(false);
  };

  const resetCardForm = () => { setNewCard(EMPTY_CARD_FORM); setEditingCardId(null); setShowCardForm(false); };
  const resetExpenseForm = () => {
    quickSpendAnchorCardIdRef.current = null;
    setExpenseValueKind('money');
    setNewExpense(EMPTY_EXPENSE_FORM);
    setMerchantSearch('');
    setEditingExpenseId(null);
    setShowExpenseForm(false);
  };

  const handleSaveCard = async (e) => {
    e.preventDefault();
    if (!user || !String(newCard.name || '').trim()) return;
    const isUnits = newCard.valueKind === 'units';

    const applyChrome = (cardData) => {
      const hexRaw = (newCard.plasticAccentHex || '').trim();
      const normalizedHex = hexRaw.startsWith('#') ? hexRaw : (hexRaw ? `#${hexRaw}` : '');
      if (hexToRgb(normalizedHex)) cardData.plasticAccentHex = normalizedHex;
      else if (editingCardId) cardData.plasticAccentHex = deleteField();
      const cardLink = normalizeCardLink(newCard.cardLink);
      if (cardLink) cardData.cardLink = cardLink;
      else if (editingCardId) cardData.cardLink = deleteField();
      const storeListLink = normalizeCardLink(newCard.storeListLink);
      if (storeListLink) cardData.storeListLink = storeListLink;
      else if (editingCardId) cardData.storeListLink = deleteField();
    };

    let cardData;
    if (isUnits) {
      const count = Number(newCard.unitCount);
      const label = String(newCard.unitLabel || '').trim();
      const venue = String(newCard.venue || '').trim();
      if (!Number.isInteger(count) || count < 1 || !label) {
        showToastMsg('Enter how many, and what each one is.', 'error');
        return;
      }
      const ruleType = newCard.ruleType === 'expires' ? 'expires' : 'permanent';
      if (ruleType === 'expires' && !newCard.expiryDate) {
        showToastMsg('Pick the date this expires.', 'error');
        return;
      }
      cardData = {
        name: String(newCard.name).trim(),
        valueKind: 'units',
        unitCount: count,
        unitLabel: label,
        programId: 'CUSTOM',
        ruleType,
        expiryDate: ruleType === 'expires' ? newCard.expiryDate : '',
        categories: [],
        color: PROGRAMS.CUSTOM.color,
        updatedAt: new Date().toISOString(),
      };
      if (venue) cardData.venue = venue;
      else if (editingCardId) cardData.venue = deleteField();
      if (editingCardId) {
        cardData.balance = deleteField();
        cardData.refillEveryMonths = deleteField();
        cardData.resetEveryMonths = deleteField();
        cardData.cycleStartMonth = deleteField();
        cardData.acceptedStores = deleteField();
      }
    } else {
      if (!newCard.balance) return;
      const program = PROGRAMS[newCard.programId];
      let ruleType = newCard.ruleType;
      let cycleFields = null;
      if (isRecurringRule(newCard.ruleType)) {
        const spec = specFromRecurringForm(newCard);
        if (spec?.error) {
          showToastMsg(spec.error, 'error');
          return;
        }
        if (spec && spec.refillEveryMonths === 1 && spec.resetEveryMonths === 1) {
          ruleType = 'monthly';
        } else if (spec) {
          ruleType = 'cycle';
          cycleFields = {
            refillEveryMonths: spec.refillEveryMonths,
            resetEveryMonths: spec.resetEveryMonths,
            cycleStartMonth: spec.cycleStartMonth,
          };
        }
      }
      cardData = {
        name: String(newCard.name).trim(),
        balance: parseFloat(newCard.balance),
        programId: newCard.programId,
        ruleType,
        expiryDate: ruleType === 'expires' ? newCard.expiryDate : '',
        categories: newCard.programId === 'CUSTOM' ? newCard.categories : [],
        color: program.color,
        updatedAt: new Date().toISOString(),
      };
      const stores = [...new Set((newCard.acceptedStores || []).map((s) => String(s).trim()).filter(Boolean))];
      if (stores.length) cardData.acceptedStores = stores;
      else if (editingCardId) cardData.acceptedStores = deleteField();
      if (cycleFields) Object.assign(cardData, cycleFields);
      else if (editingCardId) {
        cardData.refillEveryMonths = deleteField();
        cardData.resetEveryMonths = deleteField();
        cardData.cycleStartMonth = deleteField();
      }
      if (editingCardId) {
        cardData.valueKind = deleteField();
        cardData.unitCount = deleteField();
        cardData.unitLabel = deleteField();
        cardData.venue = deleteField();
      }
    }
    applyChrome(cardData);
    if (!isUnits && Array.isArray(cardData.acceptedStores)) {
      for (const name of cardData.acceptedStores) {
        if (KNOWN_MERCHANTS[name]) continue;
        const knownCustom = customStoresRef.current.find((row) => storeNameKey(row.name) === storeNameKey(name));
        await rememberStore(name, knownCustom?.cat || newCard.categories[0] || 'Other');
      }
    }
    if (editingCardId) await updateDoc(doc(getFirestore(), getCollectionPath(user.uid, 'cards'), editingCardId), cardData);
    else await addDoc(collection(getFirestore(), getCollectionPath(user.uid, 'cards')), cardData);
    showToastMsg(editingCardId ? 'Card updated' : 'Card added to wallet');
    resetCardForm();
  };

  const startSetBalance = (card) => {
    setBalanceEditCardId(card.id);
    const current = Number(card.remaining);
    setBalanceEditValue(Number.isFinite(current) ? String(current) : '');
  };

  const handleSetBalance = async (e) => {
    e.preventDefault();
    if (!user || !balanceEditCardId) return;
    const target = cardBalances.find((c) => c.id === balanceEditCardId);
    const units = isUnitCard(target);
    const amount = Number(balanceEditValue);
    if (units) {
      if (!Number.isInteger(amount) || amount < 0) {
        showToastMsg('Enter a whole number of uses left.', 'error');
        return;
      }
    } else if (!Number.isFinite(amount) || amount < 0) {
      showToastMsg('Enter the balance that is on the card right now.', 'error');
      return;
    }
    await updateDoc(doc(getFirestore(), getCollectionPath(user.uid, 'cards'), balanceEditCardId), {
      balanceSetTo: units ? amount : Math.round(amount * 100) / 100,
      balanceSetAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    showToastMsg(units ? 'Uses updated' : 'Balance updated');
    setBalanceEditCardId(null);
  };

  const handleClearSetBalance = async () => {
    if (!user || !balanceEditCardId) return;
    const target = cardBalances.find((c) => c.id === balanceEditCardId);
    await updateDoc(doc(getFirestore(), getCollectionPath(user.uid, 'cards'), balanceEditCardId), {
      balanceSetTo: deleteField(),
      balanceSetAt: deleteField(),
      updatedAt: new Date().toISOString(),
    });
    showToastMsg(isUnitCard(target) ? 'Back to the tracked count' : 'Back to the tracked balance');
    setBalanceEditCardId(null);
  };

  const handleSaveExpense = async (e) => {
    e.preventDefault();
    if (!user || !newExpense.name || !newExpense.cardId) return;
    const selectedCard = cardBalances.find((c) => c.id === newExpense.cardId);
    const planningAsOf = planDateFromInput(newExpense.scheduledFor);
    const editingRow = editingExpenseId ? expenses.find((ex) => ex.id === editingExpenseId) : null;

    if (expenseValueKind === 'units' || isUnitCard(selectedCard)) {
      const uses = Number(newExpense.units);
      if (!Number.isInteger(uses) || uses < 1) {
        showToastMsg('Enter how many to use.', 'error');
        return;
      }
      if (!selectedCard || !isUnitCard(selectedCard)) {
        showToastMsg('Pick an experience card.', 'error');
        return;
      }
      const left = getRemainingForCardAt(selectedCard, planningAsOf, editingRow);
      if (uses > left) {
        showToastMsg(left > 0 ? `Only ${formatUses(left, selectedCard.unitLabel)} left.` : 'Nothing left on this card.', 'error');
        return;
      }
      const venue = String(selectedCard.venue || '').trim();
      const expenseData = {
        name: newExpense.name,
        units: uses,
        unitLabel: selectedCard.unitLabel || '',
        category: '',
        merchantName: venue,
        expenseCategories: [],
        expenseMerchants: venue ? [venue] : [],
        cardId: newExpense.cardId,
        isCompleted: newExpense.isCompleted || false,
        scheduledFor: newExpense.scheduledFor ? new Date(`${newExpense.scheduledFor}T12:00:00`).toISOString() : null,
        updatedAt: editingExpenseId ? (newExpense.updatedAt || new Date().toISOString()) : new Date().toISOString(),
      };
      if (editingExpenseId) {
        expenseData.amount = deleteField();
        await updateDoc(doc(getFirestore(), getCollectionPath(user.uid, 'expenses'), editingExpenseId), expenseData);
      } else {
        await addDoc(collection(getFirestore(), getCollectionPath(user.uid, 'expenses')), expenseData);
      }
      showToastMsg(editingExpenseId ? 'Update saved' : 'Use logged');
      resetExpenseForm();
      return;
    }

    if (!newExpense.amount || !newExpense.expenseCategories?.length) return;
    const reqAmount = parseFloat(newExpense.amount);
    const planningRemaining = selectedCard
      ? getRemainingForCardAt(selectedCard, planningAsOf)
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
        const cardId = pickExpenseCardId(cardBalances, next.expenseCategories, next.expenseMerchants, '', quickSpendAnchorCardIdRef.current, customStores);
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
  const requestDeleteCard = (card) => setCardPendingDelete(card);
  const confirmDeleteCard = async () => {
    const target = cardPendingDelete;
    setCardPendingDelete(null);
    if (target) await deleteCard(target.id);
  };
  const deleteExpense = async (id) => { if (user) { await deleteDoc(doc(getFirestore(), getCollectionPath(user.uid, 'expenses'), id)); showToastMsg('Expense removed'); } };
  const startEditCard = (card) => {
    const preset = recurringPresetId(card) || 'monthly';
    const units = isUnitCard(card);
    setNewCard({
      ...EMPTY_CARD_FORM,
      ...card,
      balance: card.balance != null ? String(card.balance) : '',
      valueKind: units ? 'units' : 'money',
      unitCount: card.unitCount != null ? String(card.unitCount) : '',
      unitLabel: card.unitLabel || '',
      venue: card.venue || '',
      programId: card.programId || 'CUSTOM',
      ruleType: units
        ? (card.ruleType === 'expires' ? 'expires' : 'permanent')
        : (isRecurringRule(card.ruleType) ? card.ruleType : (card.ruleType || 'permanent')),
      recurringPreset: isRecurringRule(card.ruleType) ? preset : 'monthly',
      refillEveryMonths: card.refillEveryMonths ?? 3,
      resetEveryMonths: card.resetEveryMonths ?? 12,
      cycleStartMonth: card.cycleStartMonth ?? 1,
      expiryDate: card.expiryDate || '',
      categories: card.categories || [],
      acceptedStores: acceptedStoreNames(card),
      plasticAccentHex: card.plasticAccentHex || '',
      cardLink: card.cardLink || '',
      storeListLink: card.storeListLink || '',
    });
    setEditingCardId(card.id);
    setShowCardForm(true);
  };
  const startEditExpense = (expense) => {
    quickSpendAnchorCardIdRef.current = null;
    const card = cardBalances.find((c) => c.id === expense.cardId);
    const unitsMode = isUseLedgerRow(expense, card);
    const expenseCategories = expenseCategoriesForDisplay(expense);
    const expenseMerchants = expenseMerchantsForDisplay(expense);
    setExpenseValueKind(unitsMode ? 'units' : 'money');
    setNewExpense({
      ...expense,
      expenseCategories,
      expenseMerchants,
      amount: expense.amount != null ? String(expense.amount) : '',
      units: expense.units != null ? String(expense.units) : (unitsMode ? '1' : ''),
      scheduledFor: toScheduledForInputValue(expense.scheduledFor),
      isManualSplit: false,
      chargeAmount: '',
    });
    setMerchantSearch('');
    setEditingExpenseId(expense.id);
    setShowExpenseForm(true);
  };
  const startQuickExpense = (cardId) => {
    const card = cardBalances.find((c) => c.id === cardId);
    const unitsMode = isUnitCard(card);
    quickSpendAnchorCardIdRef.current = unitsMode ? null : cardId;
    setExpenseValueKind(unitsMode ? 'units' : 'money');
    setNewExpense({
      ...EMPTY_EXPENSE_FORM,
      name: unitsMode ? (card.unitLabel || card.name || '') : '',
      units: unitsMode ? '1' : '',
      cardId,
    });
    setMerchantSearch('');
    setEditingExpenseId(null);
    setShowExpenseForm(true);
  };
  const addExpenseMerchantFromList = (name, cat) => {
    setNewExpense((prev) => {
      const merchants = prev.expenseMerchants.includes(name) ? prev.expenseMerchants : [...prev.expenseMerchants, name];
      const categories = prev.expenseCategories.includes(cat) ? prev.expenseCategories : [...prev.expenseCategories, cat];
      const cardId = pickExpenseCardId(cardBalances, categories, merchants, prev.cardId, quickSpendAnchorCardIdRef.current, customStores);
      return { ...prev, expenseMerchants: merchants, expenseCategories: categories, cardId };
    });
    setMerchantSearch('');
    setShowMerchantSuggestions(false);
  };
  const addExpenseMerchantFreeText = () => {
    const typed = merchantSearch.trim().replace(/\s+/g, ' ');
    if (!typed) return;
    const resolved = resolveCatalogStoreName(typed, customStores);
    const known = catalogEntries(customStores).find(([name]) => name === resolved);
    if (known) {
      addExpenseMerchantFromList(known[0], known[1].cat);
      return;
    }
    if (getSmartMatches(typed, 1, customStores).length === 0 && newExpense.expenseCategories[0]) {
      rememberStore(typed, newExpense.expenseCategories[0]);
    }
    setNewExpense((prev) => {
      if (prev.expenseMerchants.includes(typed)) return prev;
      const merchants = [...prev.expenseMerchants, typed];
      const cardId = pickExpenseCardId(cardBalances, prev.expenseCategories, merchants, prev.cardId, quickSpendAnchorCardIdRef.current, customStores);
      return { ...prev, expenseMerchants: merchants, cardId };
    });
    setMerchantSearch('');
    setShowMerchantSuggestions(false);
  };
  const removeExpenseMerchant = (name) => {
    setNewExpense((prev) => {
      const merchants = prev.expenseMerchants.filter((m) => m !== name);
      const cardId = pickExpenseCardId(cardBalances, prev.expenseCategories, merchants, prev.cardId, quickSpendAnchorCardIdRef.current, customStores);
      return { ...prev, expenseMerchants: merchants, cardId };
    });
  };
  const toggleExpenseCategory = (cat) => {
    setNewExpense((prev) => {
      const has = prev.expenseCategories.includes(cat);
      const categories = has ? prev.expenseCategories.filter((c) => c !== cat) : [...prev.expenseCategories, cat];
      const cardId = pickExpenseCardId(cardBalances, categories, prev.expenseMerchants, prev.cardId, quickSpendAnchorCardIdRef.current, customStores);
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

  if (loadingAuth) {
    return (
      <div className={`flex min-h-screen min-h-0 flex-1 flex-col ${isDarkMode ? 'dark' : ''}`}>
        <div className="cdv-shell flex min-h-0 flex-1 items-center justify-center" role="status">
          <Loader2 className="animate-spin text-[var(--cdv-faint)]" size={24} aria-hidden />
          <span className="sr-only">Loading…</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className={`flex min-h-screen min-h-0 flex-1 flex-col ${isDarkMode ? 'dark' : ''}`}>
        <div className="cdv-shell flex min-h-0 flex-1 flex-col items-center justify-center px-4 py-12">
          <div className="w-full max-w-sm animate-in slide-in-from-bottom-3 fade-in duration-500">
            <div className="mb-9">
              <span className="mb-6 grid h-11 w-11 place-items-center rounded-[14px] bg-[var(--cdv-surface-inverse)] text-[var(--cdv-on-inverse)]" aria-hidden>
                <CreditCard size={21} />
              </span>
              <h1 className="cdv-display text-[2rem] leading-[1.1]" translate="no">CardsDeVen</h1>
              <p className="mt-2.5 text-[var(--cdv-mute)]">
                Know which gift card to use, before you reach the counter.
              </p>
            </div>

            <div className="cdv-panel p-7">
              <h2 className="cdv-display text-lg">{isLoginMode ? 'Sign in' : 'Create your account'}</h2>
              <p className="mt-1 text-sm text-[var(--cdv-mute)]">
                {isLoginMode ? 'Your wallet and plans sync across devices.' : 'Free, and your card balances stay private to you.'}
              </p>

              {authError && (
                <p
                  role="alert"
                  className="mt-5 flex items-start gap-2 rounded-[var(--cdv-r-md)] px-3.5 py-3 text-sm"
                  style={{ background: 'var(--cdv-danger-soft)', color: 'var(--cdv-danger)' }}
                >
                  <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden />
                  <span>{authError}</span>
                </p>
              )}

              <form onSubmit={handleAuthSubmit} className="mt-6 space-y-4">
                <div>
                  <label htmlFor="cdv-email" className="cdv-label">Email</label>
                  <div className="relative">
                    <Mail className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--cdv-faint)]" size={17} aria-hidden />
                    <input
                      id="cdv-email"
                      name="email"
                      type="email"
                      required
                      autoComplete="email"
                      inputMode="email"
                      spellCheck={false}
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="cdv-input !pl-10"
                      placeholder="you@example.com"
                      dir="ltr"
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor="cdv-password" className="cdv-label">Password</label>
                  <div className="relative">
                    <Lock className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--cdv-faint)]" size={17} aria-hidden />
                    <input
                      id="cdv-password"
                      name="password"
                      type="password"
                      required
                      minLength={6}
                      autoComplete={isLoginMode ? 'current-password' : 'new-password'}
                      spellCheck={false}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="cdv-input !pl-10"
                      placeholder="At least 6 characters"
                      dir="ltr"
                    />
                  </div>
                </div>
                <button type="submit" disabled={isProcessingAuth} className="cdv-btn cdv-btn--primary !mt-6 w-full !py-3">
                  {isProcessingAuth
                    ? <><Loader2 className="animate-spin" size={17} aria-hidden /> {isLoginMode ? 'Signing in…' : 'Creating account…'}</>
                    : (isLoginMode ? 'Sign In' : 'Create Account')}
                </button>
              </form>

              <p className="mt-6 border-t border-[var(--cdv-hairline)] pt-5 text-center text-sm text-[var(--cdv-mute)]">
                {isLoginMode ? 'No account yet? ' : 'Already have an account? '}
                <button
                  type="button"
                  onClick={() => { setIsLoginMode(!isLoginMode); setAuthError(''); }}
                  className="rounded font-semibold text-[var(--cdv-accent)] hover:underline"
                >
                  {isLoginMode ? 'Create one' : 'Sign in'}
                </button>
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`${isDarkMode ? 'dark' : ''} font-sans bg-[var(--cdv-canvas)] ${activeTab === 'ai' ? 'flex min-h-0 max-h-[100dvh] flex-1 flex-col overflow-hidden' : 'min-h-screen flex-1 pb-20'}`}
    >
      <div
        className={`cdv-shell relative ${activeTab === 'ai' ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : 'min-h-screen'}`}
      >
        <a href="#cdv-main" className="cdv-skip-link">Skip to content</a>

        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[200] max-w-[calc(100vw-2rem)]" role="status" aria-live="polite">
          {toast.visible && (
            <div
              className={`flex items-center gap-2 rounded-full px-5 py-3 text-sm font-semibold shadow-[var(--cdv-shadow-float)] animate-in slide-in-from-top-4 fade-in duration-300 ${toast.type === 'error' ? 'bg-[var(--cdv-danger)] text-white' : 'bg-[var(--cdv-surface-inverse)] text-[var(--cdv-on-inverse)]'}`}
            >
              {toast.type === 'success'
                ? <CheckCircle2 size={17} className="text-[var(--cdv-positive)] shrink-0" aria-hidden />
                : <AlertCircle size={17} className="shrink-0" aria-hidden />}
              <span className="min-w-0">{toast.message}</span>
            </div>
          )}
        </div>

        {/*
          A real sticky bar. The previous floating panel sat on top of each tab's
          primary action, which made Add Card and Plan Purchase unclickable.
        */}
        <header className="cdv-topbar sticky top-0 z-50">
          <div className="max-w-6xl mx-auto flex items-center justify-between gap-3 px-4 sm:px-6 h-14">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] bg-[var(--cdv-surface-inverse)] text-[var(--cdv-on-inverse)]" aria-hidden>
                <CreditCard size={15} />
              </span>
              <span className="cdv-display text-base tracking-tight truncate" translate="no">CardsDeVen</span>
            </div>
            <div className="flex items-center gap-1.5 min-w-0">
              <p className="hidden sm:block text-xs text-[var(--cdv-faint)] max-w-[16rem] truncate" title={user.email}>{user.email}</p>
              <button type="button" onClick={() => setIsDarkMode(!isDarkMode)} className="cdv-icon-btn" aria-label={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}>
                {isDarkMode ? <Sun size={17} aria-hidden /> : <Moon size={17} aria-hidden />}
              </button>
              <button type="button" onClick={handleSignOut} className="cdv-icon-btn cdv-icon-btn--danger" aria-label="Sign out">
                <LogOut size={17} aria-hidden />
              </button>
            </div>
          </div>
        </header>

        <main
          id="cdv-main"
          className={`mx-auto w-full max-w-6xl px-4 pt-8 pb-24 sm:px-6 sm:pt-10 ${activeTab === 'ai' ? 'flex min-h-0 flex-1 basis-0 flex-col overflow-hidden' : ''}`}
        >
          {/* Dashboard */}
          {activeTab === 'dashboard' && (
            <div className="space-y-10 animate-in fade-in slide-in-from-bottom-2 duration-500">
              {expiringAlerts.length > 0 && (
                <section aria-labelledby="cdv-expiring-heading" className="cdv-panel overflow-hidden" style={{ borderColor: 'var(--cdv-warning-soft)' }}>
                  <div className="flex items-center gap-2.5 border-b border-[var(--cdv-hairline)] bg-[var(--cdv-warning-soft)] px-5 py-3">
                    <Clock size={15} className="text-[var(--cdv-warning)] shrink-0" aria-hidden />
                    <h3 id="cdv-expiring-heading" className="text-sm font-semibold text-[var(--cdv-warning)]">
                      {expiringAlerts.length === 1 ? '1 card expires' : `${expiringAlerts.length} cards expire`} within 30 days
                    </h3>
                  </div>
                  <ul className="cdv-divide">
                    {expiringAlerts.map((card) => (
                      <li key={card.id} className="flex items-center justify-between gap-4 px-5 py-3.5">
                        <span className="font-medium text-[var(--cdv-ink)] truncate min-w-0">{card.name}</span>
                        <span className="flex shrink-0 items-baseline gap-3">
                          {isUnitCard(card)
                            ? <span className="font-semibold text-[var(--cdv-ink)]">{formatUses(card.remaining, card.unitLabel)}</span>
                            : <Money value={card.remaining} className="font-semibold text-[var(--cdv-ink)]" />}
                          <span className="cdv-badge cdv-badge--warning">{getDaysUntilExpiry(card.expiryDate)} days left</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section aria-label="Portfolio summary" className="cdv-band-inverse overflow-hidden">
                <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-[var(--cdv-band-divider)]">
                  <div className="p-7 sm:p-9">
                    <p className="cdv-eyebrow !text-[var(--cdv-on-band-mute)]">Total portfolio</p>
                    <p className="cdv-amount mt-3 text-4xl sm:text-5xl font-semibold text-[var(--cdv-on-band)]">{formatShekels(totalLoadedBalance)}</p>
                    <p className="mt-2 text-sm text-[var(--cdv-on-band-mute)]">
                      {unitCardBalances.length > 0
                        ? <>Loaded across {moneyCardBalances.length} money {moneyCardBalances.length === 1 ? 'card' : 'cards'}. {unitCardBalances.length} experience {unitCardBalances.length === 1 ? 'card is' : 'cards are'} tracked separately.</>
                        : <>Loaded across {cards.length} {cards.length === 1 ? 'card' : 'cards'}</>}
                    </p>
                  </div>
                  <div className="p-7 sm:p-9">
                    <p className="cdv-eyebrow !text-[var(--cdv-on-band-mute)]">Still available</p>
                    <p className="cdv-amount mt-3 text-4xl sm:text-5xl font-semibold text-[var(--cdv-positive)]">{formatShekels(totalRemainingBalance)}</p>
                    <p className="mt-2 text-sm text-[var(--cdv-on-band-mute)]">
                      After <span className="cdv-amount">{formatShekels(totalPlannedExpenses)}</span> planned and spent
                    </p>
                  </div>
                </div>
              </section>

              <section aria-labelledby="cdv-budget-heading">
                <div className="mb-5 flex items-baseline justify-between gap-4">
                  <h2 id="cdv-budget-heading" className="cdv-display text-2xl">Budget by category</h2>
                  {fundsByCategory.length > 0 && (
                    <p className="cdv-eyebrow shrink-0">{fundsByCategory.length} categories</p>
                  )}
                </div>
                {fundsByCategory.length === 0 ? (
                  <div className="cdv-panel--empty px-6 py-14 text-center">
                    <PieChart size={28} className="mx-auto mb-4 text-[var(--cdv-faint)]" aria-hidden />
                    <p className="font-medium text-[var(--cdv-ink)]">No categories yet</p>
                    <p className="mx-auto mt-1 max-w-xs text-sm text-[var(--cdv-mute)]">Add a card to your wallet and its spending categories appear here.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {fundsByCategory.map(([category, data]) => (
                      <article key={category} className="cdv-panel cdv-panel--interactive cdv-cat-card flex flex-col p-5" style={categoryHueStyle(category)}>
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span className="cdv-cat-mark" aria-hidden>{CATEGORY_ICONS[category]}</span>
                          <h3 className="text-sm font-semibold text-[var(--cdv-body)] leading-tight min-w-0 break-words">{category}</h3>
                        </div>
                        <p className="cdv-amount mt-4 text-2xl font-semibold text-[var(--cdv-ink)]">{formatShekels(data.total)}</p>
                        <p className="mt-3 border-t border-[var(--cdv-hairline)] pt-3 text-xs leading-relaxed text-[var(--cdv-mute)] line-clamp-2" title={data.sources.join(', ')}>
                          {data.sources.join(' · ')}
                        </p>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}

          {/* Wallets */}
          {activeTab === 'wallets' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
              <div className="flex flex-col sm:flex-row sm:justify-between sm:items-end gap-4">
                <div className="min-w-0">
                  <h2 className="cdv-display text-3xl">Wallet</h2>
                  <p className="mt-1.5 text-[var(--cdv-mute)]">Name and balance at a glance. Open a card for the rest.</p>
                </div>
                <button
                  type="button"
                  onClick={() => { resetCardForm(); setShowCardForm(true); }}
                  className="cdv-btn cdv-btn--primary shrink-0"
                >
                  <Plus size={17} aria-hidden /> Add Card
                </button>
              </div>

              {cards.length === 0 ? (
                <div className="cdv-panel--empty px-6 py-16 text-center">
                  <CreditCard size={30} className="mx-auto mb-4 text-[var(--cdv-faint)]" aria-hidden />
                  <h3 className="cdv-display text-lg">Your wallet is empty</h3>
                  <p className="mx-auto mt-2 max-w-sm text-sm text-[var(--cdv-mute)]">Add a gift card, a pack of uses, or a benefit grant and CardsDeVen starts matching it to deals.</p>
                  <button type="button" onClick={() => { resetCardForm(); setShowCardForm(true); }} className="cdv-btn cdv-btn--primary mt-6">
                    <Plus size={17} aria-hidden /> Add your first card
                  </button>
                </div>
              ) : (
                <div className={`cdv-wallet${walletSplit && openWalletCard ? ' cdv-wallet--split' : ''}`}>
                <ul className="cdv-wallet-list" aria-label="Your cards">
                    {cardBalances.map((card) => {
                      const units = isUnitCard(card);
                      const chromeGradient = buildPlasticGradientFromHex(card.plasticAccentHex) || (WALLET_CARD_CHROME[card.programId] || WALLET_CARD_CHROME.CUSTOM);
                      const isExpiringSoon = card.ruleType === 'expires' && getDaysUntilExpiry(card.expiryDate) <= 30;
                      const isOpen = openWalletCardId === card.id;
                      return (
                        <li key={card.id} className="cdv-wallet-entry">
                          <button
                            type="button"
                            className={`cdv-wallet-item${isOpen ? ' cdv-wallet-item--open' : ''}${isExpiringSoon ? ' cdv-wallet-item--soon' : ''}`}
                            aria-expanded={isOpen}
                            aria-controls={isOpen ? 'cdv-wallet-detail' : undefined}
                            onClick={() => setOpenWalletCardId(isOpen ? null : card.id)}
                          >
                            <span className="cdv-wallet-item__swatch" style={{ background: chromeGradient }} aria-hidden />
                            <span className="cdv-wallet-item__name" title={card.name}>{card.name}</span>
                            {units
                              ? <span className="cdv-wallet-item__balance">{formatUses(card.remaining, card.unitLabel)}</span>
                              : <Money value={card.remaining} className="cdv-wallet-item__balance" />}
                            <ChevronDown size={16} className={`cdv-wallet-item__chevron${isOpen ? ' is-open' : ''}`} aria-hidden />
                          </button>
                          {!walletSplit && isOpen && (
                            <OpenWalletCard
                              card={card}
                              detailRef={walletDetailRef}
                              onEdit={startEditCard}
                              onDelete={requestDeleteCard}
                              onSpend={startQuickExpense}
                              onSetBalance={startSetBalance}
                            />
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  {walletSplit && openWalletCard && (
                    <OpenWalletCard
                      card={openWalletCard}
                      detailRef={walletDetailRef}
                      onEdit={startEditCard}
                      onDelete={requestDeleteCard}
                      onSpend={startQuickExpense}
                      onSetBalance={startSetBalance}
                    />
                  )}
                </div>
              )}
            </div>
          )}

          {/* Planner */}
          {activeTab === 'planner' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
              <div className="flex flex-col sm:flex-row sm:justify-between sm:items-end gap-4">
                <div className="min-w-0">
                  <h2 className="cdv-display text-3xl">Planner</h2>
                  <p className="mt-1.5 text-[var(--cdv-mute)]">Reserve funds against a card before you buy.</p>
                </div>
                <button type="button" onClick={() => { resetExpenseForm(); setShowExpenseForm(true); }} className="cdv-btn cdv-btn--primary shrink-0">
                  <Plus size={17} aria-hidden /> Plan Purchase
                </button>
              </div>

              <section aria-labelledby="cdv-ledger-heading" className="cdv-panel overflow-hidden">
                <div className="flex items-center justify-between gap-4 border-b border-[var(--cdv-hairline)] px-5 py-4">
                  <h3 id="cdv-ledger-heading" className="font-semibold text-[var(--cdv-ink)]">Ledger</h3>
                  <p className="flex items-baseline gap-2">
                    <span className="cdv-eyebrow">Reserved</span>
                    <Money value={totalPlannedExpenses} className="font-semibold text-[var(--cdv-ink)]" />
                  </p>
                </div>
                {expenses.length === 0 ? (
                  <div className="px-6 py-14 text-center">
                    <Receipt size={28} className="mx-auto mb-4 text-[var(--cdv-faint)]" aria-hidden />
                    <p className="font-medium text-[var(--cdv-ink)]">Nothing planned yet</p>
                    <p className="mx-auto mt-1 max-w-xs text-sm text-[var(--cdv-mute)]">Plan a purchase and CardsDeVen reserves the funds against the right card.</p>
                  </div>
                ) : (
                  <ul className="cdv-divide">
                    {sortedExpenses.map((expense) => {
                      const sourceCard = cards.find((c) => c.id === expense.cardId);
                      const useRow = isUseLedgerRow(expense, sourceCard);
                      const scheduled = expense.scheduledFor ? new Date(expense.scheduledFor) : null;
                      const isFuture = scheduled ? scheduled > new Date() : false;
                      const merchants = expenseMerchantsForDisplay(expense);
                      const categories = expenseCategoriesForDisplay(expense);
                      return (
                        <li key={expense.id} className="group flex items-center gap-4 px-5 py-4">
                          <button
                            type="button"
                            onClick={() => toggleExpenseCompletion(expense)}
                            className="cdv-icon-btn shrink-0"
                            style={expense.isCompleted ? { color: 'var(--cdv-positive)', background: 'var(--cdv-positive-soft)' } : undefined}
                            aria-pressed={!!expense.isCompleted}
                            aria-label={expense.isCompleted
                              ? `Mark ${expense.name} as not yet ${useRow ? 'used' : 'spent'}`
                              : `Mark ${expense.name} as ${useRow ? 'used' : 'spent'}`}
                          >
                            {expense.isCompleted ? <CheckSquare size={17} aria-hidden /> : <Square size={17} aria-hidden />}
                          </button>

                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className={`font-semibold min-w-0 break-words ${expense.isCompleted ? 'text-[var(--cdv-mute)] line-through decoration-[var(--cdv-hairline-heavy)]' : 'text-[var(--cdv-ink)]'}`}>
                                {expense.name}
                              </p>
                              {expense.isCompleted && <span className="cdv-badge cdv-badge--positive">{useRow ? 'Used' : 'Spent'}</span>}
                              {scheduled && (
                                <span className={`cdv-badge ${isFuture ? 'cdv-badge--accent' : 'cdv-badge--neutral'}`}>
                                  {formatDate(scheduled)}
                                </span>
                              )}
                            </div>
                            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--cdv-mute)]">
                              {categories.length > 0
                                ? categories.map((cat) => (
                                  <span key={cat} className="cdv-chip cdv-cat" style={categoryHueStyle(cat)}>
                                    <span aria-hidden>{CATEGORY_ICONS[cat]}</span> {cat}
                                  </span>
                                ))
                                : <span>{useRow ? (sourceCard?.unitLabel || expense.unitLabel || 'Use') : '—'}</span>}
                              <span aria-hidden className="text-[var(--cdv-faint)]">•</span>
                              <span className="min-w-0 truncate font-medium text-[var(--cdv-body)]">{sourceCard?.name || 'Deleted card'}</span>
                              {merchants.map((m) => (
                                <span key={m} className="flex items-center gap-1 min-w-0">
                                  <MerchantIcon merchantName={m} category={KNOWN_MERCHANTS[m]?.cat || categories[0] || expense.category} className="w-4 h-4 rounded-[4px] border-0" />
                                  <span className="truncate">{m.split('(')[0].trim()}</span>
                                </span>
                              ))}
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center gap-3">
                            {useRow
                              ? <span className={`text-base font-semibold ${expense.isCompleted ? 'text-[var(--cdv-positive)]' : 'text-[var(--cdv-ink)]'}`}>{formatUses(expense.units, sourceCard?.unitLabel || expense.unitLabel)}</span>
                              : <Money value={parseFloat(expense.amount)} className={`text-base font-semibold ${expense.isCompleted ? 'text-[var(--cdv-positive)]' : 'text-[var(--cdv-ink)]'}`} />}
                            <div className="flex gap-0.5 transition-opacity duration-150 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                              <button type="button" onClick={() => startEditExpense(expense)} className="cdv-icon-btn" aria-label={`Edit ${expense.name}`}><Edit2 size={16} aria-hidden /></button>
                              <button type="button" onClick={() => deleteExpense(expense.id)} className="cdv-icon-btn cdv-icon-btn--danger" aria-label={`Delete ${expense.name}`}><Trash2 size={16} aria-hidden /></button>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>
          )}

          {/* Insights */}
          {activeTab === 'insights' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
              <div className="min-w-0">
                <h2 className="cdv-display text-3xl">Checkout check</h2>
                <p className="mt-1.5 text-[var(--cdv-mute)]">Type where you&rsquo;re paying and see which card works, plus any club deal.</p>
              </div>

              {/* Search leads — it is the reason to open this tab. */}
              <section aria-labelledby="cdv-search-heading" className="cdv-band-inverse p-6 sm:p-8">
                <h3 id="cdv-search-heading" className="cdv-eyebrow !text-[var(--cdv-on-band-mute)]">Where are you paying?</h3>
                <div className="relative mt-3">
                  <Search size={18} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[var(--cdv-on-band-mute)]" aria-hidden />
                  <input
                    type="search"
                    name="merchant"
                    autoComplete="off"
                    spellCheck={false}
                    value={insightSearch}
                    onChange={(e) => setInsightSearch(e.target.value)}
                    placeholder="Zara, Domino&rsquo;s, Cinema City…"
                    aria-label="Search for a merchant"
                    className="w-full rounded-full border border-white/20 bg-white/10 py-3.5 pl-12 pr-4 text-base text-[var(--cdv-on-band)] placeholder:text-[var(--cdv-on-band-mute)] outline-none transition-colors duration-150 focus:border-white/50 focus:bg-white/15"
                  />
                </div>

                {insightSearch && (
                  <div className="mt-6 space-y-3" aria-live="polite">
                    {(() => {
                      const matches = getSmartMatches(insightSearch, 5, customStores);
                      if (matches.length === 0) {
                        return (
                          <p className="rounded-[var(--cdv-r-md)] border border-white/15 bg-white/5 px-4 py-3.5 text-sm text-[var(--cdv-on-band-mute)]">
                            No match in the merchant database. Your general category rules still apply — check the coverage table below.
                          </p>
                        );
                      }
                      return matches.map(([searchMatch, mData]) => {
                        const acceptedCards = sortedCardBalances.filter((c) => !isUnitCard(c) && checkCompatibility(c, mData.cat, searchMatch).allowed && c.remaining > 0);
                        const merchantDeals = discountsData.filter(
                          (d) => userClubs.includes(d.c) && dealMatchesInsightMerchant(d, searchMatch, insightSearch)
                        );
                        return (
                          <article key={searchMatch} className="animate-in slide-in-from-bottom-1 fade-in rounded-[var(--cdv-r-lg)] border border-white/15 bg-white/[0.07] p-5">
                            <div className="flex items-center gap-3">
                              <MerchantIcon merchantName={searchMatch} category={mData.cat} className="w-9 h-9 rounded-[10px]" />
                              <div className="min-w-0">
                                <h4 className="font-semibold leading-tight text-[var(--cdv-on-band)] break-words" dir="auto">{searchMatch}</h4>
                                <p className="mt-1.5">
                                  <span className="cdv-chip cdv-cat" style={categoryHueStyle(mData.cat)}>
                                    <span aria-hidden>{CATEGORY_ICONS[mData.cat]}</span> {mData.cat}
                                  </span>
                                </p>
                              </div>
                            </div>

                            <div className="mt-4">
                              {acceptedCards.length > 0 ? (
                                <ul className="flex flex-wrap gap-2">
                                  {acceptedCards.map((c) => {
                                    const isExpiringSoon = c.ruleType === 'expires' && getDaysUntilExpiry(c.expiryDate) <= 30;
                                    return (
                                      <li
                                        key={c.id}
                                        className="flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm"
                                        style={isExpiringSoon
                                          ? { background: 'var(--cdv-warning-soft)', borderColor: 'var(--cdv-warning)', color: 'var(--cdv-warning)' }
                                          : { background: 'rgba(255,255,255,0.95)', borderColor: 'transparent', color: '#14171a' }}
                                      >
                                        {isExpiringSoon
                                          ? <Clock size={14} className="shrink-0" aria-hidden />
                                          : <CheckCircle2 size={14} className="shrink-0 text-[#12795e]" aria-hidden />}
                                        <span className="truncate max-w-[12rem] font-medium">{c.name}</span>
                                        <Money value={c.remaining} className="font-semibold opacity-70" />
                                      </li>
                                    );
                                  })}
                                </ul>
                              ) : (
                                <p className="inline-flex items-start gap-2 rounded-[var(--cdv-r-md)] px-3.5 py-2.5 text-sm" style={{ background: 'var(--cdv-danger-soft)', color: 'var(--cdv-danger)' }}>
                                  <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden />
                                  <span>No card with funds covers this merchant.</span>
                                </p>
                              )}
                            </div>

                            {merchantDeals.length > 0 && (
                              <div className="mt-5 border-t border-white/15 pt-4">
                                <p className="cdv-eyebrow !text-[var(--cdv-on-band-mute)] mb-3 flex items-center gap-1.5">
                                  <Gift size={12} aria-hidden /> Club deals
                                </p>
                                <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                  {merchantDeals.map((deal, idx) => (
                                    <li key={deal._bhKey || deal.product_id || idx} className="flex items-start gap-2.5 rounded-[var(--cdv-r-md)] border border-white/10 bg-black/25 p-3">
                                      <span className="cdv-chip cdv-cat shrink-0" style={{ '--cat-h': CLUBS[deal.c].hue }} dir="rtl" translate="no">{CLUBS[deal.c].name}</span>
                                      <DealLink url={deal.url || deal.product_url} className="min-w-0 text-sm leading-snug text-[var(--cdv-on-band)] hover:underline">{deal.d}</DealLink>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </article>
                        );
                      });
                    })()}
                    {(() => {
                      const redeemCards = sortedCardBalances.filter((c) => unitCardMatchesQuery(c, insightSearch));
                      if (redeemCards.length === 0) return null;
                      return (
                        <article className="rounded-[var(--cdv-r-lg)] border border-white/15 bg-white/[0.07] p-5">
                          <p className="cdv-eyebrow !text-[var(--cdv-on-band-mute)] mb-3">You can redeem</p>
                          <ul className="space-y-2">
                            {redeemCards.map((c) => (
                              <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-2 text-sm text-[var(--cdv-on-band)]">
                                <span className="font-medium">{c.name}</span>
                                <span>{formatUses(c.remaining, c.unitLabel)}{c.venue ? ` at ${c.venue}` : ''}</span>
                              </li>
                            ))}
                          </ul>
                        </article>
                      );
                    })()}
                  </div>
                )}
              </section>

              {cardBalances.length > 0 && uniqueCoverageCategories.length > 0 && (
                <section aria-labelledby="cdv-coverage-heading" className="cdv-panel overflow-hidden">
                  <div className="border-b border-[var(--cdv-hairline)] px-5 py-4 sm:px-6">
                    <h3 id="cdv-coverage-heading" className="font-semibold text-[var(--cdv-ink)]">Category coverage</h3>
                    <p className="mt-1 max-w-2xl text-sm text-[var(--cdv-mute)]">
                      Which of your cards can pay in each category.
                      {moneyCardBalances.length > 5 && <span className="hidden sm:inline"> Scroll sideways for the rest of your cards.</span>}
                    </p>
                  </div>

                  {/* Small screens get a stacked list; the matrix needs width to stay legible. */}
                  <ul className="cdv-divide sm:hidden">
                    {uniqueCoverageCategories.map((category) => {
                      const supporting = moneyCardBalances.filter((c) => (c.derivedCats || []).includes(category));
                      return (
                        <li key={category} className="px-5 py-4">
                          <div className="flex items-center gap-2.5">
                            <span className="cdv-cat-mark" style={categoryHueStyle(category)} aria-hidden>{CATEGORY_ICONS[category] || '🏷️'}</span>
                            <h4 className="text-sm font-semibold leading-tight text-[var(--cdv-ink)] min-w-0">{category}</h4>
                          </div>
                          <div className="mt-2.5 flex flex-wrap gap-1.5">
                            {supporting.length === 0 ? (
                              <span className="cdv-badge cdv-badge--neutral">No coverage</span>
                            ) : (
                              supporting.map((c) => {
                                const onlyAt = storeLimitSummary(c);
                                return <span key={c.id} className="cdv-badge cdv-badge--positive">{c.name}{onlyAt ? ` · ${onlyAt}` : ''}</span>;
                              })
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>

                  <div className="hidden sm:block overflow-x-auto">
                    <table className="w-full min-w-[800px] border-collapse text-sm">
                      <caption className="sr-only">Wallet card coverage by shopping category</caption>
                      <thead>
                        <tr>
                          <th scope="col" className="sticky left-0 z-20 min-w-[210px] border-b border-r border-[var(--cdv-hairline)] bg-[var(--cdv-surface)] px-5 py-3 text-left">
                            <span className="cdv-eyebrow">Category</span>
                          </th>
                          {moneyCardBalances.map((card) => {
                            const prog = PROGRAMS[card.programId || 'CUSTOM'] || PROGRAMS.CUSTOM;
                            return (
                              <th key={card.id} scope="col" className="min-w-[120px] border-b border-[var(--cdv-hairline)] px-3 py-3 align-bottom text-center">
                                <span className="flex flex-col items-center gap-1">
                                  <span className="text-xs font-semibold leading-tight text-[var(--cdv-ink)]">{card.name}</span>
                                  <span className="max-w-[140px] truncate text-[10px] text-[var(--cdv-faint)]">{prog.name}</span>
                                </span>
                              </th>
                            );
                          })}
                        </tr>
                      </thead>
                      <tbody className="cdv-divide">
                        {uniqueCoverageCategories.map((category) => (
                          <tr key={category} className="group">
                            <th scope="row" className="sticky left-0 z-10 border-r border-[var(--cdv-hairline)] bg-[var(--cdv-surface)] px-5 py-3 text-left font-medium text-[var(--cdv-body)] transition-colors duration-150 group-hover:bg-[var(--cdv-surface-sunken)]">
                              <span className="inline-flex items-center gap-2">
                                <span className="cdv-cat-mark" style={categoryHueStyle(category)} aria-hidden>{CATEGORY_ICONS[category] || '🏷️'}</span>
                                <span className="leading-tight">{category}</span>
                              </span>
                            </th>
                            {moneyCardBalances.map((card) => {
                              const covered = (card.derivedCats || []).includes(category);
                              const onlyAt = storeLimitSummary(card);
                              const coverLabel = onlyAt
                                ? `${card.name} covers ${category} only at ${onlyAt}`
                                : `${card.name} covers ${category}`;
                              return (
                                <td key={`${category}-${card.id}`} className="p-2 text-center align-middle transition-colors duration-150 group-hover:bg-[var(--cdv-surface-sunken)]">
                                  {covered ? (
                                    <CheckCircle2 className="mx-auto text-[var(--cdv-positive)]" size={18} aria-label={coverLabel} />
                                  ) : (
                                    <>
                                      <span className="mx-auto block h-1 w-1 rounded-full bg-[var(--cdv-hairline-heavy)]" aria-hidden />
                                      <span className="sr-only">{card.name} does not cover {category}</span>
                                    </>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
            </div>
          )}

          {/* Clubs */}
          {activeTab === 'clubs' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
              <div className="min-w-0">
                <h2 className="cdv-display text-3xl">Clubs</h2>
                <p className="mt-1.5 text-[var(--cdv-mute)]">Turn on the clubs you belong to and their deals appear here.</p>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {Object.values(CLUBS).map((club) => {
                  const isActive = userClubs.includes(club.id);
                  return (
                    <button
                      key={club.id}
                      type="button"
                      onClick={() => handleToggleClub(club.id)}
                      aria-pressed={isActive}
                      className={`cdv-panel cdv-club flex items-center justify-between gap-3 px-5 py-4 text-left transition-colors duration-150 ${isActive ? 'cdv-club--on' : 'hover:border-[var(--cdv-hairline-strong)]'}`}
                      style={{ '--cat-h': club.hue }}
                    >
                      <span className="min-w-0">
                        <span className="block font-semibold text-[var(--cdv-ink)] truncate" dir="rtl" translate="no">{club.name}</span>
                        <span className="cdv-eyebrow mt-0.5 block">
                          {isActive ? 'Active' : 'Not a member'}
                        </span>
                      </span>
                      {isActive
                        ? <CheckCircle2 size={19} className="cdv-club__mark shrink-0" aria-hidden />
                        : <Plus size={19} className="shrink-0 text-[var(--cdv-faint)]" aria-hidden />}
                    </button>
                  );
                })}
              </div>

              <section aria-labelledby="cdv-deals-heading" className="cdv-panel overflow-hidden">
                <div className="border-b border-[var(--cdv-hairline)] px-5 py-4">
                  <h3 id="cdv-deals-heading" className="sr-only">Available deals</h3>
                  <div className="relative max-w-md">
                    <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--cdv-faint)]" size={17} aria-hidden />
                    <input
                      type="search"
                      name="deal"
                      autoComplete="off"
                      spellCheck={false}
                      value={clubSearch}
                      onChange={(e) => { setClubSearch(e.target.value); setDealsShown(DEALS_PAGE_SIZE); }}
                      placeholder="Search deals — pizza, FOX, hotel…"
                      aria-label="Search deals"
                      className="cdv-input !pl-10"
                    />
                  </div>
                </div>

                {userClubs.length === 0 ? (
                  <div className="px-6 py-14 text-center">
                    <Gift size={28} className="mx-auto mb-4 text-[var(--cdv-faint)]" aria-hidden />
                    <p className="font-medium text-[var(--cdv-ink)]">No clubs selected</p>
                    <p className="mx-auto mt-1 max-w-xs text-sm text-[var(--cdv-mute)]">Pick a club above to load its current deals.</p>
                  </div>
                ) : (() => {
                  const visibleDeals = discountsData.filter((d) => userClubs.includes(d.c) && dealMatchesClubSearch(d, clubSearch));
                  if (visibleDeals.length === 0) {
                    return (
                      <div className="px-6 py-14 text-center" aria-live="polite">
                        <Search size={28} className="mx-auto mb-4 text-[var(--cdv-faint)]" aria-hidden />
                        <p className="font-medium text-[var(--cdv-ink)]">No deals match &ldquo;{clubSearch}&rdquo;</p>
                        <p className="mx-auto mt-1 max-w-xs text-sm text-[var(--cdv-mute)]">Try a shorter term, or clear the search to browse everything.</p>
                      </div>
                    );
                  }
                  const shown = visibleDeals.slice(0, dealsShown);
                  return (
                    <>
                      <p className="px-5 pt-4 cdv-eyebrow" aria-live="polite">
                        {shown.length < visibleDeals.length
                          ? `${shown.length} of ${visibleDeals.length} deals`
                          : `${visibleDeals.length} deals`}
                      </p>
                      {/*
                        Deals are Hebrew, so each row gets dir="rtl". Under the document's
                        LTR base direction the trailing ₪ and the parentheses around prices
                        were reordered, which made the prices read wrong.
                      */}
                      <ul className="mt-4 grid grid-cols-1 gap-px border-t border-[var(--cdv-hairline)] bg-[var(--cdv-hairline)] md:grid-cols-2">
                        {shown.map((deal, idx) => (
                          <li
                            key={deal.product_id ? `pais-${deal.product_id}` : deal._bhKey || `${deal.c}-${idx}-${deal.m.slice(0, 40)}`}
                            dir="rtl"
                            className="flex items-start gap-3 bg-[var(--cdv-surface)] p-4 transition-colors duration-150 hover:bg-[var(--cdv-surface-sunken)]"
                          >
                            <MerchantIcon merchantName={deal.m} category={KNOWN_MERCHANTS[deal.m]?.cat || 'Other'} className="w-10 h-10 rounded-[10px] shrink-0" />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <h4 className="min-w-0 break-words font-semibold leading-tight text-[var(--cdv-ink)]">{deal.m.split('(')[0].trim()}</h4>
                                <span className="cdv-chip cdv-cat" style={{ '--cat-h': CLUBS[deal.c].hue }} translate="no">{CLUBS[deal.c].name}</span>
                              </div>
                              <DealLink
                                url={deal.url || deal.product_url}
                                className="mt-1 block text-sm leading-snug text-[var(--cdv-accent)] hover:underline"
                              >
                                {deal.d}
                              </DealLink>
                            </div>
                          </li>
                        ))}
                      </ul>
                      {shown.length < visibleDeals.length && (
                        <div className="border-t border-[var(--cdv-hairline)] p-5 text-center">
                          <button type="button" onClick={() => setDealsShown((n) => n + DEALS_PAGE_SIZE)} className="cdv-btn cdv-btn--outline">
                            Show {Math.min(DEALS_PAGE_SIZE, visibleDeals.length - shown.length)} more
                          </button>
                        </div>
                      )}
                    </>
                  );
                })()}
              </section>
            </div>
          )}

          {/* Advisor — scoped styles in aiChatBrutalist.css */}
          {activeTab === 'ai' && (
            <div className="ai-advisor-chat mx-auto flex min-h-0 w-full max-w-4xl flex-1 basis-0 flex-col text-left animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div className="ai-chat-shell">
                {/*
                  Clear lives in the header instead of the old sticky overlay, which
                  floated over the first message and clipped it.
                */}
                <div className="ai-chat-header">
                  <h2 className="ai-chat-header__title">
                    <span className="ai-chat-header__dot" aria-hidden />
                    Advisor
                  </h2>
                  <div className="ai-chat-header__actions">
                    {!aiTipBarOpen && (
                      <button
                        type="button"
                        className="cdv-btn cdv-btn--ghost"
                        onClick={() => {
                          setAiTipBarOpen(true);
                          try {
                            localStorage.removeItem(AI_TIP_BAR_DISMISSED_KEY);
                          } catch {
                            /* ignore */
                          }
                        }}
                      >
                        Show tip
                      </button>
                    )}
                    <button type="button" onClick={clearAiChatHistory} className="cdv-icon-btn cdv-icon-btn--danger" title="Clear chat history">
                      <Trash2 size={16} aria-hidden />
                      <span className="sr-only">Clear chat history</span>
                    </button>
                  </div>
                </div>

                {aiTipBarOpen && (
                  <div className="ai-chat-tip">
                    <p className="ai-chat-tip__text">
                      <strong>Tip</strong> — budget, item and area together give sharper combinations.
                    </p>
                    <button
                      type="button"
                      className="cdv-icon-btn"
                      title="Dismiss tip"
                      onClick={() => {
                        setAiTipBarOpen(false);
                        try {
                          localStorage.setItem(AI_TIP_BAR_DISMISSED_KEY, '1');
                        } catch {
                          /* ignore */
                        }
                      }}
                    >
                      <X size={15} aria-hidden />
                      <span className="sr-only">Dismiss tip</span>
                    </button>
                  </div>
                )}

                <div className="ai-chat-scroll space-y-4">
                  {aiMessages.map((msg, idx) => {
                    const replyLang = msg.role === 'model' ? precedingUserLang(aiMessages, idx) : 'he';
                    return (
                      <div key={idx} className={`ai-chat-row ${msg.role === 'user' ? 'ai-chat-row--user' : ''}`}>
                        {msg.role === 'model' && (
                          <div className="ai-chat-avatar">
                            <Bot size={15} aria-hidden />
                          </div>
                        )}
                        <div
                          className={`ai-chat-bubble break-words ${msg.role === 'user' ? 'ai-chat-bubble--user whitespace-pre-wrap text-left' : `ai-chat-bubble--model ${replyLang === 'en' ? 'text-left' : 'text-right'}`}`}
                          dir={msg.role === 'model' ? (replyLang === 'en' ? 'ltr' : 'rtl') : 'auto'}
                        >
                          <div className="ai-chat-meta">{msg.role === 'user' ? 'You' : 'Advisor'}</div>
                          <div dir="auto">
                            {msg.role === 'model' ? renderAdvisorMessage(msg.text, replyLang) : renderChatText(msg.text)}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {/* Before the first question the pane is otherwise empty, so offer openers. */}
                  {aiMessages.length <= 1 && !isAiTyping && (
                    <div className="pt-2">
                      <p className="cdv-eyebrow mb-3">Try asking</p>
                      <div className="flex flex-wrap gap-2">
                        {AI_STARTER_PROMPTS.map((prompt) => (
                          <button
                            key={prompt}
                            type="button"
                            onClick={() => setAiInput(prompt)}
                            className="cdv-chip cdv-chip--selectable text-left"
                          >
                            {prompt}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {isAiTyping && (
                    <div className="ai-chat-row">
                      <div className="ai-chat-avatar">
                        <Bot size={15} className="opacity-60" aria-hidden />
                      </div>
                      <div className="ai-loader-card">
                        <HamsterWheelLoader />
                        {aiLoadingQuote && <p className="ai-loader-quote">{aiLoadingQuote}</p>}
                      </div>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>

                <div className="ai-chat-composer">
                  <form onSubmit={handleSendAI}>
                    <label htmlFor="ai-chat-input" className="sr-only">Message the advisor</label>
                    <div className="ai-chat-composer__field">
                      <input
                        id="ai-chat-input"
                        type="text"
                        value={aiInput}
                        onChange={(e) => setAiInput(e.target.value)}
                        placeholder="e.g. I need pizza for 10 people…"
                        disabled={isAiTyping}
                        className="ai-chat-composer__input"
                        autoComplete="off"
                        dir="auto"
                      />
                      <button type="submit" disabled={!aiInput.trim() || isAiTyping} className="ai-chat-composer__send" aria-label="Send message">
                        <Send size={16} aria-hidden />
                      </button>
                    </div>
                    <p className="ai-chat-composer__hint">Answers use your real card balances and active club deals.</p>
                  </form>
                </div>
              </div>
            </div>
          )}
        </main>

        <nav aria-label="Main" className="cdv-nav fixed bottom-0 left-0 right-0 z-40 flex justify-around gap-1 px-2 py-1.5 sm:justify-center sm:gap-4 lg:gap-8">
          {[{ id: 'dashboard', icon: LayoutDashboard, label: 'Home' }, { id: 'wallets', icon: CreditCard, label: 'Wallet' }, { id: 'planner', icon: Receipt, label: 'Planner' }, { id: 'insights', icon: Search, label: 'Checkout' }, { id: 'clubs', icon: Gift, label: 'Clubs' }, { id: 'ai', icon: Bot, label: 'Advisor' }].map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              aria-current={activeTab === item.id ? 'page' : undefined}
              className={`cdv-nav-item ${activeTab === item.id ? 'cdv-nav-item--on' : ''}`}
            >
              <item.icon size={19} aria-hidden />
              <span className="cdv-nav-item__label">{item.label}</span>
            </button>
          ))}
        </nav>

        <Modal isOpen={!!cardPendingDelete} onClose={() => setCardPendingDelete(null)} title="Delete this card?">
          <p className="text-[var(--cdv-body)]">
            <span className="font-semibold text-[var(--cdv-ink)]">{cardPendingDelete?.name}</span> will be removed from your wallet.
            Planned purchases that point at it stay in the ledger but lose their funding source.
          </p>
          <div className="mt-7 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" onClick={() => setCardPendingDelete(null)} className="cdv-btn cdv-btn--outline">Keep card</button>
            <button type="button" onClick={confirmDeleteCard} className="cdv-btn" style={{ background: 'var(--cdv-danger)', color: '#fff' }}>
              <Trash2 size={16} aria-hidden /> Delete card
            </button>
          </div>
        </Modal>

        <Modal
          isOpen={!!balanceEditCardId}
          onClose={() => setBalanceEditCardId(null)}
          title={(() => {
            const named = cardBalances.find((c) => c.id === balanceEditCardId);
            const verb = named && isUnitCard(named) ? 'Set remaining' : 'Set balance';
            return named ? `${verb} · ${named.name}` : verb;
          })()}
        >
          {(() => {
            const target = cardBalances.find((c) => c.id === balanceEditCardId);
            const units = isUnitCard(target);
            const hasSnapshot = target && target.balanceSetTo != null && target.balanceSetTo !== '';
            return (
              <form onSubmit={handleSetBalance} className="space-y-6">
                <p className="text-sm leading-relaxed text-[var(--cdv-mute)]">
                  {units
                    ? 'Type how many uses are left right now. Use it when a redemption was not logged, or when more were added. Older plans stay in the ledger and are already included in this number. Anything you log after saving is subtracted.'
                    : 'Type the amount on this card right now. Use it when spending was not logged, or when more money was added. Older plans stay in the ledger and are already included in this number. Anything you plan after saving is subtracted.'}
                  {target && !units && isRecurringRule(target.ruleType) ? ' A monthly or yearly card goes back to its normal refill at the next reset.' : ''}
                </p>
                <div>
                  <label htmlFor="set-balance-amount" className="cdv-label">{units ? `Uses left${target?.unitLabel ? ` (${target.unitLabel})` : ''}` : 'Current balance (₪)'}</label>
                  <input
                    id="set-balance-amount"
                    type="number"
                    required
                    min="0"
                    step={units ? '1' : '0.01'}
                    value={balanceEditValue}
                    onChange={(e) => setBalanceEditValue(e.target.value)}
                    className="cdv-input cdv-amount !text-base !font-semibold"
                    placeholder={units ? '0' : '0.00'}
                  />
                </div>
                <div className="flex flex-col-reverse gap-2 border-t border-[var(--cdv-hairline)] pt-6 sm:flex-row sm:justify-end">
                  {hasSnapshot ? (
                    <button type="button" onClick={handleClearSetBalance} className="cdv-btn cdv-btn--outline">
                      {units ? 'Use tracked count' : 'Use tracked balance'}
                    </button>
                  ) : null}
                  <button type="submit" className="cdv-btn cdv-btn--primary">{units ? 'Save remaining' : 'Save balance'}</button>
                </div>
              </form>
            );
          })()}
        </Modal>

        <Modal isOpen={showCardForm} onClose={resetCardForm} title={editingCardId ? 'Edit Card' : 'Add Card'}>
          <form onSubmit={handleSaveCard} className="space-y-6">
            <fieldset>
              <legend className="cdv-label">What this card holds</legend>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {[{ id: 'money', label: 'Money balance', detail: 'Shekels you can spend, like Cibus or a gift card.' }, { id: 'units', label: 'Uses', detail: 'A count of something, like 10 massages or 1 flight. No money.' }].map((option) => {
                  const isSelected = (newCard.valueKind || 'money') === option.id;
                  return (
                    <button
                      type="button"
                      key={option.id}
                      onClick={() => setNewCard({
                        ...newCard,
                        valueKind: option.id,
                        ruleType: option.id === 'units'
                          ? (newCard.ruleType === 'expires' ? 'expires' : 'permanent')
                          : newCard.ruleType,
                        programId: option.id === 'units' ? 'CUSTOM' : newCard.programId,
                        categories: option.id === 'units' ? [] : newCard.categories,
                      })}
                      aria-pressed={isSelected}
                      className="flex flex-col gap-0.5 rounded-[var(--cdv-r-md)] border p-3 text-left transition-colors duration-150"
                      style={isSelected
                        ? { borderColor: 'var(--cdv-accent)', background: 'var(--cdv-accent-soft)' }
                        : { borderColor: 'var(--cdv-hairline)', background: 'var(--cdv-surface-sunken)' }}
                    >
                      <span className={`text-sm font-semibold leading-tight ${isSelected ? 'text-[var(--cdv-accent)]' : 'text-[var(--cdv-ink)]'}`}>{option.label}</span>
                      <span className="text-[11px] leading-snug text-[var(--cdv-mute)]">{option.detail}</span>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {newCard.valueKind !== 'units' && (
            <fieldset>
              <legend className="cdv-label">Program type</legend>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {Object.values(PROGRAMS).map((prog) => {
                  const isSelected = newCard.programId === prog.id;
                  return (
                    <button
                      type="button"
                      key={prog.id}
                      onClick={() => {
                        const categories = prog.id === 'CUSTOM'
                          ? [...new Set((newCard.acceptedStores || []).map((name) => (merchantMeta(name, customStores) || KNOWN_MERCHANTS[name])?.cat).filter((cat) => CATEGORIES.includes(cat)))]
                          : [];
                        setNewCard({ ...newCard, programId: prog.id, categories });
                      }}
                      aria-pressed={isSelected}
                      className="flex flex-col gap-0.5 rounded-[var(--cdv-r-md)] border p-3 text-left transition-colors duration-150"
                      style={isSelected
                        ? { borderColor: 'var(--cdv-accent)', background: 'var(--cdv-accent-soft)' }
                        : { borderColor: 'var(--cdv-hairline)', background: 'var(--cdv-surface-sunken)' }}
                    >
                      <span className={`text-sm font-semibold leading-tight ${isSelected ? 'text-[var(--cdv-accent)]' : 'text-[var(--cdv-ink)]'}`}>{prog.name}</span>
                      <span className="text-[11px] leading-tight text-[var(--cdv-mute)]">{prog.description}</span>
                    </button>
                  );
                })}
              </div>
            </fieldset>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div><label htmlFor="card-name" className="cdv-label">Display Name</label><input id="card-name" type="text" required value={newCard.name} onChange={(e) => setNewCard({ ...newCard, name: e.target.value })} className="cdv-input" placeholder={newCard.valueKind === 'units' ? 'e.g. Spa package' : 'e.g. My Cibus Card'} /></div>
              {newCard.valueKind === 'units' ? (
                <div>
                  <label htmlFor="card-unit-count" className="cdv-label">How many</label>
                  <input id="card-unit-count" type="number" required min="1" step="1" value={newCard.unitCount} onChange={(e) => setNewCard({ ...newCard, unitCount: e.target.value })} className="cdv-input cdv-amount !text-base !font-semibold" placeholder="10" />
                </div>
              ) : (
                <div>
                  <label htmlFor="card-balance" className="cdv-label">{isRecurringRule(newCard.ruleType) ? 'Added each refill (₪)' : 'Total Limit (₪)'}</label>
                  <input id="card-balance" type="number" required min="0" step="0.01" value={newCard.balance} onChange={(e) => setNewCard({ ...newCard, balance: e.target.value })} className="cdv-input cdv-amount !text-base !font-semibold" placeholder="0.00" />
                  {isRecurringRule(newCard.ruleType) ? (
                    <p className="mt-2 text-xs leading-relaxed text-[var(--cdv-mute)]">This is one deposit. A monthly card reloads this amount. A longer cycle adds it again each refill until the reset.</p>
                  ) : null}
                </div>
              )}
            </div>

            {newCard.valueKind === 'units' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <div>
                  <label htmlFor="card-unit-label" className="cdv-label">What each one is</label>
                  <input id="card-unit-label" type="text" required value={newCard.unitLabel} onChange={(e) => setNewCard({ ...newCard, unitLabel: e.target.value })} className="cdv-input" placeholder="massages" />
                  <p className="mt-2 text-xs leading-relaxed text-[var(--cdv-mute)]">Shown after the number, so type it the way you want it read: massages, flight ticket, smoothies.</p>
                </div>
                <div>
                  <label htmlFor="card-venue" className="cdv-label">Where</label>
                  <input id="card-venue" type="text" value={newCard.venue} onChange={(e) => setNewCard({ ...newCard, venue: e.target.value })} className="cdv-input" placeholder="Optional place" />
                </div>
              </div>
            )}

            {newCard.valueKind !== 'units' && (
              <StoreLimitPicker
                selected={newCard.acceptedStores || []}
                customStores={customStores}
                defaultCategory={(newCard.categories || [])[0] || 'Other'}
                onAdd={(name, cat) => {
                  setNewCard((prev) => {
                    const stores = (prev.acceptedStores || []).some((s) => storeNameKey(s) === storeNameKey(name))
                      ? prev.acceptedStores
                      : [...(prev.acceptedStores || []), name];
                    const categories = prev.programId === 'CUSTOM' && cat && CATEGORIES.includes(cat) && !(prev.categories || []).includes(cat)
                      ? [...(prev.categories || []), cat]
                      : prev.categories;
                    return { ...prev, acceptedStores: stores, categories };
                  });
                }}
                onCreate={(name, cat) => {
                  rememberStore(name, cat);
                  setNewCard((prev) => {
                    const stores = (prev.acceptedStores || []).some((s) => storeNameKey(s) === storeNameKey(name))
                      ? prev.acceptedStores
                      : [...(prev.acceptedStores || []), name];
                    const categories = prev.programId === 'CUSTOM' && cat && CATEGORIES.includes(cat) && !(prev.categories || []).includes(cat)
                      ? [...(prev.categories || []), cat]
                      : prev.categories;
                    return { ...prev, acceptedStores: stores, categories };
                  });
                }}
                onRemove={(name) => {
                  setNewCard((prev) => ({
                    ...prev,
                    acceptedStores: (prev.acceptedStores || []).filter((s) => storeNameKey(s) !== storeNameKey(name)),
                  }));
                }}
              />
            )}

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <div>
                <label htmlFor="cdv-card-link" className="cdv-label">Balance link</label>
                <input
                  id="cdv-card-link"
                  type="url"
                  inputMode="url"
                  value={newCard.cardLink || ''}
                  onChange={(e) => setNewCard({ ...newCard, cardLink: e.target.value })}
                  className="cdv-input"
                  placeholder="https://…"
                  dir="ltr"
                />
                <p className="mt-2 text-xs text-[var(--cdv-mute)]">Optional. Shows a Check balance button on the card.</p>
              </div>
              <div>
                <label htmlFor="cdv-store-list-link" className="cdv-label">Store list link</label>
                <input
                  id="cdv-store-list-link"
                  type="url"
                  inputMode="url"
                  value={newCard.storeListLink || ''}
                  onChange={(e) => setNewCard({ ...newCard, storeListLink: e.target.value })}
                  className="cdv-input"
                  placeholder="https://…"
                  dir="ltr"
                />
                <p className="mt-2 text-xs text-[var(--cdv-mute)]">Optional. Shows a Store list button — the page of places this card can pay.</p>
              </div>
            </div>

            <div className="space-y-3 rounded-[var(--cdv-r-md)] border border-[var(--cdv-hairline)] bg-[var(--cdv-surface-sunken)] p-4">
              <div className="flex flex-wrap items-center gap-3">
                <input
                  id="cdv-custom-plastic"
                  type="checkbox"
                  checked={!!newCard.plasticAccentHex}
                  onChange={(e) => {
                    if (e.target.checked) {
                      const cur = (newCard.plasticAccentHex || '').trim();
                      const norm = cur.startsWith('#') ? cur : (cur ? `#${cur}` : '');
                      setNewCard({ ...newCard, plasticAccentHex: hexToRgb(norm) ? norm : '#176551' });
                    } else setNewCard({ ...newCard, plasticAccentHex: '' });
                  }}
                  className="h-4 w-4 shrink-0 rounded accent-[var(--cdv-accent)]"
                />
                <label htmlFor="cdv-custom-plastic" className="cursor-pointer font-medium text-[var(--cdv-ink)]">Custom card color</label>
              </div>
              {newCard.plasticAccentHex ? (
                <div className="flex flex-wrap items-center gap-4">
                  <input
                    type="color"
                    aria-label="Plastic gradient base color"
                    value={(() => {
                      const c = (newCard.plasticAccentHex || '').trim();
                      const n = c.startsWith('#') ? c : `#${c}`;
                      return hexToRgb(n) ? n : '#176551';
                    })()}
                    onChange={(ev) => setNewCard({ ...newCard, plasticAccentHex: ev.target.value })}
                    className="h-10 w-20 cursor-pointer rounded-[var(--cdv-r-sm)] border border-[var(--cdv-hairline-strong)] bg-transparent"
                  />
                  <p className="max-w-xs text-xs text-[var(--cdv-mute)]">Overrides the program default on the wallet plastic. Uncheck to use the built-in program colors.</p>
                </div>
              ) : (
                <p className="text-xs text-[var(--cdv-mute)]">Wallet preview uses each program’s default plastic gradient.</p>
              )}
            </div>

            <fieldset>
              <legend className="cdv-label">{newCard.valueKind === 'units' ? 'How long it lasts' : 'How the balance behaves'}</legend>
              <div className={`grid grid-cols-1 gap-2 ${newCard.valueKind === 'units' ? 'sm:grid-cols-2' : 'sm:grid-cols-3'}`}>
                {(newCard.valueKind === 'units' ? BALANCE_BEHAVIORS.filter((rule) => rule.id !== 'recurring') : BALANCE_BEHAVIORS).map((rule) => {
                  const isSelected = rule.id === 'recurring'
                    ? isRecurringRule(newCard.ruleType)
                    : newCard.ruleType === rule.id;
                  return (
                    <button
                      type="button"
                      key={rule.id}
                      onClick={() => {
                        if (rule.id === 'recurring') {
                          const preset = newCard.recurringPreset || 'monthly';
                          setNewCard({
                            ...newCard,
                            ruleType: preset === 'monthly' ? 'monthly' : 'cycle',
                            recurringPreset: preset,
                          });
                          return;
                        }
                        setNewCard({ ...newCard, ruleType: rule.id });
                      }}
                      aria-pressed={isSelected}
                      className="flex items-center gap-2.5 rounded-[var(--cdv-r-md)] border px-4 py-3 text-sm font-medium transition-colors duration-150"
                      style={isSelected
                        ? { borderColor: 'var(--cdv-accent)', background: 'var(--cdv-accent-soft)', color: 'var(--cdv-accent)' }
                        : { borderColor: 'var(--cdv-hairline)', background: 'var(--cdv-surface-sunken)', color: 'var(--cdv-body)' }}
                    >
                      <rule.icon size={16} className="shrink-0" aria-hidden />
                      {rule.label}
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {isRecurringRule(newCard.ruleType) && (() => {
              const preset = newCard.recurringPreset || 'monthly';
              const formSpec = specFromRecurringForm({ ...newCard, recurringPreset: preset });
              const formError = formSpec?.error || '';
              const showCycleStart = preset === 'quarterly-yearly' || (preset === 'custom' && Number(newCard.resetEveryMonths) > 1);
              return (
                <div className="space-y-4 animate-in slide-in-from-top-2 fade-in">
                  <fieldset>
                    <legend className="cdv-label">Refill schedule</legend>
                    <div className="grid grid-cols-1 gap-2">
                      {RECURRING_PRESETS.map((option) => {
                        const isSelected = preset === option.id;
                        return (
                          <button
                            type="button"
                            key={option.id}
                            onClick={() => {
                              if (option.id === 'monthly') {
                                setNewCard({ ...newCard, ruleType: 'monthly', recurringPreset: 'monthly' });
                                return;
                              }
                              if (option.id === 'quarterly-yearly') {
                                setNewCard({
                                  ...newCard,
                                  ruleType: 'cycle',
                                  recurringPreset: 'quarterly-yearly',
                                  refillEveryMonths: 3,
                                  resetEveryMonths: 12,
                                  cycleStartMonth: newCard.cycleStartMonth || 1,
                                });
                                return;
                              }
                              setNewCard({
                                ...newCard,
                                ruleType: 'cycle',
                                recurringPreset: 'custom',
                                refillEveryMonths: newCard.refillEveryMonths || 3,
                                resetEveryMonths: newCard.resetEveryMonths || 12,
                                cycleStartMonth: newCard.cycleStartMonth || 1,
                              });
                            }}
                            aria-pressed={isSelected}
                            className="flex flex-col gap-0.5 rounded-[var(--cdv-r-md)] border p-3 text-left transition-colors duration-150"
                            style={isSelected
                              ? { borderColor: 'var(--cdv-accent)', background: 'var(--cdv-accent-soft)' }
                              : { borderColor: 'var(--cdv-hairline)', background: 'var(--cdv-surface-sunken)' }}
                          >
                            <span className={`text-sm font-semibold leading-tight ${isSelected ? 'text-[var(--cdv-accent)]' : 'text-[var(--cdv-ink)]'}`}>{option.label}</span>
                            <span className="text-[11px] leading-snug text-[var(--cdv-mute)]">{option.detail}</span>
                          </button>
                        );
                      })}
                    </div>
                  </fieldset>

                  {preset === 'custom' && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                      <div>
                        <label htmlFor="card-refill-months" className="cdv-label">Add money every (months)</label>
                        <input
                          id="card-refill-months"
                          type="number"
                          required
                          min="1"
                          max="36"
                          step="1"
                          value={newCard.refillEveryMonths}
                          onChange={(e) => setNewCard({ ...newCard, ruleType: 'cycle', recurringPreset: 'custom', refillEveryMonths: e.target.value })}
                          className="cdv-input"
                        />
                      </div>
                      <div>
                        <label htmlFor="card-reset-months" className="cdv-label">Reset to zero every (months)</label>
                        <input
                          id="card-reset-months"
                          type="number"
                          required
                          min="1"
                          max="60"
                          step="1"
                          value={newCard.resetEveryMonths}
                          onChange={(e) => setNewCard({ ...newCard, ruleType: 'cycle', recurringPreset: 'custom', resetEveryMonths: e.target.value })}
                          className="cdv-input"
                        />
                      </div>
                    </div>
                  )}

                  {showCycleStart && (
                    <div>
                      <label htmlFor="card-cycle-start" className="cdv-label">{preset === 'quarterly-yearly' ? 'Year begins in' : 'Cycle begins in'}</label>
                      <select
                        id="card-cycle-start"
                        value={String(newCard.cycleStartMonth || 1)}
                        onChange={(e) => setNewCard({ ...newCard, cycleStartMonth: Number(e.target.value) })}
                        className="cdv-input sm:!w-1/2 appearance-none"
                      >
                        {CYCLE_MONTHS.map((month, index) => (
                          <option key={month} value={index + 1}>{month}</option>
                        ))}
                      </select>
                      <p className="mt-2 text-xs leading-relaxed text-[var(--cdv-mute)]">January follows a calendar year. Pick another month if this card’s year starts then. Refills land on the 1st.</p>
                    </div>
                  )}

                  {formError ? (
                    <p role="alert" className="text-xs leading-relaxed text-[var(--cdv-danger)]">{formError}</p>
                  ) : (
                    <p className="text-xs leading-relaxed text-[var(--cdv-mute)]">
                      {formSpec?.grant
                        ? recurringStatusLine({
                          ruleType: formSpec.refillEveryMonths === 1 && formSpec.resetEveryMonths === 1 ? 'monthly' : 'cycle',
                          balance: formSpec.grant,
                          refillEveryMonths: formSpec.refillEveryMonths,
                          resetEveryMonths: formSpec.resetEveryMonths,
                          cycleStartMonth: formSpec.cycleStartMonth,
                        })
                        : 'Enter the amount added on each refill. That figure is one deposit, not the year’s total.'}
                    </p>
                  )}
                </div>
              );
            })()}

            {newCard.ruleType === 'expires' && <div className="animate-in slide-in-from-top-2 fade-in"><label htmlFor="card-expiry" className="cdv-label">Expiration Date</label><input id="card-expiry" type="date" required value={newCard.expiryDate || ''} onChange={(e) => setNewCard({ ...newCard, expiryDate: e.target.value })} className="cdv-input sm:!w-1/2" /></div>}

            {newCard.valueKind === 'units' ? null : newCard.programId === 'CUSTOM' ? (
              <fieldset className="animate-in fade-in">
                <legend className="cdv-label">Where this card can pay</legend>
                {/* No inner scroll: a nested scroller inside the modal clipped the last row. */}
                <div className="flex flex-wrap gap-1.5">
                  {CATEGORIES.map((cat) => {
                    const isSelected = newCard.categories.includes(cat);
                    return (
                      <button
                        type="button"
                        key={cat}
                        onClick={() => toggleCategorySelection(cat)}
                        aria-pressed={isSelected}
                        className={`cdv-chip cdv-chip--selectable cdv-cat ${isSelected ? 'cdv-chip--on' : ''}`}
                        style={categoryHueStyle(cat)}
                      >
                        <span aria-hidden>{CATEGORY_ICONS[cat]}</span> {cat}
                      </button>
                    );
                  })}
                </div>
                {newCard.categories.length === 0 && (
                  <p className="mt-2.5 text-xs text-[var(--cdv-mute)]">Pick at least one category to save this card.</p>
                )}
                {(newCard.acceptedStores || []).length > 0 && newCard.categories.length > 0 && (
                  <p className="mt-2.5 text-xs text-[var(--cdv-mute)]">Checkout offers this card only at the stores you picked, inside these categories.</p>
                )}
              </fieldset>
            ) : (
              <div className="flex items-start gap-2.5 rounded-[var(--cdv-r-md)] border border-[var(--cdv-accent-border)] bg-[var(--cdv-accent-soft)] p-4">
                <Info className="mt-0.5 shrink-0 text-[var(--cdv-accent)]" size={17} aria-hidden />
                <p className="text-sm text-[var(--cdv-body)]">
                  Categories and accepted merchants for <span className="font-semibold text-[var(--cdv-ink)]">{PROGRAMS[newCard.programId].name}</span> are kept up to date automatically.
                </p>
              </div>
            )}
            <div className="border-t border-[var(--cdv-hairline)] pt-6">
              <button type="submit" disabled={newCard.valueKind === 'units'
                ? (!String(newCard.unitLabel || '').trim() || !Number.isInteger(Number(newCard.unitCount)) || Number(newCard.unitCount) < 1)
                : ((newCard.programId === 'CUSTOM' && newCard.categories.length === 0) || Boolean(isRecurringRule(newCard.ruleType) && specFromRecurringForm(newCard)?.error))} className="cdv-btn cdv-btn--primary w-full !py-3">
                {editingCardId ? 'Save changes' : 'Add to Wallet'}
              </button>
            </div>
          </form>
        </Modal>

        <Modal isOpen={showExpenseForm} onClose={resetExpenseForm} title={expenseValueKind === 'units' ? (editingExpenseId ? 'Edit use' : 'Log a use') : (editingExpenseId ? 'Edit Plan' : 'Plan a Purchase')}>
          <form onSubmit={handleSaveExpense} className="space-y-6">
            <div className="flex items-center gap-3 rounded-[var(--cdv-r-md)] border border-[var(--cdv-hairline)] bg-[var(--cdv-surface-sunken)] p-4">
              <input type="checkbox" id="isCompleted" checked={newExpense.isCompleted} onChange={(e) => setNewExpense({ ...newExpense, isCompleted: e.target.checked })} className="h-4 w-4 shrink-0 rounded accent-[var(--cdv-accent)]" />
              <label htmlFor="isCompleted" className="cursor-pointer"><div className="font-medium text-[var(--cdv-ink)]">{expenseValueKind === 'units' ? 'Already used' : 'Already spent'}</div><div className="text-xs text-[var(--cdv-mute)]">{expenseValueKind === 'units' ? 'Tick this if you have already redeemed it.' : 'Tick this if you have already paid at the store.'}</div></label>
            </div>

            <div><label htmlFor="exp-name" className="cdv-label">Item / Purpose</label><input id="exp-name" type="text" required value={newExpense.name} onChange={(e) => setNewExpense({ ...newExpense, name: e.target.value })} className="cdv-input" placeholder={expenseValueKind === 'units' ? 'e.g. Massage' : 'e.g. Cinema Tickets'} /></div>

            {expenseValueKind !== 'units' && <fieldset className="min-w-0">
              <legend className="cdv-label">Categories</legend>
              <p className="mb-3 text-xs text-[var(--cdv-mute)]">Select every category this purchase touches (one or more).</p>
              {/* No inner scroll: a nested scroller inside the modal clipped the last row. */}
              <div className="-m-1 flex flex-wrap gap-2 p-1">
                {CATEGORIES.map((cat) => {
                  const isSelected = newExpense.expenseCategories.includes(cat);
                  return (
                    <button type="button" key={cat} onClick={() => toggleExpenseCategory(cat)} aria-pressed={isSelected} className={`cdv-chip cdv-chip--selectable cdv-cat ${isSelected ? 'cdv-chip--on' : ''}`} style={categoryHueStyle(cat)}>
                      <span aria-hidden>{CATEGORY_ICONS[cat]}</span> {cat}
                    </button>
                  );
                })}
              </div>
            </fieldset>}

            {expenseValueKind !== 'units' && <div>
              <label htmlFor="exp-retailer" className="cdv-label">Retailers (optional)</label>
              <p className="mb-2 text-xs text-[var(--cdv-mute)]">Add several stores for the same trip or basket. Pick from search or type and press Add.</p>
              {newExpense.expenseMerchants.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-3">
                  {newExpense.expenseMerchants.map((name) => {
                    const iconCat = KNOWN_MERCHANTS[name]?.cat || newExpense.expenseCategories[0] || CATEGORIES[0];
                    return (
                      <span key={name} className="cdv-chip !pr-1">
                        <MerchantIcon merchantName={name} category={iconCat} className="w-5 h-5 rounded border-0 bg-transparent" />
                        <span className="max-w-[10rem] truncate">{name.split('(')[0].trim()}</span>
                        <button type="button" onClick={() => removeExpenseMerchant(name)} className="rounded-full p-1 text-[var(--cdv-faint)] transition-colors duration-150 hover:bg-[var(--cdv-hairline)] hover:text-[var(--cdv-ink)]" aria-label={`Remove ${name}`}><X size={14} /></button>
                      </span>
                    );
                  })}
                </div>
              )}
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--cdv-faint)]" size={17} aria-hidden />
                  <input id="exp-retailer" type="search" autoComplete="off" value={merchantSearch} onChange={(e) => { setMerchantSearch(e.target.value); setShowMerchantSuggestions(true); }} onFocus={() => setShowMerchantSuggestions(true)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addExpenseMerchantFreeText(); } }} className="cdv-input !pl-10" placeholder="e.g. Wolt, FOX…" />
                  {showMerchantSuggestions && merchantSearch && (
                    <div className="absolute z-50 mt-1 max-h-48 w-full overflow-y-auto rounded-[var(--cdv-r-md)] border border-[var(--cdv-hairline-strong)] bg-[var(--cdv-surface)] shadow-[var(--cdv-shadow-lg)]">
                      {getSmartMatches(merchantSearch, 15, customStores).map(([name, data]) => (
                        /* onMouseDown so selection lands before the input's blur hides the list. */
                        <button
                          type="button"
                          key={name}
                          onMouseDown={() => addExpenseMerchantFromList(name, data.cat)}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addExpenseMerchantFromList(name, data.cat); } }}
                          className="flex w-full items-center justify-between gap-3 border-b border-[var(--cdv-hairline)] p-3 text-left transition-colors duration-150 last:border-0 hover:bg-[var(--cdv-surface-sunken)]"
                        >
                          <span className="flex min-w-0 items-center gap-2"><MerchantIcon merchantName={name} category={data.cat} className="w-6 h-6 rounded border-0 bg-transparent" /><span className="min-w-0 truncate font-medium text-[var(--cdv-ink)]" dir="auto">{name}</span></span>
                          <span className="cdv-chip cdv-cat shrink-0" style={categoryHueStyle(data.cat)}>{data.cat}</span>
                        </button>
                      ))}
                      {getSmartMatches(merchantSearch, 15, customStores).length === 0 && <p className="p-3 text-center text-sm text-[var(--cdv-mute)]">No catalog match — use Add for a custom name.</p>}
                    </div>
                  )}
                </div>
                <button type="button" onClick={addExpenseMerchantFreeText} className="cdv-btn cdv-btn--outline shrink-0">Add</button>
              </div>
            </div>}

            <div>
              <label htmlFor="exp-month" className="cdv-label">{expenseValueKind === 'units' ? 'Date (optional)' : 'Plan for month (optional)'}</label>
              <input id="exp-month" type="date" value={newExpense.scheduledFor || ''} onChange={(e) => setNewExpense({ ...newExpense, scheduledFor: e.target.value })} className="cdv-input sm:!w-64" />
              <p className="mt-2 text-xs leading-relaxed text-[var(--cdv-mute)]">{expenseValueKind === 'units' ? 'Pick the date you intend to redeem this.' : <>Pick the date you intend to pay. <strong className="font-semibold text-[var(--cdv-body)]">Monthly</strong> cards refill on the 1st and ignore other months. Cards that stack, such as a quarterly grant with a yearly reset, include every deposit that will have arrived by this date.</>}</p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              {expenseValueKind === 'units' ? (
                <div>
                  <label htmlFor="exp-units" className="cdv-label">How many</label>
                  <input id="exp-units" type="number" required min="1" step="1" value={newExpense.units} onChange={(e) => setNewExpense({ ...newExpense, units: e.target.value })} className="cdv-input cdv-amount !text-base !font-semibold" placeholder="1" />
                </div>
              ) : (
                <div>
                  <label htmlFor="exp-amount" className="cdv-label">Estimated Cost (₪)</label>
                  <input id="exp-amount" type="number" required min="0.01" step="0.01" value={newExpense.amount} onChange={(e) => setNewExpense({ ...newExpense, amount: e.target.value })} className="cdv-input cdv-amount !text-base !font-semibold" placeholder="0.00" />
                  {!editingExpenseId && newExpense.amount && <div className="mt-3 flex items-center gap-2"><input type="checkbox" id="isManualSplit" checked={newExpense.isManualSplit || false} onChange={(e) => setNewExpense({ ...newExpense, isManualSplit: e.target.checked, chargeAmount: e.target.checked ? newExpense.amount : '' })} className="h-4 w-4 shrink-0 rounded accent-[var(--cdv-accent)]" /><label htmlFor="isManualSplit" className="cursor-pointer text-xs text-[var(--cdv-mute)]">Split this payment across multiple cards?</label></div>}
                </div>
              )}
              <div>
                <label htmlFor="exp-card" className="cdv-label">{expenseValueKind === 'units' ? 'Redeem from' : 'Pay With'}</label>
                <select id="exp-card" required value={newExpense.cardId} onChange={(e) => setNewExpense({ ...newExpense, cardId: e.target.value })} className="cdv-input appearance-none">
                  <option value="" disabled>{expenseValueKind === 'units' ? 'Choose a card' : (!newExpense.expenseCategories?.length ? 'Choose a card (add categories to filter by rules)' : '-- Evaluated Cards --')}</option>
                  {sortedCardBalances.filter((card) => (expenseValueKind === 'units' ? isUnitCard(card) : !isUnitCard(card))).map((card) => {
                    const noCatsYet = !newExpense.expenseCategories?.length;
                    const isAllowedByRules = noCatsYet || cardMatchesExpenseSelection(card, newExpense.expenseCategories, newExpense.expenseMerchants, customStores);
                    const isEditingCurrent = editingExpenseId && card.id === newExpense.cardId;
                    const planAsOf = planDateFromInput(newExpense.scheduledFor);
                    const editingExpenseRow = editingExpenseId ? expenses.find((ex) => ex.id === editingExpenseId) : null;
                    const rem = getRemainingForCardAt(card, planAsOf, editingExpenseRow);
                    const expiringTag = card.ruleType === 'expires' && getDaysUntilExpiry(card.expiryDate) <= 30 ? '[EXPIRING!] ' : '';
                    if (expenseValueKind === 'units') {
                      const wanted = Number(newExpense.units || 0);
                      const isSelectable = rem > 0 || isEditingCurrent;
                      const short = wanted > rem && !isEditingCurrent;
                      return <option key={card.id} value={card.id} disabled={!isSelectable}>{expiringTag}{card.name} — {formatUses(rem, card.unitLabel)} left{short ? ' — not enough' : ''}</option>;
                    }
                    const canAfford = isEditingCurrent || rem >= parseFloat(newExpense.amount || 0);
                    const isAnchorOrSelected = card.id === newExpense.cardId;
                    const isSelectable = noCatsYet
                      ? (isAnchorOrSelected || rem > 0)
                      : (isAllowedByRules && (rem > 0 || isEditingCurrent));
                    const ruleHint = noCatsYet ? '' : (!isAllowedByRules ? ' - Rule Blocked' : (!canAfford ? ' - Requires Split' : ''));
                    return <option key={card.id} value={card.id} disabled={!isSelectable}>{expiringTag}{card.name} — {formatShekels(rem)} available{ruleHint}</option>;
                  })}
                </select>
                {expenseValueKind !== 'units' && newExpense.expenseCategories?.length > 0 && cardBalances.filter((c) => !isUnitCard(c) && cardMatchesExpenseSelection(c, newExpense.expenseCategories, newExpense.expenseMerchants, customStores)).length === 0 && <p className="mt-2 flex items-center gap-1.5 text-xs text-[var(--cdv-danger)]"><ShieldAlert size={12} /> No valid cards for this combination.</p>}
              </div>
            </div>

            {expenseValueKind !== 'units' && newExpense.isManualSplit && !editingExpenseId && newExpense.cardId && (() => {
              const splitCard = cardBalances.find((c) => c.id === newExpense.cardId);
              const splitCap = splitCard ? getRemainingForCardAt(splitCard, planDateFromInput(newExpense.scheduledFor)) : 0;
              return (
                <div className="animate-in fade-in slide-in-from-top-2 rounded-[var(--cdv-r-md)] border border-[var(--cdv-accent-border)] bg-[var(--cdv-accent-soft)] p-4">
                  <label htmlFor="exp-charge" className="cdv-label">Amount to charge to selected card (₪)</label>
                  <input id="exp-charge" type="number" required min="0.01" max={Math.min(parseFloat(newExpense.amount || Infinity), splitCap || Infinity)} step="0.01" value={newExpense.chargeAmount} onChange={(e) => setNewExpense({ ...newExpense, chargeAmount: e.target.value })} className="cdv-input cdv-amount !text-base !font-semibold" placeholder="0.00" />
                </div>
              );
            })()}

            <div className="border-t border-[var(--cdv-hairline)] pt-6">
              {(() => {
                const selectedCard = cardBalances.find((c) => c.id === newExpense.cardId);
                const planRemaining = selectedCard ? getRemainingForCardAt(selectedCard, planDateFromInput(newExpense.scheduledFor)) : 0;
                const reqAmount = parseFloat(newExpense.amount || 0);
                let actualLogAmount = reqAmount;
                let isSplitNeeded = false;
                if (expenseValueKind !== 'units' && selectedCard && !editingExpenseId) {
                  if (newExpense.isManualSplit && newExpense.chargeAmount) actualLogAmount = parseFloat(newExpense.chargeAmount || 0);
                  if (actualLogAmount > planRemaining) actualLogAmount = planRemaining;
                  if (actualLogAmount < reqAmount && actualLogAmount > 0) isSplitNeeded = true;
                }
                const confirmLabel = expenseValueKind === 'units'
                  ? (editingExpenseId ? 'Save changes' : 'Log use')
                  : (editingExpenseId ? 'Save changes' : 'Confirm Plan');
                return (
                  <button
                    type="submit"
                    className="cdv-btn w-full !py-3"
                    style={isSplitNeeded
                      ? { background: 'var(--cdv-warning)', color: '#fff' }
                      : { background: 'var(--cdv-surface-inverse)', color: 'var(--cdv-on-inverse)' }}
                  >
                    {isSplitNeeded
                      ? <>Split payment — charge <span className="cdv-amount">{formatShekels(actualLogAmount)}</span> now</>
                      : confirmLabel}
                  </button>
                );
              })()}
            </div>
          </form>
        </Modal>
      </div>
    </div>
  );
}
