import "server-only";
import { isNotNull } from "drizzle-orm";
import type { MailService } from "@/domain/records";
import type { DbOrTx } from "./db/client";
import { serviceStatus } from "./db/schema";

/** A successful connection ends an outage. */
export function markServiceOk(db: DbOrTx, service: MailService, now: Date = new Date()): void {
  const at = now.toISOString();
  db.insert(serviceStatus)
    .values({ service, failingSince: null, lastError: null, lastOkAt: at, updatedAt: at })
    .onConflictDoUpdate({ target: serviceStatus.service, set: { failingSince: null, lastError: null, lastOkAt: at, updatedAt: at } })
    .run();
}

/** The first failure starts the outage; later failures keep its start time. */
export function markServiceFailing(db: DbOrTx, service: MailService, error: string, now: Date = new Date()): void {
  const at = now.toISOString();
  const current = db.select().from(serviceStatus).all().find((row) => row.service === service);
  db.insert(serviceStatus)
    .values({ service, failingSince: at, lastError: error, lastOkAt: null, updatedAt: at })
    .onConflictDoUpdate({
      target: serviceStatus.service,
      set: { failingSince: current?.failingSince ?? at, lastError: error, updatedAt: at },
    })
    .run();
}

/** Mail outages for the banner shown on every screen. */
export function mailOutages(db: DbOrTx): { service: MailService; since: string }[] {
  return db
    .select({ service: serviceStatus.service, since: serviceStatus.failingSince })
    .from(serviceStatus)
    .where(isNotNull(serviceStatus.failingSince))
    .all()
    .map((row) => ({ service: row.service, since: row.since! }));
}
