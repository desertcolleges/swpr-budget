import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseServiceKey =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const resendApiKey = Deno.env.get("RESEND_API_KEY") || "";
const adminEmail =
  Deno.env.get("ADMIN_NOTIFICATION_EMAIL") || "taylor@desertcolleges.org";
const appBaseUrl =
  Deno.env.get("APP_BASE_URL") ||
  "https://desertcolleges.github.io/swpr-budget-mod/";

console.log("Environment check:");
console.log("supabaseUrl:", supabaseUrl ? "set" : "MISSING");
console.log("supabaseServiceKey:", supabaseServiceKey ? "set" : "MISSING");
console.log("resendApiKey:", resendApiKey ? "set" : "MISSING");
console.log("adminEmail:", adminEmail);
console.log("appBaseUrl:", appBaseUrl);

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const jsonHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*"
};

function errorResponse(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: jsonHeaders
  });
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

serve(async (req) => {
  console.log("Request received:", req.method, req.url);

  if (req.method === "OPTIONS") {
    console.log("Handling CORS preflight");
    return new Response(null, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, apikey"
      }
    });
  }

  if (req.method !== "POST") {
    console.log("Invalid method:", req.method);
    return errorResponse("Method not allowed", 405);
  }

  try {
    const body = await req.json();
    console.log("Request body received:", body);

    const {
      institution,
      requesterName,
      requesterEmail,
      justification,
      modifications,
      round
    } = body;

    if (
      !institution ||
      !requesterName ||
      !requesterEmail ||
      !justification ||
      !round
    ) {
      console.log("Missing required fields");
      return errorResponse("Missing required fields");
    }

    const roundKey = String(round).toUpperCase().trim();

    if (!Array.isArray(modifications) || modifications.length === 0) {
      console.log("No modifications provided");
      return errorResponse("No modifications provided");
    }

    console.log("Validating modifications...");
    let proposedTotal = 0;

    for (const mod of modifications) {
      const proposed = Number(mod.proposed_budget ?? 0);

      if (
        !Number.isFinite(proposed) ||
        proposed < 0 ||
        !Number.isInteger(proposed)
      ) {
        console.log("Invalid budget amount detected");
        return errorResponse(
          "Budget amounts must be non-negative whole dollars"
        );
      }

      const modRound = String(mod.round ?? roundKey).toUpperCase().trim();
      if (modRound !== roundKey) {
        return errorResponse(
          "Modification round does not match request round"
        );
      }

      proposedTotal += proposed;
    }

    // The proposed total must equal the college's allocation for the round,
    // including for an initial budget.
    const { data: allocation, error: allocError } = await supabase
      .from("college_allocations")
      .select("allocation_amount")
      .eq("institution", institution)
      .eq("round", roundKey)
      .maybeSingle();

    if (allocError) {
      console.error("Allocation lookup error:", allocError);
      return errorResponse("Unable to verify allocation", 500);
    }

    const allocated = Number(allocation?.allocation_amount);

    if (!allocation || !(allocated > 0)) {
      console.log("No allocation set");
      return errorResponse(
        `No ${roundKey} allocation is set for this institution`
      );
    }

    console.log(
      "Budget totals - Allocation:",
      allocated,
      "Proposed:",
      proposedTotal
    );

    if (Math.abs(proposedTotal - allocated) >= 0.005) {
      console.log("Proposed total does not equal allocation");
      return errorResponse(
        `Proposed budget must equal the ${roundKey} allocation`
      );
    }

    const requestNumber =
      "REQ-" +
      Array.from(crypto.getRandomValues(new Uint8Array(4)))
        .map((b: number) => b.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase();

    console.log("Creating submission with request number:", requestNumber);

    const { data: submission, error: insertError } =
      await supabase
        .from("budget_submissions")
        .insert({
          request_number: requestNumber,
          requester_name: requesterName,
          requester_email: requesterEmail,
          institution: institution,
          justification: justification,
          round: roundKey,
          status: "Pending"
        })
        .select()
        .single();

    if (insertError) {
      console.error("Insert error:", insertError);
      return errorResponse("Failed to create submission", 500);
    }

    console.log("Submission created:", submission.id);

    const modificationRows = modifications.map(
      (mod: Record<string, unknown>) => ({
        submission_id: submission.id,
        round: roundKey,
        title: mod.title,
        activity_title: mod.activity_title,
        object_category: mod.object_category,
        object_code: mod.object_code,
        current_budget: Number(mod.current_budget) || 0,
        proposed_budget: Number(mod.proposed_budget) || 0,
        current_budget_description: mod.current_budget_description,
        proposed_budget_description: mod.proposed_budget_description,
        activity_status: mod.activity_status,
        is_new_line: Boolean(mod.is_new_line),
        current_expenditure: 0
      })
    );

    console.log("Inserting", modificationRows.length, "modifications");

    const { error: modError } = await supabase
      .from("submission_modifications")
      .insert(modificationRows);

    if (modError) {
      console.error("Modification insert error:", modError);
      // Avoid leaving an orphaned submission without line items.
      await supabase
        .from("budget_submissions")
        .delete()
        .eq("id", submission.id);
      return errorResponse("Failed to create modifications", 500);
    }

    console.log("Modifications inserted successfully");

    console.log("Sending notification emails...");
    await sendEmails(
      requesterName,
      requesterEmail,
      institution,
      requestNumber
    );

    console.log("Returning success response");

    return new Response(
      JSON.stringify({
        success: true,
        request_number: requestNumber
      }),
      { status: 200, headers: jsonHeaders }
    );
  } catch (error) {
    console.error("Error:", error);

    return errorResponse(
      error instanceof Error ? error.message : "Unknown error",
      500
    );
  }
});

async function sendEmails(
  requesterName: string,
  requesterEmail: string,
  institution: string,
  requestNumber: string
) {
  if (!adminEmail || !adminEmail.includes("@")) {
    console.error("Invalid admin email:", adminEmail);
    return;
  }

  const adminLink = `${appBaseUrl}admin.html`;

  const adminEmailBody = `
    <h2>Budget Request Submitted</h2>
    <p><strong>Request ID:</strong> ${escapeHtml(requestNumber)}</p>
    <p><strong>Requester:</strong> ${escapeHtml(requesterName)}</p>
    <p><strong>Email:</strong> ${escapeHtml(requesterEmail)}</p>
    <p><strong>Institution:</strong> ${escapeHtml(institution)}</p>
    <p><a href="${adminLink}">View Request in Admin Dashboard</a></p>
  `;

  const requesterEmailBody = `
    <h2>Budget Request Received</h2>
    <p>Dear ${escapeHtml(requesterName)},</p>
    <p>Your budget request has been submitted and is pending review.</p>
    <p><strong>Request ID:</strong> ${escapeHtml(requestNumber)}</p>
    <p>You will receive an email notification when your request has been reviewed.</p>
    <p>If you have any questions, please contact your administrator.</p>
  `;

  try {
    console.log("Sending admin notification to:", adminEmail);

    const adminResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `******
      },
      body: JSON.stringify({
        from: "noreply@desertcolleges.org",
        to: adminEmail.trim(),
        subject: `Budget Request: ${requestNumber}`,
        html: adminEmailBody
      })
    });

    const adminResult = await adminResponse.json();
    console.log("Admin email result:", adminResult);

    console.log("Sending requester confirmation to:", requesterEmail);

    const requesterResponse = await fetch(
      "https://api.resend.com/emails",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `******
        },
        body: JSON.stringify({
          from: "noreply@desertcolleges.org",
          to: requesterEmail.trim(),
          subject: `Budget Request Received: ${requestNumber}`,
          html: requesterEmailBody
        })
      }
    );

    const requesterResult = await requesterResponse.json();
    console.log("Requester email result:", requesterResult);
  } catch (error) {
    console.error("Email send error:", error);
  }
}
