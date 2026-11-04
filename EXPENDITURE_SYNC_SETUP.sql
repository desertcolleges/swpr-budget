-- Run AFTER DATABASE_SETUP.sql and configuring the two Vault secrets below.
-- Set expenditure_sync_url to https://<project-ref>.supabase.co/functions/v1/sync-expenditures.
-- Set expenditure_sync_secret to the same random value as the Edge Function's EXPENDITURE_SYNC_SECRET.
-- Create these through Supabase Vault; do not paste secret values into committed files.
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'expenditure_sync_url')
    or not exists (select 1 from vault.decrypted_secrets where name = 'expenditure_sync_secret') then
    raise exception 'Configure expenditure_sync_url and expenditure_sync_secret in Supabase Vault first';
  end if;
end $$;

select cron.schedule('budget-expenditure-hourly', '0 * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'expenditure_sync_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'expenditure_sync_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
$job$);

select cron.schedule('budget-draft-expiry-cleanup', '15 3 * * *', $job$
  delete from public.budget_drafts where expires_at < now();
$job$);
