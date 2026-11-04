const budgetEditorState = {
  institution: '', round: '', baselineHash: '', projects: [], expenditures: [], dirty: false
};

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('adminBudgetLoadForm').addEventListener('submit', loadAdminBudget);
  document.getElementById('adminBudgetSaveForm').addEventListener('submit', saveAdminBudget);
  document.getElementById('adminBudgetAddActivity').addEventListener('click', addAdminBudgetActivity);
  document.getElementById('adminBudgetProject').addEventListener('input', populateAdminActivityOptions);
  document.getElementById('adminBudgetReason').addEventListener('input', markAdminBudgetDirty);
  document.getElementById('syncExpendituresButton').addEventListener('click', syncExpenditures);
  document.getElementById('refreshSyncStatusButton').addEventListener('click', loadExpenditureSyncStatus);
  document.getElementById('adminBudgetEditor').addEventListener('input', event => {
    const target = event.target;
    if (!['proposed_budget', 'proposed_budget_description'].includes(target.dataset.field)) return;
    const row = budgetEditorState.projects[Number(target.dataset.projectIndex)]
      ?.activities[Number(target.dataset.activityIndex)]?.categoryRows.find(r => r.object_category === target.dataset.category);
    if (!row) return;
    row[target.dataset.field] = target.dataset.field === 'proposed_budget' ? (target.value === '' ? 0 : Number(target.value)) : target.value;
    row.modified = window.ModRender.isChanged(row);
    window.BudgetUI.autoGrowTextareas(document.getElementById('adminBudgetEditor'));
    target.closest('tr').classList.toggle('changed-row', row.modified);
    markAdminBudgetDirty();
    renderAdminBudgetTotals();
  });
  document.getElementById('adminBudgetEditor').addEventListener('click', event => {
    const button = event.target.closest('[data-action="delete-activity"]');
    if (!button || !confirm('Remove this activity from the proposed budget?')) return;
    budgetEditorState.projects[Number(button.dataset.projectIndex)].activities.splice(Number(button.dataset.activityIndex), 1);
    markAdminBudgetDirty();
    renderAdminBudgetEditor();
  });
  window.addEventListener('beforeunload', event => {
    if (!budgetEditorState.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
});

function populateAdminBudgetSelectors() {
  document.getElementById('adminBudgetInstitution').innerHTML = state.institutions
    .map(name => `<option value="${escapeAttribute(name)}">${escapeHtml(name)}</option>`).join('');
  document.getElementById('adminBudgetRound').innerHTML = getAllRounds()
    .map(round => `<option value="${escapeAttribute(round)}">${escapeHtml(round)}</option>`).join('');
}

function managedAdminProjects() {
  return state.projects.filter(project => project.round === budgetEditorState.round && project.is_active !== false)
    .map(project => ({ project: project.name, activities: (project.project_activities || []).map(a => a.activity_name) }));
}

async function loadAdminBudget(event) {
  event?.preventDefault();
  if (budgetEditorState.dirty && !confirm('Discard your unapplied budget changes?')) return;
  const institution = document.getElementById('adminBudgetInstitution').value;
  const round = document.getElementById('adminBudgetRound').value;
  if (!institution || !round) return;
  try {
    showLoading(true);
    const [snapshot, expenditures] = await Promise.all([
      supabaseClient.rpc('get_budget_snapshot', { p_institution: institution, p_round: round }),
      supabaseClient.rpc('get_expenditures', { p_institution: institution })
    ]);
    if (snapshot.error) throw snapshot.error;
    if (expenditures.error) throw expenditures.error;
    Object.assign(budgetEditorState, {
      institution, round, baselineHash: snapshot.data.fingerprints[round] || snapshot.data.empty_fingerprint,
      projects: window.BudgetUI.buildProjects(snapshot.data.rows), dirty: false
    });
    document.getElementById('adminBudgetHeading').textContent = `${institution} / ${round}`;
    const roundExpenditures = (expenditures.data || []).filter(row =>
      (row.round || inferRound(row.project)) === round);
    budgetEditorState.expenditures = roundExpenditures;
    document.getElementById('adminBudgetCurrent').innerHTML =
      window.BudgetUI.renderBudget(snapshot.data.rows, roundExpenditures, managedAdminProjects()).html;
    document.getElementById('adminBudgetSection').classList.remove('hidden');
    document.getElementById('adminBudgetReason').value = '';
    document.getElementById('adminBudgetDirtyStatus').textContent = '';
    document.getElementById('adminBudgetProjectOptions').innerHTML = Array.from(new Set([
      ...budgetEditorState.projects.map(p => p.name), ...managedAdminProjects().map(p => p.project)
    ])).map(name => `<option value="${escapeAttribute(name)}"></option>`).join('');
    renderAdminBudgetEditor();
    await loadAdminBudgetHistory();
  } catch (error) {
    showMessage('Unable to load budget: ' + error.message, 'error');
  } finally {
    showLoading(false);
  }
}

function renderAdminBudgetEditor() {
  const element = document.getElementById('adminBudgetEditor');
  element.innerHTML = window.BudgetUI.renderEditor(budgetEditorState.projects);
  element.querySelectorAll('.project-section').forEach((section, index) => {
    const coverage = document.createElement('div');
    coverage.className = 'project-coverage';
    coverage.dataset.coverageProject = index;
    section.querySelector('.project-content').prepend(coverage);
  });
  window.BudgetUI.autoGrowTextareas(element);
  renderAdminBudgetTotals();
}

function adminBudgetLines() {
  return budgetEditorState.projects.flatMap(project => project.activities.flatMap(activity =>
    activity.categoryRows.map(row => ({ ...row, title: project.name, activity_title: activity.name, is_new_line: activity.is_new_line }))));
}

function renderAdminBudgetTotals() {
  const lines = adminBudgetLines();
  const total = lines.reduce((sum, row) => sum + (Number.isFinite(row.proposed_budget) ? row.proposed_budget : 0), 0);
  const allocation = state.allocations.find(a => a.institution === budgetEditorState.institution && a.round === budgetEditorState.round)?.allocation_amount;
  document.getElementById('adminBudgetSummary').innerHTML = `
    <div class="summary-card"><span>Allocation (informational)</span><strong>${formatCurrency(allocation || 0)}</strong></div>
    <div class="summary-card"><span>Proposed Budget</span><strong>${formatCurrency(total)}</strong></div>
    <div class="summary-card"><span>Variance from Allocation</span><strong>${formatCurrency(total - Number(allocation || 0))}</strong></div>`;
  document.getElementById('adminBudgetSaveButton').disabled = !lines.length
    || lines.some(row => !Number.isSafeInteger(row.proposed_budget) || row.proposed_budget < 0);
  document.querySelectorAll('#adminBudgetEditor [data-coverage-project]').forEach(element => {
    const project = budgetEditorState.projects[Number(element.dataset.coverageProject)];
    const proposed = project.activities.flatMap(activity => activity.categoryRows.map(row => ({
      title: project.name, activity_title: activity.name, object_category: row.object_category,
      object_code: row.object_code, budget: row.proposed_budget, budget_item_description: row.proposed_budget_description
    })));
    element.innerHTML = `<h4>Proposed project budget coverage</h4>${window.BudgetUI.renderProjectSummary(proposed, budgetEditorState.expenditures, project.name)}`;
  });
}

function markAdminBudgetDirty() {
  budgetEditorState.dirty = true;
  document.getElementById('adminBudgetDirtyStatus').textContent = 'Unapplied budget changes';
}

function populateAdminActivityOptions() {
  const name = document.getElementById('adminBudgetProject').value.trim().toLowerCase();
  const managed = managedAdminProjects().find(p => p.project.toLowerCase() === name);
  document.getElementById('adminBudgetActivityOptions').innerHTML = (managed?.activities || [])
    .map(activity => `<option value="${escapeAttribute(activity)}"></option>`).join('');
}

function addAdminBudgetActivity() {
  const projectName = document.getElementById('adminBudgetProject').value.trim();
  const activityName = document.getElementById('adminBudgetActivity').value.trim();
  if (!projectName || !activityName) {
    showMessage('Enter a project and activity name.', 'error');
    return;
  }
  let project = budgetEditorState.projects.find(p => p.name.toLowerCase() === projectName.toLowerCase());
  if (!project) {
    project = { name: projectName, activities: [] };
    budgetEditorState.projects.push(project);
  }
  if (project.activities.some(a => a.name.toLowerCase() === activityName.toLowerCase())) {
    showMessage('This activity is already in the budget.', 'error');
    return;
  }
  const activity = window.BudgetUI.buildProjects([], [{ project: project.name, activities: [activityName] }])[0].activities[0];
  activity.is_new_line = true;
  project.activities.push(activity);
  document.getElementById('adminBudgetActivity').value = '';
  markAdminBudgetDirty();
  renderAdminBudgetEditor();
}

async function saveAdminBudget(event) {
  event.preventDefault();
  const reason = document.getElementById('adminBudgetReason').value.trim();
  const lines = adminBudgetLines();
  if (!reason || lines.some(row => !Number.isSafeInteger(row.proposed_budget) || row.proposed_budget < 0
    || (row.proposed_budget > 0 && !row.proposed_budget_description.trim()))) {
    showMessage('Provide a reason, nonnegative whole-dollar amounts, and descriptions for funded categories.', 'error');
    return;
  }
  if (!confirm(`Apply this budget immediately to ${budgetEditorState.institution} / ${budgetEditorState.round}? Allocation limits will not be enforced. Existing requests may need revision.`)) return;
  try {
    showLoading(true);
    const { error } = await supabaseClient.rpc('admin_save_budget', {
      p_institution: budgetEditorState.institution, p_round: budgetEditorState.round,
      p_baseline_hash: budgetEditorState.baselineHash, p_reason: reason, p_lines: lines
    });
    if (error) throw error;
    budgetEditorState.dirty = false;
    document.getElementById('adminBudgetInstitution').value = budgetEditorState.institution;
    document.getElementById('adminBudgetRound').value = budgetEditorState.round;
    await loadAdminBudget();
    showMessage('Budget changes applied. Before/after values were saved in admin history.', 'success');
  } catch (error) {
    showMessage('Unable to apply budget: ' + error.message, 'error');
  } finally {
    showLoading(false);
  }
}

async function loadAdminBudgetHistory() {
  const { data, error } = await supabaseClient.from('budget_changes').select('*')
    .eq('institution', budgetEditorState.institution).eq('round', budgetEditorState.round)
    .order('created_at', { ascending: false });
  if (error) throw error;
  document.getElementById('adminBudgetHistory').innerHTML = (data || []).map(change => {
    const before = window.BudgetUI.buildProjects(change.before_rows);
    const after = window.BudgetUI.buildProjects(change.after_rows);
    const rows = new Map();
    before.forEach(p => p.activities.forEach(a => a.categoryRows.forEach(r => rows.set(JSON.stringify([p.name, a.name, r.object_category]),
      { ...r, title: p.name, activity_title: a.name, proposed_budget: 0, proposed_budget_description: '' }))));
    after.forEach(p => p.activities.forEach(a => a.categoryRows.forEach(r => {
      const key = JSON.stringify([p.name, a.name, r.object_category]);
      const old = rows.get(key);
      rows.set(key, { ...r, title: p.name, activity_title: a.name, current_budget: old?.current_budget || 0,
        current_budget_description: old?.current_budget_description || '' });
    })));
    return `<details class="card"><summary>${escapeHtml(formatDate(change.created_at))} — ${escapeHtml(change.reason)}</summary>
      <p>Admin ID: ${escapeHtml(change.admin_id)}</p>${window.ModRender.render(Array.from(rows.values()))}</details>`;
  }).join('') || '<p class="hint">No manual budget changes recorded.</p>';
}

async function loadExpenditureSyncStatus() {
  const { data, error } = await supabaseClient.from('expenditure_sync_state').select('*').eq('id', 1).single();
  const element = document.getElementById('adminSyncStatus');
  if (error) {
    element.textContent = 'Unable to load sync status: ' + error.message;
    element.className = 'difference-invalid';
    return;
  }
  const stale = data.last_success_at && Date.now() - Date.parse(data.last_success_at) > 7200000;
  element.className = data.last_error || stale ? 'difference-invalid' : 'hint';
  element.textContent = `Last successful sync: ${data.last_success_at ? new Date(data.last_success_at).toLocaleString() : 'Never'}. Rows: ${data.row_count}.
    Last attempt: ${data.last_attempt_at ? new Date(data.last_attempt_at).toLocaleString() : 'Never'}.
    ${stale ? 'Data may be out of date. ' : ''}${data.last_error ? 'Error: ' + data.last_error : ''}`;
}

async function syncExpenditures() {
  const button = document.getElementById('syncExpendituresButton');
  button.disabled = true;
  try {
    const { data: session, error } = await supabaseClient.auth.getSession();
    if (error) throw error;
    if (!session.session) throw new Error('Sign in again to sync expenditures');
    const response = await fetch(`${SUPABASE_URL}/functions/v1/sync-expenditures`, {
      method: 'POST', headers: {
        'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.session.access_token}`
      }, body: '{}'
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Sync failed');
    showMessage(`Expenditures updated from the Google Sheet (${result.row_count} rows). Reload an open budget to see the latest values.`, 'success');
  } catch (error) {
    showMessage('Expenditure sync failed; previous expenditure data was retained: ' + error.message, 'error');
  } finally {
    button.disabled = false;
    await loadExpenditureSyncStatus();
  }
}
