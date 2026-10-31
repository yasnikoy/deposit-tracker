# Deposit Tracker — Runbook

For the person whose PC runs the app and the IT colleague who helps. Every step assumes the
standard layout below. Background and reasons: `docs/ARCHITECTURE.md` → Operations and deployment.

```
C:\DepositTracker\app           program files (the release zip; replaced by updates)
C:\DepositTracker\data          database, uploaded files, logs, backups
C:\DepositTracker\deposit.key   key that encrypts the mail passwords (keep a copy elsewhere!)
C:\DepositTracker\deposit.env   settings written by setup.cmd (port, folders, email mode)
```

The app runs as the scheduled task **DepositTracker**, under your Windows account, from Windows
startup, without anyone logging in. People open it at `http://<PC's IP address>:<port>`
(e.g. `http://192.168.1.20:3000`); office PCs all share the name "UserPC", so the name does not work.

## Contents

1. [First setup](#1-first-setup)
2. [Configure mail](#2-configure-mail)
3. [Add users](#3-add-users)
4. [Add an agency form template](#4-add-an-agency-form-template)
5. [Start, stop, check](#5-start-stop-check)
6. [Update and roll back](#6-update-and-roll-back)
7. [Back up](#7-back-up)
8. [Restore from a backup](#8-restore-from-a-backup)
9. [Back up and restore the key file](#9-back-up-and-restore-the-key-file)
10. [Move to another PC](#10-move-to-another-pc)
11. [When mail is down](#11-when-mail-is-down)
12. [Troubleshooting](#12-troubleshooting)
13. [Publishing a release (developer)](#13-publishing-a-release-developer)

## 1. First setup

Before you start: Windows 10/11 x64, 8 GB RAM, 20 GB free disk; sleep disabled during office
hours; ideally IT has given the PC a fixed IP (DHCP reservation).

1. Download `deposit-tracker-<version>-win-x64.zip` from the release page and unzip its contents
   to `C:\DepositTracker\app` (so that `C:\DepositTracker\app\setup.cmd` exists).
2. Double-click `setup.cmd` and approve the administrator prompt. It asks:
   - **Port** — Enter for 3000 (it checks that the port is free).
   - **Send emails for real?** — No for a test installation (dry-run: emails are stored, never sent).
     Yes only on the office PC once mail is configured.
   - **Create an admin account** — username, display name, password (at least 8 characters by
     default; Ayarlar → Kullanıcı güvenliği sets the minimum).
   - **Start automatically with Windows?** — Yes on the office PC (the app starts at boot, before
     anyone logs in). No: the app runs only after `start.cmd`, until the next restart.
   - **Windows account and password** for the task — Enter to accept your own account.
     The password goes to Windows Task Scheduler only. An account without a password: leave it
     empty; the task is then registered without a stored password and cannot reach network
     shares, so the second backup location must be a local folder or an external disk.
     Change it later? Run `setup.cmd` again.
3. Setup opens the port in Windows Firewall (domain and private networks only), registers the
   task, starts the app and prints the addresses. Open one in Chrome or Edge and log in.
4. In the app (Yönetim menu): Ayarlar → E-posta sunucusu (section 2), Kullanıcılar (section 3), Acenteler
   (with B/L number patterns and form templates), Listeler (bank accounts), Tatiller, standing
   documents, and **Ayarlar → Yedekleme → İkinci yedek konumu** (section 7).
5. Copy `C:\DepositTracker\deposit.key` to a safe place (section 9).

`setup.cmd` can be run again at any time to change the port, the email mode, automatic start or the account; it
keeps the data.

## 2. Configure mail

Ayarlar → E-posta sunucusu: SMTP and IMAP server, port, user and app password (from the mail provider),
the sent-folder name, sender name and address. "Deneme gönder" (Deneme e-postası) checks SMTP. Passwords are
stored encrypted with `deposit.key`.

Emails really go out only when `EMAIL_MODE=live` in `deposit.env` (chosen in setup). The grey
banner "Deneme modu: e-postalar kaydedilir ama gönderilmez" at the top means dry-run. To switch: run `setup.cmd` again and answer Yes.

## 3. Add users

Yönetim → Kullanıcılar → Yeni kullanıcı: username, name, roles (Muhasebe, Operasyon, Yönetici;
several allowed) and a temporary password; the user sets their own at first login. Users are
deactivated, never deleted. Locked out after failed logins: "Kilidi aç" on the same page.

No admin can log in any more: run `create-admin.cmd` in `C:\DepositTracker\app` to create a new
admin from the command line.

## 4. Add an agency form template

Acenteler → the agency → **Form şablonu (Word)**: upload the agency's blank refund form as `.docx`
with fields written as `{alan_adı}`; the card lists the fields that can be used ("Kullanılabilecek
alanlar") and rejects unknown ones. Only admins can change templates. Operations then downloads
the prefilled form from each B/L.

## 5. Start, stop, check

In `C:\DepositTracker\app` (each asks for administrator approval):

| Command | Does |
| --- | --- |
| `start.cmd` | starts the app (task) and waits until it answers |
| `stop.cmd` | stops it; it stays stopped until `start.cmd` or, with automatic start, the next Windows start |
| `backup.cmd` | takes a backup now (works while the app runs) |
| `create-admin.cmd` | creates an admin from the command line |
| `setup.cmd` | changes port, email mode, automatic start, account |

Health: Yönetim → **Sistem durumu** shows the version, the address to share, backups (red when
older than yesterday or the second location is unreachable), mail servers and failed jobs. From
another PC: `http://<IP>:<port>/api/health` answers `{"ok":true,"version":"…"}`.

## 6. Update and roll back

**Normal updates (same major version, e.g. 1.2 → 1.3):** an admin sees "Yeni sürüm … hazır" at
the top. Sistem durumu → Güncelleme → read the notes → **Güncelle**. The app downloads the
package, checks its signature, restarts and installs it; nobody can work for a few minutes. The
database is backed up automatically before it changes.

If the new version does not start within three minutes, the app switches back to the previous
version by itself, and undoes the database change from that backup. `data\logs\updates.log`
says what happened; send it with `data\logs\console*.log` to the developer.

**Manual update (new major version, e.g. 1.x → 2.0, or without internet on the PC):**

1. Download the zip (and read the release notes: a major version lists extra steps).
2. `stop.cmd`.
3. Rename `C:\DepositTracker\app` to `app-previous` (delete an older `app-previous` first).
4. Unzip the new zip to `C:\DepositTracker\app`.
5. `start.cmd`. Migrations run on start, after an automatic backup.

**Manual roll back:** `stop.cmd`, rename `app` to `app-failed`, rename `app-previous` to `app`,
and if the failed version changed the database, restore the newest
`data\backups\pre-migration-*.sqlite` as in section 8. `start.cmd`.

## 7. Back up

Automatic, daily at Ayarlar → Yedekleme → **Günlük yedek saati** (default 12:30), and at the next start
if the PC was off then:

- `data\backups\daily\deposit-YYYY-MM-DD.sqlite` — the database;
- `data\backups\files\` — uploaded files (only new ones are copied);
- the same under `<second location>\deposit-tracker-backups\` when **İkinci yedek konumu** is set.

Set the second location (a network share like `\\server\share\depozito`, or a USB disk that stays
connected) right after setup; the app's Windows account must be able to write there. Kept: the
14 newest daily copies plus one per week for 8 weeks (Ayarlar → Yedekleme). Also kept apart:
`pre-migration-*.sqlite` (before each update) and `before-…` copies.

Take one by hand: `backup.cmd`, or Sistem durumu → **Şimdi yedekle**.

**Monthly:** restore the newest backup on another PC or folder and open it (section 8, steps with a
copy) to make sure backups really work.

The key file is never in a backup: keep its copy separately (section 9).

## 8. Restore from a backup

1. `stop.cmd`.
2. Move the current files aside (never delete them):
   `data\deposit.sqlite` → e.g. `data\deposit.sqlite.before-restore`, and delete
   `data\deposit.sqlite-wal` and `data\deposit.sqlite-shm` if they exist.
3. Copy the chosen `backups\daily\deposit-YYYY-MM-DD.sqlite` to `data\deposit.sqlite`.
4. If uploaded files are missing too, copy `backups\files\*` into `data\files\` (skip existing).
5. `start.cmd`, log in, check the newest records.

Everything entered after that backup's time is gone; enter it again from the papers.

## 9. Back up and restore the key file

`C:\DepositTracker\deposit.key` encrypts the stored mail passwords. Without it the app still
works, but the mail passwords must be entered again (Ayarlar → E-posta sunucusu).

- **Back up:** copy it once to a USB stick kept in a drawer, or into a password manager (open it
  in Notepad, copy the single line). Never put it next to the backups or in email.
- **Restore:** `stop.cmd`, put the file back as `C:\DepositTracker\deposit.key`, `start.cmd`.
- **Lost:** `stop.cmd`, delete the broken key if any, `start.cmd` (a new key is created), then enter
  the SMTP/IMAP passwords again.

## 10. Move to another PC

1. Old PC: `backup.cmd`, then `stop.cmd`. In Task Scheduler, disable the task **DepositTracker**
   (so two copies never run).
2. Copy the whole `C:\DepositTracker` folder (app, data, deposit.key, deposit.env) to the new PC,
   same path.
3. New PC: `setup.cmd` (answer No to "create admin"; accept the rest). It registers the task and
   firewall rule there and starts the app.
4. Tell everyone the new address (shown by setup). Ask IT for a fixed IP for the new PC.
5. After a week without problems, delete the folder and the task on the old PC.

## 11. When mail is down

A red banner says the mail server (SMTP or IMAP) is unreachable. Nothing is lost:

- requests stay queued and are retried (3 attempts with growing pauses); a request that still
  fails shows on Talepler → **Gönderilemeyen** and on the dashboard, to send again;
- replies are read again from the mailbox once it is back (the app never moves or marks mail).

Check: internet on the PC, the mail password (changed? enter the new app password in
Ayarlar → E-posta sunucusu), the provider's status. Sistem durumu shows when it started failing.

## 12. Troubleshooting

| Symptom | Check |
| --- | --- |
| Page does not open from other PCs | Open `http://localhost:<port>` on the app PC. Works there: firewall (run `setup.cmd` again) or wrong IP (Sistem durumu shows it). Not there: `start.cmd` |
| `start.cmd`: "did not answer" | `data\logs\console-error.log` and `console.log`; the app's own logs in `data\logs\app.*.log` |
| App does not start after a Windows password change | `setup.cmd` again, give the new password |
| "Another instance is already running" | `stop.cmd`, then `start.cmd` |
| Backups red on Sistem durumu | PC off at backup time (fine; caught up at next start), or the second location unreachable (share offline, USB disk unplugged, no write permission) |
| Disk filling up | Sistem durumu → free disk; old backups are pruned automatically; ask IT for space |

Send the developer: `data\logs\` (all files of the last days) and a screenshot of Sistem durumu.
Never send `deposit.key` or `deposit.sqlite`.

## 13. Publishing a release (developer)

On the development machine, from a clean `main`:

1. Raise the version (`package.json`) and add the change-log entry with `vX.Y.Z` in its title in
   `docs/ARCHITECTURE.md`; commit and tag `vX.Y.Z`.
2. `pnpm build:portable` → `dist/deposit-tracker-X.Y.Z-win-x64.zip`.
3. `pnpm release` — signs it (key: `~/.config/deposit-tracker/release-private-key.pem`) and shows
   what would be published.
4. `git push origin main` and `pnpm release --publish` — creates the GitHub release with the zip,
   `.sig` and `.sha256`. Installed apps see it within a day (or at Sistem durumu → Şimdi kontrol et).

The release key: back it up in the password manager. Lost → a new key pair means a manual update
(section 6) to a build with the new public key. Leaked → same, at once.
