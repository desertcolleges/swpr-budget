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

- **Mark as Finalized** (Admin) calls `admin_finalize_submission`, which replaces the institution's `budget_reference` rows for that round with the approved request's lines (zero-dollar lines are dropped), so projects, activities and object codes can change. `budget_reference.round` is added and backfilled from the title by `DATABASE_SETUP.sql`. Before/after values stay in `submission_modifications` and `submission_revisions` and are visible in the request history/status pages.
- One open request (Pending/Approved/Rejected) per institution + round. Requesters edit and resubmit it (status returns to Pending; the prior version is saved in `submission_revisions`). Only **Finalized** allows a fresh request.
- Requesters see a **Modification History** tab per round; admins can delete requests (`admin_delete_submission`).
- Redeploy **both** edge functions (`send-approval`, `submit-budget`) and re-run `DATABASE_SETUP.sql` after pulling these changes. `send-approval` must allow the `apikey` CORS header or admin notifications silently fail in the browser.

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
