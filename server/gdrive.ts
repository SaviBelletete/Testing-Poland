/**
 * Google Drive upload helper using googleapis npm package.
 * Replaces rclone-based uploads so this works on the production server
 * where rclone is not installed.
 */
import { google } from "googleapis";
import fs from "fs";
import path from "path";

const FOLDER_NAME = "Payment File Processor Backups";

function getOAuth2Client() {
  const clientId = process.env.GDRIVE_CLIENT_ID;
  const clientSecret = process.env.GDRIVE_CLIENT_SECRET;
  const refreshToken = process.env.GDRIVE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing Google Drive credentials: GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET, GDRIVE_REFRESH_TOKEN"
    );
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return oauth2Client;
}

/**
 * Get or create the backup folder on Google Drive.
 * Returns the folder ID.
 */
async function getOrCreateFolder(drive: ReturnType<typeof google.drive>): Promise<string> {
  // Search for existing folder
  const res = await drive.files.list({
    q: `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id, name)",
    spaces: "drive",
  });

  if (res.data.files && res.data.files.length > 0) {
    return res.data.files[0].id!;
  }

  // Create folder if it doesn't exist
  const folder = await drive.files.create({
    requestBody: {
      name: FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder",
    },
    fields: "id",
  });

  return folder.data.id!;
}

/**
 * Upload a file to the Google Drive backup folder.
 * Returns the shareable link.
 */
export async function uploadToGoogleDrive(
  filePath: string,
  mimeType: string = "application/octet-stream"
): Promise<string> {
  const auth = getOAuth2Client();
  const drive = google.drive({ version: "v3", auth });

  const folderId = await getOrCreateFolder(drive);
  const fileName = path.basename(filePath);

  const fileMetadata = {
    name: fileName,
    parents: [folderId],
  };

  const media = {
    mimeType,
    body: fs.createReadStream(filePath),
  };

  const file = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: "id, webViewLink",
  });

  // Make the file readable by anyone with the link
  await drive.permissions.create({
    fileId: file.data.id!,
    requestBody: {
      role: "reader",
      type: "anyone",
    },
  });

  return file.data.webViewLink || `https://drive.google.com/file/d/${file.data.id}/view`;
}

/**
 * List files in the backup folder older than `daysOld` days.
 * Returns array of file IDs to delete.
 */
export async function listOldBackupFiles(daysOld: number = 30): Promise<string[]> {
  const auth = getOAuth2Client();
  const drive = google.drive({ version: "v3", auth });

  const folderId = await getOrCreateFolder(drive);

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOld);
  const cutoffISO = cutoffDate.toISOString();

  const res = await drive.files.list({
    q: `'${folderId}' in parents and createdTime < '${cutoffISO}' and trashed=false`,
    fields: "files(id, name, createdTime)",
    spaces: "drive",
  });

  return (res.data.files || []).map((f) => f.id!).filter(Boolean);
}

/**
 * Delete a file from Google Drive by ID.
 */
export async function deleteGoogleDriveFile(fileId: string): Promise<void> {
  const auth = getOAuth2Client();
  const drive = google.drive({ version: "v3", auth });
  await drive.files.delete({ fileId });
}
