import { beforeEach, describe, expect, it } from "vitest";
import type { AuthUser } from "@/server/auth/types";
import type { Db } from "@/server/db/client";
import { auditLog } from "@/server/db/schema";
import { ForbiddenError } from "@/server/errors";
import { listFeedback, setFeedbackClosed, submitFeedback } from "@/server/feedback";
import { listNotifications } from "@/server/notifications";
import { createTestDb, makeUser } from "../support/db";

const NOW = new Date("2026-11-10T09:00:00Z");

let db: Db;
let admin: AuthUser;
let ops: AuthUser;

beforeEach(async () => {
  db = createTestDb();
  admin = await makeUser(db, "admin", ["ADMIN"]);
  ops = await makeUser(db, "ops", ["OPERATIONS"]);
});

describe("feedback", () => {
  it("anyone sends it; admins are notified, list it and close or reopen it", () => {
    const id = submitFeedback(db, ops, { kind: "BUG", body: "Talepler listesinde tarih yanlış görünüyor.", page: "/requests" }, NOW);
    expect(listNotifications(db, admin)).toEqual([expect.objectContaining({ kind: "NEW_FEEDBACK", entityId: id })]);
    expect(listNotifications(db, ops)).toEqual([]);

    expect(listFeedback(db, admin)).toEqual([expect.objectContaining({ id, kind: "BUG", page: "/requests", byName: expect.any(String), closedAt: null })]);
    expect(() => listFeedback(db, ops)).toThrow(ForbiddenError);
    expect(() => setFeedbackClosed(db, ops, { id, closed: true }, NOW)).toThrow(ForbiddenError);

    const later = submitFeedback(db, ops, { kind: "IDEA", body: "Toplu yanıt kaydı için kısayol.", page: null }, new Date("2026-11-11T09:00:00Z"));
    setFeedbackClosed(db, admin, { id: later, closed: true }, NOW);
    // Open ones first.
    expect(listFeedback(db, admin).map((f) => [f.id, f.closedAt !== null])).toEqual([
      [id, false],
      [later, true],
    ]);
    setFeedbackClosed(db, admin, { id: later, closed: false }, NOW);
    expect(listFeedback(db, admin).every((f) => f.closedAt === null)).toBe(true);
    expect(db.select().from(auditLog).all().map((a) => a.action).filter((a) => a.startsWith("feedback."))).toEqual([
      "feedback.submit",
      "feedback.submit",
      "feedback.close",
      "feedback.reopen",
    ]);
  });
});
