import { handleDraft } from "../budget-draft/index.ts";
import { handleSync } from "../sync-expenditures/index.ts";
import { handleSubmission } from "../../../SUBMIT_BUDGET_EDGE_FUNCTION.ts";
import { hashToken } from "./http.ts";

function assert(condition: boolean, message = "Assertion failed") {
  if (!condition) throw new Error(message);
}
const request = (body: unknown, bearer?: string) => new Request("http://localhost/function", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
  body: JSON.stringify(body)
});

Deno.test("draft/submission email failures retain success, links use hashed tokens, and sync authorizes and validates", async () => {
  const keys = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "RESEND_API_KEY", "APP_BASE_URL",
    "GOOGLE_SERVICE_ACCOUNT_JSON", "EXPENDITURE_SHEET_ID", "EXPENDITURE_SHEET_RANGE", "EXPENDITURE_SYNC_SECRET"];
  const previous = new Map(keys.map(key => [key, Deno.env.get(key)]));
  const originalFetch = globalThis.fetch;
  let draftHash = "";
  let committed = 0;
  let sheetInvalid = false;
  let emailedHtml = "";
  let errorRecorded = false;
  try {
    Deno.env.set("SUPABASE_URL", "http://localhost:54321");
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
    Deno.env.set("APP_BASE_URL", "https://example.invalid/");
    Deno.env.set("EXPENDITURE_SYNC_SECRET", "test-scheduled-secret");
    Deno.env.delete("RESEND_API_KEY");
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
        status, headers: { "Content-Type": "application/json" }
      });
      if (url.pathname.endsWith("/save_budget_draft")) {
        const body = JSON.parse(String(init?.body));
        draftHash = body.p_token_hash;
        return response({ version: 1, updated_at: new Date().toISOString() });
      }
      if (url.pathname.endsWith("/submit_budget_request")) return response({ request_number: "REQ-TEST", resubmitted: false });
      if (url.pathname.endsWith("/emails")) {
        emailedHtml = JSON.parse(String(init?.body)).html;
        return response({ error: "Provider unavailable" }, 503);
      }
      if (url.pathname.endsWith("/token")) return response({ access_token: "test-google-token" });
      if (url.hostname === "sheets.googleapis.com") return response({ values: [
        ["institution", "round", "project", "object_category", "expenditure_amount"],
        ["College", "R10", "Project R10", sheetInvalid ? "7000" : "1000", 123]
      ] });
      if (url.pathname.endsWith("/replace_expenditure_snapshot")) {
        committed++;
        return response(1);
      }
      if (url.pathname.endsWith("/expenditure_sync_state")) {
        const body = JSON.parse(String(init?.body || "{}"));
        if (body.last_error) errorRecorded = true;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected test request: ${url.pathname}`);
    };
    const token = "f".repeat(64);
    const draftBody = { action: "save", token, version: 0, requesterName: "Requester",
      requesterEmail: "requester@example.invalid", institution: "College", round: "R10",
      payload: { projects: [], justification: "", baselineHash: "a".repeat(32) }, sendEmail: true };
    const saved = await handleDraft(request(draftBody));
    const result = await saved.json();
    assert(saved.status === 200 && result.version === 1 && result.email_warning.includes("not configured"));
    assert(draftHash === await hashToken(token) && draftHash !== token);
    Deno.env.set("RESEND_API_KEY", "test-email-key");
    const emailFailure = await (await handleDraft(request(draftBody))).json();
    assert(emailFailure.email_warning.includes("503"));
    assert(emailedHtml.includes(`#draft=${token}`) && emailedHtml.includes("not been submitted"));
    const invalidDraft = await handleDraft(request({ ...draftBody, payload: { projects: [{
      name: "P", activities: [{ name: "A", categoryRows: [] }]
    }] } }));
    assert(invalidDraft.status === 400);
    const submission = await handleSubmission(request({ institution: "College", round: "R10",
      requesterName: "Requester", requesterEmail: "requester@example.invalid", justification: "Reason",
      baselineHash: "a".repeat(32), modifications: [{ title: "Project", activity_title: "Activity",
        object_category: "1000s", current_budget: 0, proposed_budget: 100, proposed_budget_description: "Budget" }]
    }));
    assert(submission.status === 200 && (await submission.json()).email_warning.includes("503"));
    assert((await handleSync(request({}))).status === 401);
    const generated = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", generated.privateKey));
    const pem = btoa(Array.from(pkcs8, b => String.fromCharCode(b)).join(""));
    Deno.env.set("GOOGLE_SERVICE_ACCOUNT_JSON", JSON.stringify({
      client_email: "test@example.invalid", private_key: `-----BEGIN PRIVATE KEY-----\n${pem}\n-----END PRIVATE KEY-----`
    }));
    Deno.env.set("EXPENDITURE_SHEET_ID", "test-sheet");
    Deno.env.set("EXPENDITURE_SHEET_RANGE", "Expenditures!A:E");
    assert((await handleSync(request({}, "test-scheduled-secret"))).status === 200);
    assert(committed === 1);
    sheetInvalid = true;
    assert((await handleSync(request({}, "test-scheduled-secret"))).status === 500);
    assert(committed === 1 && errorRecorded, "Invalid snapshot must not replace the previous data");
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
});
