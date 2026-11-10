import { expect, it } from "vitest";
import { takeGettingStarted } from "@/server/preferences";
import { createTestDb, makeUser } from "../support/db";

it("opens the getting-started guide once per user", async () => {
  const db = createTestDb();
  const ops = await makeUser(db, "ops", ["OPERATIONS"]);
  const acc = await makeUser(db, "acc", ["ACCOUNTANT"]);
  expect(takeGettingStarted(db, ops)).toBe(true);
  expect(takeGettingStarted(db, ops)).toBe(false);
  expect(takeGettingStarted(db, acc)).toBe(true);
});
