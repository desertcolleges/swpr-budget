# swpr-budget

Budget modification request tool for Regional Strong Workforce.

## Implementation notes

- Header branding now uses `images/iedrc-logo.png` in `index.html`, `admin.html`, and `status.html`.
- Requester flow now uses a project → activity → object-category (1000s-6000s) modification structure.
- Activity deletion removes all six object-category rows from local state and excludes the activity from submission payload.
- New activity creation adds six object-category rows immediately with `$0` and blank proposed descriptions.
- Request status lookup supports direct deep links with `status.html?requestId=REQ-XXXXX` and manual request-number lookup.
- Status lookup is intentionally request-number based (semi-public access model); request numbers should be treated as non-secret identifiers.
- Status page PDF export currently uses browser print dialog via **Download PDF**.
- Email function source is in `SEND_APPROVAL_EDGE_FUNCTION.ts`; deploy it as Supabase Edge Function `send-approval`.
- Apply `DATABASE_SETUP.sql` in Supabase SQL Editor to provision normalized submission modification fields, indexes, and status lookup RPC.

- Admin → Allocations → **Reset Budget** calls `admin_reset_budget`: it deletes the college's `budget_reference` rows for that round (finalized or imported), closes open requests with status `Reset` (history kept), and records the round in `budget_round_resets` so the external import skips it. The college then sees "Build Rx Budget" like a new allocation; finalizing the new budget clears the marker.
- **Mark as Finalized** (Admin) calls `admin_finalize_submission`, which replaces the institution's `budget_reference` rows for that round with the approved request's lines (empty zero-dollar lines are omitted; zero-dollar descriptions are retained), so projects, activities and object codes can change. `budget_reference.round` is added and backfilled from the title by `DATABASE_SETUP.sql`. A trigger on `budget_reference` makes the external import skip finalized institution+rounds and blocks deletes/updates/truncates of finalized rows (`sync_batch like 'finalized:%'`). Before/after values stay in `submission_modifications` and `submission_revisions` and are visible in the request history/status pages.
- One open request (Pending/Approved/Rejected) per institution + round. Requesters edit and resubmit it (status returns to Pending; the prior version is saved in `submission_revisions`). Only **Finalized** allows a fresh request.
- Requesters see a **Modification History** tab per round; admins can delete requests (`admin_delete_submission`).
- Apply `DATABASE_SETUP.sql` and deploy the edge functions after pulling these changes; see deployment below. `send-approval` must allow the `apikey` CORS header.

## Drafts, manual budgets, and expenditure displays

- **Save Draft** asks for name/email and emails a private continuation link. Incomplete and out-of-balance budgets can be saved. After the first save, edits autosave with a visible status; explicit saves send another confirmation email. Drafts are separate from approval requests. The link works across devices without sign-in, grants editing access, and must not be forwarded. Only a SHA-256 hash of its random 256-bit token is stored. Links expire after 90 days without a save; submitting closes the draft atomically. Concurrent edits are rejected rather than overwritten. Email failures explicitly distinguish saved data from undelivered confirmation.
- **Admin → Budgets** applies college/round budgets immediately without an allocation constraint, including rounds without an allocation. It requires an active admin, valid nonnegative whole-dollar amounts, descriptions for funded lines, a reason, and confirmation. All six category rows are retained, and before/after snapshots and admin identity appear in Admin Change History. These budgets are protected from external budget imports. Changing a budget invalidates old request baselines: requesters must review against the current budget and resubmit before finalization can replace it.
- **Expenditures are project/category totals, not activity totals.** Each project starts with a six-category summary of combined activity budgets, activity-labeled descriptions, expenditures, and remaining balances. Coverage warnings are per category even if the project total is sufficient. Spending is counted once in project/round totals, including expenditure-only projects/categories. Activity breakdowns show only budgets and descriptions. Missing categories display zero everywhere, including reviews, history, status, and printing.
- Forms use compact spacing and wider description columns. Description text wraps and editable descriptions grow with their contents; narrow screens stack editor fields instead of hiding them.

## Deployment

1. Apply **`DATABASE_SETUP.sql`** in the Supabase SQL Editor. It extends the existing database; it is not a blank-database bootstrap.
2. Link the Supabase CLI to the existing project, then deploy:

   ```sh
   supabase functions deploy budget-draft sync-expenditures submit-budget send-approval
   ```

   `supabase/config.toml` points `submit-budget` and `send-approval` at their existing root sources. The new functions and shared dependencies are under `supabase/functions/`. Draft/submission functions deliberately disable gateway JWT verification because requesters have no accounts; tokens and inputs are validated in the functions. Sheet syncing validates active admin sessions or the dedicated scheduler secret.
3. Configure backend secrets using Supabase's secret manager: **`RESEND_API_KEY`**, **`ADMIN_NOTIFICATION_EMAIL`**, and **`APP_BASE_URL`** (the deployed site URL with trailing slash). Optional **`NOTIFICATION_FROM_EMAIL`** defaults to the existing verified sender. Keep all credentials out of the repository.
4. Deploy the static files together, including `drafts.js` and `admin-budgets.js`. Deploy database/functions before the frontend; older frontends must be refreshed because submissions now include a budget fingerprint.
5. Complete Google Sheet configuration below. Without it, the site continues using the existing `expenditure_reference` data and explicitly reports that the first Sheet sync has not completed.

## Google Sheet expenditure source

The old site reads `expenditure_reference` on institution load. Its original importer/schedule is not present in this repository. After the first successful Sheet sync, the site uses the separate `expenditure_snapshot` table instead. The new importer does **not** change budgets or delete old reference data.

Create a private Sheet with one header row containing these exact names (spaces in place of underscores are also accepted):

| institution | round | project | object_category | expenditure_amount |
|---|---|---|---|---|
| Exact configured college name | R10 | Exact project name | 1000s | 1234.56 |

Use **cumulative net totals**, not transactions, with one row per college/round/project/category. All six categories may be listed; missing expenditure categories mean zero. Categories may be `1000` through `6000` or their `s` forms. Amount cells should be numeric; formatting a numeric cell as currency is fine. Text such as `$1,234.56` is rejected. Negative totals are accepted for net credits/refunds. Duplicate keys, invalid amounts/categories/rounds, unknown institutions, and empty imports are rejected in full.

**The configured range is a complete snapshot for all colleges/rounds the site should report.** A successful import replaces the prior Sheet snapshot, including removing omitted keys. Do not configure a partial college/round range unless that is the entire intended reporting scope. Unknown project names remain visible as unmatched spending for reconciliation; use exact project names to associate spending with budgets.

1. Enable the Google Sheets API in Google Cloud, create a service account, and share only the expenditure Sheet with its email as **Viewer**. No requester/admin Google permissions are needed to read it.
2. Set backend secrets: **`GOOGLE_SERVICE_ACCOUNT_JSON`** (the account JSON), **`EXPENDITURE_SHEET_ID`**, **`EXPENDITURE_SHEET_RANGE`** (for example `Expenditures!A:E`), and **`EXPENDITURE_SYNC_SECRET`** (a random scheduler-only secret).
3. Use **Admin → Expenditures → Sync Now** to confirm mappings and totals before enabling the schedule. Import failures retain the last successful data and report the error. The admin tab shows last attempt/success, imported row count, and failures. Public budget views show freshness and warn after two hours without a successful sync.
4. Create Supabase Vault secrets named **`expenditure_sync_url`** (the deployed `sync-expenditures` endpoint) and **`expenditure_sync_secret`** (the same value as `EXPENDITURE_SYNC_SECRET`). Then run **`EXPENDITURE_SYNC_SETUP.sql`** to enable hourly syncing and daily expired-draft cleanup. Re-running it updates the named jobs instead of duplicating them. Check Supabase Cron run history and `net._http_response` for scheduler/network failures; a failure to reach the function cannot update its error record, but the public freshness warning still detects stale data.
5. Confirm or disable the prior expenditure importer outside this repository to avoid maintaining two competing sources. Existing external **budget** imports remain separate.

## Automated checks

```sh
npm ci
npm test
npx playwright install chromium
npm run test:browser
# With Deno installed:
npm run test:edge
```

Database tests run the migration twice in an isolated PostgreSQL-compatible engine with a minimal legacy schema. Browser tests use mocked backend/email responses; live email delivery, Google account permissions, and scheduled execution must be confirmed after deployment.

## Manual testing checklist

- [ ] Reject a request: admin sees "notification email sent" (or an explicit warning) and the requester receives the email.
- [ ] Resubmit a Pending/Approved/Rejected request: same request number, status returns to Pending, History tab shows it.
- [ ] Mark Approved request Finalized; requester can then start a new request from scratch.
- [ ] Admin review shows Project → Activity → category grouping with changes highlighted; Delete works.

- [ ] Load a round with multiple projects, including projects with and without activities.
- [ ] Add a new activity to an empty project section.
- [ ] Modify budget and description for an existing activity object category.
- [ ] Delete an activity and verify totals recalculate.
- [ ] Add a new activity and budget multiple object categories.
- [ ] Try submitting with an activity where all categories are `$0` (should error).
- [ ] Try submitting with missing description for a category budgeted above `$0` (should error).
- [ ] Verify round total validation blocks out-of-balance submission.
- [ ] Admin: load settings, toggle visible rounds, save, and reload requester view.
- [ ] Admin: review a request and verify object category and descriptions are displayed clearly.
- [ ] Requester: open status portal and verify full modification details with new fields.
- [ ] Email: verify approval and rejection notifications include proper status link and wording.

## Admin setup: projects, tabs, and Google SSO

1. **Run the SQL.** Supabase → SQL Editor → paste all of `DATABASE_SETUP.sql` → Run (safe to re-run). This creates `projects`, `project_activities`, `admin_allowlist`, and the `copy_project` / `claim_admin_access` functions, and seeds projects from the old `activity_management` table.
2. **Google Cloud.** console.cloud.google.com → APIs & Services → OAuth consent screen (choose *Internal* if desertcolleges.org is your Workspace) → Credentials → Create OAuth client ID (Web application). Add the authorized redirect URI shown in Supabase → Authentication → Providers → Google (`https://<project-ref>.supabase.co/auth/v1/callback`).
3. **Supabase.** Authentication → Providers → Google: enable, paste client ID and secret. Authentication → URL Configuration: set Site URL to the deployed admin site and add `<site>/admin.html` to Redirect URLs.
4. **Admins.** Existing admins with desertcolleges.org emails are seeded into the allow-list. Anyone else: sign in once, then use Admin → Admins tab to add `name@desertcolleges.org`. Only active allow-listed accounts can enter.
5. **Projects.** Admin → Projects: review seeded projects, set the round on any marked *Unassigned* (hidden from requesters until set), then use Copy to create P62 etc. from P61.
6. Optional: disable email/password sign-in in Supabase (Authentication → Providers → Email) now that the form is removed.
