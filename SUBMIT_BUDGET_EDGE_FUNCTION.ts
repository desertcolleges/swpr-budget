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
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      {
        status: 405,
        headers: { "Content-Type": "application/json" }
      }
    );
  }

  try {
    const body = await req.json();
    console.log("Request body received:", body);

    const {
      institution,
      requesterName,
      requesterEmail,
      justification,
      modifications
    } = body;

    if (!institution || !requesterName || !requesterEmail || !justification) {
      console.log("Missing required fields");
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    if (!Array.isArray(modifications) || modifications.length === 0) {
      console.log("No modifications provided");
      return new Response(
        JSON.stringify({ error: "No modifications provided" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    console.log("Validating modifications...");
    let currentTotal = 0;
    let proposedTotal = 0;

    for (const mod of modifications) {
      const current = parseFloat(mod.current_budget) || 0;
      const proposed = parseFloat(mod.proposed_budget) || 0;

      if (proposed < 0) {
        console.log("Negative budget amount detected");
        return new Response(
          JSON.stringify({
            error: "Budget amounts cannot be negative"
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      currentTotal += current;
      proposedTotal += proposed;
    }

    console.log(
      "Budget totals - Current:",
      currentTotal,
      "Proposed:",
      proposedTotal
    );

    if (Math.abs(currentTotal - proposedTotal) >= 0.005) {
      console.log("Budget totals do not match");
      return new Response(
        JSON.stringify({
          error: "Proposed budget must equal current budget"
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const requestNumber =
      "REQ-" +
      crypto
        .getRandomValues(new Uint8Array(4))
        .reduce((a: string, b: number) => a + b.toString(16), "")
        .substring(0, 8)
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
          status: "Pending"
        })
        .select()
        .single();

    if (insertError) {
      console.error("Insert error:", insertError);
      return new Response(
        JSON.stringify({ error: "Failed to create submission" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    console.log("Submission created:", submission.id);

    const modificationRows = modifications.map(
      (mod: Record<string, unknown>) => ({
        submission_id: submission.id,
        title: mod.title,
        activity_title: mod.activity_title,
        budget_item_description: mod.budget_item_description,
        object_code: mod.object_code,
        current_budget: parseFloat(
          mod.current_budget as string
        ) || 0,
        proposed_budget: parseFloat(
          mod.proposed_budget as string
        ) || 0,
        current_expenditure: 0,
        proposed_description: mod.proposed_description
      })
    );

    console.log("Inserting", modificationRows.length, "modifications");

    const { error: modError } = await supabase
      .from("submission_modifications")
      .insert(modificationRows);

    if (modError) {
      console.error("Modification insert error:", modError);
      return new Response(
        JSON.stringify({
          error: "Failed to create modifications"
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
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
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      }
    );
  } catch (error) {
    console.error("Error:", error);

    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error"
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      }
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
  const requesterLink = `${appBaseUrl}?requestId=${requestNumber}`;

  const adminEmailBody = `
    <h2>Budget Modification Request Submitted</h2>
    <p><strong>Request ID:</strong> ${requestNumber}</p>
    <p><strong>Requester:</strong> ${requesterName}</p>
    <p><strong>Email:</strong> ${requesterEmail}</p>
    <p><strong>Institution:</strong> ${institution}</p>
    <p><a href="${adminLink}">View Request in Admin Dashboard</a></p>
  `;

  const requesterEmailBody = `
    <h2>Budget Modification Request Received</h2>
    <p>Dear ${requesterName},</p>
    <p>Your budget modification request has been submitted and is pending review.</p>
    <p><strong>Request ID:</strong> ${requestNumber}</p>
    <p>You will receive an email notification when your request has been reviewed.</p>
    <p>If you have any questions, please contact your administrator.</p>
  `;

  try {
    console.log("Sending admin notification to:", adminEmail);

    const adminResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resendApiKey}`
      },
      body: JSON.stringify({
        from: "noreply@desertcolleges.org",
        to: adminEmail.trim(),
        subject: `Budget Modification Request: ${requestNumber}`,
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
          Authorization: `Bearer ${resendApiKey}`
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
