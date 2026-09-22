# Local testing (no Manus infrastructure required)

This lets someone run the app on their own machine, upload a master + weekly
file through the real UI, and see the processing result — without any
production database, object storage, or login.

It's a development/demo setup only. It is **not** how production should run
— see the migration handoff docs' "Recreate the Runtime Outside Manus"
section for what a real deployment needs (managed database, S3-compatible
storage, auth).

## What makes this possible

- **No login required.** The upload UI (`client/src/pages/Home.tsx`) doesn't
  gate on authentication.
- **Storage falls back automatically.** `server/storage.ts` uses Manus's
  Forge-backed storage only when `BUILT_IN_FORGE_API_URL`/`BUILT_IN_FORGE_API_KEY`
  are set. Otherwise it uses `server/storageLocal.ts`, which writes files to
  a local `.local-storage/` directory and serves them back over HTTP.
- **Database is a normal local MySQL/MariaDB.** The app just needs
  `DATABASE_URL` pointing at *some* MySQL-compatible database with the
  Drizzle schema applied — it doesn't need to be Manus's managed one.

## Setup

Requires Node.js 22, pnpm, and a Debian/Ubuntu-family machine (for the
`apt-get install mariadb-server` step — adapt that one line if you're on a
different OS and already have a MySQL-compatible database running).

```bash
./scripts/local-dev-setup.sh
pnpm dev
```

Then open **http://localhost:3000/** and upload a master file + a weekly
file through the UI (or use one of the two upload panels — "Upload New
Campaign" for a master-only upload, or the process panel for a
master+weekly pair). Processing results, the reconciliation report, and
generated payment files (Wise UK/International, PayPal) all work exactly as
they would in production; only *where* files and campaign records are
stored is different.

## If your tester has their own Claude Code

Point their session at this branch and ask it to run
`./scripts/local-dev-setup.sh`, then `pnpm dev`, then open the app and try
an upload — it can do the whole thing (including generating a sample
master/weekly file pair if they don't have real ones handy) without you
needing to walk them through each command by hand.

## Cleanup

The script creates a local MariaDB database (`payment_processor`) and a
`.env` file (gitignored, not a real secret — just a local dev DB
connection string). To reset to a clean state:

```bash
mysql -u root -e "DROP DATABASE IF EXISTS payment_processor;"
rm -rf .local-storage .env
```
