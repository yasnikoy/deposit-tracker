import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@/server/db/client";
import { countPendingMigrations, migrateWithBackup } from "@/server/db/migrate";
import { MIGRATIONS } from "../../support/db";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "deposit-migrate-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Copy of the real migrations plus one extra migration, to simulate an app update. */
function migrationsWithExtraStep(): string {
  const folder = path.join(dir, "migrations");
  fs.cpSync(MIGRATIONS, folder, { recursive: true });
  const journalFile = path.join(folder, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalFile, "utf8"));
  const last = journal.entries.at(-1);
  journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1, tag: "9999_test_extra" });
  fs.writeFileSync(journalFile, JSON.stringify(journal));
  fs.writeFileSync(path.join(folder, "9999_test_extra.sql"), "CREATE TABLE test_extra (id integer);");
  return folder;
}

describe("migrateWithBackup", () => {
  it("migrates a fresh database without a backup", async () => {
    const db = openDatabase(path.join(dir, "fresh.sqlite"));
    const result = await migrateWithBackup(db, { backupDir: path.join(dir, "backups"), migrationsFolder: MIGRATIONS });
    expect(result.applied).toBeGreaterThan(0);
    expect(result.backupFile).toBeNull();
    expect(countPendingMigrations(db, MIGRATIONS)).toBe(0);
  });

  it("backs up an existing database before applying pending migrations", async () => {
    const db = openDatabase(path.join(dir, "app.sqlite"));
    await migrateWithBackup(db, { backupDir: path.join(dir, "backups"), migrationsFolder: MIGRATIONS });

    const updated = migrationsWithExtraStep();
    const result = await migrateWithBackup(db, { backupDir: path.join(dir, "backups"), migrationsFolder: updated });
    expect(result.applied).toBe(1);
    expect(result.backupFile).not.toBeNull();

    const backup = openDatabase(result.backupFile!);
    const tables = (sql: string) => backup.$client.prepare(sql).all();
    expect(tables("SELECT name FROM sqlite_master WHERE name = 'users'")).toHaveLength(1);
    expect(tables("SELECT name FROM sqlite_master WHERE name = 'test_extra'")).toHaveLength(0);
  });

  it("rebuilds tables that other rows reference without breaking or losing data", async () => {
    // Bring a database to the schema before 0003 (which rebuilds deposit_payments) and fill it.
    const before = path.join(dir, "before-0003");
    fs.cpSync(MIGRATIONS, before, { recursive: true });
    const journalFile = path.join(before, "meta", "_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalFile, "utf8"));
    journal.entries = journal.entries.filter((e: { tag: string }) => e.tag < "0003");
    fs.writeFileSync(journalFile, JSON.stringify(journal));

    const db = openDatabase(path.join(dir, "app.sqlite"));
    await migrateWithBackup(db, { backupDir: path.join(dir, "backups"), migrationsFolder: before });
    db.$client.exec(`
      INSERT INTO users(id,username,display_name,password_hash,created_at,updated_at) VALUES (1,'uu','U','x','t','t');
      INSERT INTO currencies(code,name) VALUES ('USD','Dolar');
      INSERT INTO agencies(id,name,created_at,updated_at) VALUES (1,'A','t','t');
      INSERT INTO bank_accounts(id,name,bank_name,iban,currency,created_at,updated_at) VALUES (1,'b','b','TR1','USD','t','t');
      INSERT INTO documents(id,kind,original_name,stored_path,mime_type,size_bytes,sha256,uploaded_by,uploaded_at,owner_type,owner_id)
        VALUES (1,'RECEIPT','a','p','m',1,'h',1,'t','deposit_payment',1);
      INSERT INTO deposit_payments(id,agency_id,amount_minor,currency,paid_at,kind,bank_account_id,evidence_document_id,created_by,created_at,updated_at)
        VALUES (1,1,100,'USD','2026-10-01','BANK',1,1,1,'t','t');
      INSERT INTO bills_of_lading(id,bl_no,deposit_payment_id,agency_id,currency,deposit_amount_minor,paid_at,status,created_by,created_at,updated_at)
        VALUES (1,'B1',1,1,'USD',100,'2026-10-01','PAID',1,'t','t');
      INSERT INTO ledger_entries(bl_id,type,amount_minor,currency,entry_date,deposit_payment_id,created_by,created_at)
        VALUES (1,'PAYMENT',100,'USD','2026-10-01',1,1,'t');`);

    const result = await migrateWithBackup(db, { backupDir: path.join(dir, "backups"), migrationsFolder: MIGRATIONS });
    expect(result.applied).toBeGreaterThan(0);
    expect(db.$client.prepare("SELECT id, amount_minor FROM deposit_payments").all()).toEqual([{ id: 1, amount_minor: 100 }]);
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
    // Constraints of the rebuilt table still hold.
    expect(() => db.$client.exec("UPDATE deposit_payments SET amount_minor = 0")).toThrow(/CHECK/);
    // 0005 rebuilds bills_of_lading with override columns; existing B/Ls keep their data and inherit.
    expect(db.$client.prepare("SELECT bl_no, status, follow_up_days FROM bills_of_lading").all()).toEqual([
      { bl_no: "B1", status: "PAID", follow_up_days: null },
    ]);
    expect(() => db.$client.exec("UPDATE bills_of_lading SET follow_up_days = 0")).toThrow(/CHECK/);
    expect(() =>
      db.$client.exec(`INSERT INTO bills_of_lading(bl_no,agency_id,currency,deposit_amount_minor,paid_at,status,created_by,created_at,updated_at)
        VALUES ('b1',1,'USD',100,'2026-10-01','PAID',1,'t','t')`),
    ).toThrow(/UNIQUE/);
  });

  it("does nothing when no migration is pending", async () => {
    const db = openDatabase(path.join(dir, "app.sqlite"));
    await migrateWithBackup(db, { backupDir: path.join(dir, "backups"), migrationsFolder: MIGRATIONS });
    expect(await migrateWithBackup(db, { backupDir: path.join(dir, "backups"), migrationsFolder: MIGRATIONS })).toEqual({
      applied: 0,
      backupFile: null,
    });
  });

  it("moves the notes still in effect into the B/L description, oldest first, then drops them", async () => {
    const before = path.join(dir, "before-0022");
    fs.cpSync(MIGRATIONS, before, { recursive: true });
    const journalFile = path.join(before, "meta", "_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalFile, "utf8"));
    journal.entries = journal.entries.filter((e: { tag: string }) => e.tag < "0022");
    fs.writeFileSync(journalFile, JSON.stringify(journal));

    const db = openDatabase(path.join(dir, "app.sqlite"));
    await migrateWithBackup(db, { backupDir: path.join(dir, "backups"), migrationsFolder: before });
    db.$client.exec(`
      INSERT INTO users(id,username,display_name,password_hash,created_at,updated_at) VALUES (1,'ayse','Ayşe','x','t','t'), (2,'ali','Ali','x','t','t');
      INSERT INTO currencies(code,name) VALUES ('USD','Dolar');
      INSERT INTO agencies(id,name,created_at,updated_at) VALUES (1,'A','t','t');
      INSERT INTO bills_of_lading(id,bl_no,agency_id,currency,deposit_amount_minor,paid_at,status,created_by,created_at,updated_at)
        VALUES (1,'B1',1,'USD',100,'2026-10-01','PAID',1,'t','t'), (2,'B2',1,'USD',100,'2026-10-01','PAID',1,'t','t');
      INSERT INTO notes(bl_id,author_id,body,created_at) VALUES (1,2,'Acente arandı, @ayse','2026-10-20T22:30:00.000Z');
      INSERT INTO notes(bl_id,author_id,body,created_at) VALUES (1,1,'Portal kontrol edildi','2026-10-02T08:00:00.000Z');
      INSERT INTO notes(bl_id,author_id,body,created_at,undone_at,undone_by) VALUES (1,1,'Yanlış not','2026-10-03T08:00:00.000Z','2026-10-03T08:01:00.000Z',1);`);

    await migrateWithBackup(db, { backupDir: path.join(dir, "backups"), migrationsFolder: MIGRATIONS });
    // Istanbul dates: 22:30 UTC on 20 Oct is already 21 Oct there; the undone note is left out.
    expect(db.$client.prepare("SELECT id, description FROM bills_of_lading ORDER BY id").all()).toEqual([
      { id: 1, description: "02.10.2026 Ayşe: Portal kontrol edildi\n21.10.2026 Ali: Acente arandı, @ayse" },
      { id: 2, description: null },
    ]);
    expect(db.$client.prepare("SELECT name FROM sqlite_master WHERE name = 'notes'").all()).toHaveLength(0);
  });
});
