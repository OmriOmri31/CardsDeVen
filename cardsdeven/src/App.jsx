import React, { useState, useMemo, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import {
  getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, onAuthStateChanged, signInAnonymously
} from 'firebase/auth';
import { getFirestore, collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc, setDoc } from 'firebase/firestore';
import {
  CreditCard, LayoutDashboard, Receipt, Plus, Trash2, AlertCircle,
  CalendarDays, RefreshCw, Infinity as InfinityIcon, CheckCircle2,
  Edit2, Moon, Sun, PieChart, LogOut, Lock, Mail,
  Loader2, X, Search, ShieldAlert, Zap, Clock, CheckSquare, Square, Gift, Bot, Send, Info
} from 'lucide-react';

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

// Map the Hebrew categories from your scraper to the App's English categories
const HEBREW_TO_APP_CATEGORIES = {
  "בידור וסטנד אפ": "Cinemas", 
  "מופעים ומוזיקה": "Cinemas",
  "מופעים": "Cinemas",
  "קולנוע": "Cinemas",
  "אטרקציות": "Kids & Baby",
  "ספא ונופש": "Spas & Wellness",
  "צרכנות": "Online Retail & Delivery",
  "קולינריה": "Food Chains & Restaurants",
  "כללי": "Other"
};

// --- DOMAIN KNOWLEDGE: CATEGORY SEARCH ALIASES ---
const CATEGORY_ALIASES = {
  "Supermarkets & Groceries": ["supermarket", "grocery", "groceries", "סופר", "סופרמרקט", "מכולת", "מזון"],
  "Fashion & Apparel": ["fashion", "apparel", "clothing", "clothes", "shoes", "אופנה", "בגדים", "בגדי", "הנעלה", "נעליים", "לבוש"],
  "Home & Household": ["home", "household", "furniture", "kitchen", "בית", "ריהוט", "לבית", "עיצוב הבית", "מטבח", "כלי בית"],
  "Hotels & Lodging": ["hotel", "lodging", "vacation", "resort", "מלון", "מלונות", "נופש", "לינה", "חופשה"],
  "Spas & Wellness": ["spa", "wellness", "massage", "ספא", "עיסוי", "טיפולים"],
  "Electronics": ["electronics", "computers", "mobile", "phone", "חשמל", "אלקטרוניקה", "מחשבים", "מוצרי חשמל", "סלולר", "טלפון"],
  "Cinemas": ["cinema", "movie", "movies", "film", "קולנוע", "סרט", "סרטים", "סינמה", "הופעה", "סטנדאפ", "מופע"],
  "Food Chains & Restaurants": ["food", "restaurant", "dining", "cafe", "burger", "pizza", "אוכל", "מסעדה", "מסעדות", "בית קפה", "בתי קפה", "פיצה", "המבורגר", "סושי"],
  "Online Retail & Delivery": ["online", "delivery", "ecommerce", "אונליין", "משלוח", "משלוחים", "אינטרנט", "קניות ברשת"],
  "Pharmacy & Health": ["pharmacy", "health", "makeup", "פארם", "בית מרקחת", "בריאות", "תרופות", "איפור", "קוסמטיקה", "פארמה"],
  "Fuel & Transportation": ["fuel", "gas", "transportation", "דלק", "תחבורה", "תחנת דלק"],
  "Fitness & Gym": ["fitness", "gym", "workout", "כושר", "חדר כושר", "ספורט", "אימון", "מנוי"],
  "Kids & Baby": ["kids", "baby", "toys", "ילדים", "תינוקות", "צעצועים", "משחקים"],
  "Other": ["other", "אחר", "שונות", "ספרים"]
};

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

const CLUBS = {
  BEHATSDAA: { id: 'BEHATSDAA', name: 'בהצדעה', color: 'bg-blue-600' },
  PAIS_PLUS: { id: 'PAIS_PLUS', name: 'פיס פלוס', color: 'bg-red-500' },
  DREAMCARD: { id: 'DREAMCARD', name: 'DreamCard', color: 'bg-slate-900' }
};

// Hardcoded deals minus the Behatsdaa ones (since we pull those live now)
const HARDCODED_DISCOUNTS = [
  { m: "Domino's Pizza (דומינוס פיצה)", c: "PAIS_PLUS", d: "תו קנייה 150 ב-99 ש\"ח / 100 ב-69 ש\"ח" },
  { m: "Pizza Hut (פיצה האט)", c: "PAIS_PLUS", d: "2 פיצות + תוספת + מקלות שוקולד ב-120 ש\"ח" },
  { m: "Pizza Shemesh (פיצה שמש)", c: "PAIS_PLUS", d: "2 משפחתיות + תוספות + שתיה ב-75 ש\"ח" },
  { m: "Papa John's (פאפא ג'ונס)", c: "PAIS_PLUS", d: "תו 100 ב-75 ש\"ח / פיצה אישית ב-22 ש\"ח" },
  { m: "Pizza Prego (פיצה פרגו)", c: "PAIS_PLUS", d: "2 משפחתיות ב-80 ש\"ח" },
  { m: "Cinema City (סינמה סיטי)", c: "PAIS_PLUS", d: "כרטיס ב-22 ש\"ח / כרטיס+פופקורן+שתיה ב-35 ש\"ח" },
  { m: "Planet (פלאנט)", c: "PAIS_PLUS", d: "כרטיס ב-22 ש\"ח" },
  { m: "Mishloha (משלוחה)", c: "PAIS_PLUS", d: "תו 100 ב-72 ש\"ח / 200 ב-160 ש\"ח" },
  { m: "10bis (תן ביס)", c: "PAIS_PLUS", d: "תו קנייה 100 ב-67 ש\"ח" },
  { m: "FOX (פוקס)", c: "PAIS_PLUS", d: "תו קנייה 200 ב-155 ש\"ח (אתר בלבד)" },
  { m: "Terminal X (טרמינל איקס)", c: "PAIS_PLUS", d: "תווי קנייה החל מ-160 ש\"ח" },
  { m: "Factory 54 (פקטורי 54)", c: "PAIS_PLUS", d: "תו 200 ב-120 ש\"ח" },
  { m: "Golf & Co (גולף)", c: "PAIS_PLUS", d: "תו 250 ב-210 ש\"ח" },
  { m: "Last Price (לאסט פרייס)", c: "PAIS_PLUS", d: "תו 300 ב-265 ש\"ח" },
  { m: "Boxil (בוקסיל)", c: "PAIS_PLUS", d: "תו קנייה 400 ב-305 ש\"ח" },
  { m: "Shrolik (שרוליק)", c: "PAIS_PLUS", d: "תו קנייה 400 ב-284 ש\"ח" },
  { m: "Mega Sport (מגה ספורט)", c: "PAIS_PLUS", d: "תו 500 ב-390 ש\"ח / 300 ב-233 ש\"ח" },
  { m: "Adidas (אדידס)", c: "PAIS_PLUS", d: "תו 200 ב-154 ש\"ח" },
  { m: "Holmes Place (הולמס פלייס)", c: "PAIS_PLUS", d: "10 כניסות מ-529 ש\"ח" },
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

const INITIAL_KNOWN_MERCHANTS = {
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

const getDaysUntilExpiry = (dateString) => {
  if (!dateString) return Infinity;
  return Math.ceil((new Date(dateString) - new Date()) / (1000 * 60 * 60 * 24));
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
          return isBold ? <strong key={`part-${lineIdx}-${partIdx}`}>{content}</strong> : <React.Fragment key={`part-${lineIdx}-${partIdx}`}>{content}</React.Fragment>;
        })}
        {lineIdx < lines.length - 1 && <br />}
      </React.Fragment>
    );
  });
};

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


export default function App() {
  const [user, setUser] = useState(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [toast, setToast] = useState({ visible: false, message: '', type: 'success' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoginMode, setIsLoginMode] = useState(true);
  const [authError, setAuthError] = useState('');
  const [isProcessingAuth, setIsProcessingAuth] = useState(false);
  const [activeTab, setActiveTab] = useState('dashboard');
  
  // --- NEW DATA PIPELINE STATES ---
  const [liveDeals, setLiveDeals] = useState([]);
  const [dynamicMerchants, setDynamicMerchants] = useState(INITIAL_KNOWN_MERCHANTS);

  const [cards, setCards] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [userClubs, setUserClubs] = useState([]);
  const [aiMessages, setAiMessages] = useState([{ role: 'model', text: 'היי! אני העוזר החכם שלך. תגיד לי מה אתה רוצה לקנות, ואמצא את המבצעים הכי שווים בשבילך! 😎' }]);
  const [aiInput, setAiInput] = useState('');
  const [isAiTyping, setIsAiTyping] = useState(false);
  const chatEndRef = useRef(null);
  const abortControllerRef = useRef(null);
  const aiRequestInFlightRef = useRef(false);
  const [showCardForm, setShowCardForm] = useState(false);
  const [editingCardId, setEditingCardId] = useState(null);
  const [newCard, setNewCard] = useState({ name: '', balance: '', programId: 'CUSTOM', ruleType: 'permanent', expiryDate: '', categories: [] });
  const [showExpenseForm, setShowExpenseForm] = useState(false);
  const [editingExpenseId, setEditingExpenseId] = useState(null);
  const [newExpense, setNewExpense] = useState({ name: '', amount: '', category: '', merchantName: '', cardId: '', isCompleted: false, isManualSplit: false, chargeAmount: '' });
  const [merchantSearch, setMerchantSearch] = useState('');
  const [showMerchantSuggestions, setShowMerchantSuggestions] = useState(false);
  const [insightSearch, setInsightSearch] = useState('');
  const [clubSearch, setClubSearch] = useState('');

  // --- FETCH SCRAPED DATA ON LOAD ---
  // --- FETCH SCRAPED DATA ON LOAD ---
  useEffect(() => {
    const fetchLiveDeals = async () => {
      try {
        // THE FIX: Add a timestamp "cache-buster" to force the browser to download the freshest file
        const response = await fetch('/data.json?nocache=' + new Date().getTime());
        if (!response.ok) return;
        const json = await response.json();

        const flattenedDeals = [];
        const updatedMerchants = { ...INITIAL_KNOWN_MERCHANTS };

        // 1. Iterate through Master Categories
        Object.entries(json.data || {}).forEach(([masterCategory, venues]) => {
          const mappedAppCategory = HEBREW_TO_APP_CATEGORIES[masterCategory] || "Other";

          // 2. Iterate through Venues
          Object.entries(venues).forEach(([venueName, showsObject]) => {
            
            // 3. Iterate through the Show Names
            Object.entries(showsObject).forEach(([showName, showArray]) => {
              
              let trueMerchantName = venueName;
              
              const findTrueMerchant = (text) => {
                if (!text) return null;
                const paddedText = ` ${text.toLowerCase().replace(/[\-\(\)]/g, ' ')} `;
                
                for (const [knownName, data] of Object.entries(INITIAL_KNOWN_MERCHANTS)) {
                  if (data.aliases && data.aliases.some(alias => paddedText.includes(` ${alias.toLowerCase()} `))) {
                    return knownName;
                  }
                  const englishName = knownName.split('(')[0].trim().toLowerCase();
                  if (paddedText.includes(` ${englishName} `)) return knownName;
                }
                return null;
              };

              const genericVenues = ["כללי / מיקומים שונים", "קולנוע", "צרכנות", "אטרקציות", "ספא ונופש", "כללי", "מופעים", "מופעים והצגות"];
              
              if (genericVenues.includes(venueName)) {
                 const found = findTrueMerchant(showName) || findTrueMerchant(showArray[0]?.title);
                 trueMerchantName = found ? found : showName;
              } else {
                 const found = findTrueMerchant(venueName);
                 if (found) trueMerchantName = found;
              }

              // Inject the scraped venue into our known merchants database
              if (!updatedMerchants[trueMerchantName]) {
                updatedMerchants[trueMerchantName] = {
                  cat: mappedAppCategory,
                  networks: [], 
                  aliases: [trueMerchantName.toLowerCase(), showName.toLowerCase()]
                };
              }

              // Add the deals
              showArray.forEach(show => {
                flattenedDeals.push({
                  m: trueMerchantName,
                  c: 'BEHATSDAA',
                  d: `${show.title} (${show.price})`
                });
              });
            });
          });
        });

        setLiveDeals(flattenedDeals);
        setDynamicMerchants(updatedMerchants);
      } catch (error) {
        console.error("Failed to load live deals:", error);
      }
    };

    fetchLiveDeals();
  }, []);

  // --- COMBINE HARDCODED WITH SCRAPED ---
  const allDiscountsData = useMemo(() => {
    return [...HARDCODED_DISCOUNTS, ...liveDeals];
  }, [liveDeals]);


  // --- HELPER FUNCTIONS MOVED INSIDE COMPONENT TO ACCESS DYNAMIC MERCHANTS ---
  const getLogoPath = (merchantString) => {
    if (!merchantString) return '';
    const merchData = dynamicMerchants[merchantString];
    if (merchData && merchData.logo) return `/assets/logos/${merchData.logo}`;
    const englishPart = merchantString.split('(')[0].trim().toLowerCase();
    const filename = englishPart.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return `/assets/logos/${filename}.png`;
  };

  const checkCompatibility = (card, category, merchantName) => {
    const pId = card.programId || 'CUSTOM';
    const merchData = dynamicMerchants[merchantName];

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

  const getDerivedCategories = (card) => {
    const pId = card.programId || 'CUSTOM';
    if (pId === 'CUSTOM') return card.categories || [];
    if (pId === 'HG' || pId === 'FLEX') return CATEGORIES.filter(c => !['Fuel & Transportation', 'Pharmacy & Health'].includes(c));
    if (pId === 'FTR') return ["Food Chains & Restaurants", "Fashion & Apparel", "Cinemas", "Spas & Wellness", "Online Retail & Delivery", "Hotels & Lodging"];
    if (pId === 'FTR_VAC') return ["Hotels & Lodging"];

    const derived = new Set();
    if (pId === 'CB') derived.add("Food Chains & Restaurants");
    Object.values(dynamicMerchants).forEach((m) => {
      if (m.networks.includes(pId)) derived.add(m.cat);
    });
    return Array.from(derived);
  };

  const getSmartMatches = (query, maxResults = 15) => {
    if (!query) return [];
    const q = query.toLowerCase().trim();

    return Object.entries(dynamicMerchants)
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


  useEffect(() => {
    if (isDarkMode) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }, [isDarkMode]);

  const showToastMsg = (message, type = 'success') => {
    setToast({ visible: true, message, type });
    setTimeout(() => setToast({ visible: false, message: '', type: 'success' }), 3000);
  };

  const getCollectionPath = (uid, collectionName) => {
    if (typeof __app_id !== 'undefined') return `artifacts/${__app_id}/users/${uid}/${collectionName}`;
    return `users/${uid}/${collectionName}`;
  };

  useEffect(() => {
    const firebaseConfig = typeof __firebase_config !== 'undefined'
      ? JSON.parse(__firebase_config)
      : {
        apiKey: "AIzaSyBjn2oGHj-bT_O213csvNPLoEliTdWbS4M",
        authDomain: "cardsdeven.firebaseapp.com",
        projectId: "cardsdeven",
        storageBucket: "cardsdeven.firebasestorage.app",
        messagingSenderId: "226004826296",
        appId: "1:226004826296:web:b1b173216ea6578ed29c4d"
      };
    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => { setUser(currentUser); setLoadingAuth(false); });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) { setCards([]); setExpenses([]); setUserClubs([]); return; }
    const db = getFirestore();
    const unsubCards = onSnapshot(collection(db, getCollectionPath(user.uid, 'cards')), (snapshot) => setCards(snapshot.docs.map((d) => ({ id: d.id, ...d.data() }))));
    const unsubExpenses = onSnapshot(collection(db, getCollectionPath(user.uid, 'expenses')), (snapshot) => setExpenses(snapshot.docs.map((d) => ({ id: d.id, ...d.data() }))));
    const unsubClubs = onSnapshot(doc(db, getCollectionPath(user.uid, 'settings'), 'clubsProfile'), (docSnap) => { if (docSnap.exists()) setUserClubs(docSnap.data().activeClubs || []); });
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

  const cardBalances = useMemo(() => cards.map((card) => {
    const spent = expenses.filter((e) => e.cardId === card.id).reduce((sum, e) => sum + parseFloat(e.amount || 0), 0);
    const derivedCats = getDerivedCategories(card);
    return { ...card, spent, remaining: parseFloat(card.balance) - spent, derivedCats };
  }), [cards, expenses, dynamicMerchants]);

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
    setIsAiTyping(true);

    const walletString = cardBalances.map((c) => `${c.name}:₪${c.remaining}`).join(', ');
    const merchantNames = Object.keys(dynamicMerchants).map((k) => k.split('(')[0].trim()).join(', ');
    
    const systemInstruction = `You are a sharp, witty, and highly practical Israeli shopping assistant.
Your goal is to save the user money by cross-referencing what they want to buy with their specific digital wallet balances and active discount clubs.

### TONE & PERSONALITY:
- MANDATORY OUTPUT LANGUAGE: ${preferredLanguage === 'en' ? 'English' : 'Hebrew'} only. Do not mix languages unless user asks.
- Reply natively in the EXACT language the user used.
- Be highly energetic, direct, and slightly humorous (Israeli style). Use emojis appropriately (e.g., "מישהו פה מתכנן חגיגה 🍕", "ברור, בוא נארגן לך הופעה פצצה לחתונה 👔").
- DO NOT be generic. Do not just list stores. Be a decisive, mathematical advisor.

### STRICT RESPONSE FORMAT:
Your response must ALWAYS follow this exact structure (use bold text for emphasis, but DO NOT use Markdown headers like # or ## to keep the chat UI clean):

**Witty Opening:** 1-2 lines acknowledging the request with a fun, enthusiastic tone.

🌟 **השילוב המנצח (The Winning Combo):** Tell them EXACTLY where to go, which discount to claim from their clubs, and exactly which card from their wallet to use. You MUST mention their specific card balance.
*Example: "לך לפוקס. יש לך ב'בהצדעה' שובר של 150 ב-100 ש"ח, ותשלם עליו עם כרטיס ה-HappyGift שלך (יש לך שם 500 ש"ח!)."*

💡 **עוד אופציות טובות (Alternative Options):** List 1-2 other relevant merchants from their data where they have valid cards or discounts.

⚠️ **שים לב לתקציב (Budget Note - ONLY IF RELEVANT):** If the estimated cost of the item is likely higher than their available card balance, explicitly tell them they will need to do a "Split Payment" (לפצל תשלום) at the register with a regular credit card.

🎯 **שאלה למיקוד (Call to Action):** End with one short question to narrow down their needs.`;

    try {
      // We pass the raw data so the backend can search it using Vectors
      const payload = {
         query: userText, 
         history: aiMessages, 
         systemInstruction,
         userClubs: userClubs,
         walletString: walletString,
         merchantNames: merchantNames
      };

      const response = await fetch('/.netlify/functions/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: abortControllerRef.current.signal
      });

      if (!response.ok) throw new Error(`Status ${response.status}`);
      const data = await response.json();
      
      if (data.result) setAiMessages([...newMessages, { role: 'model', text: data.result }]);
    } catch (err) {
      if (err.name !== 'AbortError') setAiMessages([...newMessages, { role: 'model', text: `אופס, משהו השתבש בחיבור שלי. 😅\n\n${err.message}` }]);
    } finally {
      setIsAiTyping(false);
      aiRequestInFlightRef.current = false;
    }
  };

  const resetCardForm = () => { setNewCard({ name: '', balance: '', programId: 'CUSTOM', ruleType: 'permanent', expiryDate: '', categories: [] }); setEditingCardId(null); setShowCardForm(false); };
  const resetExpenseForm = () => { setNewExpense({ name: '', amount: '', category: '', merchantName: '', cardId: '', isCompleted: false, isManualSplit: false, chargeAmount: '' }); setMerchantSearch(''); setEditingExpenseId(null); setShowExpenseForm(false); };

  const handleSaveCard = async (e) => {
    e.preventDefault();
    if (!user || !newCard.name || !newCard.balance) return;
    const program = PROGRAMS[newCard.programId];
    const cardData = {
      name: newCard.name, balance: parseFloat(newCard.balance), programId: newCard.programId,
      ruleType: newCard.ruleType, expiryDate: newCard.ruleType === 'expires' ? newCard.expiryDate : '',
      categories: newCard.programId === 'CUSTOM' ? newCard.categories : [], color: program.color, updatedAt: new Date().toISOString()
    };
    if (editingCardId) await updateDoc(doc(getFirestore(), getCollectionPath(user.uid, 'cards'), editingCardId), cardData);
    else await addDoc(collection(getFirestore(), getCollectionPath(user.uid, 'cards')), cardData);
    showToastMsg(editingCardId ? 'Card updated' : 'Card added to wallet');
    resetCardForm();
  };

  const handleSaveExpense = async (e) => {
    e.preventDefault();
    if (!user || !newExpense.name || !newExpense.amount || !newExpense.category || !newExpense.cardId) return;
    const reqAmount = parseFloat(newExpense.amount);
    const selectedCard = cardBalances.find((c) => c.id === newExpense.cardId);
    let saveAmount = reqAmount;
    let isSplit = false;
    if (selectedCard && !editingExpenseId) {
      if (newExpense.isManualSplit && newExpense.chargeAmount) saveAmount = parseFloat(newExpense.chargeAmount);
      if (saveAmount > selectedCard.remaining) saveAmount = selectedCard.remaining;
      if (saveAmount < reqAmount) isSplit = true;
    }
    const expenseData = {
      name: isSplit ? (newExpense.name.includes('(Part') ? newExpense.name : `${newExpense.name} (Part 1)`) : newExpense.name,
      amount: saveAmount, category: newExpense.category, merchantName: newExpense.merchantName, cardId: newExpense.cardId,
      isCompleted: newExpense.isCompleted || false, updatedAt: editingExpenseId ? (newExpense.updatedAt || new Date().toISOString()) : new Date().toISOString()
    };
    if (editingExpenseId) await updateDoc(doc(getFirestore(), getCollectionPath(user.uid, 'expenses'), editingExpenseId), expenseData);
    else await addDoc(collection(getFirestore(), getCollectionPath(user.uid, 'expenses')), expenseData);
    if (isSplit) {
      showToastMsg(`Saved ₪${saveAmount}. Pick next card for remaining ₪${(reqAmount - saveAmount).toFixed(2)}`);
      setNewExpense((prev) => ({
        ...prev,
        name: prev.name.match(/\(Part \d+\)/) ? prev.name.replace(/\(Part (\d+)\)/, (_match, p1) => `(Part ${parseInt(p1, 10) + 1})`) : `${prev.name} (Part 2)`,
        amount: (reqAmount - saveAmount).toFixed(2), cardId: '', isManualSplit: false, chargeAmount: ''
      }));
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
  const startEditCard = (card) => { setNewCard({ ...card, programId: card.programId || 'CUSTOM', expiryDate: card.expiryDate || '', categories: card.categories || [] }); setEditingCardId(card.id); setShowCardForm(true); };
  const startEditExpense = (expense) => { setNewExpense({ ...expense }); setMerchantSearch(expense.merchantName || ''); setEditingExpenseId(expense.id); setShowExpenseForm(true); };
  const startQuickExpense = (cardId) => { resetExpenseForm(); setNewExpense((prev) => ({ ...prev, cardId })); setShowExpenseForm(true); };
  const handleMerchantSelect = (name, cat) => { setMerchantSearch(name); setNewExpense({ ...newExpense, merchantName: name, category: cat, cardId: '' }); setShowMerchantSuggestions(false); };
  const toggleCategorySelection = (cat) => {
    setNewCard((prev) => {
      const currentCategories = prev.categories || [];
      if (currentCategories.includes(cat)) return { ...prev, categories: currentCategories.filter((c) => c !== cat) };
      return { ...prev, categories: [...currentCategories, cat] };
    });
  };

  if (loadingAuth) return <div className={`min-h-screen ${isDarkMode ? 'dark' : ''}`}><div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center text-blue-500"><Loader2 className="animate-spin" size={40} /></div></div>;

  if (!user) {
    return (
      <div className={`min-h-screen ${isDarkMode ? 'dark' : ''}`}>
        <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col items-center justify-center p-4 transition-colors duration-300">
          <div className="mb-10 text-center animate-in slide-in-from-bottom-4 fade-in duration-500">
            <div className="bg-gradient-to-tr from-blue-600 to-indigo-600 p-5 rounded-3xl shadow-xl mb-6 inline-block"><CreditCard size={48} className="text-white" /></div>
            <h1 className="text-4xl font-extrabold text-slate-900 dark:text-white mb-3 tracking-tight">CardsDeVen</h1>
            <p className="text-slate-500 dark:text-slate-400 max-w-sm text-lg">Smart logic for Israeli gift cards.</p>
          </div>
          <div className="w-full max-w-md bg-white dark:bg-slate-900 p-8 rounded-[2rem] shadow-2xl border border-slate-100 dark:border-slate-800 animate-in slide-in-from-bottom-8 fade-in duration-700 delay-150">
            <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-100 mb-6 text-center">{isLoginMode ? 'Welcome Back' : 'Create Account'}</h2>
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
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-200 transition-colors duration-300 relative">
        {toast.visible && (
          <div className="fixed top-24 left-1/2 -translate-x-1/2 z-[200] animate-in slide-in-from-top-4 fade-in duration-300">
            <div className={`${toast.type === 'error' ? 'bg-red-600' : 'bg-slate-900 dark:bg-white text-white dark:text-slate-900'} px-6 py-3 rounded-full shadow-2xl font-medium flex items-center gap-2`}>
              {toast.type === 'success' ? <CheckCircle2 size={18} className="text-emerald-400 dark:text-emerald-500" /> : <AlertCircle size={18} className="text-white" />}
              {toast.message}
            </div>
          </div>
        )}

        <header className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 p-4 sm:p-5 sticky top-0 z-40 transition-colors">
          <div className="max-w-6xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-3 sm:gap-4">
              <div className="bg-gradient-to-tr from-blue-600 to-indigo-600 p-2 sm:p-2.5 rounded-xl shadow-lg"><CreditCard size={24} className="text-white" /></div>
              <div><h1 className="text-lg sm:text-xl font-extrabold tracking-tight text-slate-900 dark:text-white">CardsDeVen</h1><p className="text-[10px] sm:text-xs font-medium text-slate-500 dark:text-slate-400">{user.email}</p></div>
            </div>
            <div className="flex items-center gap-2 sm:gap-3">
              <button onClick={() => setIsDarkMode(!isDarkMode)} className="p-2.5 bg-slate-100 dark:bg-slate-800 rounded-full hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors text-slate-600 dark:text-slate-300">{isDarkMode ? <Sun size={18} /> : <Moon size={18} />}</button>
              <button onClick={handleSignOut} className="p-2.5 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-full hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors"><LogOut size={18} /></button>
            </div>
          </div>
        </header>

        <main className="max-w-6xl mx-auto p-4 sm:p-6 mt-2 sm:mt-6">
          {/* Dashboard */}
          {activeTab === 'dashboard' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
              {expiringAlerts.length > 0 && (
                <div className="bg-gradient-to-r from-orange-500 to-red-600 rounded-[2rem] p-6 shadow-lg text-white flex flex-col sm:flex-row items-center gap-4 sm:justify-between animate-in zoom-in-95">
                  <div className="flex items-center gap-4">
                    <div className="bg-white/20 p-3 rounded-full"><Clock size={28} /></div>
                    <div><h3 className="font-bold text-lg">Use It Or Lose It</h3><p className="text-white/80 text-sm">{expiringAlerts.length} card(s) expiring within 30 days!</p></div>
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
                <div className="bg-gradient-to-br from-slate-900 to-slate-800 dark:from-slate-800 dark:to-slate-700 text-white p-8 rounded-[2rem] shadow-xl relative overflow-hidden group hover:shadow-2xl transition-all">
                  <div className="relative z-10"><div className="text-slate-300 dark:text-slate-400 text-sm font-semibold mb-2 uppercase tracking-widest">Total Portfolio</div><div className="text-5xl font-black mb-1">₪{totalInitialBalance.toLocaleString()}</div><div className="text-slate-400 dark:text-slate-500 text-sm">Initial setup across {cards.length} cards</div></div>
                  <div className="absolute -right-8 -bottom-8 bg-white/5 p-8 rounded-full group-hover:scale-110 transition-transform duration-500"><CreditCard size={100} className="text-white/10" /></div>
                </div>
                <div className="bg-gradient-to-br from-emerald-500 to-emerald-700 text-white p-8 rounded-[2rem] shadow-xl relative overflow-hidden group hover:shadow-2xl transition-all">
                  <div className="relative z-10"><div className="text-emerald-100 text-sm font-semibold mb-2 uppercase tracking-widest">Available Power</div><div className="text-5xl font-black mb-1">₪{totalRemainingBalance.toLocaleString()}</div><div className="text-emerald-200 text-sm">After ₪{totalPlannedExpenses.toLocaleString()} total expenses</div></div>
                  <div className="absolute -right-8 -bottom-8 bg-black/5 p-8 rounded-full group-hover:scale-110 transition-transform duration-500"><Receipt size={100} className="text-black/10" /></div>
                </div>
              </div>

              <div>
                <h2 className="text-2xl font-bold text-slate-800 dark:text-white mb-6">Budget by Category</h2>
                {fundsByCategory.length === 0 ? (
                  <div className="text-center p-12 bg-white dark:bg-slate-900 rounded-[2rem] shadow-sm border border-slate-100 dark:border-slate-800"><PieChart size={48} className="mx-auto mb-4 text-slate-300 dark:text-slate-700" /><p className="text-slate-500 dark:text-slate-400 font-medium">Add cards to populate your category breakdown.</p></div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                    {fundsByCategory.map(([category, data]) => (
                      <div key={category} className="p-6 bg-white dark:bg-slate-900 rounded-[1.5rem] shadow-sm border border-slate-100 dark:border-slate-800 hover:shadow-md hover:-translate-y-1 transition-all group">
                        <div className="flex justify-between items-start mb-4">
                          <div className="font-bold text-slate-700 dark:text-slate-200 flex items-center gap-2"><span>{CATEGORY_ICONS[category]}</span><span className="leading-tight">{category}</span></div>
                          <div className="bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 px-3 py-1 rounded-full text-xs font-bold">Available</div>
                        </div>
                        <div className="text-3xl font-black text-slate-900 dark:text-white mb-3">₪{data.total.toLocaleString()}</div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed"><span className="font-semibold">Sources:</span> {data.sources.join(', ')}</div>
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
              <div className="flex justify-between items-end">
                <div><h2 className="text-3xl font-bold text-slate-900 dark:text-white tracking-tight">Digital Wallet</h2><p className="text-slate-500 dark:text-slate-400 mt-1">Manage your active gift cards and budgets.</p></div>
                <button onClick={() => { resetCardForm(); setShowCardForm(true); }} className="bg-slate-900 dark:bg-white text-white dark:text-slate-900 px-5 py-3 rounded-xl font-bold flex items-center gap-2 hover:scale-105 active:scale-95 transition-all shadow-lg hover:shadow-xl"><Plus size={20} /> Add Card</button>
              </div>

              {cards.length === 0 ? (
                <div className="text-center p-16 bg-white dark:bg-slate-900 rounded-[2rem] shadow-sm border border-slate-100 dark:border-slate-800 border-dashed"><CreditCard size={64} className="mx-auto mb-6 text-slate-200 dark:text-slate-800" /><h3 className="text-xl font-bold text-slate-700 dark:text-slate-200 mb-2">Your wallet is empty</h3><p className="text-slate-500 dark:text-slate-400 max-w-sm mx-auto">Click the button above to register your first funding source or gift card.</p></div>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                  {cardBalances.map((card) => {
                    const ruleData = RULE_TYPES[card.ruleType?.toUpperCase()] || RULE_TYPES.PERMANENT;
                    const progData = PROGRAMS[card.programId || 'CUSTOM'] || PROGRAMS.CUSTOM;
                    const percentRemaining = Math.max(0, Math.min(100, (card.remaining / parseFloat(card.balance)) * 100));
                    const isExpiringSoon = card.ruleType === 'expires' && getDaysUntilExpiry(card.expiryDate) <= 30;
                    return (
                      <div key={card.id} className="relative group perspective-1000">
                        <div className={`${card.color || GRADIENTS[0]} rounded-[2rem] p-8 text-white shadow-xl hover:shadow-2xl transition-all duration-300 aspect-[1.58/1] flex flex-col justify-between relative overflow-hidden ${isExpiringSoon ? 'ring-4 ring-orange-500 ring-offset-2 dark:ring-offset-slate-950' : ''}`}>
                          <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/3"></div>
                          <div className="flex justify-between items-start relative z-10">
                            <div>
                              <div className="flex items-center gap-2 mb-1"><h3 className="font-bold text-2xl tracking-tight">{card.name}</h3><span className="bg-white/20 px-2 py-0.5 rounded text-[10px] font-bold tracking-widest uppercase backdrop-blur-md border border-white/20">{progData.name}</span></div>
                              <div className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider ${isExpiringSoon ? 'text-orange-200 font-bold' : 'text-white/80'}`}><ruleData.icon size={14} /> {ruleData.label}{card.ruleType === 'expires' && card.expiryDate && ` • ${new Date(card.expiryDate).toLocaleDateString()}`}{isExpiringSoon && ' (EXPIRING!)'}</div>
                            </div>
                            <div className="flex flex-col items-end gap-2">
                              <button onClick={() => startQuickExpense(card.id)} className="bg-white text-slate-900 hover:bg-emerald-400 hover:text-white p-2.5 rounded-full shadow-lg transition-colors flex items-center gap-2 group/btn"><Zap size={18} className="fill-current" /><span className="hidden sm:group-hover/btn:block text-xs font-bold uppercase tracking-wider pr-2">Quick Spend</span></button>
                              <div className="bg-white/20 backdrop-blur-md p-1.5 rounded-xl opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity flex gap-1">
                                <button onClick={() => startEditCard(card)} className="p-2 hover:bg-white/20 rounded-lg transition-colors"><Edit2 size={16} /></button>
                                <button onClick={() => { if (window.confirm('Delete this card?')) deleteCard(card.id); }} className="p-2 hover:bg-red-500/50 rounded-lg transition-colors text-red-100"><Trash2 size={16} /></button>
                              </div>
                            </div>
                          </div>
                          <div className="relative z-10">
                            <div className="flex justify-between items-end mb-3">
                              <div><div className="text-white/60 text-xs font-semibold uppercase tracking-wider mb-1">Available</div><div className="text-4xl font-black font-mono tracking-tight">₪{card.remaining.toLocaleString()}</div></div>
                              <div className="text-right"><div className="text-white/60 text-xs font-semibold uppercase tracking-wider mb-1">Total Limit</div><div className="text-lg font-bold">₪{parseFloat(card.balance).toLocaleString()}</div></div>
                            </div>
                            <div className="w-full bg-black/20 h-2.5 rounded-full overflow-hidden backdrop-blur-sm"><div className="bg-white h-full rounded-full transition-all duration-1000 ease-out relative" style={{ width: `${percentRemaining}%` }}><div className="absolute inset-0 bg-gradient-to-r from-transparent to-white/50 animate-[shimmer_2s_infinite]"></div></div></div>
                          </div>
                        </div>
                        <div className="px-4 py-4 flex flex-wrap gap-2">{card.derivedCats.map((cat) => (<span key={cat} className="bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 px-3 py-1.5 rounded-full text-xs font-semibold shadow-sm flex items-center gap-1.5">{CATEGORY_ICONS[cat]} {cat}</span>))}</div>
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
                                {expense.merchantName && <span className="bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-[9px] sm:text-[10px] px-2 py-0.5 rounded font-bold uppercase tracking-wider flex items-center gap-1"><MerchantIcon merchantName={expense.merchantName} category={expense.category} className="w-4 h-4 rounded-sm border-0" />{expense.merchantName.split('(')[0].trim()}</span>}
                              </div>
                              <div className="flex flex-wrap items-center gap-2 text-xs"><span className="font-medium text-slate-500">{CATEGORY_ICONS[expense.category]} {expense.category}</span><span className="text-slate-300 dark:text-slate-600">•</span><span className="font-bold flex items-center gap-1"><span className={`w-2 h-2 rounded-full ${progColor}`}></span>{sourceCard?.name || 'Deleted Card'}</span></div>
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
              <div className="bg-gradient-to-r from-blue-600 to-indigo-600 rounded-[2rem] p-6 sm:p-8 shadow-xl text-white">
                <h3 className="text-xl font-bold mb-4 flex items-center gap-2"><Search size={24} /> Where are you paying?</h3>
                <input type="text" value={insightSearch} onChange={(e) => setInsightSearch(e.target.value)} placeholder="e.g. Zara, Pizza, Cinema, COMY..." className="w-full pl-5 pr-12 py-4 rounded-2xl bg-white/10 backdrop-blur-md border border-white/20 text-white placeholder-white/60 focus:ring-4 focus:ring-white/30 outline-none font-medium text-lg transition-all" />
                {insightSearch && (
                  <div className="mt-6 space-y-4">
                    {(() => {
                      const matches = getSmartMatches(insightSearch, 5);
                      if (matches.length === 0) return <div className="text-white/80 font-medium bg-white/10 p-4 rounded-2xl border border-white/20">Merchant not found in official database. Generic category rules will apply.</div>;
                      return matches.map(([searchMatch, mData]) => {
                        const acceptedCards = sortedCardBalances.filter((c) => checkCompatibility(c, mData.cat, searchMatch).allowed && c.remaining > 0);
                        // Check against the combined data (Hardcoded + Live Scraped)
                        const merchantDeals = allDiscountsData.filter((d) => d.m === searchMatch && userClubs.includes(d.c));
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
                                    <div key={idx} className="bg-black/20 border border-white/10 rounded-xl p-3 text-sm flex gap-3 items-start backdrop-blur-sm">
                                      <span className={`px-2 py-1 rounded text-[10px] font-bold text-white whitespace-nowrap ${CLUBS[deal.c].color}`}>{CLUBS[deal.c].name}</span>
                                      <span className="text-amber-50 font-medium text-sm leading-tight">{deal.d}</span>
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
                  <div className="relative max-w-md"><Search className="absolute left-3.5 top-3.5 text-slate-400" size={18} /><input type="text" value={clubSearch} onChange={(e) => setClubSearch(e.target.value)} placeholder="Search discounts (e.g. Pizza, FOX, COMY)..." className="w-full pl-10 p-3.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white rounded-xl focus:ring-4 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all font-medium" /></div>
                </div>
                <div className="p-6">
                  {userClubs.length === 0 ? (
                    <div className="text-center p-8"><Gift size={48} className="mx-auto mb-4 text-slate-200 dark:text-slate-800" /><p className="text-slate-500 font-medium">Select a club above to see your available deals.</p></div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {allDiscountsData.filter((d) => {
                        if (!userClubs.includes(d.c)) return false;
                        if (!clubSearch) return true;
                        const qs = clubSearch.toLowerCase();
                        const cat = dynamicMerchants[d.m]?.cat || "";
                        const catAliases = CATEGORY_ALIASES[cat] || [];
                        return d.m.toLowerCase().includes(qs) || d.d.toLowerCase().includes(qs) || cat.toLowerCase().includes(qs) || catAliases.some((a) => a.includes(qs));
                      }).slice(0, 50).map((deal, idx) => ( // Sliced to 50 so React doesn't freeze rendering 4000 rows at once
                        <div key={idx} className="flex gap-4 items-start p-4 border border-slate-100 dark:border-slate-800 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors group">
                          <MerchantIcon merchantName={deal.m} category={dynamicMerchants[deal.m]?.cat} className="w-12 h-12 rounded-lg" />
                          <div><div className="font-bold text-slate-900 dark:text-white flex items-center gap-2 mb-1">{deal.m.split('(')[0].trim()}<span className={`text-[9px] px-1.5 py-0.5 rounded text-white ${CLUBS[deal.c].color}`}>{CLUBS[deal.c].name}</span></div><div className="text-sm font-medium text-emerald-600 dark:text-emerald-400 leading-tight">{deal.d}</div></div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* AI */}
          {activeTab === 'ai' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 h-[80vh] flex flex-col">
              <div className="flex justify-between items-end">
                <div><h2 className="text-3xl font-bold text-slate-900 dark:text-white tracking-tight">Smart Assistant</h2><p className="text-slate-500 dark:text-slate-400 mt-1">Ask me what to buy, and I'll find the best deal.</p></div>
                <button onClick={() => { if (abortControllerRef.current) abortControllerRef.current.abort(); setAiMessages([{ role: 'model', text: 'היסטוריית הצ\'אט נמחקה! אז מה קונים היום? 😎' }]); setIsAiTyping(false); }} className="p-2.5 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-full transition-colors" title="Clear Chat History"><Trash2 size={20} /></button>
              </div>
              <div className="flex-1 bg-white dark:bg-slate-900 rounded-[2rem] shadow-sm border border-slate-100 dark:border-slate-800 overflow-hidden flex flex-col">
                <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-slate-900 dark:to-slate-800">
                  <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300">
                    Tip: ask with budget + item + area for better combo precision.
                  </p>
                </div>
                <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 bg-slate-50/60 dark:bg-slate-950/40">
                  {aiMessages.map((msg, idx) => (
                    <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      {msg.role === 'model' && <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center shrink-0 mr-3 mt-1 shadow-sm"><Bot size={16} className="text-blue-600 dark:text-blue-400" /></div>}
                      <div className={`max-w-[88%] sm:max-w-[76%] p-4 rounded-2xl shadow-sm ${msg.role === 'user' ? 'bg-blue-600 text-white rounded-tr-sm text-left' : 'bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 rounded-tl-sm border border-slate-200 dark:border-slate-700/50 leading-relaxed text-right'}`} dir={msg.role === 'model' ? "rtl" : "auto"}>
                        <div className={`text-[10px] uppercase tracking-wider mb-1.5 ${msg.role === 'user' ? 'text-blue-100' : 'text-slate-400 dark:text-slate-500'}`}>
                          {msg.role === 'user' ? 'You' : 'Advisor'}
                        </div>
                        <div className="whitespace-pre-wrap">{renderChatText(msg.text)}</div>
                      </div>
                    </div>
                  ))}
                  {isAiTyping && <div className="flex justify-start"><div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center shrink-0 mr-3 mt-1"><Bot size={16} className="text-blue-600 dark:text-blue-400" /></div><div className="bg-white dark:bg-slate-800 p-4 rounded-2xl rounded-tl-sm border border-slate-200 dark:border-slate-700/50 shadow-sm"><Loader2 className="animate-spin text-slate-400" size={20} /></div></div>}
                  <div ref={chatEndRef} />
                </div>
                <div className="p-4 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-100 dark:border-slate-800">
                  <form onSubmit={handleSendAI} className="relative flex items-center">
                    <input type="text" value={aiInput} onChange={(e) => setAiInput(e.target.value)} placeholder="e.g. I need to buy pizza for 10 people..." disabled={isAiTyping} className="w-full pl-4 pr-14 py-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:ring-4 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all shadow-sm disabled:opacity-70" />
                    <button type="submit" disabled={!aiInput.trim() || isAiTyping} className="absolute right-2 p-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"><Send size={18} className="ml-0.5" /></button>
                  </form>
                </div>
              </div>
            </div>
          )}
        </main>

        <nav className="fixed bottom-0 left-0 right-0 bg-white/90 dark:bg-slate-900/90 backdrop-blur-xl border-t border-slate-200 dark:border-slate-800 shadow-[0_-10px_40px_rgba(0,0,0,0.05)] px-2 sm:px-6 py-4 flex justify-around sm:justify-center sm:gap-8 lg:gap-16 z-40 transition-colors overflow-x-auto">
          {[{ id: 'dashboard', icon: LayoutDashboard, label: 'Dashboard' }, { id: 'wallets', icon: CreditCard, label: 'Wallet' }, { id: 'planner', icon: Receipt, label: 'Planner' }, { id: 'insights', icon: Search, label: 'Search' }, { id: 'clubs', icon: Gift, label: 'Clubs' }, { id: 'ai', icon: Bot, label: 'Smart AI' }].map((item) => (
            <button key={item.id} onClick={() => setActiveTab(item.id)} className={`flex flex-col items-center gap-1.5 transition-all duration-300 min-w-[50px] ${activeTab === item.id ? 'text-blue-600 dark:text-blue-400 scale-110' : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 hover:scale-105'}`}>
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

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div>
                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">Specific Merchant (Optional)</label>
                <div className="relative">
                  <Search className="absolute left-3.5 top-3.5 text-slate-400" size={18} />
                  <input type="text" value={merchantSearch} onChange={(e) => { setMerchantSearch(e.target.value); setNewExpense({ ...newExpense, merchantName: e.target.value, cardId: '' }); setShowMerchantSuggestions(true); }} onFocus={() => setShowMerchantSuggestions(true)} className="w-full pl-10 p-3.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white rounded-xl focus:ring-4 focus:ring-emerald-500/20 focus:border-emerald-500 outline-none transition-all font-medium" placeholder="e.g. Wolt, FOX..." />
                  {showMerchantSuggestions && merchantSearch && (
                    <div className="absolute z-50 w-full mt-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl max-h-48 overflow-y-auto">
                      {getSmartMatches(merchantSearch).map(([name, data]) => (
                        <div key={name} onMouseDown={() => handleMerchantSelect(name, data.cat)} className="p-3 hover:bg-slate-50 dark:hover:bg-slate-700 cursor-pointer border-b border-slate-100 dark:border-slate-700/50 last:border-0 flex justify-between items-center">
                          <div className="flex items-center gap-2"><MerchantIcon merchantName={name} category={data.cat} className="w-6 h-6 rounded border-0 bg-transparent" /><span className="font-bold text-slate-800 dark:text-slate-200">{name}</span></div>
                          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 bg-slate-100 dark:bg-slate-900 px-2 py-1 rounded">{data.cat}</span>
                        </div>
                      ))}
                      {getSmartMatches(merchantSearch).length === 0 && <div className="p-3 text-sm text-slate-500 text-center">Unrecognized merchant. Using generic rules.</div>}
                    </div>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">Category</label>
                <select required value={newExpense.category} onChange={(e) => setNewExpense({ ...newExpense, category: e.target.value, cardId: '' })} className="w-full p-3.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white rounded-xl focus:ring-4 focus:ring-emerald-500/20 focus:border-emerald-500 outline-none transition-all font-medium appearance-none">
                  <option value="" disabled>-- Select Category --</option>
                  {CATEGORIES.map((cat) => <option key={cat} value={cat}>{CATEGORY_ICONS[cat]} {cat}</option>)}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div>
                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">Estimated Cost (₪)</label>
                <input type="number" required min="0.01" step="0.01" value={newExpense.amount} onChange={(e) => setNewExpense({ ...newExpense, amount: e.target.value, cardId: '' })} className="w-full p-3.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white rounded-xl focus:ring-4 focus:ring-emerald-500/20 focus:border-emerald-500 outline-none transition-all font-mono font-bold text-lg text-emerald-600 dark:text-emerald-400" placeholder="0.00" />
                {!editingExpenseId && newExpense.amount && <div className="mt-3 flex items-center gap-2"><input type="checkbox" id="isManualSplit" checked={newExpense.isManualSplit || false} onChange={(e) => setNewExpense({ ...newExpense, isManualSplit: e.target.checked, chargeAmount: e.target.checked ? newExpense.amount : '' })} className="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500 bg-white border-slate-300" /><label htmlFor="isManualSplit" className="text-xs font-semibold text-slate-500 dark:text-slate-400 cursor-pointer">Split this payment across multiple cards?</label></div>}
              </div>
              <div>
                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">Pay With</label>
                <select required disabled={!newExpense.category} value={newExpense.cardId} onChange={(e) => setNewExpense({ ...newExpense, cardId: e.target.value })} className="w-full p-3.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white rounded-xl focus:ring-4 focus:ring-emerald-500/20 focus:border-emerald-500 disabled:opacity-50 outline-none transition-all font-medium appearance-none">
                  <option value="" disabled>{!newExpense.category ? 'Awaiting category...' : '-- Evaluated Cards --'}</option>
                  {sortedCardBalances.map((card) => {
                    if (!newExpense.category) return null;
                    const compatibility = checkCompatibility(card, newExpense.category, newExpense.merchantName);
                    const isEditingCurrent = editingExpenseId && card.id === newExpense.cardId;
                    const canAfford = isEditingCurrent || card.remaining >= parseFloat(newExpense.amount || 0);
                    const isAllowedByRules = compatibility.allowed;
                    const isSelectable = isAllowedByRules && card.remaining > 0;
                    const expiringTag = card.ruleType === 'expires' && getDaysUntilExpiry(card.expiryDate) <= 30 ? '[EXPIRING!] ' : '';
                    return <option key={card.id} value={card.id} disabled={!isSelectable}>{expiringTag}{card.name} (Available: ₪{card.remaining.toLocaleString()}) {!isAllowedByRules ? '- Rule Blocked' : (!canAfford ? '- Requires Split' : '')}</option>;
                  })}
                </select>
                {newExpense.category && cardBalances.filter((c) => checkCompatibility(c, newExpense.category, newExpense.merchantName).allowed).length === 0 && <p className="text-red-500 dark:text-red-400 text-[10px] mt-1.5 font-bold uppercase tracking-wider flex items-center gap-1"><ShieldAlert size={12} /> No valid cards for this merchant/category.</p>}
              </div>
            </div>

            {newExpense.isManualSplit && !editingExpenseId && newExpense.cardId && (
              <div className="animate-in fade-in slide-in-from-top-2 bg-blue-50 dark:bg-blue-900/10 p-4 rounded-xl border border-blue-100 dark:border-blue-800/50">
                <label className="block text-sm font-bold text-blue-800 dark:text-blue-300 mb-2">Amount to charge to selected card (₪)</label>
                <input type="number" required min="0.01" max={Math.min(parseFloat(newExpense.amount || Infinity), cardBalances.find((c) => c.id === newExpense.cardId)?.remaining || Infinity)} step="0.01" value={newExpense.chargeAmount} onChange={(e) => setNewExpense({ ...newExpense, chargeAmount: e.target.value })} className="w-full p-3.5 bg-white dark:bg-slate-800 border border-blue-200 dark:border-blue-700 text-slate-900 dark:text-white rounded-xl focus:ring-4 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all font-mono font-bold text-lg" placeholder="0.00" />
              </div>
            )}

            <div className="pt-6 border-t border-slate-100 dark:border-slate-800">
              {(() => {
                const selectedCard = cardBalances.find((c) => c.id === newExpense.cardId);
                const reqAmount = parseFloat(newExpense.amount || 0);
                let actualLogAmount = reqAmount;
                let isSplitNeeded = false;
                if (selectedCard && !editingExpenseId) {
                  if (newExpense.isManualSplit && newExpense.chargeAmount) actualLogAmount = parseFloat(newExpense.chargeAmount || 0);
                  if (actualLogAmount > selectedCard.remaining) actualLogAmount = selectedCard.remaining;
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