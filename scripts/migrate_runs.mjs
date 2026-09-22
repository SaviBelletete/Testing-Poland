import "dotenv/config";
import mysql from "mysql2/promise";

const sql = `CREATE TABLE IF NOT EXISTS \`processing_runs\` (
  \`id\` int AUTO_INCREMENT NOT NULL,
  \`campaignId\` int,
  \`campaignName\` varchar(255) NOT NULL,
  \`clientName\` varchar(128) NOT NULL,
  \`processedAt\` timestamp NOT NULL DEFAULT (now()),
  \`weeklyFilename\` varchar(255) NOT NULL,
  \`masterFilename\` varchar(255) NOT NULL,
  \`rowsProcessed\` int NOT NULL DEFAULT 0,
  \`rowsAdded\` int NOT NULL DEFAULT 0,
  \`rowsSkipped\` int NOT NULL DEFAULT 0,
  \`rowCountPass\` int NOT NULL DEFAULT 0,
  \`amountExpected\` varchar(64) NOT NULL DEFAULT '',
  \`amountActual\` varchar(64) NOT NULL DEFAULT '',
  \`amountPass\` int NOT NULL DEFAULT 0,
  \`downloadKey\` varchar(512) NOT NULL DEFAULT '',
  \`sheetName\` varchar(128) NOT NULL DEFAULT '',
  CONSTRAINT \`processing_runs_id\` PRIMARY KEY(\`id\`)
)`;

const conn = await mysql.createConnection(process.env.DATABASE_URL);
try {
  await conn.execute(sql);
  console.log("✅ processing_runs table created (or already exists)");
} finally {
  await conn.end();
}
