# Payment File Processor - TODO

## Backend
- [x] File upload endpoint with multer (weekly + master files)
- [x] Client auto-detection (SC Johnson vs PepsiCo) from filename/content
- [x] Weekly file parser (skip row 1 title, use row 2 as headers, data from row 3)
- [x] Column mapping engine (weekly -> master column mapping)
- [x] SEPA payment handling (Account Number = IBAN, Bank Sort Code = BIC)
- [x] Country/sheet detection (Poland for SCJ, France/other for PepsiCo)
- [x] Duplicate prevention (check Serial numbers against existing master rows)
- [x] Append new rows to correct sheet in master file
- [x] Copy formula pattern from last existing row (cols AE-AX)
- [x] Reconciliation: row count check (weekly rows == added rows)
- [x] Reconciliation: amount total check (weekly Value sum == added Value sum)
- [x] Return processing results (rows processed, added, skipped, reconciliation status)
- [x] File download endpoint (return updated master file via S3)
- [x] Support multiple file pairs in one session
- [x] Python worker (ZIP-surgical approach) for large .xlsm files without OOM
- [x] Auto-start Python worker with Node.js server (with auto-restart on crash)

## Frontend
- [x] Savi branding (colors: #4DFFA8 green, #224B50 dark teal, white)
- [x] Header with savi logo
- [x] File upload panel (drag & drop, weekly + master file pair)
- [x] Add multiple file pair support
- [x] Processing status indicator (loading state)
- [x] Results summary panel per file pair
- [x] Reconciliation report (rows processed/added/skipped, pass/fail)
- [x] Download button for updated master file
- [x] Error handling display
- [x] How-it-works step guide
- [x] Process All button for batch processing

## Testing
- [x] Vitest unit test for column mapping engine
- [x] Vitest unit test for duplicate detection
- [x] Vitest unit test for reconciliation checks
- [x] End-to-end test with sample files (SCJ + PepsiCo via API)

## Phase 2 Features
- [x] DB schema: campaigns table (id, name, clientName, storageKey, originalFilename, uploadedAt, lastProcessedAt)
- [x] tRPC router: campaigns.list, campaigns.rename, campaigns.delete, campaigns.get, campaigns.getMasterUrl
- [x] Backend: store master file in S3 on first upload, keyed by campaign
- [x] Backend: process-payments endpoint accepts campaignId OR masterFile upload
- [x] Frontend: Campaigns panel showing stored master files with client, filename, last updated
- [x] Frontend: Upload page - if campaign exists, only ask for weekly file
- [x] Frontend: "Replace master file" option per campaign (collapsible advanced section)
- [x] Frontend: Campaign name editable by user
- [x] Frontend: Delete campaign button
- [x] English/Polish language switcher in header (EN default)
- [x] Translation strings for all UI text in both languages
- [x] Language preference persisted in localStorage

## Phase 2 Polish
- [x] Replace remaining hardcoded English strings in Home.tsx (toast/error/helper messages) with i18n keys

## Bug Fixes
- [x] Fix "string did not match the expected pattern" error on master file upload (added full MIME types to accept attributes: .xlsm + application/vnd.ms-excel.sheet.macroEnabled.12)

## Phase 3 — Processing History Log
- [x] DB schema: processing_runs table (id, campaignId, campaignName, processedAt, weeklyFilename, rowsProcessed, rowsAdded, rowsSkipped, rowCountPass, amountExpected, amountActual, amountPass, downloadKey, originalFilename)
- [x] DB helpers: createProcessingRun, listProcessingRuns, listRunsByCampaign
- [x] tRPC procedures: history.list, history.byCampaign, history.getDownloadUrl
- [x] Record each successful processing run in uploadRouter.ts
- [x] History tab in UI with table of all runs
- [x] Per-run: campaign name, date, rows added/skipped, reconciliation pass/fail badges, download link
- [x] Filter history by campaign
- [x] i18n translations for History tab (EN + PL)

## Bug Fixes (Phase 3)
- [x] Fix Python worker not available in deployed production environment (ECONNREFUSED 127.0.0.1:5001) — fixed path resolution (process.cwd() instead of __dirname), added fs-based python binary detection, and auto pip install of requirements on startup

## Bug Fixes (Phase 4)
- [x] Prevent duplicate campaign creation: if a campaign with the same clientName + sheetName already exists, return 409 with actionable error message instead of creating a new one

## Bug Fixes (Phase 5)
- [x] Fix active tab button text contrast — selected tab text is unreadable (used explicit hex #224B50 via .savi-tab CSS class, moved Google Fonts @import to top of index.css to fix PostCSS error)

## Phase 6 — Sheet Selector & History Export
- [x] Backend: expose available sheets from a campaign's master file via tRPC (campaigns.getSheets)
- [x] Backend: accept optional targetSheet override in process-payments endpoint
- [x] Backend: history export endpoint returning CSV/Excel of all runs (optionally filtered by campaign)
- [x] Frontend: sheet selector dropdown shown after campaign is selected (only if >1 sheet available)
- [x] Frontend: pre-select the auto-detected sheet, allow user to override
- [x] Frontend: "Export History" button on History tab (downloads CSV)
- [x] i18n: EN + PL translations for all new strings

## Bug Fixes (Phase 6)
- [x] Fix "string did not match the expected pattern" toast error on Mac when uploading .xlsm master file
- [x] Fix 500 error on upload-campaign when Python worker is still starting up
- [x] Fix Python worker not starting in production
- [x] Fix campaign naming: use original filename (without extension) instead of detected client/region name (e.g. SC Johnson file should not be renamed to "UK")

## Phase 7 — Worker Warm-up & Sheet Re-detection
- [x] Add /api/warmup endpoint that pings the Python worker to start it
- [x] Call /api/warmup silently on app load (App.tsx or Home.tsx mount) so worker is ready before user uploads
- [x] Add tRPC procedure campaigns.refreshSheets(campaignId) that re-runs detect and updates sheetName/sheetNames in DB
- [x] After upload-campaign succeeds with empty sheetNames, poll campaigns.refreshSheets every 3s until sheets are populated (max 10 attempts), then update the campaign list

## Phase 8 — Remove Python Dependency
- [x] Replace Python Flask worker with TypeScript/ExcelJS processor: removed Python startup from server/_core/index.ts, rewired uploadRouter.ts to use paymentProcessor.ts directly, removed python-worker copy from build script
- [x] worker-health endpoint always returns ok (engine: typescript) — no separate process needed
- [x] warmup endpoint is a no-op (TypeScript processor needs no warm-up)
- [x] All 16 Vitest tests pass with zero TypeScript errors

## Phase 9 — Multi-Sheet Processing (All Countries in One Run)
- [x] Rewrite processPaymentFiles to iterate over all sheets in the weekly file, match each to the corresponding master sheet by name, and append rows
- [x] Return per-sheet results (rowsAdded, rowsSkipped, reconciliation) for each country processed
- [x] Update uploadRouter process-payments to handle multi-sheet result and store per-sheet history
- [x] Remove Target Sheet selector from the Process Payments UI (no longer needed)
- [x] Show per-country results breakdown in the results panel
- [x] Update i18n keys for multi-sheet result display (EN + PL)
- [x] Add Arkusz1 → Poland alias to detectTargetSheet
- [x] Fix refreshSheets tRPC procedure to use TypeScript ZIP parser instead of Python worker
- [x] All 16 tests pass, zero TypeScript errors

## Bug Fixes (Phase 9)
- [x] Fix "Processing engine is starting up" error on weekly file upload on deployed site — root cause: ExcelJS loading entire 27MB .xlsm workbook in 27s, exceeding cloud container timeout; fixed by ZIP-surgical approach

## Phase 10 — ZIP-Surgical Processor (Performance Fix)
- [x] Rewrite paymentProcessor.ts to use JSZip + XML string manipulation instead of ExcelJS full-workbook load
- [x] Parse only the target country sheet XMLs from the ZIP (not all 31 sheets)
- [x] Append new rows directly to sheet XML and repack ZIP
- [x] Reduce processing time from 27s to 4.5s for 27MB .xlsm files (well within cloud timeout)
- [x] All 16 Vitest tests pass, zero TypeScript errors

## Bug Fix — Response Buffer
- [x] Fix 500 error on process-payments: exclude updatedMasterBuffer (27MB binary) from JSON response; frontend uses downloadUrl instead

## Phase 11 — Integration Test Fixes
- [x] Fix integration test: update weekly file headers to match real file format (Purchase Date (UTC), 37 columns)
- [x] Fix integration test: update assertions to use correct field names (rowsAdded/rowsSkipped not totalRowsAdded/totalRowsSkipped)
- [x] Fix duplicate detection: add inlineStr format support for column A serial extraction
- [x] Fix parseSheetMap: store original case first so masterSheetDisplayName preserves correct casing
- [x] Remove debug console.log statements from paymentProcessor.ts
- [x] All 18 Vitest tests pass, zero TypeScript errors

## Bug Fix — React Render Crash
- [x] Fix React crash when displaying process-payments result (frontend accessing property that changed shape)

## Bug Fix — PepsiCo Weekly File
- [x] Fix PepsiCo weekly file showing 0 rows despite having data in the worksheet
- [x] Add IBAN-prefix fallback: when sheet name doesn't match any master sheet, detect country from IBAN prefixes (FR→France, GB→UK, DE→Germany etc.)
- [x] Remove arkusz1 from Poland aliases (it's a generic Excel sheet name, not a country indicator)

## Bug Fix — XML Corruption in Downloaded Master
- [x] Fix XML corruption causing Excel repair errors: root cause was JSZip misreading ZIP central directory for large .xlsm files (189 entries, 154MB uncompressed), swapping/dropping sheet content
- [x] Replaced JSZip with adm-zip which correctly reads all 189 entries
- [x] Added force-load loop (entry.getData() for all entries) before toBuffer() so adm-zip preserves all entries in output
- [x] Verified: processed master has 0 missing files, 0 XML errors, sheet3.xml correct 27MB size

## Feature — Master File Downloads
- [x] Add Download button to each campaign tile on the Campaigns tab
- [x] Add a dedicated "Master Files" fourth tab for quick download of latest master per campaign
- [x] i18n keys for new strings (EN + PL)

## Bug Fix — Double Extension on Download
- [x] Fix .xlsm.xlsx double extension: replaced S3 direct URL with /api/download proxy that streams file with correct Content-Disposition header; all 4 download handlers now use proxy

## Feature — Payment File Generator
- [x] Build configurable payment format registry (PaymentFormat type with routing rules: payType, currency, outputFormat, columns)
- [x] Implement generatePaymentFiles() server function that takes newly-added rows and produces files per format
- [x] Support Wise UK XLSX format (sort code + account number, GBP, bacs/bank pay types)
- [x] Support Wise international CSV format (IBAN + BIC, EUR/CHF/ZAR/PLN/TRY/SEK, transferwise pay type)
- [x] Support PayPal CSV format (email + amount, any currency, paypal pay type)
- [x] Wire generatePaymentFiles into uploadRouter process-payments endpoint (non-fatal, runs after master update)
- [x] Store generated payment files in S3 and link to processing_run record (paymentFiles JSON column)
- [x] Reuse /api/download proxy endpoint for payment file downloads (correct filename/content-type)
- [x] UI: show generated payment files in process result panel after processing (PaymentFilesSection component)
- [x] i18n keys for all new strings (EN + PL)
- [x] Fix BIC column lookup: graceful fallback when column absent (prevents ExcelJS out-of-bounds error)
- [x] All 18 Vitest tests pass, zero TypeScript errors

## Feature — Auto-save Campaign on Manual Upload
- [x] When master + weekly are uploaded together without selecting a saved campaign, auto-save the master as a new campaign in the database
- [x] Duplicate check: if a campaign for the same client/sheet already exists, reuse it instead of creating a duplicate
- [x] Original master stored as campaign master in S3; updated (post-processing) master stored separately for download
- [x] campaignId returned in response so History tab links the run to the correct campaign
- [x] All 18 Vitest tests pass, zero TypeScript errors

## Bug Fix — Mondelez ROI Sheet Alias
- [x] Add ROI → Ireland country alias: Mondelez weekly file uses sheet name "ROI" (Republic of Ireland) which now correctly maps to the "Ireland" sheet in the master file
- [x] Added aliases: "roi", "republic of ireland", "roi ireland", "ireland roi" to COUNTRY_ALIASES ireland entry
- [x] All 18 Vitest tests pass, zero TypeScript errors

## Feature — Automated Google Drive Backup
- [x] Install googleapis npm package
- [x] Add GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET, GDRIVE_REFRESH_TOKEN secrets
- [x] Create server/gdrive.ts: Google Drive OAuth2 helper (upload, list old files, delete)
- [x] Create server/backup.ts: MySQL dump to SQL → upload to S3 + Google Drive
- [x] Create server/backup-cleanup.ts: delete backups older than 30 days
- [x] Create server/backup-scheduler.ts: request-triggered scheduler (DB every 4h, code archive every Thursday)
- [x] Wire startBackupScheduler() and checkAndRunBackupIfNeeded() into Express server entry point
- [x] Backup folder on Google Drive: "Payment File Processor Backups"
- [x] Timestamps stored in /home/ubuntu/database-backups/ (persists across sandbox hibernation)
- [x] All 20 Vitest tests pass (including gdrive.test.ts credential validation), zero TypeScript errors

## Bug Fix — 413 File Too Large (Mondelez)
- [x] Add /api/upload-chunk endpoint: accept chunk index + upload ID, store chunks in memory map
- [x] Add /api/finalize-upload endpoint: reassemble chunks into full buffer, then process normally
- [x] Replace client-side FormData fetch with chunked upload utility (client/src/lib/chunkedUpload.ts; wired into Home.tsx via uploadFileInChunks/needsChunkedUpload)
- [x] Show upload progress bar during chunked upload

## Chunked Upload — Finalize Fix (branch: claude/fix-chunked-upload-finalize)
Production returned HTTP 500 during finalization after bypassing the reverse-proxy's 413 limit. Root-caused to two divergence/robustness gaps between /api/process-payments and /api/finalize-upload:
- The two routes carried separately-maintained copies of the campaign/master/history logic (finalize-upload's copy had already drifted — a dead `timestamp + 1` workaround for an S3 key collision that storagePut's random hash suffix already prevents).
- Errors raised before a route handler's own try/catch (a malformed JSON body rejected by express.json(), a multer limit) fell through to Express's default HTML error handler instead of returning JSON, which a `fetch().then(r => r.json())` caller can't parse — surfacing as an opaque failure.
- [x] Fix the production HTTP 500 in /api/finalize-upload end-to-end — extracted the shared logic into `server/processPaymentsFlow.ts` (`runProcessPaymentsFlow`), used by both routes so they cannot diverge again; added `server/_core/jsonErrorHandler.ts` so every error on the API surface returns structured JSON.
- [x] Add automated end-to-end tests for /api/upload-chunk plus /api/finalize-upload, including a normal processing response — `server/uploadRouter.chunkedUpload.integration.test.ts` drives a real Express server over HTTP with a synthetic multi-chunk master + weekly file (forward and reverse chunk arrival order) and asserts the same response shape /api/process-payments returns, plus JSON-only error responses for a malformed body and an incomplete chunk set.
- [ ] Validate against an environment that matches the deployed reverse-proxy's upload body-size limit (~8 MB) before declaring this closed in production — not done in this session (no access to the production proxy/infra). Do not assume a development preview bypasses the reverse proxy.

## Feature — Local Development Without Manus (branch: claude/local-dev-testing)
Goal: let someone upload a file and see the processing output without any Manus infrastructure, so the app can be tested before a real deployment exists.
- [x] `server/storage.ts` falls back to a local-disk adapter (`server/storageLocal.ts`, writes to `.local-storage/`, served at `/local-storage`) whenever `BUILT_IN_FORGE_API_URL`/`BUILT_IN_FORGE_API_KEY` are unset — production (Forge-configured) behavior unchanged, purely additive
- [x] `scripts/local-dev-setup.sh`: installs/starts MariaDB, creates a local database, applies the existing Drizzle migrations, writes a local-only `.env`
- [x] `LOCAL_TESTING.md` documenting the setup (no login required — the upload UI never gated on auth)
- [x] Verified end-to-end against a live local server + local database + local-disk storage: campaign auto-creation, duplicate-row skipping, reconciliation, Wise UK payment file generation, and the processed-master download all worked

## Real-file validation (small-file /api/process-payments path)
Ran a real SC Johnson master (27MB, 32 sheets) and a real multi-country weekly extract (52 rows across UK/Germany/South Africa/France/Belgium/Italy/Turkey/Spain) through the live local app, outside any test suite, to check the core processing path against production-shaped data rather than synthetic fixtures. Files were provided for this check only — not committed, not retained.
- [x] Confirmed: 0 false duplicates, 0 missed rows across all 8 countries
- [x] Confirmed: weekly sheet name "Belgium NL" correctly matched to master sheet "Belgium" via the alias-matching logic on a real mismatch (not a synthetic test case)
- [x] Confirmed: row-count and amount reconciliation both passed exactly (expected == actual) on real monetary totals
- [x] Confirmed: processed the real 27MB master in ~2.8s
- [x] Confirmed: all 6 expected payment output files generated correctly, split by currency/pay type (Wise UK GBP, PayPal GBP, PayPal EUR, Wise EUR, Wise ZAR, Wise TRY)
- [x] Confirmed: processed master downloaded successfully afterward (valid ZIP)
