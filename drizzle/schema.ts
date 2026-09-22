import { int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Campaigns table — stores one master file per campaign.
 * Each campaign is associated with a client (SC Johnson, PepsiCo, etc.)
 * and holds the S3 storage key for the master .xlsm file.
 */
export const campaigns = mysqlTable("campaigns", {
  id: int("id").autoincrement().primaryKey(),
  /** Human-readable campaign name, editable by the user */
  name: varchar("name", { length: 255 }).notNull(),
  /** Auto-detected client name (SC Johnson, PepsiCo, etc.) */
  clientName: varchar("clientName", { length: 128 }).notNull(),
  /** S3 storage key for the master file */
  storageKey: varchar("storageKey", { length: 512 }).notNull(),
  /** Original filename of the master file */
  originalFilename: varchar("originalFilename", { length: 255 }).notNull(),
  /** Target sheet name detected in the master file */
  sheetName: varchar("sheetName", { length: 128 }).default("").notNull(),
  /** Available sheet names in the master file (JSON array) */
  sheetNames: text("sheetNames").default("[]").notNull(),
  /** When the master file was first uploaded */
  uploadedAt: timestamp("uploadedAt").defaultNow().notNull(),
  /** When this campaign was last processed (weekly file appended) */
  lastProcessedAt: timestamp("lastProcessedAt"),
  /** Number of rows in the master at last processing */
  lastRowCount: int("lastRowCount").default(0),
});

export type Campaign = typeof campaigns.$inferSelect;
export type InsertCampaign = typeof campaigns.$inferInsert;

/**
 * Processing runs table — records every weekly file processing run.
 * Provides a full audit trail of what was processed each week.
 */
export const processingRuns = mysqlTable("processing_runs", {
  id: int("id").autoincrement().primaryKey(),
  /** FK to campaigns table (nullable — run may have been done without a saved campaign) */
  campaignId: int("campaignId"),
  /** Campaign name at time of processing (denormalized for history display) */
  campaignName: varchar("campaignName", { length: 255 }).notNull(),
  /** Client name at time of processing */
  clientName: varchar("clientName", { length: 128 }).notNull(),
  /** When this run was executed */
  processedAt: timestamp("processedAt").defaultNow().notNull(),
  /** Original filename of the weekly extracted file */
  weeklyFilename: varchar("weeklyFilename", { length: 255 }).notNull(),
  /** Original filename of the master file produced */
  masterFilename: varchar("masterFilename", { length: 255 }).notNull(),
  /** Total rows in the weekly file */
  rowsProcessed: int("rowsProcessed").default(0).notNull(),
  /** Rows successfully added to the master */
  rowsAdded: int("rowsAdded").default(0).notNull(),
  /** Rows skipped (duplicates) */
  rowsSkipped: int("rowsSkipped").default(0).notNull(),
  /** Row count reconciliation: did added rows match expected? */
  rowCountPass: int("rowCountPass").default(0).notNull(), // 1=pass, 0=fail
  /** Expected total amount from weekly file */
  amountExpected: varchar("amountExpected", { length: 64 }).default("").notNull(),
  /** Actual total amount added to master */
  amountActual: varchar("amountActual", { length: 64 }).default("").notNull(),
  /** Amount reconciliation: did totals match? */
  amountPass: int("amountPass").default(0).notNull(), // 1=pass, 0=fail
  /** S3 key of the updated master file produced by this run */
  downloadKey: varchar("downloadKey", { length: 512 }).default("").notNull(),
  /** Target sheet name that was updated (comma-separated for multi-sheet runs) */
  sheetName: varchar("sheetName", { length: 512 }).default("").notNull(),
  /** JSON array of per-sheet results for multi-sheet runs */
  sheetResults: text("sheetResults"),
  /** JSON array of generated payment file metadata [{label, filename, downloadKey, rowCount}] */
  paymentFiles: text("paymentFiles"),
});

export type ProcessingRun = typeof processingRuns.$inferSelect;
export type InsertProcessingRun = typeof processingRuns.$inferInsert;
