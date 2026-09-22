# Payment File Processor — Project Instructions

## Scope and source of truth

This repository is a TypeScript/React web application that processes weekly cashback Excel files into stored master `.xlsx`/`.xlsm` campaign files. The source snapshot was imported from Git revision `fd8245da`.

Before proposing a change, inspect the relevant route, processor, database helper, UI component, and tests. Preserve existing business behavior unless the task explicitly changes it. Do not replace the ZIP-surgical processor with a full-workbook ExcelJS solution; large macro-enabled masters rely on the current AdmZip-based approach to avoid timeouts and corruption.

## Core behavior that must remain intact

- Process a weekly file against a selected campaign master or a newly uploaded master.
- Append only rows whose serial number is not already in the relevant master sheet.
- Match weekly country sheets to master country sheets, including aliases. `ROI`, `Republic of Ireland`, `ROI Ireland`, and `Ireland ROI` must map to `Ireland`.
- Reconcile added row counts and monetary totals before reporting the result.
- Produce payment files for Wise UK (XLSX), Wise International (CSV), and PayPal (CSV).
- Preserve campaign records and processing history. Do not save full `addedRows` payloads into the history JSON field.
- Validate an updated master begins with ZIP `PK` bytes before storing it. Do not update a campaign’s master pointer until history persistence succeeds.
- Preserve all English and Polish translations. Every new user-visible string must have both translations.
- Download routes must send the original intended filename using `Content-Disposition`; do not use direct object-storage download URLs that cause `.xlsm.xlsx` names.

## Architecture

- Frontend: React 19, Vite 7, Tailwind 4, shadcn/Radix components, tRPC client.
- Server: Express 4, tRPC 11, Drizzle ORM, MySQL/TiDB-compatible database.
- Spreadsheet processing: `server/paymentProcessor.ts` uses ZIP/XML surgery with `adm-zip`.
- Upload REST routes: `server/uploadRouter.ts`.
- Database schema/migrations: `drizzle/schema.ts` and `drizzle/`.
- UI and translations: primarily `client/src/pages/Home.tsx`.
- Tests: Vitest; use `server/paymentProcessor.integration.test.ts` as the model for end-to-end processor tests.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm check
pnpm build
pnpm dev
```

Run `pnpm test` and `pnpm check` before each commit. Add or update tests with every behavioral fix. Do not claim a production bug is fixed based only on TypeScript compilation or a unit test.

## Known unresolved work

The chunked upload feature is incomplete. Files over 6 MB currently route through `client/src/lib/chunkedUpload.ts` to `/api/upload-chunk` and `/api/finalize-upload`. Production returned HTTP 500 during finalization after bypassing a 413 limit. Treat this as unresolved.

Required repair sequence:

1. Update `todo.md` so the finalize bug and automated end-to-end tests are open work.
2. Compare `/api/finalize-upload` with the canonical `/api/process-payments` route.
3. Refactor shared business processing into one helper so the two routes cannot diverge.
4. Add an integration test that uploads a synthetic master and weekly file in multiple chunks, finalizes, and validates the normal processing response.
5. Return only structured JSON errors from upload routes; never return a Vite/HTML error response.
6. Validate in an environment that matches the deployed reverse-proxy upload limit before declaring the path complete.

Do not assume a development preview bypasses the reverse proxy. Verify it.

## Security and data handling

Never commit, log, echo, or place secrets in prompts. Use the deployment platform’s secret manager for database credentials, Google Drive OAuth credentials, storage credentials, and authentication credentials. Existing Google Drive OAuth credentials must be rotated because they were previously exposed in a conversation.

Do not add customer Excel files, database backups, or exported data to Git. Database records contain object-storage keys; migration of stored masters and generated payment files requires a private object-store transfer or an atomic key remap.

## Backups

`server/backup-scheduler.ts` performs request-triggered backups: database backup is due every four hours and code backup is due on Thursday. The current code derives the project directory from `import.meta.url` and uses `/tmp/database-backups` in production. Because `/tmp` is ephemeral, a cold start can create extra catch-up backups. For strict durable cadence, persist scheduler state in the database or object storage.

## Change discipline

Keep changes narrow, reviewable, and reversible. Prefer a focused branch/PR per concern. If an external integration or deployment setting is required, document the exact new environment variable name and the required target service without placing any value in source.
