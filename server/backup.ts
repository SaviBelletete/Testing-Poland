import mysql from "mysql2/promise";
import { storagePut } from "./storage";
import { ENV } from "./_core/env";
import fs from "fs";
import path from "path";
import { uploadToGoogleDrive } from "./gdrive";

interface BackupResult {
  success: boolean;
  filename: string;
  url?: string;
  googleDriveUrl?: string;
  size?: number;
  error?: string;
}

/**
 * Generate a complete database backup as SQL dump.
 * Returns the backup content as a string.
 */
export async function generateBackupSQL(): Promise<string> {
  const connection = await mysql.createConnection(ENV.databaseUrl);

  const timestamp = new Date().toISOString();
  let backup = `-- Payment File Processor Database Backup\n`;
  backup += `-- Generated: ${timestamp}\n`;
  backup += `-- WARNING: This file contains sensitive data. Store securely.\n\n`;

  try {
    // Get all table names
    const [tables] = await connection.execute("SHOW TABLES");
    const tableNames = (tables as any[]).map((row: any) => Object.values(row)[0] as string);

    for (const tableName of tableNames) {
      try {
        // Get table structure
        const [createTableResult] = await connection.execute(`SHOW CREATE TABLE \`${tableName}\``);
        const createTableSQL = (createTableResult as any)[0]["Create Table"];

        backup += `\n-- ============================================\n`;
        backup += `-- Table: ${tableName}\n`;
        backup += `-- ============================================\n`;
        backup += `DROP TABLE IF EXISTS \`${tableName}\`;\n`;
        backup += createTableSQL + ";\n\n";

        // Get table data
        const [rows] = await connection.execute(`SELECT * FROM \`${tableName}\``);
        const dataRows = rows as any[];

        if (dataRows.length > 0) {
          backup += `-- Data for ${tableName} (${dataRows.length} rows)\n`;

          for (const row of dataRows) {
            const columns = Object.keys(row)
              .map((k) => `\`${k}\``)
              .join(", ");
            const values = Object.values(row)
              .map((v) => {
                if (v === null) return "NULL";
                if (typeof v === "number") return String(v);
                if (v instanceof Date)
                  return `'${v.toISOString().slice(0, 19).replace("T", " ")}'`;
                return `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
              })
              .join(", ");

            backup += `INSERT INTO \`${tableName}\` (${columns}) VALUES (${values});\n`;
          }
          backup += "\n";
        }
      } catch (error) {
        backup += `-- ERROR backing up table ${tableName}: ${error}\n\n`;
        console.error(`Error backing up table ${tableName}:`, error);
      }
    }

    backup += `\n-- Backup completed: ${new Date().toISOString()}\n`;
  } finally {
    await connection.end();
  }

  return backup;
}

/**
 * Create a database backup and upload it to S3 + Google Drive.
 * Returns the backup URL and metadata.
 */
export async function createAndUploadBackup(): Promise<BackupResult> {
  let tempFilePath: string | null = null;

  try {
    // Generate backup SQL
    const backupSQL = await generateBackupSQL();

    // Create filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
    const filename = `database-backup-${timestamp}.sql`;
    const buffer = Buffer.from(backupSQL, "utf-8");

    // Try to upload to S3 (non-fatal if it fails)
    let s3Url: string | undefined;
    let s3Error: string | undefined;
    try {
      const s3Key = `backups/${filename}`;
      const uploadResult = await storagePut(s3Key, buffer, "application/sql");
      s3Url = uploadResult.url;
      console.log("[Backup] Uploaded to S3:", s3Url);
    } catch (s3Err) {
      s3Error = s3Err instanceof Error ? s3Err.message : "Unknown S3 error";
      console.error("[Backup] S3 upload failed (continuing with Google Drive):", s3Error);
    }

    // Save to persistent local backup directory
    const backupDir = "/home/ubuntu/database-backups";
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const persistentFilePath = path.join(backupDir, filename);
    fs.writeFileSync(persistentFilePath, backupSQL, "utf-8");
    console.log("[Backup] Saved locally to:", persistentFilePath);

    // Also save to /tmp for Google Drive upload
    tempFilePath = path.join("/tmp", filename);
    fs.writeFileSync(tempFilePath, backupSQL, "utf-8");

    // Upload to Google Drive
    let googleDriveUrl: string | undefined;
    try {
      googleDriveUrl = await uploadToGoogleDrive(tempFilePath, "application/sql");
      console.log("[Backup] Uploaded to Google Drive:", googleDriveUrl);
    } catch (gdriveError) {
      const gdriveErrorMsg =
        gdriveError instanceof Error ? gdriveError.message : "Unknown Google Drive error";
      console.error("[Backup] Google Drive upload failed:", gdriveErrorMsg);

      if (!s3Url) {
        return {
          success: false,
          filename,
          error: `Both S3 and Google Drive uploads failed. S3: ${s3Error}. Google Drive: ${gdriveErrorMsg}`,
        };
      }
    }

    if (s3Url || googleDriveUrl) {
      return {
        success: true,
        filename,
        url: s3Url || googleDriveUrl,
        googleDriveUrl,
        size: buffer.length,
      };
    } else {
      return {
        success: false,
        filename,
        error: "Both S3 and Google Drive uploads failed",
      };
    }
  } catch (error) {
    console.error("Backup failed:", error);
    return {
      success: false,
      filename: "",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
  }
}
