import "dotenv/config";
import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

const [result] = await conn.execute("DELETE FROM campaigns");
console.log(`Deleted ${result.affectedRows} campaign(s).`);

const [result2] = await conn.execute("DELETE FROM processing_runs");
console.log(`Deleted ${result2.affectedRows} processing run(s).`);

await conn.end();
console.log("Done — database is clean.");
