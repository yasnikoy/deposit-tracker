"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { addCalendarDays, istanbulToday } from "@/domain/business-days";
import { t } from "@/i18n";
import { formatBusinessDate, formatTimestamp } from "@/lib/format";
import type { SystemHealth } from "@/server/health";
import { runBackupNowAction } from "./actions";

const bytes = (n: number | null) => {
  if (n === null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toLocaleString("tr-TR", { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
};
const when = (iso: string | null) => (iso ? formatTimestamp(iso) : "—");

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[14rem_1fr] gap-2 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span>{children}</span>
    </div>
  );
}

/** Admin health page: app, backups, mail and scheduler at a glance (ARCHITECTURE → Health). */
export function SystemScreen({ health, canBackup }: { health: SystemHealth; canBackup: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const { backups } = health;
  // A daily backup older than yesterday means the PC was off at backup time or the backup fails.
  const yesterday = addCalendarDays(istanbulToday(), -1);
  const localStale = !backups.local || backups.local.date < yesterday;
  const secondProblem = backups.second && (!backups.second.reachable || !backups.second.latest || backups.second.latest.date < (backups.local?.date ?? ""));

  const backupNow = async () => {
    setBusy(true);
    const result = await runBackupNowAction({});
    setBusy(false);
    if (!result.ok) return void toast.error(t(result.error, result.params));
    if (result.data.secondError) toast.warning(t("system.backupSecondFailed", { error: result.data.secondError }));
    else toast.success(t("system.backupDone"));
    router.refresh();
  };

  return (
    <div className="grid max-w-4xl gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("system.app")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Row label={t("system.version")}>{health.version}</Row>
          <Row label={t("system.startedAt")}>{when(health.startedAt)}</Row>
          <Row label={t("system.address")}>
            <span className="font-mono">{health.address}</span>
            {health.otherAddresses.length > 0 && <span className="text-muted-foreground ml-2 text-xs">{health.otherAddresses.join(" · ")}</span>}
          </Row>
          <Row label={t("system.emailMode")}>
            {health.emailMode === "live" ? t("system.emailLive") : <Badge variant="secondary">{t("system.emailDryRun")}</Badge>}
          </Row>
          <Row label={t("system.dataDir")}>
            <span className="font-mono text-xs">{health.dataDir}</span>
          </Row>
          <Row label={t("system.databaseSize")}>{bytes(health.databaseBytes)}</Row>
          <Row label={t("system.diskFree")}>{bytes(health.diskFreeBytes)}</Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t("system.backups")}</CardTitle>
          {canBackup && (
            <Button size="sm" onClick={backupNow} disabled={busy}>
              {busy ? t("system.backupRunning") : t("system.backupNow")}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <Row label={t("system.backupLocal")}>
            {backups.local ? `${formatBusinessDate(backups.local.date)} · ${when(backups.local.at)} · ${bytes(backups.local.sizeBytes)}` : "—"}{" "}
            {localStale && <Badge variant="destructive">{t("system.backupStale")}</Badge>}
          </Row>
          <Row label={t("system.backupSecond")}>
            {!backups.second ? (
              <span className="text-muted-foreground">{t("system.backupSecondUnset")}</span>
            ) : (
              <>
                <span className="font-mono text-xs">{backups.second.location}</span>
                <br />
                {!backups.second.reachable
                  ? t("system.backupSecondUnreachable")
                  : backups.second.latest
                    ? `${formatBusinessDate(backups.second.latest.date)} · ${when(backups.second.latest.at)}`
                    : "—"}{" "}
                {secondProblem && <Badge variant="destructive">{t("system.backupSecondProblem")}</Badge>}
              </>
            )}
          </Row>
          <Row label={t("system.backupNext")}>{when(backups.nextRunAt)}</Row>
          {backups.lastFailure && (
            <Row label={t("system.backupLastFailure")}>
              <span className="text-destructive">
                {when(backups.lastFailure.at)} · {backups.lastFailure.error}
              </span>
            </Row>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("system.mail")}</CardTitle>
        </CardHeader>
        <CardContent>
          {health.mail.length === 0 && <Row label={t("system.mailServers")}>—</Row>}
          {health.mail.map((m) => (
            <Row key={m.service} label={m.service}>
              {m.failingSince ? (
                <span className="text-destructive">
                  {t("system.mailFailing", { since: when(m.failingSince) })} · {m.lastError}
                </span>
              ) : (
                t("system.mailOk", { at: when(m.lastOkAt) })
              )}
            </Row>
          ))}
          <Row label={t("system.lastPoll")}>{when(health.lastMailboxPollAt)}</Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("system.jobs")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Row label={t("system.jobsPending")}>{health.jobs.pending}</Row>
          <Row label={t("system.jobsFailed")}>
            {health.jobs.failedRecently.length === 0
              ? t("system.none")
              : health.jobs.failedRecently.map((j, i) => (
                  <div key={i} className="text-destructive">
                    {when(j.at)} · {t(`system.jobKinds.${j.kind}`)} · {j.error}
                  </div>
                ))}
          </Row>
        </CardContent>
      </Card>
    </div>
  );
}

