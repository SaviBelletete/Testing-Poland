#!/usr/bin/env bash
# Local development / demo setup.
#
# Gets the app runnable on a single machine for manual testing (upload a
# file, see the processing result) without any Manus infrastructure:
#   - A local MariaDB/MySQL database with the Drizzle schema applied.
#   - Local-disk file storage (server/storageLocal.ts), used automatically
#     because BUILT_IN_FORGE_API_URL/KEY are left unset.
#   - No auth is required — client/src/pages/Home.tsx (the upload UI) does
#     not gate on login.
#
# This is a development/demo setup only — see the "Recreate the Runtime
# Outside Manus" section of the migration handoff docs for what a real
# production deployment (managed database, S3-compatible storage, auth)
# needs instead.
#
# Usage:
#   ./scripts/local-dev-setup.sh
#
# Requires: a Debian/Ubuntu host with apt and sudo/root access, Node.js 22,
# and pnpm (both already required to run this project at all).

set -euo pipefail
cd "$(dirname "$0")/.."

DB_NAME="payment_processor"
DB_USER="payment_processor"
DB_PASSWORD="localdevpassword"
APP_PORT="${PORT:-3000}"

# Root doesn't need (and often doesn't have) sudo; everyone else does.
if [ "$(id -u)" -eq 0 ]; then
  RUN_AS_ROOT=""
else
  RUN_AS_ROOT="sudo"
fi

echo "==> Installing MariaDB (skipped if already installed)..."
if ! command -v mariadbd >/dev/null 2>&1 && ! command -v mysqld >/dev/null 2>&1; then
  $RUN_AS_ROOT apt-get update -qq
  $RUN_AS_ROOT env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq mariadb-server
fi

echo "==> Starting MariaDB..."
$RUN_AS_ROOT service mariadb start || true
for i in $(seq 1 10); do
  if mysqladmin ping >/dev/null 2>&1; then break; fi
  sleep 1
done
mysqladmin ping

echo "==> Creating database and user (idempotent)..."
$RUN_AS_ROOT mysql -u root <<SQL
CREATE DATABASE IF NOT EXISTS ${DB_NAME};
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASSWORD}';
GRANT ALL PRIVILEGES ON ${DB_NAME}.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL

echo "==> Applying Drizzle migrations..."
for f in drizzle/*.sql; do
  $RUN_AS_ROOT mysql -u root "${DB_NAME}" < "$f"
done

echo "==> Writing .env (local only — gitignored, not a real secret)..."
cat > .env <<EOF
NODE_ENV=development
PORT=${APP_PORT}
DATABASE_URL=mysql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:3306/${DB_NAME}
JWT_SECRET=local-dev-only-not-a-real-secret
EOF

echo "==> Installing dependencies..."
pnpm install --frozen-lockfile

echo
echo "Setup complete. Start the app with:"
echo "  pnpm dev"
echo "Then open http://localhost:${APP_PORT}/ and upload a master + weekly file."
echo "No login is required."
