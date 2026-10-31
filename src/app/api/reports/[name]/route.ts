import type { NextRequest } from "next/server";
import { istanbulToday } from "@/domain/business-days";
import { exportFileName, toCsv, type Grid } from "@/lib/csv";
import type { AuthUser } from "@/server/auth/types";
import { getCurrentSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { ForbiddenError } from "@/server/errors";
import { agingGrid, scorecardGrid } from "@/server/report-exports";
import { agencyScorecardFor, agingReportFor } from "@/server/reports";

const REPORTS: Record<string, (user: AuthUser) => Grid> = {
  aging: (user) => agingGrid(agingReportFor(getDb(), user)),
  scorecard: (user) => scorecardGrid(agencyScorecardFor(getDb(), user)),
};

/** A report as shown on the Reports screen, as a CSV download. */
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/reports/[name]">) {
  const session = await getCurrentSession();
  if (!session || session.user.mustChangePassword) return new Response(null, { status: 401 });
  const name = (await ctx.params).name;
  const report = Object.hasOwn(REPORTS, name) ? REPORTS[name] : undefined;
  if (!report) return new Response(null, { status: 404 });

  try {
    return new Response(toCsv(report(session.user)), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFileName(name, istanbulToday())}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof ForbiddenError) return new Response(null, { status: 403 });
    throw error;
  }
}
