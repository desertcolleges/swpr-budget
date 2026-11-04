export interface Expenditure {
  institution: string;
  round: string;
  project: string;
  object_category: string;
  expenditure_amount: number;
}

export function parseSheet(values: unknown[][]): Expenditure[] {
  if (!Array.isArray(values) || values.length < 2) throw new Error("The Sheet has no expenditure rows; previous data was retained");
  const columns = values[0].map(v => String(v).trim().toLowerCase().replaceAll(" ", "_"));
  const required = ["institution", "round", "project", "object_category", "expenditure_amount"];
  for (const column of required) {
    if (columns.filter(c => c === column).length !== 1) throw new Error(`Sheet must contain exactly one ${column} column`);
  }
  const seen = new Set<string>();
  const result: Expenditure[] = [];
  values.slice(1).forEach((row, index) => {
    if (row.every(cell => String(cell ?? "").trim() === "")) return;
    const get = (column: string) => String(row[columns.indexOf(column)] ?? "").trim();
    const institution = get("institution");
    const project = get("project");
    const round = get("round").toUpperCase();
    const object_category = get("object_category").toLowerCase().replace(/s$/, "") + "s";
    const amount = get("expenditure_amount");
    if (!institution || !project || !/^R[1-9][0-9]*$/.test(round) || !/^[1-6]000s$/.test(object_category)
      || !/^-?\d+(\.\d{1,2})?$/.test(amount) || !Number.isFinite(Number(amount))
      || Math.abs(Number(amount)) > Number.MAX_SAFE_INTEGER / 100) throw new Error(`Invalid expenditure data on Sheet row ${index + 2}`);
    const key = JSON.stringify([institution.toLowerCase(), round, project.toLowerCase(), object_category]);
    if (seen.has(key)) throw new Error(`Duplicate project/category total on Sheet row ${index + 2}`);
    seen.add(key);
    result.push({ institution, round, project, object_category, expenditure_amount: Number(amount) });
  });
  if (!result.length) throw new Error("Empty imports are not allowed; previous data was retained");
  return result;
}

function base64url(bytes: Uint8Array) {
  return btoa(Array.from(bytes, b => String.fromCharCode(b)).join("")).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function sheetValues(credentials: string, sheetId: string, range: string): Promise<unknown[][]> {
  const account = JSON.parse(credentials);
  if (!account.client_email || !account.private_key) throw new Error("Google service account credentials are incomplete");
  const encode = (v: unknown) => base64url(new TextEncoder().encode(JSON.stringify(v)));
  const now = Math.floor(Date.now() / 1000);
  const message = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: account.client_email, scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600
  })}`;
  const pem = account.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), c => c.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(message));
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${message}.${base64url(new Uint8Array(signature))}`
    }), signal: AbortSignal.timeout(20000)
  });
  if (!tokenResponse.ok) throw new Error(`Google authorization failed (${tokenResponse.status})`);
  const token = await tokenResponse.json();
  if (!token.access_token) throw new Error("Google did not return an access token");
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`, {
    headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`Unable to read the Google Sheet (${response.status})`);
  const data = await response.json();
  return data.values || [];
}
