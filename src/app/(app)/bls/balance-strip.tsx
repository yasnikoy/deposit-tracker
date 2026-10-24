import { t, type TranslationKey } from "@/i18n";
import { formatMoney } from "@/lib/money";
import type { BlBalance } from "@/domain/balances";

/** Deposit, collected, deductions and what remains open; all derived from the ledger. */
export function BalanceStrip({ bl }: { bl: BlBalance & { currency: string } }) {
  const cells: [TranslationKey, number][] = [
    ["bls.detail.deposit", bl.depositMinor],
    ["bls.collected", bl.collectedMinor],
    ["bls.deductions", bl.deductionsMinor],
    ["bls.detail.remaining", bl.expectedMinor],
  ];
  return (
    <dl className="grid grid-cols-4 divide-x rounded-md border">
      {cells.map(([label, minor]) => (
        <div key={label} className="px-3 py-2">
          <dt className="text-muted-foreground text-xs">{t(label)}</dt>
          <dd className="tabular font-medium whitespace-nowrap">{formatMoney(minor, bl.currency)}</dd>
        </div>
      ))}
    </dl>
  );
}
