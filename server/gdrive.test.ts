/**
 * Test to validate Google Drive OAuth credentials are correctly configured.
 * This test verifies that the googleapis client can authenticate and list files.
 */
import { describe, it, expect } from "vitest";
import { google } from "googleapis";

describe("Google Drive credentials", () => {
  it("should have all required environment variables set", () => {
    expect(process.env.GDRIVE_CLIENT_ID).toBeTruthy();
    expect(process.env.GDRIVE_CLIENT_SECRET).toBeTruthy();
    expect(process.env.GDRIVE_REFRESH_TOKEN).toBeTruthy();
  });

  it("should be able to authenticate with Google Drive API", async () => {
    const clientId = process.env.GDRIVE_CLIENT_ID;
    const clientSecret = process.env.GDRIVE_CLIENT_SECRET;
    const refreshToken = process.env.GDRIVE_REFRESH_TOKEN;

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    const drive = google.drive({ version: "v3", auth: oauth2Client });

    // List files — will fail with auth error if credentials are invalid
    const res = await drive.files.list({
      pageSize: 1,
      fields: "files(id, name)",
    });

    expect(res.status).toBe(200);
    expect(res.data).toBeDefined();
  }, 15000); // 15s timeout for network call
});
