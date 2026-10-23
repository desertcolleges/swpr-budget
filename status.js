const SUPABASE_URL = 'https://dfghvbhidpzxjdcczcck.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_IXoPGcfK7o5LbccQvk6g9g_cWbtfrH2';

const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
);

const state = {
  request: null,
  modifications: []
};

document.addEventListener('DOMContentLoaded', () => {
  document
    .getElementById('lookupForm')
    .addEventListener('submit', handleLookup);

  document
    .getElementById('printRecordButton')
    .addEventListener('click', () => window.print());

  const params = new URLSearchParams(window.location.search);
  const requestId = params.get('requestId') || '';

  if (requestId) {
    document.getElementById('requestNumberInput').value = requestId;
    void runDeepLinkLookup();
  }
});

async function runDeepLinkLookup() {
  try {
    await handleLookup({
      preventDefault() {}
    });
  } catch (error) {
    showMessage('Lookup failed: ' + (error?.message || 'Unknown error'), 'error');
  }
}

async function handleLookup(event) {
  event.preventDefault();

  const requestNumber =
    document.getElementById('requestNumberInput').value.trim();

  if (!requestNumber) {
    showMessage('Request number is required.', 'error');
    return;
  }

  try {
    showLoading(true);
    clearMessage();

    const { data, error } = await supabaseClient.rpc('get_request_status', {
      p_request_number: requestNumber
    });

    if (error) throw error;

    hydrateStatusData(data || []);

    if (!state.request) {
      throw new Error('No request matched that request number.');
    }

    renderStatusRecord();
  } catch (error) {
    document.getElementById('statusResultSection').classList.add('hidden');
    showMessage('Lookup failed: ' + error.message, 'error');
  } finally {
    showLoading(false);
  }
}

function hydrateStatusData(rows) {
  if (!rows.length) {
    state.request = null;
    state.modifications = [];
    return;
  }

  const first = rows[0];

  state.request = {
    request_number: first.request_number,
    requester_name: first.requester_name,
    requester_email: first.requester_email,
    institution: first.institution,
    round: first.round,
    status: first.status,
    admin_notes: first.admin_notes,
    justification: first.justification,
    created_at: first.created_at,
    reviewed_at: first.reviewed_at
  };

  state.modifications = rows
    .filter(row => row.title || row.activity_title || row.object_category || row.object_code)
    .map(row => ({
      title: row.title,
      activity_title: row.activity_title,
      object_category: row.object_category || inferObjectCategory(row.object_code),
      object_code: row.object_code,
      current_budget: row.current_budget,
      current_budget_description: row.current_budget_description || row.budget_item_description,
      proposed_budget: row.proposed_budget,
      proposed_budget_description: row.proposed_budget_description || row.proposed_description,
      is_new_line: row.is_new_line,
      round: row.modification_round || row.round
    }));
}

function renderStatusRecord() {
  const request = state.request;

  document.getElementById('statusResultSection').classList.remove('hidden');
  document.getElementById('statusRequestHeading').textContent =
    `Request ${request.request_number}`;

  const summary = document.getElementById('requestSummary');
  const statusClass = getStatusClass(request.status);

  summary.innerHTML = `
    <div class="record-grid">
      <p><strong>Requester:</strong> ${escapeHtml(request.requester_name || '')}</p>
      <p><strong>Email:</strong> ${escapeHtml(request.requester_email || '')}</p>
      <p><strong>Institution:</strong> ${escapeHtml(request.institution || '')}</p>
      <p><strong>Round:</strong> ${escapeHtml(request.round || 'Unknown')}</p>
      <p><strong>Status:</strong> <span class="status-badge ${statusClass}">${escapeHtml(request.status || '')}</span></p>
      <p><strong>Submitted:</strong> ${formatDate(request.created_at)}</p>
      <p><strong>Reviewed:</strong> ${formatDate(request.reviewed_at)}</p>
    </div>
    <p><strong>Justification:</strong> ${escapeHtml(request.justification || '')}</p>
    <p><strong>Admin Notes:</strong> ${escapeHtml(request.admin_notes || 'No notes provided')}</p>
  `;

  renderModificationTable();
  renderRecordNotice();
}

function renderModificationTable() {
  document.getElementById('requestModifications').innerHTML =
    window.ModRender.render(state.modifications);
}

function renderRecordNotice() {
  const block = document.getElementById('resubmissionBlock');

  block.innerHTML = `
    <strong>PDF Export:</strong>
    Server-side PDF is not implemented yet. Use “Download PDF” to open your browser print dialog and save this page as a PDF.
  `;
}

function inferObjectCategory(objectCode) {
  const codeText = String(objectCode || '').trim();
  const digits = codeText.replace(/[^0-9]/g, '');

  if (!digits) return '6000s';

  const leading = Number(digits[0]);
  if (leading >= 1 && leading <= 6) {
    return `${leading}000s`;
  }

  return '6000s';
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function getStatusClass(status) {
  const normalized = String(status || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');

  return `status-${normalized || 'pending'}`;
}

function toNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  const parsed = Number(
    String(value || '')
      .replace(/[$,\s]/g, '')
      .trim()
  );

  return Number.isFinite(parsed) ? parsed : 0;
}

function formatCurrency(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(toNumber(value));
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function showMessage(message, type) {
  document.getElementById('messageArea').innerHTML = `
    <div class="alert alert-${type}">
      ${escapeHtml(message)}
    </div>
  `;
}

function clearMessage() {
  document.getElementById('messageArea').innerHTML = '';
}

function showLoading(show) {
  document
    .getElementById('loadingOverlay')
    .classList.toggle('hidden', !show);
}
