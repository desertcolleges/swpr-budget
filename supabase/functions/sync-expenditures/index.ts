import { client, json } from "../_shared/http.ts";
import { parseSheet, sheetValues } from "../_shared/sheets.ts";

export async function handleSync(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return json(null);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const startedAt = new Date().toISOString();
  let db: ReturnType<typeof client> | undefined;
  try {
    db = client();
    const bearer = req.headers.get("Authorization")?.replace(/^Bearer /, "") || "";
    const scheduledSecret = Deno.env.get("EXPENDITURE_SYNC_SECRET");
    // Scheduled calls use a separate secret; interactive calls require an active admin.
    if (!scheduledSecret || bearer !== scheduledSecret) {
      const { data: user, error } = await db.auth.getUser(bearer);
      if (error || !user.user) return json({ error: "Authentication required" }, 401);
      const { data: admin, error: adminError } = await db.from("admin_users").select("user_id")
        .eq("user_id", user.user.id).eq("active", true).maybeSingle();
      if (adminError) throw new Error("Unable to verify admin access");
      if (!admin) return json({ error: "Admin access required" }, 403);
    }
    const credentials = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
    const sheetId = Deno.env.get("EXPENDITURE_SHEET_ID");
    const range = Deno.env.get("EXPENDITURE_SHEET_RANGE");
    if (!credentials || !sheetId || !range) throw new Error("Google Sheet sync is not configured");
    const { error: attemptError } = await db.from("expenditure_sync_state").update({ last_attempt_at: startedAt }).eq("id", 1);
    if (attemptError) throw new Error("Unable to record sync attempt");
    const rows = parseSheet(await sheetValues(credentials, sheetId, range));
    const { data, error } = await db.rpc("replace_expenditure_snapshot", { p_rows: rows, p_started_at: startedAt });
    if (error) throw new Error(error.message);
    return json({ success: true, row_count: data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Expenditure sync failed";
    console.error("Expenditure sync failed:", message);
    if (db) {
      const { error: recordError } = await db.from("expenditure_sync_state")
        .update({ last_error: message, last_attempt_at: startedAt }).eq("id", 1)
        .or(`last_success_at.is.null,last_success_at.lt.${startedAt}`);
      if (recordError) console.error("Unable to record sync failure:", recordError.message);
    }
    return json({ error: message }, 500);
  }
}

if (import.meta.main) Deno.serve(handleSync);
