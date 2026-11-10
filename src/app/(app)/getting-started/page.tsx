import Link from "next/link";
import type { Role } from "@/domain/roles";
import { t, type TranslationKey } from "@/i18n";
import { requireSession } from "@/server/auth/current-user";

type Step = { key: string; href: string };

/** The core workflow of each role, in the order the work happens; not every function. */
const STEPS: Record<Role, Step[]> = {
  ACCOUNTANT: [
    { key: "payment", href: "/accounting?tab=payments" },
    { key: "refund", href: "/accounting?tab=refunds" },
    { key: "entries", href: "/accounting?tab=entries" },
    { key: "follow", href: "/bls" },
  ],
  OPERATIONS: [
    { key: "createBls", href: "/bls/new" },
    { key: "form", href: "/bls" },
    { key: "send", href: "/requests" },
    { key: "reply", href: "/bls" },
    { key: "allocate", href: "/allocations" },
  ],
  ADMIN: [
    { key: "mail", href: "/admin/settings" },
    { key: "users", href: "/admin/users" },
    { key: "agencies", href: "/agencies" },
    { key: "customers", href: "/customers" },
    { key: "system", href: "/admin/system" },
  ],
};

export default async function GettingStartedPage() {
  const { user } = await requireSession();
  return (
    <>
      <h1 className="text-lg font-semibold">{t("gettingStarted.title")}</h1>
      <p className="text-muted-foreground text-sm">{t("gettingStarted.hint")}</p>
      <div className="grid max-w-5xl gap-4 xl:grid-cols-2">
        {user.roles.map((role) => (
          <section key={role} className="flex flex-col gap-2 rounded-md border p-4">
            <h2 className="font-semibold">{t(`roles.${role}`)}</h2>
            <ol className="flex flex-col gap-3">
              {STEPS[role].map((step, i) => (
                <li key={step.key} className="flex gap-3">
                  <span className="text-muted-foreground tabular w-5 shrink-0 text-right">{i + 1}.</span>
                  <span className="flex flex-col gap-0.5">
                    <Link href={step.href} className="font-medium hover:underline">
                      {t(`gettingStarted.steps.${role}.${step.key}.title` as TranslationKey)}
                    </Link>
                    <span className="text-muted-foreground text-sm">{t(`gettingStarted.steps.${role}.${step.key}.text` as TranslationKey)}</span>
                  </span>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </>
  );
}
