/**
 * Request-Based Backup Scheduler
 *
 * Database backup: every 4 hours (triggered by HTTP requests).
 * Code backup: once per week on Thursdays (triggered by HTTP requests).
 *
 * This approach survives sandbox hibernation unlike node-cron schedulers.
 *
 * Implementation:
 * - Middleware checks timestamp files on every request
 * - If 4+ hours since last DB backup, triggers DB backup in background
 * - If Thursday and 7+ days since last code backup, triggers code backup in background
 * - Non-blocking: requests complete immediately
 * - Reliable: works even after hibernation/restart
 */

import { createAndUploadBackup } from "./backup";
import { cleanupOldBackups } from "./backup-cleanup";
import { notifyOwner } from "./_core/notification";
import { uploadToGoogleDrive } from "./gdrive";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const DB_BACKUP_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const CODE_BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const THURSDAY = 4; // 0=Sunday, 4=Thursday

// Derive project root at runtime so this works in both the sandbox
// (/home/ubuntu/payment-processor) and the deployed Cloud Run container.
const __filename = fileURLToPath(import.meta.url);
const __dirname_local = path.dirname(__filename);
// server/backup-scheduler.ts → go up one level to reach the project root
const PROJECT_DIR = path.resolve(__dirname_local, "..");

// In production (Cloud Run) /home/ubuntu doesn't exist — use /tmp instead.
// In the sandbox we use a persistent path so timestamps survive hibernation.
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const BACKUP_DIR = IS_PRODUCTION
  ? "/tmp/database-backups"
  : "/home/ubuntu/database-backups";
const TIMESTAMP_FILE = path.join(BACKUP_DIR, "last-backup-timestamp.txt");
const CODE_TIMESTAMP_FILE = path.join(BACKUP_DIR, "last-code-backup-timestamp.txt");

let backupInProgress = false;

function isThursday(): boolean {
  return new Date().getDay() === THURSDAY;
}

/**
 * Run a weekly code backup: tar.gz the project and upload to Google Drive.
 */
async function runCodeBackup() {
  console.log("[Backup Scheduler] Starting code backup...");

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
  const backupName = `code-backup-${timestamp}.tar.gz`;
  const tempPath = path.join("/tmp", backupName);

  try {
    execSync(
      `tar -czf "${tempPath}" \
        --exclude='node_modules' \
        --exclude='.git' \
        --exclude='dist' \
        --exclude='build' \
        --exclude='.next' \
        --exclude='*.log' \
        --exclude='.env' \
        --exclude='.env.local' \
        --exclude='coverage' \
        --exclude='.cache' \
        --exclude='tmp' \
        --exclude='temp' \
        --exclude='.DS_Store' \
        -C "${PROJECT_DIR}" .`,
      { stdio: "pipe" }
    );

    const stats = fs.statSync(tempPath);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    console.log(`[Backup Scheduler] Code archive created: ${sizeMB} MB`);

    const googleDriveUrl = await uploadToGoogleDrive(tempPath, "application/gzip");
    console.log(`[Backup Scheduler] Code backup uploaded to Google Drive: ${googleDriveUrl}`);

    fs.writeFileSync(CODE_TIMESTAMP_FILE, Date.now().toString());
    console.log("[Backup Scheduler] Code backup timestamp updated");

    return { success: true, filename: backupName, size: `${sizeMB} MB`, url: googleDriveUrl };
  } catch (error) {
    console.error("[Backup Scheduler] Code backup error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  } finally {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  }
}

function isCodeBackupDue(): boolean {
  if (!isThursday()) return false;

  let lastCodeBackupTime = 0;
  if (fs.existsSync(CODE_TIMESTAMP_FILE)) {
    const timestamp = fs.readFileSync(CODE_TIMESTAMP_FILE, "utf-8").trim();
    lastCodeBackupTime = parseInt(timestamp, 10);
    if (isNaN(lastCodeBackupTime)) lastCodeBackupTime = 0;
  }

  return Date.now() - lastCodeBackupTime >= CODE_BACKUP_INTERVAL_MS;
}

async function runBackup() {
  console.log("[Backup Scheduler] Starting scheduled backup...");

  try {
    // Weekly code backup on Thursdays
    if (isCodeBackupDue()) {
      console.log("[Backup Scheduler] Thursday detected — running weekly code backup...");
      const codeBackupResult = await runCodeBackup();
      if (!codeBackupResult.success) {
        console.error("[Backup Scheduler] Code backup failed:", codeBackupResult.error);
        await notifyOwner({
          title: "⚠️ Weekly Code Backup Failed",
          content: `The weekly code backup (Thursday) failed.\n\nError: ${codeBackupResult.error}\n\nThe database backup will still proceed.`,
        });
      }
    } else {
      if (isThursday()) {
        console.log("[Backup Scheduler] Thursday but code backup already ran this week — skipping.");
      } else {
        console.log("[Backup Scheduler] Not Thursday — skipping code backup.");
      }
    }

    // Cleanup old backups (30-day retention)
    const cleanupResult = await cleanupOldBackups();
    console.log(
      `[Backup Scheduler] Cleanup: ${cleanupResult.s3Deleted} from S3, ${cleanupResult.googleDriveDeleted} from Google Drive`
    );

    // Database backup (every 4 hours, always)
    const result = await createAndUploadBackup();

    if (result.success) {
      console.log("[Backup Scheduler] Backup created successfully");
      console.log(`[Backup Scheduler] Filename: ${result.filename}`);
      console.log(`[Backup Scheduler] Size: ${((result.size ?? 0) / 1024).toFixed(2)} KB`);

      // Only update timestamp on success
      fs.writeFileSync(TIMESTAMP_FILE, Date.now().toString());
      console.log("[Backup Scheduler] Timestamp updated after successful backup");

      // Only notify owner if there were warnings
      if (cleanupResult.errors.length > 0 || !result.googleDriveUrl) {
        const sizeKB = ((result.size ?? 0) / 1024).toFixed(2);
        let notificationContent = `Automated backup completed with warnings.\n\nFilename: ${result.filename}\nSize: ${sizeKB} KB\n\nS3 URL: ${result.url}`;

        if (result.googleDriveUrl) {
          notificationContent += `\n\nGoogle Drive URL: ${result.googleDriveUrl}`;
        } else {
          notificationContent += `\n\n⚠️ Google Drive upload failed. Backup is only in S3.`;
        }

        if (cleanupResult.errors.length > 0) {
          notificationContent += `\n\n⚠️ Cleanup errors:\n${cleanupResult.errors.join("\n")}`;
        }

        await notifyOwner({
          title: "⚠️ Database Backup - Warnings",
          content: notificationContent,
        });
      } else {
        console.log("[Backup Scheduler] Backup successful, no notification sent (errors-only mode)");
      }
    } else {
      console.error("[Backup Scheduler] Backup failed:", result.error);
      console.log("[Backup Scheduler] Timestamp NOT updated — backup will be retried on next request");

      await notifyOwner({
        title: "❌ Database Backup Failed",
        content: `Automated backup failed.\n\nError: ${result.error}\n\nPlease check the system logs for more details.`,
      });
    }
  } catch (error) {
    console.error("[Backup Scheduler] Unexpected error:", error);
    await notifyOwner({
      title: "❌ Database Backup Error",
      content: `Automated backup encountered an unexpected error.\n\nError: ${error}\n\nPlease check the system logs.`,
    });
  } finally {
    backupInProgress = false;
  }
}

/**
 * Check if a backup is needed and run it in the background.
 * Called by Express middleware on every HTTP request — non-blocking.
 */
export function checkAndRunBackupIfNeeded() {
  if (backupInProgress) return;

  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }

    let lastBackupTime = 0;
    if (fs.existsSync(TIMESTAMP_FILE)) {
      const timestamp = fs.readFileSync(TIMESTAMP_FILE, "utf-8").trim();
      lastBackupTime = parseInt(timestamp, 10);
      if (isNaN(lastBackupTime)) lastBackupTime = 0;
    }

    const timeSinceLastBackup = Date.now() - lastBackupTime;
    const dbBackupDue = timeSinceLastBackup >= DB_BACKUP_INTERVAL_MS;
    const codeBackupDue = isCodeBackupDue();

    if (dbBackupDue || codeBackupDue) {
      if (dbBackupDue) {
        const hoursSince = Math.floor(timeSinceLastBackup / (1000 * 60 * 60));
        console.log(
          `[Backup Scheduler] ${hoursSince} hours since last DB backup, triggering backup...`
        );
      }
      if (codeBackupDue) {
        console.log("[Backup Scheduler] Weekly code backup due (Thursday), triggering backup...");
      }

      backupInProgress = true;
      runBackup().catch((err) => {
        console.error("[Backup Scheduler] Background backup failed:", err);
        backupInProgress = false;
      });
    }
  } catch (error) {
    console.error("[Backup Scheduler] Error checking backup timestamp:", error);
  }
}

/**
 * Initialise the backup system on server startup.
 * Runs a catch-up check after 15 seconds to let the server fully start.
 */
export function startBackupScheduler() {
  console.log("[Backup Scheduler] Starting request-based backup system...");
  console.log("[Backup Scheduler] Database backups: every 4 hours");
  console.log("[Backup Scheduler] Code backups: weekly on Thursdays");
  console.log("[Backup Scheduler] DB timestamp stored at:", TIMESTAMP_FILE);
  console.log("[Backup Scheduler] Code timestamp stored at:", CODE_TIMESTAMP_FILE);

  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  // Catch-up check after server has fully started
  setTimeout(() => {
    console.log("[Backup Scheduler] Running startup backup check...");
    checkAndRunBackupIfNeeded();
  }, 15000);
}
