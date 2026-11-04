import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';

const root = resolve('.');
const fingerprint = 'a'.repeat(32);
const budgetRows = [
  { institution: 'College', round: 'R10', title: 'Project R10', activity_title: 'Activity A',
    object_code: '1000', budget: 100, budget_item_description: 'Description A' },
  { institution: 'College', round: 'R10', title: 'Project R10', activity_title: 'Activity A',
    object_code: '2000', budget: 200, budget_item_description: 'Description B' }
];

function mockClient() {
  const fixture = window.__fixture;
  const answer = (table, filters, single) => {
    const rows = {
      site_config: [{ id: 1, visible_rounds: ['R10'] }],
      college_allocations: [{ institution: 'College', round: 'R10', allocation_amount: 300 }],
      projects: [{ id: 'p1', name: 'Project R10', round: 'R10', is_active: true, project_activities: [{ id: 'a1', activity_name: 'Activity A' }] }],
      institutions: [{ id: 'i1', name: 'College', is_active: true }],
      expenditure_sync_state: [{ id: 1, last_success_at: new Date().toISOString(), row_count: 1 }],
      admin_users: [{ user_id: 'admin', active: true }],
      budget_submissions: [], budget_changes: [], admin_allowlist: []
    }[table] || [];
    const filtered = rows.filter(row => filters.every(([key, value]) => row[key] === value));
    return { data: single ? filtered[0] || null : filtered, error: null };
  };
  window.supabase = { createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'admin-token', user: { id: 'admin', email: 'admin@desertcolleges.org' } } }, error: null }),
      signOut: async () => ({ error: null })
    },
    rpc: async (name, params) => {
      if (name === 'get_public_institutions') return { data: [{ institution: 'College' }], error: null };
      if (name === 'claim_admin_access') return { data: true, error: null };
      if (name === 'get_budget_snapshot') return { data: { rows: fixture.rows, fingerprints: { R10: fixture.fingerprint }, empty_fingerprint: 'b'.repeat(32) }, error: null };
      if (name === 'get_expenditures') return { data: [{ round: 'R10', project: 'Project R10', object_category: '1000s', expenditure_amount: 120 }], error: null };
      if (name === 'admin_save_budget') {
        window.__adminSave = params;
        fixture.rows = params.p_lines.map(row => ({ title: row.title, activity_title: row.activity_title,
          institution: params.p_institution, round: params.p_round, object_code: row.object_code,
          budget: row.proposed_budget, budget_item_description: row.proposed_budget_description }));
        return { data: 'change-id', error: null };
      }
      return { data: [], error: null };
    },
    from(table) {
      const filters = [];
      let single = false;
      const query = new Proxy({}, {
        get(_, method) {
          if (method === 'then') return (ok, fail) => Promise.resolve(answer(table, filters, single)).then(ok, fail);
          return (...args) => {
            if (method === 'eq') filters.push(args);
            if (method === 'single' || method === 'maybeSingle') single = true;
            return query;
          };
        }
      });
      return query;
    }
  }) };
}

test('requester drafts, compact responsive fields, project expenditure totals, and admin override', async () => {
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(root + '/')) throw new Error('Invalid path');
      const bytes = await readFile(file);
      res.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png' }[extname(file)] || 'text/plain');
      res.end(bytes);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1024, height: 800 } });
    await context.addInitScript({ content: `window.__fixture = ${JSON.stringify({ rows: budgetRows, fingerprint })};` });
    await context.route('https://cdn.jsdelivr.net/**', route => route.fulfill({
      contentType: 'text/javascript', body: `(${mockClient.toString()})();`
    }));
    const drafts = new Map();
    const submissions = [];
    await context.route('**/functions/v1/**', async route => {
      const body = route.request().postDataJSON();
      if (route.request().url().endsWith('/budget-draft')) {
        if (body.action === 'load') {
          return route.fulfill({ json: drafts.get(body.token) });
        }
        const old = drafts.get(body.token);
        if (old && old.version !== body.version) return route.fulfill({ status: 409, json: { error: 'Draft changed in another window' } });
        const saved = { institution: body.institution, round: body.round, requester_name: body.requesterName,
          requester_email: body.requesterEmail, payload: body.payload, version: (old?.version || 0) + 1,
          updated_at: new Date().toISOString() };
        drafts.set(body.token, saved);
        return route.fulfill({ json: { version: saved.version, updated_at: saved.updated_at } });
      }
      if (route.request().url().endsWith('/submit-budget')) {
        submissions.push(body);
        if (body.draftToken) drafts.get(body.draftToken).submitted_request = 'REQ-TEST';
        return route.fulfill({ json: { request_number: 'REQ-TEST', success: true } });
      }
      return route.fulfill({ json: { success: true, row_count: 1 } });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url);
    await page.selectOption('#institutionSelect', 'College');
    await page.click('#loadBudgetButton');
    await page.click('[data-round="R10"]');
    assert.equal(await page.textContent('#roundExpenditureTotal'), '$120.00');
    assert.equal(await page.textContent('#roundCurrentTotal'), '$300.00');
    assert.match(await page.textContent('#budgetResults'), /1000s/);
    assert.match(await page.textContent('#budgetResults'), /6000s/);
    await page.click('#startModificationButton');
    const amount = page.locator('[data-category="1000s"] input[data-field="proposed_budget"]');
    await amount.fill('120');
    assert.equal(await page.locator('#submitButton').isDisabled(), true);
    await page.click('#saveDraftButton');
    await page.fill('#draftName', 'Test Requester');
    await page.fill('#draftEmail', 'requester@example.invalid');
    await page.click('#draftContactForm button[type="submit"]');
    await page.waitForFunction(() => document.getElementById('draftSaveStatus').textContent.includes('Confirmation email sent'));
    const link = await page.getAttribute('#resumeDraftLink', 'href');
    assert.ok(link.includes('#draft='));
    const resumed = await context.newPage();
    resumed.on('pageerror', e => errors.push(e.message));
    await resumed.goto(link);
    await resumed.waitForFunction(() => !document.getElementById('modificationSection').classList.contains('hidden'));
    assert.equal(await resumed.inputValue('[data-category="1000s"] input'), '120');
    assert.equal(await resumed.inputValue('#requesterEmail'), 'requester@example.invalid');
    const description = resumed.locator('[data-category="1000s"] textarea');
    const long = 'A readable, detailed description of the planned budget change. '.repeat(12);
    await description.fill(long);
    await resumed.waitForFunction(() => document.getElementById('draftSaveStatus').textContent.startsWith('Draft saved at'));
    for (const width of [1024, 768, 640, 390]) {
      await resumed.setViewportSize({ width, height: 800 });
      const bounds = await description.boundingBox();
      assert.ok(bounds.width >= (width >= 768 ? 190 : 250), `description width at ${width}: ${bounds.width}`);
      assert.ok(bounds.x + bounds.width <= width, `description inside viewport at ${width}`);
      assert.ok(await description.evaluate(el => el.scrollHeight <= el.clientHeight + 2), `description not clipped at ${width}`);
      assert.ok(await resumed.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `no page overflow at ${width}`);
    }
    await resumed.fill('[data-category="1000s"] input', '100');
    await resumed.fill('#justification', 'A tested modification');
    await resumed.click('#submitButton');
    await resumed.waitForFunction(() => document.getElementById('messageArea').textContent.includes('REQ-TEST'));
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].baselineHash, fingerprint);
    assert.ok(submissions[0].draftToken);
    assert.equal(submissions[0].modifications[0].proposed_budget_description, long.trim());
    const admin = await context.newPage();
    admin.on('pageerror', e => errors.push(e.message));
    await admin.goto(`${url}/admin.html#budgets`);
    await admin.waitForFunction(() => document.getElementById('adminBudgetInstitution').options.length > 0);
    await admin.selectOption('#adminBudgetRound', 'R10');
    await admin.click('#adminBudgetLoadForm button');
    await admin.waitForFunction(() => !document.getElementById('adminBudgetSection').classList.contains('hidden'));
    await admin.fill('#adminBudgetEditor input[data-category="1000s"]', '500');
    await admin.fill('#adminBudgetReason', 'Budget override beyond allocation');
    assert.equal(await admin.locator('#adminBudgetSaveButton').isDisabled(), false);
    admin.once('dialog', dialog => dialog.accept());
    await admin.click('#adminBudgetSaveButton');
    await admin.waitForFunction(() => window.__adminSave);
    assert.equal(await admin.evaluate(() => window.__adminSave.p_lines.reduce((n, r) => n + r.proposed_budget, 0)), 700);
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser?.close();
    await new Promise(ok => server.close(ok));
  }
});
