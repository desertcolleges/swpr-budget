import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const resendApiKey = Deno.env.get("RESEND_API_KEY") || "";
const replyToEmail = Deno.env.get("REPLY_TO_EMAIL") || Deno.env.get("ADMIN_NOTIFICATION_EMAIL") || "taylor@desertcolleges.org";
const appBaseUrl = (Deno.env.get("APP_BASE_URL") || "https://desertcolleges.github.io/swpr-budget").replace(/\/$/, "");

function escapeHtml(value: unknown): string {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// The admin page sends an apikey header; it must be allowed in the preflight,
// and CORS headers must be on every response or the browser blocks the reply.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info"
};
const jsonHeaders = { "Content-Type": "application/json", ...corsHeaders };

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: jsonHeaders }
    );
  }

  try {
    const body = await req.json();
    const { requester_email, request_number, action, notes } = body;

    if (!requester_email || !request_number || !action) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: jsonHeaders }
      );
    }

    if (!resendApiKey) {
      console.error("RESEND_API_KEY is not configured");
      throw new Error("RESEND_API_KEY is not configured");
    }

    const statusLink = `${appBaseUrl}/status.html?requestId=${encodeURIComponent(request_number)}`;
    if (!["Approved", "Rejected", "Finalized"].includes(action)) {
      return new Response(
        JSON.stringify({ error: "Unsupported action" }),
        { status: 400, headers: jsonHeaders }
      );
    }

    const subject = action === "Approved"
      ? `Your request ${request_number} has been approved`
      : action === "Finalized"
        ? `Your request ${request_number} has been finalized`
        : `Your request ${request_number} has been rejected`;

    const escapedRequest = escapeHtml(request_number);
    const escapedNotes = escapeHtml(notes || "No rejection reason provided.");

    const htmlBody = action === "Finalized"
      ? `
        <h2>Request Finalized</h2>
        <p>Your request <strong>${escapedRequest}</strong> has been finalized and your budget has been updated.</p>
        <p><a href="${statusLink}">View Request Status Record</a></p>
        <p>If you need further changes, you may now submit a new modification request.</p>
      `
      : action === "Approved"
      ? `
        <h2>Request Approved</h2>
        <p>Your request <strong>${escapedRequest}</strong> has been approved.</p>
        <p><a href="${statusLink}">View Request Status Record</a></p>
        <p>You can print or save the status record from the portal using your browser print dialog.</p>
      `
      : `
        <h2>Request Rejected</h2>
        <p>Your request <strong>${escapedRequest}</strong> has been rejected.</p>
        <p><strong>Reason:</strong> ${escapedNotes}</p>
        <p><a href="${statusLink}">View Request Status Record</a></p>
        <p>You can edit and resubmit this request from the requester form.</p>
      `;

    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + resendApiKey,
      },
      body: JSON.stringify({
        from: "noreply@desertcolleges.org",
        to: requester_email,
        reply_to: replyToEmail,
        subject,
        html: htmlBody
      })
    });

    const result = await resendResponse.json();

    if (!resendResponse.ok) {
      console.error("Resend error:", resendResponse.status, JSON.stringify(result));
      return new Response(
        JSON.stringify({ error: result.message || "Failed to send email" }),
        { status: resendResponse.status, headers: jsonHeaders }
      );
    }

    return new Response(
      JSON.stringify({ success: true, messageId: result.id }),
      { status: 200, headers: jsonHeaders }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: jsonHeaders }
    );
  }
});
