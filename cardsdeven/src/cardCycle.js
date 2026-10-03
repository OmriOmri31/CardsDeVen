/**
 * Recurring card balances.
 *
 * A monthly card (Cibus) is the short case: the grant arrives every month and
 * unused money resets on that same boundary. A longer case adds the grant on
 * one interval and only wipes the balance on a later one — for example ₪500
 * every 3 months, stacking until a yearly reset, then starting again at zero.
 *
 * Windows line up to the 1st of a month. With no custom start, January is
 * month 0, so a 12-month reset is a calendar year and a 3-month refill lands
 * in January, April, July, and October.
 */

export const CYCLE_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const RECURRING_PRESETS = [
  {
    id: 'monthly',
    label: 'Monthly reset',
    detail: 'A set amount every month, like Cibus. Anything left over resets on the 1st.',
  },
  {
    id: 'quarterly-yearly',
    label: 'Every 3 months',
    detail: 'A set amount each quarter. It stacks, then the whole balance resets to zero after a year.',
  },
  {
    id: 'custom',
    label: 'Custom schedule',
    detail: 'Choose how often money is added, and when the balance returns to zero.',
  },
];

function shekels(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function wholeMonths(raw, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.round(n) !== n || n < min || n > max) return null;
  return n;
}

/** Month index shifted so `cycleStartMonth` (1–12) is the start of each reset window. */
function shiftedMonthIndex(date, cycleStartMonth) {
  const start = wholeMonths(cycleStartMonth, 1, 12) || 1;
  return date.getFullYear() * 12 + date.getMonth() - (start - 1);
}

export function normalizeStartMonth(raw) {
  return wholeMonths(raw, 1, 12) || 1;
}

/**
 * Refill and reset must be whole months, and the reset must contain a whole
 * number of refills so the balance can return to zero on a grant boundary.
 */
export function normalizeCycleMonths(refillRaw, resetRaw) {
  const refill = wholeMonths(refillRaw, 1, 36);
  const reset = wholeMonths(resetRaw, 1, 60);
  if (refill == null) {
    return { ok: false, error: 'Refill must be a whole number of months from 1 to 36.' };
  }
  if (reset == null) {
    return { ok: false, error: 'Reset must be a whole number of months from 1 to 60.' };
  }
  if (reset < refill || reset % refill !== 0) {
    return {
      ok: false,
      error: 'The reset has to be a whole number of refills, so the balance can return to zero cleanly. Every 3 months with a 12-month reset is one example.',
    };
  }
  return { ok: true, refill, reset };
}

/** Saved cards with odd numbers still compute; the form blocks new invalid schedules. */
function sanitizeStoredMonths(refillRaw, resetRaw) {
  let refill = Math.round(Number(refillRaw));
  if (!Number.isFinite(refill) || refill < 1) refill = 1;
  if (refill > 36) refill = 36;
  let reset = Math.round(Number(resetRaw));
  if (!Number.isFinite(reset) || reset < refill) reset = refill;
  if (reset % refill !== 0) reset = refill * Math.max(1, Math.round(reset / refill));
  if (reset > 60) reset = refill * Math.max(1, Math.floor(60 / refill));
  return { refill, reset };
}

export function isRecurringRule(ruleType) {
  return ruleType === 'monthly' || ruleType === 'cycle';
}

/** @returns {null | { grant: number, refillEveryMonths: number, resetEveryMonths: number, cycleStartMonth: number }} */
export function getCycleSpec(card) {
  if (!card) return null;
  const grant = shekels(card.balance);
  if (card.ruleType === 'monthly') {
    return { grant, refillEveryMonths: 1, resetEveryMonths: 1, cycleStartMonth: 1 };
  }
  if (card.ruleType !== 'cycle') return null;
  const { refill, reset } = sanitizeStoredMonths(card.refillEveryMonths, card.resetEveryMonths);
  return {
    grant,
    refillEveryMonths: refill,
    resetEveryMonths: reset,
    cycleStartMonth: normalizeStartMonth(card.cycleStartMonth),
  };
}

export function recurringPresetId(card) {
  if (!card || card.ruleType === 'monthly') return card?.ruleType === 'monthly' ? 'monthly' : null;
  if (card.ruleType !== 'cycle') return null;
  const refill = Number(card.refillEveryMonths);
  const reset = Number(card.resetEveryMonths);
  if (refill === 1 && reset === 1) return 'monthly';
  if (refill === 3 && reset === 12) return 'quarterly-yearly';
  return 'custom';
}

/**
 * Spec the form would save, or `{ error }` when a custom schedule is invalid.
 * @returns {null | { error: string } | { grant: number, refillEveryMonths: number, resetEveryMonths: number, cycleStartMonth: number }}
 */
export function specFromRecurringForm(form) {
  if (!form || !isRecurringRule(form.ruleType)) return null;
  const preset = form.recurringPreset || (form.ruleType === 'cycle' ? recurringPresetId(form) : 'monthly');
  if (preset === 'monthly') return getCycleSpec({ ruleType: 'monthly', balance: form.balance });
  if (preset === 'quarterly-yearly') {
    return getCycleSpec({
      ruleType: 'cycle',
      balance: form.balance,
      refillEveryMonths: 3,
      resetEveryMonths: 12,
      cycleStartMonth: form.cycleStartMonth,
    });
  }
  const norm = normalizeCycleMonths(form.refillEveryMonths, form.resetEveryMonths);
  if (!norm.ok) return { error: norm.error };
  return getCycleSpec({
    ruleType: 'cycle',
    balance: form.balance,
    refillEveryMonths: norm.refill,
    resetEveryMonths: norm.reset,
    cycleStartMonth: form.cycleStartMonth,
  });
}

export function asOfDate(input) {
  if (input instanceof Date && !Number.isNaN(input.getTime())) return input;
  if (input == null || input === '') return new Date();
  if (typeof input.toDate === 'function') return asOfDate(input.toDate());
  if (typeof input === 'string') {
    const monthOnly = /^(\d{4})-(\d{2})$/.exec(input);
    if (monthOnly) return new Date(Number(monthOnly[1]), Number(monthOnly[2]) - 1, 1, 12, 0, 0, 0);
    const dayOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
    if (dayOnly) return new Date(Number(dayOnly[1]), Number(dayOnly[2]) - 1, Number(dayOnly[3]), 12, 0, 0, 0);
  }
  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export function expenseAsOfDate(expense) {
  if (!expense) return new Date();
  if (expense.scheduledFor) return asOfDate(expense.scheduledFor);
  if (expense.updatedAt) return asOfDate(expense.updatedAt);
  return new Date();
}

/**
 * Grants landed by `asOf`, plus the next refill and the next wipe.
 * `nextRefill` is null when the next grant arrives together with the reset.
 */
export function describeCycle(spec, asOfInput) {
  const asOf = asOfDate(asOfInput);
  const refill = spec.refillEveryMonths;
  const reset = spec.resetEveryMonths;
  const idx = shiftedMonthIndex(asOf, spec.cycleStartMonth);
  const cycleNumber = Math.floor(idx / reset);
  const cyclePos = idx - cycleNumber * reset;
  const grantsPerCycle = reset / refill;
  const grants = Math.floor(cyclePos / refill) + 1;
  const loaded = shekels(grants * spec.grant);
  const cycleCap = shekels(grantsPerCycle * spec.grant);
  const monthsUntilNextRefill = refill - (cyclePos % refill);
  const monthsUntilReset = reset - cyclePos;
  const nextReset = new Date(asOf.getFullYear(), asOf.getMonth() + monthsUntilReset, 1);
  const nextRefill = monthsUntilNextRefill < monthsUntilReset
    ? new Date(asOf.getFullYear(), asOf.getMonth() + monthsUntilNextRefill, 1)
    : null;
  return { grants, grantsPerCycle, loaded, cycleCap, nextReset, nextRefill, cyclePos };
}

export function expenseInSameResetWindow(card, expense, asOfInput) {
  const spec = getCycleSpec(card);
  if (!spec) return true;
  const asOf = asOfDate(asOfInput);
  const spentOn = expenseAsOfDate(expense);
  const reset = spec.resetEveryMonths;
  const a = shiftedMonthIndex(asOf, spec.cycleStartMonth);
  const b = shiftedMonthIndex(spentOn, spec.cycleStartMonth);
  return Math.floor(a / reset) === Math.floor(b / reset);
}

export function computeCardFunds(card, expenses, asOfInput) {
  const asOf = asOfDate(asOfInput);
  const list = Array.isArray(expenses) ? expenses : [];
  const spec = getCycleSpec(card);
  const spent = shekels(list.reduce((sum, expense) => {
    if (!expense || expense.cardId !== card.id) return sum;
    if (spec && !expenseInSameResetWindow(card, expense, asOf)) return sum;
    return sum + shekels(expense.amount);
  }, 0));
  if (!spec) {
    const loaded = shekels(card.balance);
    return { spent, loaded, remaining: shekels(loaded - spent), cycle: null };
  }
  const cycle = describeCycle(spec, asOf);
  return { spent, loaded: cycle.loaded, remaining: shekels(cycle.loaded - spent), cycle };
}

/** Remaining as of a plan date. The expense being edited is not counted against itself. */
export function remainingForPlan(card, expenses, asOfInput, editingExpense) {
  const funds = computeCardFunds(card, expenses, asOfInput);
  if (!editingExpense || editingExpense.cardId !== card.id) return funds.remaining;
  if (!expenseInSameResetWindow(card, editingExpense, asOfInput)) return funds.remaining;
  return shekels(funds.remaining + shekels(editingExpense.amount));
}

export function cycleBadgeLabel(card) {
  const spec = getCycleSpec(card);
  if (!spec) return null;
  if (spec.refillEveryMonths === 1 && spec.resetEveryMonths === 1) return 'Monthly Reset';
  if (spec.refillEveryMonths === 3 && spec.resetEveryMonths === 12) return 'Every 3 months';
  if (spec.resetEveryMonths === spec.refillEveryMonths) {
    return spec.refillEveryMonths === 1 ? 'Monthly Reset' : `Every ${spec.refillEveryMonths} months`;
  }
  if (spec.resetEveryMonths === 12) return `Every ${spec.refillEveryMonths} months`;
  return `Every ${spec.refillEveryMonths} mo`;
}
