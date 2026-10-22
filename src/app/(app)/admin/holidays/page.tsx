import { Forbidden } from "@/components/forbidden";
import { istanbulToday } from "@/domain/business-days";
import { t } from "@/i18n";
import { can } from "@/server/auth/can";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { listHolidays } from "@/server/holidays";
import { getTableLayout } from "@/server/preferences";
import { getSetting } from "@/server/settings";
import { HolidaysScreen } from "./holidays-screen";

export default async function HolidaysPage() {
  const { user } = await requireSession();
  if (!can(user, "holiday.manage").allowed) return <Forbidden />;
  const db = getDb();

  return (
    <>
      <h1 className="text-lg font-semibold">{t("holidays.title")}</h1>
      <HolidaysScreen
        holidays={listHolidays(db, user)}
        weekendDays={getSetting("calendar.weekendDays", {}, db)}
        halfDaysAreBusinessDays={getSetting("calendar.halfDaysAreBusinessDays", {}, db)}
        today={istanbulToday()}
        layout={getTableLayout(db, user.id, "holidays")}
      />
    </>
  );
}
