# Backups and recovery

ELESEND keeps three kinds of copy, all encrypted and stored with a different provider from the server:

| Copy | How often | Lets you |
|---|---|---|
| Change files (WAL), `wal-ship.sh` | every minute, at most 5 minutes behind | restore to any moment |
| Base backup, `base-backup.sh` | nightly | the starting point for that restore |
| Logical dump, `backup-offsite.sh` | daily | inspect or load data into any database |

A weekly drill (`verify-backup.sh`) restores the newest dump into a scratch database and checks the money ledgers balance. The same full chain is tested in CI on every change to these files (`.github/workflows/resilience-drill.yml`).

## Set up (once per server)

1. Create an rclone remote at a different provider (for example Backblaze B2 or Wasabi) and a long random passphrase in `/etc/elesend/backup.passphrase` (`chmod 600`). **Keep a copy of the passphrase away from the server.** Without it, no backup can be opened.
2. Create one check per job at a monitoring service such as healthchecks.io: WAL every 1 minute (grace 10 min), base backup daily, dump daily, drill weekly, storage every 5 minutes. Each check alerts you when a ping is late, so a backup that silently stops is noticed the same day.
3. Copy `deploy/runtime/backup.env.example` to `/etc/elesend/backup.env`, fill it in, and enable the timers as the file describes.
4. Run `base-backup.sh` once by hand, then `systemctl list-timers 'elesend-*'` to see everything scheduled.

## If the database is lost or damaged

```bash
ELESEND_ALLOW_DATABASE_RESTORE=YES bash deploy/runtime/restore-point-in-time.sh
```

This uses the newest base backup and every change file after it. To undo a mistake, add `RESTORE_TARGET_TIME="2027-02-10 14:05:00+00"` (a moment just before it). The damaged database is kept, renamed, on the database volume. Check the data, start the app, then run `base-backup.sh`.

`rollback.sh --restore-database` only goes back to the last deploy. It now says how much would be erased, and refuses anything older than a day unless you confirm.

## What is not covered

- A second database server kept in step (a streaming replica) would cut recovery from minutes to seconds and survive the server's disk failing mid-day without even the 5-minute gap. Worth adding once order volume justifies a second server.
- Riders' and customers' devices cache recent jobs, but actions taken during an outage must be retried by them.
