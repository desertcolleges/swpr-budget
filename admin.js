const SUPABASE_URL =
  'https://dfghvbhidpzxjdcczcck.supabase.co';

const SUPABASE_ANON_KEY =
  'sb_publishable_IXoPGcfK7o5LbccQvk6g9g_cWbtfrH2';

const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
);

const BASE_ROUNDS = Array.from({ length: 12 }, (_, index) => `R${index + 1}`);

function getAllRounds() {
  return Array.from(new Set([
    ...BASE_ROUNDS,
    ...state.extraRounds,
    ...state.visibleRounds,
    ...state.allocations.map(row => row.round)
  ])).sort(sortRound);
}

const state = {
  requests: [],
  selectedRequest: null,
  visibleRounds: ['R10'],
  extraRounds: [],
  allocations: [],
  institutions: [],
  activities: []
};

document.addEventListener('DOMContentLoaded', async () => {
  document
    .getElementById('loginForm')
    .addEventListener('submit', signIn);

  document
    .getElementById('logoutButton')
    .addEventListener('click', signOut);

  document
    .getElementById('statusFilter')
    .addEventListener('change', renderRequestList);

  document
    .getElementById('backToRequestsButton')
    .addEventListener('click', showRequestList);

  document
    .getElementById('approveButton')
    .addEventListener('click', () => processRequest('Approved'));

  document
    .getElementById('rejectButton')
    .addEventListener('click', () => processRequest('Rejected'));

  document
    .getElementById('roundSettingsForm')
    .addEventListener('submit', saveRoundSettings);

  document.getElementById('addRoundForm').addEventListener('submit', addRound);
  document.getElementById('allocationForm').addEventListener('submit', saveAllocation);
  document.getElementById('activityForm').addEventListener('submit', addActivity);
  document.getElementById('allocationList').addEventListener('click', handleAllocationClick);
  document.getElementById('activityList').addEventListener('click', handleActivityClick);

  renderRoundSettings();
  await loadExistingSession();
});

async function loadExistingSession() {
  const { data, error } =
    await supabaseClient.auth.getSession();

  if (error) {
    showMessage(error.message, 'error');
    return;
  }

  if (data.session) {
    const isAuthorized = await isAdminUser(data.session.user.id);

    if (!isAuthorized) {
      await supabaseClient.auth.signOut();
      showMessage(
        'This account does not have admin access.',
        'error'
      );
      return;
    }

    await showAdminDashboard(data.session);
  }
}

async function isAdminUser(userId) {
  const { data, error } = await supabaseClient
    .from('admin_users')
    .select('user_id')
    .eq('user_id', userId)
    .eq('active', true)
    .limit(1);

  if (error) {
    return false;
  }

  return Array.isArray(data) && data.length > 0;
}

async function signIn(event) {
  event.preventDefault();

  const email =
    document.getElementById('loginEmail').value.trim();

  const password =
    document.getElementById('loginPassword').value;

  try {
    showLoading(true);
    clearMessage();

    const { data, error } =
      await supabaseClient.auth.signInWithPassword({
        email,
        password
      });

    if (error) throw error;

    const isAuthorized = await isAdminUser(data.user.id);

    if (!isAuthorized) {
      await supabaseClient.auth.signOut();
      throw new Error(
        'This account does not have admin access.'
      );
    }

    await showAdminDashboard(data.session);
  } catch (error) {
    showMessage(
      'Unable to sign in: ' + error.message,
      'error'
    );
  } finally {
    showLoading(false);
  }
}

async function showAdminDashboard(session) {
  document
    .getElementById('loginSection')
    .classList.add('hidden');

  document
    .getElementById('reviewSection')
    .classList.add('hidden');

  document
    .getElementById('adminSection')
    .classList.remove('hidden');

  document.getElementById('signedInUser').textContent =
    `Signed in as ${session.user.email}`;

  await Promise.all([
    loadRequests(),
    loadRoundSettings(),
    loadActivityManagement(),
    loadAllocations()
  ]);
}

async function loadRequests() {
  try {
    showLoading(true);
    clearMessage();

    const { data, error } = await supabaseClient
      .from('budget_submissions')
      .select(`
        id,
        request_number,
        requester_name,
        requester_email,
        institution,
        round,
        status_access_token,
        justification,
        status,
        admin_notes,
        created_at,
        reviewed_at
      `)
      .order('created_at', {
        ascending: false
      });

    if (error) throw error;

    state.requests = data || [];
    renderRequestList();
  } catch (error) {
    showMessage(
      'Unable to load requests: ' + error.message,
      'error'
    );
  } finally {
    showLoading(false);
  }
}

function renderRequestList() {
  const container =
    document.getElementById('requestList');

  const status =
    document.getElementById('statusFilter').value;

  const requests = status
    ? state.requests.filter(
        request => request.status === status
      )
    : state.requests;

  if (requests.length === 0) {
    container.innerHTML =
      '<p class="card">No requests found.</p>';
    return;
  }

  let html = `
    <table>
      <thead>
        <tr>
          <th>Status</th>
          <th>Request</th>
          <th>Round</th>
          <th>Date</th>
          <th>Requester</th>
          <th>Institution</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
  `;

  requests.forEach(request => {
    html += `
      <tr>
        <td>
          <span class="status-badge status-${request.status.toLowerCase()}">
            ${escapeHtml(request.status)}
          </span>
        </td>

        <td>${escapeHtml(request.request_number)}</td>
        <td>${escapeHtml(request.round || inferRound(request.request_number) || 'Unknown')}</td>
        <td>${formatDate(request.created_at)}</td>
        <td>${escapeHtml(request.requester_name)}</td>
        <td>${escapeHtml(request.institution)}</td>

        <td>
          <button
            class="button primary small-button"
            data-request-id="${request.id}"
          >
            Review
          </button>
        </td>
      </tr>
    `;
  });

  html += '</tbody></table>';
  container.innerHTML = html;

  container
    .querySelectorAll('[data-request-id]')
    .forEach(button => {
      button.addEventListener('click', () => {
        loadRequestDetail(button.dataset.requestId);
      });
    });
}

async function loadRequestDetail(requestId) {
  try {
    showLoading(true);
    clearMessage();

    const request = state.requests.find(
      item => item.id === requestId
    );

    if (!request) {
      throw new Error('Request was not found.');
    }

    const { data: modifications, error } =
      await supabaseClient
        .from('submission_modifications')
        .select('*')
        .eq('submission_id', requestId)
        .order('title')
        .order('activity_title')
        .order('object_category')
        .order('object_code');

    if (error) throw error;

    state.selectedRequest = {
      ...request,
      modifications: modifications || []
    };

    renderRequestDetail();
  } catch (error) {
    showMessage(
      'Unable to load request: ' + error.message,
      'error'
    );
  } finally {
    showLoading(false);
  }
}

function renderRequestDetail() {
  const request = state.selectedRequest;

  document
    .getElementById('adminSection')
    .classList.add('hidden');

  document
    .getElementById('reviewSection')
    .classList.remove('hidden');

  document.getElementById('reviewRequestNumber')
    .textContent = request.request_number;

  document.getElementById('requestMetadata').innerHTML = `
    <p>
      <strong>Requester:</strong>
      ${escapeHtml(request.requester_name)}
    </p>

    <p>
      <strong>Email:</strong>
      <a href="mailto:${escapeAttribute(request.requester_email)}">
        ${escapeHtml(request.requester_email)}
      </a>
    </p>

    <p>
      <strong>Institution:</strong>
      ${escapeHtml(request.institution)}
    </p>

    <p>
      <strong>Round:</strong>
      ${escapeHtml(request.round || inferRound(request.request_number) || 'Unknown')}
    </p>

    <p>
      <strong>Status:</strong>
      ${escapeHtml(request.status)}
    </p>

    <p>
      <strong>Submitted:</strong>
      ${formatDate(request.created_at)}
    </p>

    <hr />

    <p>
      <strong>Justification:</strong>
    </p>

    <p>
      ${escapeHtml(request.justification)}
    </p>
  `;

  renderModificationDetails();

  document.getElementById('adminNotes').value =
    request.admin_notes || '';

  const isPending = request.status === 'Pending';

  document
    .getElementById('reviewActions')
    .classList.toggle('hidden', !isPending);
}

function renderModificationDetails() {
  const request = state.selectedRequest;
  const container =
    document.getElementById('modificationDetails');

  if (!request.modifications.length) {
    container.innerHTML =
      '<p class="card">No modifications were found.</p>';
    return;
  }

  let html = `
    <table>
      <thead>
        <tr>
          <th>Round</th>
          <th>Project</th>
          <th>Activity</th>
          <th>Object Category</th>
          <th>Object Code</th>
          <th>Current Description</th>
          <th>Proposed Description</th>
          <th>Current Budget</th>
          <th>Proposed Budget</th>
          <th>Flags</th>
        </tr>
      </thead>
      <tbody>
  `;

  request.modifications.forEach(row => {
    const isNew = Boolean(row.is_new_line);
    const objectCategory = row.object_category || inferObjectCategory(row.object_code);
    const currentDescription = row.current_budget_description || row.budget_item_description || '';
    const proposedDescription = row.proposed_budget_description || row.proposed_description || '';

    html += `
      <tr class="${isNew ? 'changed-row' : ''}">
        <td>${escapeHtml(row.round || request.round || '')}</td>
        <td>${escapeHtml(row.title)}</td>
        <td>${escapeHtml(row.activity_title)}</td>
        <td>${escapeHtml(objectCategory)}</td>
        <td>${escapeHtml(row.object_code)}</td>
        <td>${escapeHtml(currentDescription)}</td>
        <td>${escapeHtml(proposedDescription)}</td>
        <td class="money">${formatCurrency(row.current_budget)}</td>
        <td class="money">${formatCurrency(row.proposed_budget)}</td>
        <td>
          ${isNew ? '<span class="flag flag-new">New Activity</span>' : '<span class="flag">Existing Activity</span>'}
        </td>
      </tr>
    `;
  });

  html += '</tbody></table>';
  container.innerHTML = html;
}

async function processRequest(action) {
  const request = state.selectedRequest;

  if (!request || request.status !== 'Pending') {
    showMessage(
      'Only pending requests can be processed.',
      'error'
    );
    return;
  }

  const notes =
    document.getElementById('adminNotes').value.trim();

  if (action === 'Rejected' && !notes) {
    showMessage(
      'Please provide notes explaining the rejection.',
      'error'
    );
    return;
  }

  const confirmed = window.confirm(
    `Are you sure you want to mark this request as ${action}?`
  );

  if (!confirmed) return;

  try {
    showLoading(true);
    clearMessage();

    const { error } = await supabaseClient
      .from('budget_submissions')
      .update({
        status: action,
        admin_notes: notes || null,
        reviewed_at: new Date().toISOString()
      })
      .eq('id', request.id)
      .eq('status', 'Pending');

    if (error) throw error;

    const notificationResult = await notifyRequester(
      request.requester_email,
      request.request_number,
      action,
      notes,
      request.status_access_token
    );

    if (notificationResult.warning) {
      showMessage(
        `Request marked as ${action}. Warning: ${notificationResult.warning}`,
        'error'
      );
    } else {
      showMessage(
        `Request marked as ${action}.`,
        'success'
      );
    }

    await loadRequests();
    showRequestList();
  } catch (error) {
    showMessage(
      'Unable to process request: ' + error.message,
      'error'
    );
  } finally {
    showLoading(false);
  }
}

async function notifyRequester(
  email,
  requestNumber,
  action,
  notes,
  statusToken
) {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/functions/v1/send-approval`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
          Authorization: 'Bearer ' + SUPABASE_ANON_KEY
        },
        body: JSON.stringify({
          requester_email: email,
          request_number: requestNumber,
          action,
          notes,
          status_token: statusToken || null
        })
      }
    );

    const result = await response.json();

    if (!response.ok) {
      return {
        warning:
          result.error ||
          'Notification email was not sent.'
      };
    }

    return { warning: '' };
  } catch (error) {
    return {
      warning:
        error.message ||
        'Notification email request failed.'
    };
  }
}

function showRequestList() {
  document
    .getElementById('reviewSection')
    .classList.add('hidden');

  document
    .getElementById('adminSection')
    .classList.remove('hidden');

  state.selectedRequest = null;
}

async function loadRoundSettings() {
  try {
    const { data, error } = await supabaseClient
      .from('site_config')
      .select('visible_rounds')
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    state.visibleRounds = normalizeRoundList(data?.visible_rounds);

    if (!state.visibleRounds.length) {
      state.visibleRounds = ['R10'];
    }

    renderRoundSettings();
  } catch (error) {
    state.visibleRounds = ['R10'];
    renderRoundSettings();
    showMessage(
      'Using default visible rounds. Could not load site settings.',
      'error'
    );
  }
}

function renderRoundSettings() {
  const grid = document.getElementById('roundSettingsGrid');

  grid.innerHTML = getAllRounds().map(round => {
    const checked = state.visibleRounds.includes(round)
      ? 'checked'
      : '';

    return `
      <label class="inline-checkbox">
        <input type="checkbox" value="${round}" ${checked} />
        ${round}
      </label>
    `;
  }).join('');
}

async function saveRoundSettings(event) {
  event.preventDefault();

  const selectedRounds = Array.from(
    document.querySelectorAll(
      '#roundSettingsGrid input[type="checkbox"]:checked'
    )
  )
    .map(input => input.value)
    .sort(sortRound);

  if (!selectedRounds.length) {
    showMessage('Select at least one visible round.', 'error');
    return;
  }

  try {
    showLoading(true);

    const { error } = await supabaseClient
      .from('site_config')
      .upsert(
        {
          id: 1,
          visible_rounds: selectedRounds,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'id' }
      );

    if (error) throw error;

    state.visibleRounds = selectedRounds;

    showMessage('Visible round settings saved.', 'success');
  } catch (error) {
    showMessage(
      'Unable to save round settings: ' + error.message,
      'error'
    );
  } finally {
    showLoading(false);
  }
}

function addRound(event) {
  event.preventDefault();
  const input = document.getElementById('newRoundNumber');
  const number = Math.round(Number(input.value));

  if (!number || number < 1) {
    showMessage('Enter a valid round number.', 'error');
    return;
  }

  const round = `R${number}`;
  if (!state.extraRounds.includes(round)) state.extraRounds.push(round);

  // Preserve current checkbox selections while re-rendering.
  state.visibleRounds = Array.from(
    document.querySelectorAll('#roundSettingsGrid input:checked')
  ).map(i => i.value);
  renderRoundSettings();
  renderAllocationForm();
  input.value = '';
  showMessage(`${round} added. Select it and save round settings to make it visible.`, 'success');
}

async function loadAllocations() {
  try {
    const [instResult, allocResult] = await Promise.all([
      supabaseClient.rpc('get_public_institutions'),
      supabaseClient
        .from('college_allocations')
        .select('id, institution, round, allocation_amount')
        .order('institution')
    ]);

    if (instResult.error) throw instResult.error;
    if (allocResult.error) throw allocResult.error;

    state.institutions = (instResult.data || []).map(row => row.institution);
    state.allocations = (allocResult.data || []).map(row => ({
      ...row,
      round: inferRound(row.round) || row.round
    }));

    renderRoundSettings();
    renderAllocationForm();
    renderAllocations();
  } catch (error) {
    showMessage(
      'Unable to load allocations: ' + error.message + ' (apply DATABASE_SETUP.sql)',
      'error'
    );
  }
}

function renderAllocationForm() {
  const instSelect = document.getElementById('allocationInstitution');
  const roundSelect = document.getElementById('allocationRound');
  const instValue = instSelect.value;
  const roundValue = roundSelect.value;

  instSelect.innerHTML = state.institutions
    .map(name => `<option value="${escapeAttribute(name)}">${escapeHtml(name)}</option>`)
    .join('');
  roundSelect.innerHTML = getAllRounds()
    .map(round => `<option value="${round}">${round}</option>`)
    .join('');

  if (instValue) instSelect.value = instValue;
  roundSelect.value = roundValue || 'R11';
}

function renderAllocations() {
  const container = document.getElementById('allocationList');

  if (!state.allocations.length) {
    container.innerHTML = '<p>No allocations set.</p>';
    return;
  }

  const rows = [...state.allocations].sort((a, b) =>
    a.institution.localeCompare(b.institution) || sortRound(a.round, b.round)
  );

  container.innerHTML = `
    <table>
      <thead><tr><th>College</th><th>Round</th><th class="money">Allocation</th><th></th></tr></thead>
      <tbody>
        ${rows.map(row => `
          <tr>
            <td>${escapeHtml(row.institution)}</td>
            <td>${escapeHtml(row.round)}</td>
            <td class="money">${formatCurrency(row.allocation_amount)}</td>
            <td>
              <button class="button secondary small-button" type="button" data-action="edit-allocation" data-id="${escapeAttribute(row.id)}">Edit</button>
              <button class="button danger small-button" type="button" data-action="delete-allocation" data-id="${escapeAttribute(row.id)}">Delete</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

async function saveAllocation(event) {
  event.preventDefault();

  const institution = document.getElementById('allocationInstitution').value;
  const round = document.getElementById('allocationRound').value;
  const amount = Math.round(Number(document.getElementById('allocationAmount').value));

  if (!institution || !round || !Number.isFinite(amount) || amount < 0) {
    showMessage('Select a college and round and enter a valid amount.', 'error');
    return;
  }

  try {
    showLoading(true);
    const { error } = await supabaseClient
      .from('college_allocations')
      .upsert(
        {
          institution,
          round,
          allocation_amount: amount,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'institution,round' }
      );

    if (error) throw error;

    showMessage('Allocation saved.', 'success');
    await loadAllocations();
  } catch (error) {
    showMessage('Unable to save allocation: ' + error.message, 'error');
  } finally {
    showLoading(false);
  }
}

async function handleAllocationClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;

  const row = state.allocations.find(r => String(r.id) === button.dataset.id);
  if (!row) return;

  if (button.dataset.action === 'edit-allocation') {
    document.getElementById('allocationInstitution').value = row.institution;
    document.getElementById('allocationRound').value = row.round;
    document.getElementById('allocationAmount').value = Math.round(Number(row.allocation_amount));
    return;
  }

  if (!confirm(`Delete ${row.round} allocation for ${row.institution}?`)) return;

  try {
    showLoading(true);
    const { error } = await supabaseClient
      .from('college_allocations')
      .delete()
      .eq('id', row.id);

    if (error) throw error;
    await loadAllocations();
  } catch (error) {
    showMessage('Unable to delete allocation: ' + error.message, 'error');
  } finally {
    showLoading(false);
  }
}

async function loadActivityManagement() {
  try {
    const { data, error } = await supabaseClient
      .from('activity_management')
      .select('id, project_title, activity_name, is_active')
      .order('project_title')
      .order('activity_name');

    if (error) throw error;

    state.activities = data || [];
    renderActivities();
  } catch (error) {
    showMessage(
      'Unable to load activity management: ' + String(error?.message || '') + ' (apply DATABASE_SETUP.sql)',
      'error'
    );
  }
}

function renderActivities() {
  const container = document.getElementById('activityList');

  if (!state.activities.length) {
    container.innerHTML = '<p>No activities set up yet.</p>';
    return;
  }

  container.innerHTML = `
    <table>
      <thead><tr><th>Project</th><th>Activity</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${state.activities.map(row => `
          <tr>
            <td>${escapeHtml(row.project_title || 'All projects')}</td>
            <td>${escapeHtml(row.activity_name)}</td>
            <td>${row.is_active ? 'Active' : 'Inactive'}</td>
            <td>
              <button class="button secondary small-button" type="button" data-action="toggle-activity" data-id="${escapeAttribute(row.id)}">${row.is_active ? 'Deactivate' : 'Activate'}</button>
              <button class="button danger small-button" type="button" data-action="delete-activity" data-id="${escapeAttribute(row.id)}">Delete</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

async function addActivity(event) {
  event.preventDefault();

  const project = document.getElementById('activityProject').value.trim();
  const name = document.getElementById('activityName').value.trim();

  if (!name) {
    showMessage('Enter an activity name.', 'error');
    return;
  }

  try {
    showLoading(true);
    const { error } = await supabaseClient
      .from('activity_management')
      .insert({
        project_title: project || null,
        activity_name: name,
        is_active: true
      });

    if (error) throw error;

    document.getElementById('activityName').value = '';
    await loadActivityManagement();
    showMessage('Activity added.', 'success');
  } catch (error) {
    showMessage('Unable to add activity: ' + error.message, 'error');
  } finally {
    showLoading(false);
  }
}

async function handleActivityClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;

  const row = state.activities.find(r => String(r.id) === button.dataset.id);
  if (!row) return;

  try {
    showLoading(true);

    const query = supabaseClient.from('activity_management');
    const { error } = button.dataset.action === 'toggle-activity'
      ? await query
          .update({ is_active: !row.is_active, updated_at: new Date().toISOString() })
          .eq('id', row.id)
      : await query.delete().eq('id', row.id);

    if (error) throw error;
    await loadActivityManagement();
  } catch (error) {
    showMessage('Unable to update activity: ' + error.message, 'error');
  } finally {
    showLoading(false);
  }
}

async function signOut() {
  await supabaseClient.auth.signOut();

  document
    .getElementById('adminSection')
    .classList.add('hidden');

  document
    .getElementById('reviewSection')
    .classList.add('hidden');

  document
    .getElementById('loginSection')
    .classList.remove('hidden');

  document.getElementById('loginForm').reset();
}

function inferRound(value) {
  const match = String(value || '').match(/\bR\s*(\d+)\b/i);
  if (!match) return '';
  return `R${Number(match[1])}`;
}

function normalizeRoundList(rounds) {
  if (!Array.isArray(rounds)) return [];

  return Array.from(
    new Set(
      rounds
        .map(round => inferRound(round))
        .filter(Boolean)
    )
  ).sort(sortRound);
}

function sortRound(a, b) {
  return toRoundNumber(a) - toRoundNumber(b);
}

function toRoundNumber(round) {
  return Number(String(round || '').replace(/[^0-9]/g, '')) || 0;
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

function formatCurrency(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(Number(value) || 0);
}

function formatDate(value) {
  if (!value) return '';

  return new Date(value).toLocaleString();
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttribute(value) {
  return escapeHtml(value);
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
