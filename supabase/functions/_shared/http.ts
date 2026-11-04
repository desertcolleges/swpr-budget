import { createClient } from "npm:@supabase/supabase-js@2";

export const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}

export function client() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Backend credentials are not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function hashToken(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid saved draft link");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

export function escapeHtml(value: unknown) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

export async function email(to: string, subject: string, html: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) throw new Error("Email delivery is not configured");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({
      from: Deno.env.get("NOTIFICATION_FROM_EMAIL") || "noreply@desertcolleges.org",
      to, subject, html
    })
  });
  if (!response.ok) throw new Error(`Email provider rejected delivery (${response.status})`);
}

export function appUrl() {
  return Deno.env.get("APP_BASE_URL") || "https://desertcolleges.github.io/swpr-budget/";
}
