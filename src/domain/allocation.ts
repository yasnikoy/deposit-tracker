/**
 * Refund allocation suggestions (ARCHITECTURE → Allocation suggestions). Pure: the caller
 * passes the candidate B/Ls (same agency and currency, a request sent on or before the
 * value date, open, not voided) with their expected amounts. Nothing here is ever applied
 * without a user's confirmation (rule 6).
 */

export type AllocationCandidate = {
  blId: number;
  /** Deposit − recorded deductions − already allocated. */
  expectedMinor: number;
  /** First request date; "oldest" means first requested first. */
  firstRequestOn: string;
};

export type AllocationLine = { blId: number; amountMinor: number };

export type FifoSuggestion = {
  lines: AllocationLine[];
  /** The last B/L filled absorbs the difference; the user decides who bears it. */
  shortfall: AllocationLine | null;
  /** Money left over once every candidate is filled (overpayment). */
  remainderMinor: number;
};

export type AllocationSuggestions = {
  /** Combinations whose expected amounts sum exactly to the refund, oldest first. */
  exact: AllocationLine[][];
  fifo: FifoSuggestion;
  /** The exact search hit its cap (candidate count or time); more combinations may exist. */
  incomplete: boolean;
};

/** ARCHITECTURE → Technical decisions → Exact-subset search. */
export const EXACT_SEARCH_MAX_CANDIDATES = 30;
export const EXACT_SEARCH_BUDGET_MS = 500;

const byAge = (a: AllocationCandidate, b: AllocationCandidate) => a.firstRequestOn.localeCompare(b.firstRequestOn) || a.blId - b.blId;

export function suggestAllocations(input: {
  refundMinor: number;
  candidates: readonly AllocationCandidate[];
  /** How many exact combinations to return (the alternative-suggestions setting). */
  maxExact: number;
  clock?: () => number;
  budgetMs?: number;
}): AllocationSuggestions {
  const open = input.candidates.filter((c) => c.expectedMinor > 0).sort(byAge);
  const searched = open.slice(0, EXACT_SEARCH_MAX_CANDIDATES);
  const { combinations, timedOut } = exactSubsets(searched, input.refundMinor, input.maxExact, input.clock ?? Date.now, input.budgetMs ?? EXACT_SEARCH_BUDGET_MS);
  return {
    exact: combinations.map((combo) => combo.map((c) => ({ blId: c.blId, amountMinor: c.expectedMinor }))),
    fifo: fifo(open, input.refundMinor),
    incomplete: timedOut || open.length > searched.length,
  };
}

/**
 * Backtracking over candidates oldest first, pruned by the remaining amount. Depth-first
 * in age order yields combinations in oldest-first (lexicographic) order, so the first
 * ones found are the best ranked.
 */
function exactSubsets(candidates: AllocationCandidate[], target: number, limit: number, clock: () => number, budgetMs: number) {
  const found: AllocationCandidate[][] = [];
  const suffix = candidates.reduceRight<number[]>((sums, c, i) => ((sums[i] = c.expectedMinor + (sums[i + 1] ?? 0)), sums), []);
  const started = clock();
  let timedOut = false;
  const chosen: AllocationCandidate[] = [];

  const search = (start: number, remaining: number): void => {
    if (found.length >= limit || timedOut) return;
    if (clock() - started > budgetMs) {
      timedOut = true;
      return;
    }
    for (let i = start; i < candidates.length && found.length < limit; i++) {
      if ((suffix[i] ?? 0) < remaining) return;
      const amount = candidates[i].expectedMinor;
      if (amount > remaining) continue;
      chosen.push(candidates[i]);
      if (amount === remaining) found.push([...chosen]);
      else search(i + 1, remaining - amount);
      chosen.pop();
      if (timedOut) return;
    }
  };
  if (target > 0 && limit > 0) search(0, target);
  return { combinations: found, timedOut };
}

/** Fill the oldest B/Ls first; the last one reached absorbs the shortfall. */
function fifo(candidates: AllocationCandidate[], refundMinor: number): FifoSuggestion {
  const lines: AllocationLine[] = [];
  let left = refundMinor;
  for (const c of candidates) {
    if (left <= 0) break;
    if (left >= c.expectedMinor) {
      lines.push({ blId: c.blId, amountMinor: c.expectedMinor });
      left -= c.expectedMinor;
    } else {
      lines.push({ blId: c.blId, amountMinor: left });
      return { lines, shortfall: { blId: c.blId, amountMinor: c.expectedMinor - left }, remainderMinor: 0 };
    }
  }
  return { lines, shortfall: null, remainderMinor: left };
}
