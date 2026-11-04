import { appUrl, client, email, escapeHtml, hashToken, json } from "./supabase/functions/_shared/http.ts";

export async function handleSubmission(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return json(null);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const body = await req.json();
    const { institution, requesterName, requesterEmail, justification, modifications, round, baselineHash } = body;
    if (typeof institution !== "string" || typeof requesterName !== "string" || !requesterName.trim()
      || typeof requesterEmail !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requesterEmail)
      || typeof justification !== "string" || !justification.trim() || !/^R[1-9][0-9]*$/.test(round)
      || !Array.isArray(modifications) || !modifications.length || !/^[a-f0-9]{32}$/.test(baselineHash)) {
      return json({ error: "Complete all required fields and reopen the budget if necessary." }, 400);
    }
    for (const mod of modifications) {
      if (!Number.isSafeInteger(mod.proposed_budget) || mod.proposed_budget < 0
        || !Number.isFinite(mod.current_budget) || mod.current_budget < 0
        || !/^[1-6]000s$/.test(mod.object_category) || (mod.round && mod.round !== round)) {
        return json({ error: "Budget amounts must be nonnegative whole dollars, with valid categories and matching rounds." }, 400);
      }
    }
    const draftHash = body.draftToken ? await hashToken(body.draftToken) : null;
    const { data, error } = await client().rpc("submit_budget_request", {
      p_institution: institution, p_round: round, p_name: requesterName, p_email: requesterEmail,
      p_justification: justification, p_lines: modifications, p_baseline_hash: baselineHash,
      p_draft_hash: draftHash, p_draft_version: body.draftVersion ?? null
    });
    if (error) return json({ error: error.message }, 409);
    const warnings: string[] = [];
    let baseUrl = appUrl();
    try {
      new URL(baseUrl);
    } catch {
      warnings.push("APP_BASE_URL is invalid; notification links use the default site URL");
      baseUrl = "https://desertcolleges.github.io/swpr-budget/";
    }
    const statusUrl = new URL("status.html", baseUrl);
    statusUrl.searchParams.set("requestId", data.request_number);
    const notifications = [
      {
        to: requesterEmail,
        subject: `Budget Request ${data.resubmitted ? "Resubmitted" : "Received"}: ${data.request_number}`,
        html: `<h2>Budget request received</h2><p>Hello ${escapeHtml(requesterName)},</p>
          <p>Your ${escapeHtml(round)} request for ${escapeHtml(institution)} is pending review.</p>
          <p><a href="${escapeHtml(statusUrl.href)}">View request ${escapeHtml(data.request_number)}</a></p>`
      },
      {
        to: Deno.env.get("ADMIN_NOTIFICATION_EMAIL") || "taylor@desertcolleges.org",
        subject: `Budget Request${data.resubmitted ? " Resubmitted" : ""}: ${data.request_number}`,
        html: `<h2>Budget request ${data.resubmitted ? "resubmitted" : "submitted"}</h2>
          <p>${escapeHtml(requesterName)} (${escapeHtml(requesterEmail)}) — ${escapeHtml(institution)}, ${escapeHtml(round)}</p>
          <p><a href="${escapeHtml(new URL("admin.html", baseUrl).href)}">Review in admin dashboard</a></p>`
      }
    ];
    await Promise.all(notifications.map(async notification => {
      try {
        await email(notification.to, notification.subject, notification.html);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Email delivery failed";
        console.error("Submission notification failed:", message);
        warnings.push(message);
      }
    }));
    return json({ success: true, ...data, email_warning: warnings.length ? warnings.join("; ") : null });
  } catch (error) {
    console.error("Submission failed:", error instanceof Error ? error.message : "Unknown error");
    return json({ error: "Unable to submit request. Please try again." }, 500);
  }
}

if (import.meta.main) Deno.serve(handleSubmission);
