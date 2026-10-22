# swpr-budget-mod

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

## Manual testing checklist

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
