import "dotenv/config";
import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

const [rows] = await conn.execute("SELECT id, name, clientName, originalFilename, uploadedAt FROM campaigns ORDER BY id");
console.log("Campaigns in DB:");
console.table(rows);

await conn.end();
