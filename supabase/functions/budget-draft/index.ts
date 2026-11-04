import { appUrl, client, email, escapeHtml, hashToken, json } from "../_shared/http.ts";

export async function handleDraft(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return json(null);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const body = await req.json();
    const tokenHash = await hashToken(body.token);
    const db = client();
    if (body.action === "load") {
      const { data, error } = await db.from("budget_drafts")
        .select("institution,round,requester_name,requester_email,payload,version,updated_at,expires_at,submitted_request")
        .eq("token_hash", tokenHash).gt("expires_at", new Date().toISOString()).maybeSingle();
      if (error) throw new Error("Unable to load saved draft");
      if (!data) return json({ error: "This draft link is invalid or expired." }, 404);
      return json(data);
    }
    if (body.action !== "save") return json({ error: "Unknown draft action" }, 400);
    if (!Number.isInteger(body.version) || body.version < 0 || typeof body.requesterName !== "string"
      || !body.requesterName.trim() || typeof body.requesterEmail !== "string"
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.requesterEmail)
      || !Array.isArray(body.payload?.projects) || JSON.stringify(body.payload).length > 1000000) {
      return json({ error: "Provide your name, a valid email address, and draft details." }, 400);
    }
    // Incomplete budgets are allowed; malformed amounts and structure are not.
    for (const project of body.payload.projects) {
      if (typeof project.name !== "string" || !project.name.trim() || !Array.isArray(project.activities)) {
        return json({ error: "Invalid draft project" }, 400);
      }
      for (const activity of project.activities) {
        if (typeof activity.name !== "string" || !activity.name.trim() || !Array.isArray(activity.categoryRows)
          || activity.categoryRows.length !== 6 || new Set(activity.categoryRows.map((r: { object_category: string }) => r.object_category)).size !== 6) {
          return json({ error: "Invalid draft activity" }, 400);
        }
        for (const row of activity.categoryRows) {
          if (!/^[1-6]000s$/.test(row.object_category) || !Number.isSafeInteger(row.proposed_budget) || row.proposed_budget < 0
            || typeof row.proposed_budget_description !== "string") return json({ error: "Invalid draft budget amount or category" }, 400);
        }
      }
    }
    const { data, error } = await db.rpc("save_budget_draft", {
      p_token_hash: tokenHash, p_version: body.version, p_institution: body.institution,
      p_round: body.round, p_name: body.requesterName, p_email: body.requesterEmail, p_payload: body.payload
    });
    if (error) return json({ error: error.message }, 409);
    let emailWarning: string | null = null;
    if (body.sendEmail === true) {
      try {
        const link = new URL(appUrl());
        // The fragment avoids sending the access token in referrers or HTTP access logs.
        link.hash = `draft=${body.token}`;
        await email(body.requesterEmail, `Budget draft saved: ${body.institution} ${body.round}`, `
          <h2>Your budget modification draft is saved</h2>
          <p>Hello ${escapeHtml(body.requesterName)},</p>
          <p>Your ${escapeHtml(body.round)} draft for ${escapeHtml(body.institution)} has been saved.
          It has not been submitted for approval.</p>
          <p><a href="${escapeHtml(link.href)}">Continue working on your modification</a></p>
          <p>This private link allows editing. Do not forward it. It expires after 90 days without a save.</p>`);
      } catch (error) {
        emailWarning = error instanceof Error ? error.message : "Confirmation email could not be delivered";
        console.error("Draft confirmation delivery failed:", emailWarning);
      }
    }
    return json({ ...data, email_warning: emailWarning });
  } catch (error) {
    console.error("Draft operation failed:", error instanceof Error ? error.message : "Unknown error");
    return json({ error: error instanceof Error ? error.message : "Unable to save draft" }, 400);
  }
}

if (import.meta.main) Deno.serve(handleDraft);
