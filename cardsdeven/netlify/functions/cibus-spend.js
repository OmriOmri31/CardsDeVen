import { createHash, createSign, timingSafeEqual } from 'node:crypto';
import { computeCardFunds } from '../../src/cardCycle.js';

const MAX_AMOUNT = 9999.99;
const NOTIFICATION_PREFIX = /^עבור עסק[הת]\s+במסעדת\s*/;

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(body),
  };
}

function tokensMatch(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function header(event, name) {
  const headers = event.headers || {};
  const wanted = name.toLowerCase();
  const key = Object.keys(headers).find((item) => item.toLowerCase() === wanted);
  return key ? headers[key] : '';
}

function readPayload(event) {
  const params = event.queryStringParameters || {};
  if (!event.body) return { ...params };
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  const contentType = String(header(event, 'content-type') || '');
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return { ...params, ...Object.fromEntries(new URLSearchParams(raw)) };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return { ...params, ...parsed };
  } catch {
    /* amount may still be in the query string */
  }
  return { ...params };
}

function requestToken(event, payload) {
  const authorization = String(header(event, 'authorization') || '');
  const bearer = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice(7).trim()
    : '';
  return bearer || header(event, 'x-cibus-token') || payload.token || '';
}

/** Amount at the end of a Cibus notification: "18.73 ₪" or "18.73₪". */
export function parseCibusAmount(text) {
  const source = String(text || '').replace(/\u00a0/g, ' ').trim();
  const match = source.match(/(\d{1,4}(?:[.,]\d{1,2})?)\s*₪\s*$/u);
  if (!match) return null;
  const amount = Math.round(Number(match[1].replace(',', '.')) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) return null;
  return amount;
}

function amountFromPayload(payload) {
  const text = String(payload.text || payload.notification || payload.message || '').trim();
  const fromText = text ? parseCibusAmount(text) : null;
  if (fromText != null) return { amount: fromText, text };
  const raw = String(payload.amount ?? '').trim().replace(',', '.');
  const amount = Math.round(Number(raw) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    return { amount: null, text };
  }
  return { amount, text };
}

function purchaseName(text) {
  const middle = String(text || '')
    .replace(NOTIFICATION_PREFIX, '')
    .replace(/(\d{1,4}(?:[.,]\d{1,2})?)\s*₪\s*$/u, '')
    .trim();
  if (middle && middle.length <= 80) return middle;
  return 'Cibus';
}

function jerusalemDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function expenseDocId(text, amount) {
  const basis = text
    ? `text:${text.slice(0, 2000)}`
    : `amount:${amount}:${jerusalemDateString()}:${new Date().toISOString().slice(0, 16)}`;
  return `cibus_${createHash('sha256').update(basis).digest('hex').slice(0, 24)}`;
}

function loadServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw || !raw.trim()) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
  }
  const parsed = JSON.parse(raw);
  if (typeof parsed.private_key === 'string') {
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  }
  if (!parsed.client_email || !parsed.private_key || !parsed.project_id) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is incomplete');
  }
  return parsed;
}

async function googleAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const headerPart = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claimPart = Buffer.from(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');
  const unsigned = `${headerPart}.${claimPart}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  const assertion = `${unsigned}.${signer.sign(serviceAccount.private_key).toString('base64url')}`;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!response.ok) {
    throw new Error(`Google token request failed (${response.status})`);
  }
  const data = await response.json();
  if (!data.access_token) throw new Error('Google token response had no access_token');
  return data.access_token;
}

function firestoreUrl(projectId, path) {
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  return path ? `${base}/${path}` : base;
}

function decodeValue(value) {
  if (!value || typeof value !== 'object') return null;
  if ('stringValue' in value) return value.stringValue;
  if ('doubleValue' in value) return value.doubleValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('booleanValue' in value) return value.booleanValue;
  if ('nullValue' in value) return null;
  if ('timestampValue' in value) return value.timestampValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeValue);
  return null;
}

function decodeDocument(document) {
  const fields = {};
  for (const [key, value] of Object.entries(document.fields || {})) {
    fields[key] = decodeValue(value);
  }
  const id = String(document.name || '').split('/').pop();
  return { id, ...fields };
}

async function listDocuments(token, projectId, collectionPath) {
  const documents = [];
  let pageToken = '';
  do {
    const url = new URL(firestoreUrl(projectId, collectionPath));
    url.searchParams.set('pageSize', '300');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`Firestore list failed (${response.status})`);
    const data = await response.json();
    for (const document of data.documents || []) documents.push(decodeDocument(document));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return documents;
}

function isCibusCard(card) {
  if (card.programId === 'CB') return true;
  return String(card.name || '').trim().toLowerCase() === 'cibus';
}

function pickCibusCard(cards) {
  const wantedId = String(process.env.CIBUS_CARD_ID || '').trim();
  if (wantedId) {
    const exact = cards.find((card) => card.id === wantedId);
    if (!exact) return { error: 'CIBUS_CARD_ID does not match a card on your account.' };
    if (!isCibusCard(exact)) return { error: 'CIBUS_CARD_ID is not a Cibus card.' };
    return { card: exact };
  }
  const matches = cards.filter(isCibusCard);
  if (matches.length === 1) return { card: matches[0] };
  if (matches.length === 0) return { error: 'No Cibus card found on your account.' };
  return { error: 'More than one Cibus card. Set CIBUS_CARD_ID to the one this phone should update.' };
}

function firestoreString(value) {
  return { stringValue: String(value) };
}

async function createExpense(token, projectId, uid, docId, fields) {
  const url = new URL(firestoreUrl(projectId, `users/${uid}/expenses`));
  url.searchParams.set('documentId', docId);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  });
  if (response.status === 409) return { duplicate: true };
  if (!response.ok) throw new Error(`Firestore create failed (${response.status})`);
  return { duplicate: false };
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const secret = String(process.env.CIBUS_WEBHOOK_SECRET || '');
  const uid = String(process.env.CIBUS_OWNER_UID || '').trim();
  if (!secret || !uid) {
    return json(503, { error: 'Cibus webhook is not configured.' });
  }

  const payload = readPayload(event);
  if (!tokensMatch(requestToken(event, payload), secret)) {
    return json(401, { error: 'Unauthorized' });
  }

  const { amount, text } = amountFromPayload(payload);
  if (amount == null) {
    return json(400, { error: 'No Cibus amount found. Send the notification text or a positive amount.' });
  }

  try {
    const serviceAccount = loadServiceAccount();
    const token = await googleAccessToken(serviceAccount);
    const projectId = serviceAccount.project_id;
    const cards = await listDocuments(token, projectId, `users/${uid}/cards`);
    const picked = pickCibusCard(cards);
    if (!picked.card) return json(404, { error: picked.error });

    const card = picked.card;
    const spentAt = new Date();
    const now = spentAt.toISOString();
    const docId = expenseDocId(text, amount);
    const created = await createExpense(token, projectId, uid, docId, {
      name: firestoreString(purchaseName(text)),
      amount: { doubleValue: amount },
      category: firestoreString('Food Chains & Restaurants'),
      merchantName: firestoreString(''),
      expenseCategories: { arrayValue: { values: [firestoreString('Food Chains & Restaurants')] } },
      expenseMerchants: { arrayValue: {} },
      cardId: firestoreString(card.id),
      isCompleted: { booleanValue: true },
      scheduledFor: firestoreString(now),
      updatedAt: firestoreString(now),
      source: firestoreString('cibus-notification'),
    });

    const expenses = await listDocuments(token, projectId, `users/${uid}/expenses`);
    const funds = computeCardFunds(card, expenses, spentAt);
    return json(200, {
      ok: true,
      duplicate: created.duplicate,
      amount,
      card: card.name || 'Cibus',
      remaining: funds.remaining,
    });
  } catch (error) {
    console.error('Cibus webhook error:', error?.message || error);
    return json(500, { error: 'Could not update the Cibus balance.' });
  }
};
