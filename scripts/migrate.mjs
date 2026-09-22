import { createConnection } from "mysql2/promise";
import "dotenv/config";

const conn = await createConnection(process.env.DATABASE_URL);

// TiDB-compatible SQL (no parentheses around DEFAULT values)
const sql = `
CREATE TABLE IF NOT EXISTS \`campaigns\` (
  \`id\` int AUTO_INCREMENT NOT NULL,
  \`name\` varchar(255) NOT NULL,
  \`clientName\` varchar(128) NOT NULL,
  \`storageKey\` varchar(512) NOT NULL,
  \`originalFilename\` varchar(255) NOT NULL,
  \`sheetName\` varchar(128) NOT NULL DEFAULT '',
  \`sheetNames\` text NOT NULL,
  \`uploadedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`lastProcessedAt\` timestamp NULL,
  \`lastRowCount\` int DEFAULT 0,
  CONSTRAINT \`campaigns_id\` PRIMARY KEY(\`id\`)
)
`;

try {
  await conn.execute(sql);
  console.log("✓ Migration applied: campaigns table created");
} catch (err) {
  console.error("Migration failed:", err.message);
  process.exit(1);
} finally {
  await conn.end();
}
