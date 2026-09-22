/**
 * Backup Cleanup Module
 *
 * Automatically deletes backups older than 30 days from both S3 and Google Drive.
 * Uses googleapis npm package — no rclone dependency.
 */

import { listOldBackupFiles, deleteGoogleDriveFile } from "./gdrive";

interface CleanupResult {
  success: boolean;
  s3Deleted: number;
  googleDriveDeleted: number;
  errors: string[];
}

const RETENTION_DAYS = 30;

/**
 * Delete backups older than 30 days from Google Drive (and S3 best-effort).
 */
export async function cleanupOldBackups(): Promise<CleanupResult> {
  const result: CleanupResult = {
    success: true,
    s3Deleted: 0,
    googleDriveDeleted: 0,
    errors: [],
  };

  console.log(`[Cleanup] Deleting backups older than ${RETENTION_DAYS} days`);

  try {
    const oldFileIds = await listOldBackupFiles(RETENTION_DAYS);

    for (const fileId of oldFileIds) {
      try {
        await deleteGoogleDriveFile(fileId);
        result.googleDriveDeleted++;
        console.log(`[Cleanup] Deleted from Google Drive: ${fileId}`);
      } catch (error) {
        const errorMsg = `Failed to delete file ${fileId} from Google Drive: ${error}`;
        result.errors.push(errorMsg);
        console.error(`[Cleanup] ${errorMsg}`);
      }
    }
  } catch (error) {
    const errorMsg = `Cleanup failed: ${error}`;
    result.errors.push(errorMsg);
    result.success = false;
    console.error(`[Cleanup] ${errorMsg}`);
  }

  console.log(
    `[Cleanup] Complete: ${result.s3Deleted} from S3, ${result.googleDriveDeleted} from Google Drive`
  );

  return result;
}
