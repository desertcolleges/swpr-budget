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
    ...state.allocations.map(row => row.round),
    ...state.projects.map(project => project.round).filter(Boolean)
  ])).sort(sortRound);
}

const state = {
  requests: [],
  selectedRequest: null,
  visibleRounds: ['R10'],
  extraRounds: [],
  allocations: [],
  institutions: [],
  institutionRows: [],
  projects: [],
  projectRoundFilter: 'All',
  activeProjectId: null,
  editingProjectId: null,
  allocationRoundFilter: 'All',
  admins: [],
  currentUserEmail: '',
  activeTab: 'requests'
};

const ALLOWED_EMAIL_DOMAIN = '@desertcolleges.org';

document.addEventListener('DOMContentLoaded', async () => {
  document
    .getElementById('googleSignInButton')
    .addEventListener('click', signInWithGoogle);

  document.getElementById('adminTabs').addEventListener('click', event => {
    const button = event.target.closest('[data-tab]');
    if (button) setActiveTab(button.dataset.tab);
  });
  document.getElementById('allocationRoundTabs').addEventListener('click', event => {
    const button = event.target.closest('[data-round]');
    if (!button) return;
    state.allocationRoundFilter = button.dataset.round;
    renderAllocations();
  });
  document.getElementById('projectRoundTabs').addEventListener('click', event => {
    const button = event.target.closest('[data-round]');
    if (!button) return;
    state.projectRoundFilter = button.dataset.round;
    renderProjects();
  });
  document.getElementById('projectForm').addEventListener('submit', saveProject);
  document.getElementById('projectCancelButton').addEventListener('click', resetProjectForm);
  document.getElementById('projectList').addEventListener('click', handleProjectClick);
  document.getElementById('projectActivityForm').addEventListener('submit', addProjectActivity);
  document.getElementById('projectActivityList').addEventListener('click', handleProjectActivityClick);
  document.getElementById('closeProjectActivitiesButton').addEventListener('click', () => {
    state.activeProjectId = null;
    renderProjectActivities();
  });
  document.getElementById('adminForm').addEventListener('submit', addAdmin);
  document.getElementById('adminList').addEventListener('click', handleAdminClick);

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
  document.getElementById('institutionForm').addEventListener('submit', addInstitution);
  document.getElementById('institutionList').addEventListener('click', handleInstitutionClick);
  document.getElementById('allocationList').addEventListener('click', handleAllocationClick);

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
    await authorizeSession(data.session);
  }
}

async function authorizeSession(session) {
  const email = String(session.user.email || '').toLowerCase();
  let authorized = false;

  if (email.endsWith(ALLOWED_EMAIL_DOMAIN)) {
    const { data: claimed } = await supabaseClient.rpc('claim_admin_access');
    authorized = claimed === true && await isAdminUser(session.user.id);
  }

  if (!authorized) {
    await supabaseClient.auth.signOut();
    showMessage(
      `${email || 'This account'} does not have admin access. Use an authorized ${ALLOWED_EMAIL_DOMAIN} account.`,
      'error'
    );
    return;
  }

  await showAdminDashboard(session);
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

async function signInWithGoogle() {
  clearMessage();
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin + window.location.pathname,
      queryParams: { hd: ALLOWED_EMAIL_DOMAIN.slice(1), prompt: 'select_account' }
    }
  });

  if (error) {
    showMessage('Unable to start Google sign-in: ' + error.message, 'error');
  }
}

function setActiveTab(tab) {
  const valid = ['admins', 'allocations', 'institutions', 'projects', 'requests', 'rounds'];
  state.activeTab = valid.includes(tab) ? tab : 'requests';

  document.querySelectorAll('#adminTabs .tab-button').forEach(button => {
    const active = button.dataset.tab === state.activeTab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('hidden', panel.id !== `tab-${state.activeTab}`);
  });
  history.replaceState(null, '', `#${state.activeTab}`);
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

  state.currentUserEmail = String(session.user.email || '').toLowerCase();
  document.getElementById('signedInUser').textContent =
    `Signed in as ${session.user.email}`;

  setActiveTab(window.location.hash.slice(1) || state.activeTab);

  await Promise.all([
    loadRequests(),
    loadRoundSettings(),
    loadAllocations(),
    loadProjects(),
    loadAdmins()
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
  renderProjectForm();
  input.value = '';
  showMessage(`${round} added. Select it and save round settings to make it visible.`, 'success');
}

async function loadAllocations() {
  try {
    const [instResult, allocResult] = await Promise.all([
      supabaseClient
        .from('institutions')
        .select('id, name, is_active')
        .order('name'),
      supabaseClient
        .from('college_allocations')
        .select('id, institution, round, allocation_amount')
        .order('institution')
    ]);

    if (instResult.error) throw instResult.error;
    if (allocResult.error) throw allocResult.error;

    state.institutionRows = (instResult.data || [])
      .sort((a, b) => a.name.localeCompare(b.name));
    state.institutions = state.institutionRows
      .filter(row => row.is_active)
      .map(row => row.name);
    state.allocations = (allocResult.data || []).map(row => ({
      ...row,
      round: inferRound(row.round) || row.round
    }));

    renderRoundSettings();
    renderAllocationForm();
    renderProjectForm();
    renderAllocations();
    renderInstitutions();
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
    document.getElementById('allocationRoundTabs').innerHTML = '';
    container.innerHTML = '<p>No allocations set.</p>';
    return;
  }

  const rounds = Array.from(new Set(state.allocations.map(row => row.round))).sort(sortRound);
  if (state.allocationRoundFilter !== 'All' && !rounds.includes(state.allocationRoundFilter)) {
    state.allocationRoundFilter = 'All';
  }
  document.getElementById('allocationRoundTabs').innerHTML =
    renderRoundTabs(rounds, state.allocationRoundFilter);

  const rows = state.allocations
    .filter(row => state.allocationRoundFilter === 'All' || row.round === state.allocationRoundFilter)
    .sort((a, b) =>
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

function renderInstitutions() {
  const container = document.getElementById('institutionList');

  if (!state.institutionRows.length) {
    container.innerHTML = '<p>No institutions.</p>';
    return;
  }

  container.innerHTML = `
    <table>
      <thead><tr><th>Institution</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${state.institutionRows.map(row => `
          <tr>
            <td>${escapeHtml(row.name)}</td>
            <td>${row.is_active ? 'Active' : 'Inactive'}</td>
            <td>
              <button class="button secondary small-button" type="button" data-action="rename-institution" data-id="${escapeAttribute(row.id)}">Rename</button>
              <button class="button secondary small-button" type="button" data-action="toggle-institution" data-id="${escapeAttribute(row.id)}">${row.is_active ? 'Deactivate' : 'Activate'}</button>
              <button class="button danger small-button" type="button" data-action="delete-institution" data-id="${escapeAttribute(row.id)}">Delete</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

async function addInstitution(event) {
  event.preventDefault();
  const input = document.getElementById('institutionName');
  const name = input.value.trim();
  if (!name) return;

  try {
    showLoading(true);
    const { error } = await supabaseClient.from('institutions').insert({ name });
    if (error) throw error;
    input.value = '';
    showMessage('Institution added.', 'success');
    await loadAllocations();
  } catch (error) {
    showMessage('Unable to add institution: ' + error.message, 'error');
  } finally {
    showLoading(false);
  }
}

async function handleInstitutionClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;

  const row = state.institutionRows.find(r => String(r.id) === button.dataset.id);
  if (!row) return;

  try {
    if (button.dataset.action === 'rename-institution') {
      const newName = (prompt('New institution name:', row.name) || '').trim();
      if (!newName || newName === row.name) return;
      showLoading(true);
      const { error } = await supabaseClient.rpc('rename_institution', {
        p_id: row.id,
        p_new_name: newName
      });
      if (error) throw error;
    } else if (button.dataset.action === 'toggle-institution') {
      showLoading(true);
      const { error } = await supabaseClient
        .from('institutions')
        .update({ is_active: !row.is_active })
        .eq('id', row.id);
      if (error) throw error;
    } else if (button.dataset.action === 'delete-institution') {
      const used = state.allocations.some(a => a.institution === row.name);
      if (used) {
        showMessage('Remove this institution\'s allocations first, or deactivate it instead.', 'error');
        return;
      }
      if (!confirm(`Delete ${row.name}? Past requests keep their institution name.`)) return;
      showLoading(true);
      const { error } = await supabaseClient
        .from('institutions')
        .delete()
        .eq('id', row.id);
      if (error) throw error;
    }
    await loadAllocations();
  } catch (error) {
    showMessage('Unable to update institution: ' + error.message, 'error');
  } finally {
    showLoading(false);
  }
}

function renderRoundTabs(rounds, active) {
  return ['All', ...rounds].map(round => `
    <button class="tab-button ${round === active ? 'active' : ''}" type="button" role="tab" data-round="${escapeAttribute(round)}">${escapeHtml(round)}</button>
  `).join('');
}

// ---------- Projects ----------

async function loadProjects() {
  try {
    const { data, error } = await supabaseClient
      .from('projects')
      .select('id, name, round, is_active, project_activities(id, activity_name)');

    if (error) throw error;

    state.projects = (data || []).map(project => ({
      ...project,
      project_activities: (project.project_activities || [])
        .sort((a, b) => a.activity_name.localeCompare(b.activity_name))
    })).sort((a, b) => a.name.localeCompare(b.name));

    renderProjectForm();
    renderProjects();
  } catch (error) {
    showMessage(
      'Unable to load projects: ' + String(error?.message || '') + ' (apply DATABASE_SETUP.sql)',
      'error'
    );
  }
}

function renderProjectForm() {
  const select = document.getElementById('projectRound');
  const current = select.value;
  select.innerHTML = '<option value="">Select round</option>' + getAllRounds()
    .map(round => `<option value="${round}">${round}</option>`)
    .join('');
  select.value = current;
}

function resetProjectForm() {
  state.editingProjectId = null;
  document.getElementById('projectForm').reset();
  document.getElementById('projectSubmitButton').textContent = 'Add Project';
  document.getElementById('projectCancelButton').classList.add('hidden');
}

function renderProjects() {
  const container = document.getElementById('projectList');
  const rounds = Array.from(new Set(state.projects.map(p => p.round || 'Unassigned')))
    .sort((a, b) => (a === 'Unassigned') - (b === 'Unassigned') || sortRound(a, b));

  if (state.projectRoundFilter !== 'All' && !rounds.includes(state.projectRoundFilter)) {
    state.projectRoundFilter = 'All';
  }
  document.getElementById('projectRoundTabs').innerHTML =
    state.projects.length ? renderRoundTabs(rounds, state.projectRoundFilter) : '';

  const rows = state.projects.filter(p =>
    state.projectRoundFilter === 'All' || (p.round || 'Unassigned') === state.projectRoundFilter
  );

  if (!rows.length) {
    container.innerHTML = '<p>No projects set up yet.</p>';
  } else {
    container.innerHTML = `
      <table>
        <thead><tr><th>Project</th><th>Round</th><th>Activities</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${rows.map(row => `
            <tr>
              <td>${escapeHtml(row.name)}</td>
              <td>${escapeHtml(row.round || 'Unassigned')}</td>
              <td>${row.project_activities.length}</td>
              <td>${row.is_active ? 'Active' : 'Inactive'}</td>
              <td>
                <button class="button primary small-button" type="button" data-action="activities" data-id="${escapeAttribute(row.id)}">Activities</button>
                <button class="button secondary small-button" type="button" data-action="edit" data-id="${escapeAttribute(row.id)}">Edit</button>
                <button class="button secondary small-button" type="button" data-action="copy" data-id="${escapeAttribute(row.id)}">Copy</button>
                <button class="button secondary small-button" type="button" data-action="toggle" data-id="${escapeAttribute(row.id)}">${row.is_active ? 'Deactivate' : 'Activate'}</button>
                <button class="button danger small-button" type="button" data-action="delete" data-id="${escapeAttribute(row.id)}">Delete</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  renderProjectActivities();
}

function renderProjectActivities() {
  const card = document.getElementById('projectActivitiesCard');
  const project = state.projects.find(p => p.id === state.activeProjectId);

  if (!project) {
    card.classList.add('hidden');
    return;
  }

  card.classList.remove('hidden');
  document.getElementById('projectActivitiesTitle').textContent =
    `${project.name}${project.round ? ` (${project.round})` : ''}`;

  document.getElementById('projectActivityList').innerHTML = project.project_activities.length
    ? `<table>
        <thead><tr><th>Activity</th><th></th></tr></thead>
        <tbody>
          ${project.project_activities.map(row => `
            <tr>
              <td>${escapeHtml(row.activity_name)}</td>
              <td>
                <button class="button secondary small-button" type="button" data-action="rename-activity" data-id="${escapeAttribute(row.id)}">Rename</button>
                <button class="button danger small-button" type="button" data-action="delete-activity" data-id="${escapeAttribute(row.id)}">Delete</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`
    : '<p>No activities yet.</p>';
}

function isDuplicateProjectName(name, exceptId) {
  return state.projects.some(p =>
    p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase()
  );
}

async function saveProject(event) {
  event.preventDefault();

  const name = document.getElementById('projectName').value.trim();
  const round = document.getElementById('projectRound').value;

  if (!name || !round) {
    showMessage('Enter a project name and select a round.', 'error');
    return;
  }
  if (isDuplicateProjectName(name, state.editingProjectId)) {
    showMessage(`A project named ${name} already exists.`, 'error');
    return;
  }

  try {
    showLoading(true);
    const payload = { name, round, updated_at: new Date().toISOString() };
    const { error } = state.editingProjectId
      ? await supabaseClient.from('projects').update(payload).eq('id', state.editingProjectId)
      : await supabaseClient.from('projects').insert({ name, round });

    if (error) throw error;

    resetProjectForm();
    await loadProjects();
    showMessage('Project saved.', 'success');
  } catch (error) {
    showMessage('Unable to save project: ' + error.message, 'error');
  } finally {
    showLoading(false);
  }
}

async function handleProjectClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;

  const project = state.projects.find(p => p.id === button.dataset.id);
  if (!project) return;

  try {
    switch (button.dataset.action) {
      case 'activities':
        state.activeProjectId = project.id;
        renderProjectActivities();
        document.getElementById('projectActivitiesCard').scrollIntoView({ behavior: 'smooth' });
        return;

      case 'edit':
        state.editingProjectId = project.id;
        document.getElementById('projectName').value = project.name;
        document.getElementById('projectRound').value = project.round || '';
        document.getElementById('projectSubmitButton').textContent = 'Save Project';
        document.getElementById('projectCancelButton').classList.remove('hidden');
        document.getElementById('projectName').focus();
        return;

      case 'copy': {
        const newName = (prompt('Name for the copy:', project.name) || '').trim();
        if (!newName) return;
        if (isDuplicateProjectName(newName, null)) {
          showMessage(`A project named ${newName} already exists.`, 'error');
          return;
        }
        const roundInput = (prompt(
          `Round for ${newName} (e.g. R11). Available: ${getAllRounds().join(', ')}`,
          project.round || ''
        ) || '').trim();
        const newRound = inferRound(roundInput);
        if (!newRound) {
          showMessage('Enter a valid round such as R11.', 'error');
          return;
        }
        showLoading(true);
        const { error } = await supabaseClient.rpc('copy_project', {
          p_source: project.id,
          p_name: newName,
          p_round: newRound
        });
        if (error) throw error;
        state.projectRoundFilter = 'All';
        showMessage(`Copied ${project.name} to ${newName} (${newRound}).`, 'success');
        break;
      }

      case 'toggle': {
        showLoading(true);
        const { error } = await supabaseClient
          .from('projects')
          .update({ is_active: !project.is_active, updated_at: new Date().toISOString() })
          .eq('id', project.id);
        if (error) throw error;
        break;
      }

      case 'delete': {
        showLoading(true);
        const { count, error: usageError } = await supabaseClient
          .from('submission_modifications')
          .select('id', { count: 'exact', head: true })
          .eq('title', project.name);
        if (usageError) throw usageError;
        showLoading(false);
        if (count > 0) {
          showMessage(`${project.name} is used by ${count} existing request line(s). Deactivate it instead.`, 'error');
          return;
        }
        if (!confirm(`Delete ${project.name} and its activities? This cannot be undone.`)) return;
        showLoading(true);
        const { error } = await supabaseClient.from('projects').delete().eq('id', project.id);
        if (error) throw error;
        if (state.activeProjectId === project.id) state.activeProjectId = null;
        break;
      }
    }
    await loadProjects();
  } catch (error) {
    showMessage('Unable to update project: ' + error.message, 'error');
  } finally {
    showLoading(false);
  }
}

async function addProjectActivity(event) {
  event.preventDefault();
  const input = document.getElementById('projectActivityName');
  const name = input.value.trim();
  const project = state.projects.find(p => p.id === state.activeProjectId);
  if (!project || !name) return;

  if (project.project_activities.some(a => a.activity_name.toLowerCase() === name.toLowerCase())) {
    showMessage('That activity already exists for this project.', 'error');
    return;
  }

  try {
    showLoading(true);
    const { error } = await supabaseClient
      .from('project_activities')
      .insert({ project_id: project.id, activity_name: name });
    if (error) throw error;
    input.value = '';
    await loadProjects();
  } catch (error) {
    showMessage('Unable to add activity: ' + error.message, 'error');
  } finally {
    showLoading(false);
  }
}

async function handleProjectActivityClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;

  const project = state.projects.find(p => p.id === state.activeProjectId);
  const activity = project?.project_activities.find(a => a.id === button.dataset.id);
  if (!activity) return;

  try {
    if (button.dataset.action === 'rename-activity') {
      const newName = (prompt('New activity name:', activity.activity_name) || '').trim();
      if (!newName || newName === activity.activity_name) return;
      if (project.project_activities.some(a => a.id !== activity.id && a.activity_name.toLowerCase() === newName.toLowerCase())) {
        showMessage('That activity already exists for this project.', 'error');
        return;
      }
      showLoading(true);
      const { error } = await supabaseClient
        .from('project_activities')
        .update({ activity_name: newName })
        .eq('id', activity.id);
      if (error) throw error;
    } else {
      if (!confirm(`Delete activity "${activity.activity_name}"?`)) return;
      showLoading(true);
      const { error } = await supabaseClient
        .from('project_activities')
        .delete()
        .eq('id', activity.id);
      if (error) throw error;
    }
    await loadProjects();
  } catch (error) {
    showMessage('Unable to update activity: ' + error.message, 'error');
  } finally {
    showLoading(false);
  }
}

// ---------- Admin users ----------

async function loadAdmins() {
  try {
    const { data, error } = await supabaseClient
      .from('admin_allowlist')
      .select('email, display_name, active');

    if (error) throw error;

    state.admins = (data || []).sort((a, b) =>
      (a.display_name || a.email).localeCompare(b.display_name || b.email)
    );
    renderAdmins();
  } catch (error) {
    showMessage(
      'Unable to load admin users: ' + String(error?.message || '') + ' (apply DATABASE_SETUP.sql)',
      'error'
    );
  }
}

function renderAdmins() {
  const container = document.getElementById('adminList');

  if (!state.admins.length) {
    container.innerHTML = '<p>No admin users.</p>';
    return;
  }

  container.innerHTML = `
    <table>
      <thead><tr><th>Name</th><th>Email</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${state.admins.map(row => `
          <tr>
            <td>${escapeHtml(row.display_name)}</td>
            <td>${escapeHtml(row.email)}</td>
            <td>${row.active ? 'Active' : 'Inactive'}</td>
            <td>
              <button class="button secondary small-button" type="button" data-action="rename-admin" data-email="${escapeAttribute(row.email)}">Edit Name</button>
              <button class="button secondary small-button" type="button" data-action="toggle-admin" data-email="${escapeAttribute(row.email)}">${row.active ? 'Deactivate' : 'Activate'}</button>
              <button class="button danger small-button" type="button" data-action="delete-admin" data-email="${escapeAttribute(row.email)}">Delete</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

async function addAdmin(event) {
  event.preventDefault();

  const name = document.getElementById('adminName').value.trim();
  const email = document.getElementById('adminEmail').value.trim().toLowerCase();

  if (!email.endsWith(ALLOWED_EMAIL_DOMAIN)) {
    showMessage(`Admin email must end with ${ALLOWED_EMAIL_DOMAIN}.`, 'error');
    return;
  }

  try {
    showLoading(true);
    const { error } = await supabaseClient
      .from('admin_allowlist')
      .insert({ email, display_name: name });
    if (error) throw error;
    document.getElementById('adminForm').reset();
    await loadAdmins();
    showMessage('Admin added. They can now sign in with Google.', 'success');
  } catch (error) {
    showMessage('Unable to add admin: ' + error.message, 'error');
  } finally {
    showLoading(false);
  }
}

async function handleAdminClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;

  const row = state.admins.find(a => a.email === button.dataset.email);
  if (!row) return;

  const isSelf = row.email === state.currentUserEmail;
  const action = button.dataset.action;

  if (isSelf && action !== 'rename-admin') {
    showMessage('You cannot deactivate or delete your own admin access.', 'error');
    return;
  }

  try {
    const table = supabaseClient.from('admin_allowlist');
    if (action === 'rename-admin') {
      const newName = prompt('Admin name:', row.display_name);
      if (newName === null) return;
      showLoading(true);
      const { error } = await table.update({ display_name: newName.trim() }).eq('email', row.email);
      if (error) throw error;
    } else if (action === 'toggle-admin') {
      showLoading(true);
      const { error } = await table.update({ active: !row.active }).eq('email', row.email);
      if (error) throw error;
    } else if (action === 'delete-admin') {
      if (!confirm(`Remove ${row.email} from admin access?`)) return;
      showLoading(true);
      const { error } = await table.delete().eq('email', row.email);
      if (error) throw error;
    }
    await loadAdmins();
  } catch (error) {
    showMessage('Unable to update admin: ' + error.message, 'error');
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
