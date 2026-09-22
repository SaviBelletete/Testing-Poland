/**
 * One-time migration: add paymentFiles column to processing_runs table.
 * Run with: node scripts/migrate-payment-files.mjs
 */
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const conn = await mysql.createConnection(url);

try {
  // Check if column already exists
  const [rows] = await conn.execute(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'processing_runs' AND COLUMN_NAME = 'paymentFiles'"
  );
  if (rows.length > 0) {
    console.log("Column paymentFiles already exists — nothing to do.");
  } else {
    await conn.execute("ALTER TABLE `processing_runs` ADD `paymentFiles` text");
    console.log("Successfully added paymentFiles column to processing_runs.");
  }
} finally {
  await conn.end();
}
