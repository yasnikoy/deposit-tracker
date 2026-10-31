import { Forbidden } from "@/components/forbidden";
import { t } from "@/i18n";
import { can } from "@/server/auth/can";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { getTableLayout } from "@/server/preferences";
import { formatBusinessDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { listRefundsToAllocate, listRefundsWithRemainder } from "@/server/refunds";
import { RefundsToAllocate } from "./refunds-to-allocate";

export default async function AllocationsPage() {
  const { user } = await requireSession();
  if (!can(user, "allocation.view").allowed) return <Forbidden />;
  const db = getDb();
  return (
    <>
      <h1 className="text-lg font-semibold">{t("allocations.title")}</h1>
      <p className="text-muted-foreground text-sm">{t("allocations.hint")}</p>
      <RefundsToAllocate refunds={listRefundsToAllocate(db, user)} layout={getTableLayout(db, user.id, "refunds-to-allocate")} />
      <RemainderList db={db} user={user} />
    </>
  );
}

/** Refunds whose rest was left unallocated on purpose (e.g. an overpayment), with the reason given. */
function RemainderList({ db, user }: { db: ReturnType<typeof getDb>; user: Parameters<typeof listRefundsWithRemainder>[1] }) {
  const refunds = listRefundsWithRemainder(db, user);
  if (refunds.length === 0) return null;
  return (
    <section id="remainder" className="flex flex-col gap-2">
      <h2 className="font-semibold">{t("allocations.remainder.title")}</h2>
      <p className="text-muted-foreground text-sm">{t("allocations.remainder.hint")}</p>
      <ul className="flex flex-col gap-1 text-sm">
        {refunds.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2">
            <span className="tabular font-medium">{formatMoney(r.remainderMinor, r.currency)}</span>
            <span>
              {t("allocations.remainder.of", { id: r.id, agency: r.agencyName, amount: formatMoney(r.amountMinor, r.currency), date: formatBusinessDate(r.valueDate) })}
            </span>
            {r.unallocatedReason && <span className="text-muted-foreground text-xs italic">{r.unallocatedReason}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
