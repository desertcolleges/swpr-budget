const SUPABASE_URL = 'https://dfghvbhidpzxjdcczcck.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_IXoPGcfK7o5LbccQvk6g9g_cWbtfrH2';

const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
);

const DEFAULT_VISIBLE_ROUNDS = ['R10'];
const NEW_BUDGET_ROUND = 'R11';
const OBJECT_CATEGORIES = ['1000s', '2000s', '3000s', '4000s', '5000s', '6000s'];

const state = {
  institution: '',
  budgetRows: [],
  expenditureRows: [],
  visibleRounds: [...DEFAULT_VISIBLE_ROUNDS],
  selectedRound: '',
  modificationProjects: [],
  approvedActivitiesByProject: {},
  baselineCurrentTotal: 0,
  isNewBudget: false,
  allocations: {},
  managedActivities: []
};

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD'
});

document.addEventListener('DOMContentLoaded', () => {
  document
    .getElementById('loadBudgetButton')
    .addEventListener('click', loadSelectedInstitution);

  document
    .getElementById('addProjectButton')
    .addEventListener('click', addProject);

  document
    .getElementById('backToRoundsButton')
    .addEventListener('click', showRoundSelection);

  document
    .getElementById('startModificationButton')
    .addEventListener('click', showModificationView);

  document
    .getElementById('cancelModificationButton')
    .addEventListener('click', () => {
      if (state.isNewBudget) {
        state.isNewBudget = false;
        state.modificationProjects = [];
        hideSections();
        return;
      }
      showRoundDetailView();
    });

  document
    .getElementById('continueToRequesterInfoButton')
    .addEventListener('click', () => {
      document
        .getElementById('submissionForm')
        .scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

  document
    .getElementById('submissionForm')
    .addEventListener('submit', submitModification);

  document
    .getElementById('modificationRows')
    .addEventListener('click', handleModificationClick);

  document
    .getElementById('modificationRows')
    .addEventListener('change', handleModificationChange);

  document
    .getElementById('modificationRows')
    .addEventListener('focusout', handleModificationBlur);

  document
    .getElementById('roundCards')
    .addEventListener('click', handleRoundCardClick);

  loadInstitutions();
});

async function loadVisibleRounds() {
  try {
    const { data, error } = await supabaseClient
      .from('site_config')
      .select('visible_rounds')
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    const rounds = normalizeRoundList(data?.visible_rounds);
    state.visibleRounds = rounds.length
      ? rounds
      : [...DEFAULT_VISIBLE_ROUNDS];
  } catch (error) {
    console.warn('Using fallback visible rounds:', error.message);
    state.visibleRounds = [...DEFAULT_VISIBLE_ROUNDS];
  }
}

async function loadInstitutions() {
  try {
    showLoading(true);

    const { data, error } = await supabaseClient.rpc(
      'get_public_institutions'
    );

    if (error) throw error;

    const select = document.getElementById('institutionSelect');
    select.innerHTML =
      '<option value="">Select an institution</option>';

    (data || []).forEach(row => {
      const option = document.createElement('option');
      option.value = row.institution;
      option.textContent = row.institution;
      select.appendChild(option);
    });

    if (!data || data.length === 0) {
      select.innerHTML =
        '<option value="">No institutions found</option>';
    }
  } catch (error) {
    showMessage(
      'Unable to load institutions: ' + error.message,
      'error'
    );
  } finally {
    showLoading(false);
  }
}

async function loadSelectedInstitution() {
  const institution = document.getElementById('institutionSelect').value;

  if (!institution) {
    showMessage('Please select an institution.', 'error');
    return;
  }

  try {
    showLoading(true);
    clearMessage();

    const visibleRoundsPromise = loadVisibleRounds();
    const allocationsPromise = loadAllocations(institution);
    const managedPromise = loadManagedActivities();

    const [budgetResult, expenditureResult] = await Promise.all([
      supabaseClient
        .from('budget_reference')
        .select('*')
        .eq('institution', institution)
        .order('title')
        .order('activity_title')
        .order('object_code'),

      supabaseClient
        .from('expenditure_reference')
        .select('*')
        .eq('institution', institution)
        .order('project')
        .order('object_code')
    ]);

    await Promise.all([visibleRoundsPromise, allocationsPromise, managedPromise]);

    if (budgetResult.error) throw budgetResult.error;
    if (expenditureResult.error) throw expenditureResult.error;

    state.institution = institution;
    state.selectedRound = '';
    state.modificationProjects = [];

    state.budgetRows = (budgetResult.data || []).map(row => ({
      ...row,
      inferred_round: getRoundIdentifier(row),
      object_category: inferObjectCategory(row.object_code)
    }));

    state.expenditureRows = expenditureResult.data || [];

    renderRoundSelection();
  } catch (error) {
    showMessage(
      'Unable to load budget data: ' + error.message,
      'error'
    );
  } finally {
    showLoading(false);
  }
}

async function loadAllocations(institution) {
  state.allocations = {};

  const { data, error } = await supabaseClient
    .from('college_allocations')
    .select('round, allocation_amount')
    .eq('institution', institution);

  if (error) return;

  (data || []).forEach(row => {
    const round = normalizeRoundToken(row.round);
    if (round) state.allocations[round] = toNumber(row.allocation_amount);
  });
}

async function loadManagedActivities() {
  state.managedActivities = [];

  const { data, error } = await supabaseClient
    .from('activity_management')
    .select('project_title, activity_name')
    .eq('is_active', true);

  if (error) return;

  state.managedActivities = (data || []).map(row => ({
    project: String(row.project_title || '').trim(),
    activity: String(row.activity_name || '').trim()
  })).filter(row => row.activity);
}

function renderRoundSelection() {
  document.getElementById('institutionHeading').textContent =
    state.institution;

  hideSections();
  document
    .getElementById('roundSection')
    .classList.remove('hidden');

  const cards = document.getElementById('roundCards');
  const summaries = state.visibleRounds
    .map(round => summarizeRound(round))
    .filter(summary => summary.projectCount > 0 || summary.allocation > 0)
    .sort((a, b) => sortRound(a.round, b.round));

  if (!summaries.length) {
    cards.innerHTML = '<p class="card">No rounds with an allocation or budget found for this institution.</p>';
    return;
  }

  cards.innerHTML = summaries
    .map(summary => {
      const allocationHtml = summary.allocation > 0
        ? `<p><strong>Allocation:</strong> ${formatCurrency(summary.allocation)}</p>`
        : '';

      if (summary.projectCount === 0) {
        return `
          <article class="card round-card">
            <h3>${escapeHtml(summary.round)}</h3>
            ${allocationHtml}
            <p class="difference-invalid"><strong>Funds need to be budgeted.</strong></p>
            <button class="button primary" data-new-round="${escapeAttribute(summary.round)}">Build ${escapeHtml(summary.round)} Budget</button>
          </article>
        `;
      }

      const breakdown = summary.projects
        .slice(0, 5)
        .map(project => `<li>${escapeHtml(project.name)}: ${formatCurrency(project.total)}</li>`)
        .join('');

      const unbudgeted = summary.allocation > 0
        ? summary.allocation - summary.totalBudget
        : 0;

      return `
        <article class="card round-card">
          <h3>${escapeHtml(summary.round)}</h3>
          ${allocationHtml}
          <p><strong>Total Budget:</strong> ${formatCurrency(summary.totalBudget)}</p>
          ${Math.abs(unbudgeted) >= 0.005 ? `<p class="difference-invalid"><strong>${unbudgeted > 0 ? 'Funds need to be budgeted' : 'Over allocation'}:</strong> ${formatCurrency(Math.abs(unbudgeted))}</p>` : ''}
          <p><strong>Projects:</strong> ${summary.projectCount}</p>
          <ul class="compact-list">${breakdown || '<li>No project details available.</li>'}</ul>
          <button class="button primary" data-round="${escapeAttribute(summary.round)}">Select ${escapeHtml(summary.round)}</button>
        </article>
      `;
    })
    .join('');
}

function summarizeRound(round) {
  const roundRows = getRowsForRound(round);
  const grouped = groupByProject(roundRows);
  const projects = Object.entries(grouped).map(([name, rows]) => ({
    name,
    total: rows.reduce((sum, row) => sum + toNumber(row.budget), 0)
  }));

  return {
    round,
    allocation: state.allocations[round] || 0,
    totalBudget: roundRows.reduce(
      (sum, row) => sum + toNumber(row.budget),
      0
    ),
    projectCount: projects.length,
    projects
  };
}

function handleRoundCardClick(event) {
  const newButton = event.target.closest('[data-new-round]');
  if (newButton) {
    startNewBudget(newButton.dataset.newRound);
    return;
  }

  const button = event.target.closest('[data-round]');
  if (!button) return;

  state.selectedRound = button.dataset.round;
  showRoundDetailView();
}

function showRoundSelection() {
  state.selectedRound = '';
  renderRoundSelection();
}

function showRoundDetailView() {
  if (!state.selectedRound) {
    renderRoundSelection();
    return;
  }

  hideSections();
  document
    .getElementById('roundDetailSection')
    .classList.remove('hidden');

  document.getElementById('selectedRoundHeading').textContent =
    `${state.institution} • ${state.selectedRound}`;

  renderBudgetTableForRound(state.selectedRound);
}

function renderBudgetTableForRound(round) {
  const container = document.getElementById('budgetResults');
  const roundRows = getRowsForRound(round);

  if (!roundRows.length) {
    container.innerHTML = '<p class="card">No budget rows found for this round.</p>';
    return;
  }

  const groupedBudget = groupByProject(roundRows);
  const groupedExpenditures = groupExpenditures(
    state.expenditureRows,
    round
  );

  const currentTotal = roundRows.reduce(
    (total, row) => total + toNumber(row.budget),
    0
  );

  const expenditureTotal = roundRows.reduce(
    (total, row) =>
      total + getExpenditureForBudgetRow(row, groupedExpenditures),
    0
  );

  const remaining = currentTotal - expenditureTotal;

  document.getElementById('roundCurrentTotal').textContent =
    formatCurrency(currentTotal);
  document.getElementById('roundExpenditureTotal').textContent =
    formatCurrency(expenditureTotal);

  const remainingElement = document.getElementById('roundRemainingTotal');
  remainingElement.textContent = formatCurrency(remaining);
  remainingElement.className = remaining < 0 ? 'difference-invalid' : '';

  let html = `
    <div class="table-wrapper">
      <table>
        <thead>
          <tr>
            <th>Project</th>
            <th>Activity</th>
            <th>Description</th>
            <th>Object Code</th>
            <th class="money">Budget</th>
            <th class="money">Expenditures</th>
            <th class="money">Remaining</th>
          </tr>
        </thead>
        <tbody>
  `;

  Object.entries(groupedBudget).forEach(([project, rows]) => {
    const projectBudget = rows.reduce(
      (total, row) => total + toNumber(row.budget),
      0
    );

    const projectExpenditures = rows.reduce(
      (total, row) =>
        total + getExpenditureForBudgetRow(row, groupedExpenditures),
      0
    );

    html += `
      <tr class="project-row">
        <td colspan="4">${escapeHtml(project)}</td>
        <td class="money">${formatCurrency(projectBudget)}</td>
        <td class="money">${formatCurrency(projectExpenditures)}</td>
        <td class="money">${formatCurrency(projectBudget - projectExpenditures)}</td>
      </tr>
    `;

    rows.forEach(row => {
      const budget = toNumber(row.budget);
      const expenditures = getExpenditureForBudgetRow(
        row,
        groupedExpenditures
      );

      html += `
        <tr>
          <td>${escapeHtml(row.title)}</td>
          <td>${escapeHtml(row.activity_title)}</td>
          <td>${escapeHtml(row.budget_item_description)}</td>
          <td>${escapeHtml(row.object_code)}</td>
          <td class="money">${formatCurrency(budget)}</td>
          <td class="money">${formatCurrency(expenditures)}</td>
          <td class="money">${formatCurrency(budget - expenditures)}</td>
        </tr>
      `;
    });
  });

  html += '</tbody></table></div>';
  container.innerHTML = html;
}

function showModificationView() {
  state.isNewBudget = false;
  document.getElementById('newProjectControls').classList.add('hidden');
  document.getElementById('modificationSubheading').textContent =
    'The final proposed total must equal the allocation for this round.';
  const roundRows = getRowsForRound(state.selectedRound);

  if (!roundRows.length) {
    showMessage('There is no round data to modify.', 'error');
    return;
  }

  if (!(state.allocations[state.selectedRound] > 0)) {
    showMessage(
      `No ${state.selectedRound} allocation is set for this institution. Contact an administrator.`,
      'error'
    );
    return;
  }

  state.baselineCurrentTotal = state.allocations[state.selectedRound];

  state.approvedActivitiesByProject = buildApprovedActivities(roundRows);
  state.modificationProjects = buildModificationProjects(roundRows);

  hideSections();
  document
    .getElementById('modificationSection')
    .classList.remove('hidden');

  document.getElementById('modificationHeading').textContent =
    `Submit ${state.selectedRound} Budget Modification`;

  renderModificationProjects();
  updateModificationTotals();
}

function startNewBudget(round) {
  clearMessage();

  if (!(state.allocations[round] > 0)) {
    showMessage(
      `No ${round} allocation is set for this institution. Contact an administrator.`,
      'error'
    );
    return;
  }

  state.selectedRound = round;
  state.isNewBudget = true;
  state.modificationProjects = [];
  state.approvedActivitiesByProject = {};
  state.baselineCurrentTotal = state.allocations[round] || 0;

  document.getElementById('projectOptions').innerHTML = getKnownProjects()
    .map(name => `<option value="${escapeAttribute(name)}"></option>`)
    .join('');

  hideSections();
  document.getElementById('modificationSection').classList.remove('hidden');
  document.getElementById('newProjectControls').classList.remove('hidden');
  document.getElementById('modificationHeading').textContent =
    `${state.institution} • Build New ${round} Budget`;
  document.getElementById('modificationSubheading').textContent =
    state.baselineCurrentTotal > 0
      ? `Add projects and activities. The proposed total must equal your ${round} allocation.`
      : `Add projects and activities to build your ${round} budget.`;

  renderModificationProjects();
  updateModificationTotals();
}

function getKnownProjects() {
  const names = new Set();
  state.managedActivities.forEach(row => { if (row.project) names.add(row.project); });
  state.budgetRows.forEach(row => {
    const title = String(row.title || '').trim();
    if (title) names.add(title);
  });
  return Array.from(names).sort((x, y) => x.localeCompare(y));
}

function addProject() {
  const input = document.getElementById('newProjectName');
  const name = input.value.trim();
  const knownProjects = getKnownProjects();

  if (name && knownProjects.length && !knownProjects.some(p => p.toLowerCase() === name.toLowerCase())) {
    showMessage(`Project ${name} is not set up. Choose an approved project.`, 'error');
    return;
  }

  if (!name) {
    showMessage('Enter a project name.', 'error');
    return;
  }

  if (state.modificationProjects.some(p => p.name.toLowerCase() === name.toLowerCase())) {
    showMessage(`Project ${name} already exists.`, 'error');
    return;
  }

  clearMessage();
  const canonical = knownProjects.find(p => p.toLowerCase() === name.toLowerCase()) || name;
  state.modificationProjects.push({ name: canonical, activities: [] });
  state.approvedActivitiesByProject = buildApprovedActivities(getRowsForRound(state.selectedRound));
  input.value = '';
  renderModificationProjects();
}

function buildApprovedActivities(roundRows) {
  const map = {};

  // Keep activity options scoped to the selected round to prevent cross-round transfers.
  roundRows.forEach(row => {
    const project = String(row.title || '').trim();
    const activity = String(row.activity_title || '').trim();

    if (!project || !activity) return;

    if (!map[project]) {
      map[project] = new Set();
    }

    map[project].add(activity);
  });

  // Admin-managed activities: project-specific, or global when project_title is blank.
  const projectNames = new Set([
    ...Object.keys(map),
    ...state.modificationProjects.map(p => p.name)
  ]);

  projectNames.forEach(project => {
    if (!map[project]) map[project] = new Set();
    state.managedActivities.forEach(row => {
      if (!row.project || row.project.toLowerCase() === project.toLowerCase()) {
        map[project].add(row.activity);
      }
    });
  });

  return Object.fromEntries(
    Object.entries(map).map(([project, activities]) => {
      return [project, Array.from(activities).sort((a, b) => a.localeCompare(b))];
    })
  );
}

function buildModificationProjects(roundRows) {
  const projectMap = new Map();

  // Grouping data as project -> activity -> object category allows one normalized editable row
  // per activity/category while preserving source object-code context for payload submission.
  roundRows.forEach(row => {
    const projectName = String(row.title || 'Unassigned').trim();
    const activityName = String(row.activity_title || 'Unassigned').trim();
    const category = row.object_category || inferObjectCategory(row.object_code);

    if (!projectMap.has(projectName)) {
      projectMap.set(projectName, {
        name: projectName,
        activities: new Map()
      });
    }

    const project = projectMap.get(projectName);

    if (!project.activities.has(activityName)) {
      project.activities.set(activityName, []);
    }

    project.activities.get(activityName).push({
      object_category: category,
      object_code: String(row.object_code || '').trim(),
      current_budget: toNumber(row.budget),
      current_budget_description: String(row.budget_item_description || '').trim()
    });
  });

  return Array.from(projectMap.values())
    .map(project => {
      return {
        name: project.name,
        activities: Array.from(project.activities.entries())
          .map(([activityName, sourceRows]) => {
            const rowsByCategory = {};

            sourceRows.forEach(sourceRow => {
              const category = sourceRow.object_category;

              if (!rowsByCategory[category]) {
                rowsByCategory[category] = {
                  object_category: category,
                  object_code: sourceRow.object_code,
                  current_budget: 0,
                  current_budget_description: '',
                  proposed_budget: 0,
                  proposed_budget_description: '',
                  modified: false
                };
              }

              rowsByCategory[category].current_budget += sourceRow.current_budget;

              if (!rowsByCategory[category].current_budget_description && sourceRow.current_budget_description) {
                rowsByCategory[category].current_budget_description = sourceRow.current_budget_description;
              }

              if (!rowsByCategory[category].object_code && sourceRow.object_code) {
                rowsByCategory[category].object_code = sourceRow.object_code;
              }
            });

            const categoryRows = OBJECT_CATEGORIES.map(category => {
              const existing = rowsByCategory[category];

              if (existing) {
                return {
                  ...existing,
                  proposed_budget: existing.current_budget,
                  proposed_budget_description: existing.current_budget_description,
                  modified: false
                };
              }

              return {
                object_category: category,
                object_code: '',
                current_budget: 0,
                current_budget_description: '',
                proposed_budget: 0,
                proposed_budget_description: '',
                modified: false
              };
            });

            return {
              name: activityName,
              is_new_line: false,
              categoryRows
            };
          })
          .sort((a, b) => a.name.localeCompare(b.name))
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function renderModificationProjects() {
  const container = document.getElementById('modificationRows');

  container.innerHTML = state.modificationProjects.map((project, projectIndex) => {
    const existingActivities = new Set(project.activities.map(activity => activity.name));
    const approvedActivities = state.approvedActivitiesByProject[project.name] || [];
    const addableActivities = approvedActivities.filter(name => !existingActivities.has(name));

    const activitiesHtml = project.activities.length
      ? project.activities.map((activity, activityIndex) => renderActivityCard(projectIndex, activityIndex, activity)).join('')
      : '<p>No activities yet for this project. Add one below.</p>';
    const noneNote = !addableActivities.length
      ? '<p class="hint">No approved activities available. Ask an administrator to set them up.</p>'
      : '';

    return `
      <section class="project-section">
        <h3 class="project-header">${escapeHtml(project.name)}</h3>
        <div class="project-content">
          ${activitiesHtml}
          ${noneNote}
          <div class="activity-controls">
            <label for="add-activity-${projectIndex}">Add New Activity</label>
            <select id="add-activity-${projectIndex}" data-project-index="${projectIndex}" data-action="activity-select">
              <option value="">Select an activity</option>
              ${addableActivities.map(activity => `<option value="${escapeAttribute(activity)}">${escapeHtml(activity)}</option>`).join('')}
            </select>
            <button class="button primary small-button" type="button" data-project-index="${projectIndex}" data-action="add-activity">+ Add New Activity</button>
          </div>
        </div>
      </section>
    `;
  }).join('');
}

function renderActivityCard(projectIndex, activityIndex, activity) {
  const rowsHtml = activity.categoryRows.map(row => {
    const warningClass = row.proposed_budget > 0 && !String(row.proposed_budget_description || '').trim()
      ? 'object-row-warning'
      : '';

    return `
      <tr class="${row.modified ? 'changed-row' : ''} ${warningClass}" data-project-index="${projectIndex}" data-activity-index="${activityIndex}" data-category="${escapeAttribute(row.object_category)}">
        <td>
          ${row.modified ? '<span class="modified-indicator">●</span>' : ''}
          ${escapeHtml(row.object_category)}
        </td>
        <td class="money current-cell">${formatCurrency(row.current_budget)}</td>
        <td class="current-cell">${escapeHtml(row.current_budget_description || '—')}</td>
        <td>
          <input
            type="number"
            class="amount-input"
            min="0"
            step="1"
            inputmode="numeric"
            value="${toInputAmount(row.proposed_budget)}"
            data-project-index="${projectIndex}"
            data-activity-index="${activityIndex}"
            data-category="${escapeAttribute(row.object_category)}"
            data-field="proposed_budget"
          />
        </td>
        <td>
          <textarea
            rows="2"
            data-project-index="${projectIndex}"
            data-activity-index="${activityIndex}"
            data-category="${escapeAttribute(row.object_category)}"
            data-field="proposed_budget_description"
          >${escapeHtml(row.proposed_budget_description)}</textarea>
        </td>
      </tr>
    `;
  }).join('');

  return `
    <article class="activity-card" data-project-index="${projectIndex}" data-activity-index="${activityIndex}">
      <div class="activity-header">
        <h4>${escapeHtml(activity.name)}${activity.is_new_line ? ' <span class="flag flag-new">New Activity</span>' : ''}</h4>
        <button class="button danger small-button" type="button" data-project-index="${projectIndex}" data-activity-index="${activityIndex}" data-action="delete-activity">Delete Activity</button>
      </div>
      <div class="table-wrapper">
        <table class="activity-table">
          <thead>
            <tr>
              <th class="col-category">Object Category</th>
              <th class="money col-current">Current Budget</th>
              <th class="col-current-desc">Current Description</th>
              <th class="money col-proposed">Proposed Budget</th>
              <th class="col-proposed-desc">Proposed Description</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
    </article>
  `;
}

function handleModificationClick(event) {
  const deleteButton = event.target.closest('[data-action="delete-activity"]');
  if (deleteButton) {
    const projectIndex = Number(deleteButton.dataset.projectIndex);
    const activityIndex = Number(deleteButton.dataset.activityIndex);
    deleteActivity(projectIndex, activityIndex);
    return;
  }

  const addButton = event.target.closest('[data-action="add-activity"]');
  if (addButton) {
    const projectIndex = Number(addButton.dataset.projectIndex);
    const select = document.getElementById(`add-activity-${projectIndex}`);
    addActivity(projectIndex, select?.value || '');
  }
}

function handleModificationChange(event) {
  const target = event.target;

  if (target.dataset.action === 'activity-select') {
    return;
  }

  if (!target.dataset || target.dataset.field === undefined) {
    return;
  }

  applyModificationFieldUpdate(target);
}

function handleModificationBlur(event) {
  const target = event.target;

  if (!target.dataset || target.dataset.field !== 'proposed_budget_description') {
    return;
  }

  applyModificationFieldUpdate(target);
}

function applyModificationFieldUpdate(target) {
  const projectIndex = Number(target.dataset.projectIndex);
  const activityIndex = Number(target.dataset.activityIndex);
  const category = target.dataset.category;
  const field = target.dataset.field;

  const row = getCategoryRow(projectIndex, activityIndex, category);
  if (!row) return;

  if (field === 'proposed_budget') {
    row.proposed_budget = Math.round(toNumber(target.value));
    target.value = row.proposed_budget ? String(row.proposed_budget) : '';
  } else if (field === 'proposed_budget_description') {
    row.proposed_budget_description = String(target.value || '').trim();
  }

  row.modified = isObjectRowModified(row);
  updateCategoryRowAppearance(projectIndex, activityIndex, category);
  updateModificationTotals();
}

function deleteActivity(projectIndex, activityIndex) {
  const project = state.modificationProjects[projectIndex];
  if (!project) return;

  project.activities.splice(activityIndex, 1);
  renderModificationProjects();
  updateModificationTotals();
}

function addActivity(projectIndex, activityName) {
  const project = state.modificationProjects[projectIndex];
  if (!project) return;

  const selectedName = String(activityName || '').trim();
  if (!selectedName) {
    showMessage('Select an activity to add.', 'error');
    return;
  }

  const alreadyExists = project.activities.some(activity => activity.name === selectedName);

  if (alreadyExists) {
    showMessage(`Activity ${selectedName} is already added for project ${project.name}.`, 'error');
    return;
  }

  const categoryRows = OBJECT_CATEGORIES.map(category => ({
    object_category: category,
    object_code: '',
    current_budget: 0,
    current_budget_description: '',
    proposed_budget: 0,
    proposed_budget_description: '',
    modified: false
  }));

  project.activities.push({
    name: selectedName,
    is_new_line: true,
    categoryRows
  });

  project.activities.sort((a, b) => a.name.localeCompare(b.name));
  renderModificationProjects();
  updateModificationTotals();
}

function updateCategoryRowAppearance(projectIndex, activityIndex, category) {
  const rowElement = document.querySelector(
    `tr[data-project-index="${projectIndex}"][data-activity-index="${activityIndex}"][data-category="${cssEscape(category)}"]`
  );

  const row = getCategoryRow(projectIndex, activityIndex, category);

  if (!rowElement || !row) return;

  rowElement.classList.toggle('changed-row', row.modified);

  const requiresDescription = row.proposed_budget > 0 && !String(row.proposed_budget_description || '').trim();
  rowElement.classList.toggle('object-row-warning', requiresDescription);

  const indicatorCell = rowElement.querySelector('td:first-child');
  if (indicatorCell) {
    indicatorCell.innerHTML = `${row.modified ? '<span class="modified-indicator">●</span>' : ''}${escapeHtml(row.object_category)}`;
  }
}

function getCategoryRow(projectIndex, activityIndex, category) {
  const project = state.modificationProjects[projectIndex];
  if (!project) return null;

  const activity = project.activities[activityIndex];
  if (!activity) return null;

  return activity.categoryRows.find(row => row.object_category === category) || null;
}

function isObjectRowModified(row) {
  const budgetChanged = Math.abs(toNumber(row.proposed_budget) - toNumber(row.current_budget)) >= 0.005;
  const descriptionChanged = String(row.proposed_budget_description || '').trim() !== String(row.current_budget_description || '').trim();

  return budgetChanged || descriptionChanged;
}

function updateModificationTotals() {
  const currentTotal = state.baselineCurrentTotal;
  const proposedTotal = getFlattenedModifications().reduce(
    (sum, row) => sum + toNumber(row.proposed_budget),
    0
  );

  const difference = proposedTotal - currentTotal;
  const valid = currentTotal > 0 && Math.abs(difference) < 0.005;

  document.getElementById('currentTotal').textContent =
    formatCurrency(currentTotal);
  document.getElementById('proposedTotal').textContent =
    formatCurrency(proposedTotal);

  const differenceElement = document.getElementById('totalDifference');
  differenceElement.textContent = formatCurrency(difference);
  differenceElement.className = valid
    ? 'difference-valid'
    : 'difference-invalid';

  document.getElementById('submitButton').disabled = !valid;
}

async function submitModification(event) {
  event.preventDefault();

  const requesterName =
    document.getElementById('requesterName').value.trim();
  const requesterEmail =
    document.getElementById('requesterEmail').value.trim();
  const justification =
    document.getElementById('justification').value.trim();

  if (!requesterName || !requesterEmail || !justification) {
    showMessage('Please complete all required fields.', 'error');
    return;
  }

  const flattened = getFlattenedModifications();
  const validationErrors = validateModifications(flattened);

  if (validationErrors.length) {
    showMessage(validationErrors[0], 'error');
    return;
  }

  try {
    showLoading(true);
    clearMessage();

    const response = await fetch(
      `${SUPABASE_URL}/functions/v1/submit-budget`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
          Authorization: 'Bearer ' + SUPABASE_ANON_KEY
        },
        body: JSON.stringify({
          institution: state.institution,
          requesterName,
          requesterEmail,
          justification,
          round: state.selectedRound,
          modifications: flattened.map(row => ({
            title: row.title,
            activity_title: row.activity_title,
            object_category: row.object_category,
            object_code: row.object_code || '',
            current_budget: toNumber(row.current_budget),
            current_budget_description: row.current_budget_description,
            proposed_budget: toNumber(row.proposed_budget),
            proposed_budget_description: row.proposed_budget_description,
            is_new_line: Boolean(row.is_new_line),
            activity_status: row.activity_status,
            round: state.selectedRound
          }))
        })
      }
    );

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Unable to submit request.');
    }

    document.getElementById('submissionForm').reset();

    showMessage(
      `Request ${result.request_number} was submitted successfully for ${state.selectedRound}.`,
      'success'
    );

    state.modificationProjects = [];
    if (state.isNewBudget) {
      state.isNewBudget = false;
      hideSections();
    } else {
      showRoundDetailView();
    }
  } catch (error) {
    showMessage(
      'Unable to submit request: ' + error.message,
      'error'
    );
  } finally {
    showLoading(false);
  }
}

function validateModifications(flattened) {
  const errors = [];

  if (!hasMeaningfulChanges()) {
    errors.push(state.isNewBudget
      ? 'Add at least one budgeted line before submission.'
      : 'At least one budget line must be modified before submission.');
    return errors;
  }

  const byProjectActivity = new Map();

  flattened.forEach(row => {
    if (!byProjectActivity.has(row.title)) {
      byProjectActivity.set(row.title, new Map());
    }

    const activityMap = byProjectActivity.get(row.title);

    if (!activityMap.has(row.activity_title)) {
      activityMap.set(row.activity_title, []);
    }

    activityMap.get(row.activity_title).push(row);
  });

  byProjectActivity.forEach(activityMap => {
    activityMap.forEach(activityRows => {
      const sample = activityRows[0];
      const hasBudgetedCategory = activityRows.some(
        row => toNumber(row.proposed_budget) > 0
      );

      if (!hasBudgetedCategory) {
        errors.push(
          `Activity ${sample.activity_title} must have at least one budgeted object category.`
        );
      }
    });
  });

  flattened.forEach(row => {
    if (
      toNumber(row.proposed_budget) > 0 &&
      !String(row.proposed_budget_description || '').trim()
    ) {
      errors.push(
        `Description required for ${row.activity_title} - ${row.object_category}.`
      );
    }
  });

  const proposedTotal = flattened.reduce(
    (sum, row) => sum + toNumber(row.proposed_budget),
    0
  );

  if (!(state.baselineCurrentTotal > 0)) {
    errors.push(`No ${state.selectedRound} allocation is set for this institution.`);
  } else if (Math.abs(proposedTotal - state.baselineCurrentTotal) >= 0.005) {
    errors.push(
      `The proposed budget must equal the ${state.selectedRound} allocation.`
    );
  }

  return errors;
}

function getFlattenedModifications() {
  return state.modificationProjects.flatMap(project => {
    return project.activities.flatMap(activity => {
      return activity.categoryRows.map(row => ({
        title: project.name,
        activity_title: activity.name,
        object_category: row.object_category,
        object_code: row.object_code,
        current_budget: row.current_budget,
        current_budget_description: row.current_budget_description,
        proposed_budget: row.proposed_budget,
        proposed_budget_description: row.proposed_budget_description,
        is_new_line: activity.is_new_line,
        activity_status: 'active'
      }));
    });
  });
}

function hasMeaningfulChanges() {
  return state.modificationProjects.some(project => {
    return project.activities.some(activity => {
      return activity.categoryRows.some(row => isObjectRowModified(row));
    });
  });
}

function getRowsForRound(round) {
  return state.budgetRows.filter(
    row => row.inferred_round === round && state.visibleRounds.includes(round)
  );
}

function groupByProject(rows) {
  return rows.reduce((groups, row) => {
    const project = row.title || 'Unassigned';

    if (!groups[project]) {
      groups[project] = [];
    }

    groups[project].push(row);
    return groups;
  }, {});
}

function groupExpenditures(rows, round) {
  return rows.reduce((groups, row) => {
    if (getRoundIdentifier(row) !== round) {
      return groups;
    }

    const key = [row.project, row.object_code]
      .map(value => String(value || '').trim().toLowerCase())
      .join('|');

    groups[key] = (groups[key] || 0) + toNumber(row.expenditure_amount);

    return groups;
  }, {});
}

function getExpenditureForBudgetRow(row, groupedExpenditures) {
  const key = [row.title, row.object_code]
    .map(value => String(value || '').trim().toLowerCase())
    .join('|');

  return groupedExpenditures[key] || 0;
}

function getRoundIdentifier(row) {
  const explicitRound =
    row?.round ||
    row?.round_name ||
    row?.funding_round ||
    row?.grant_round ||
    '';

  const normalizedExplicit = normalizeRoundToken(explicitRound);
  if (normalizedExplicit) {
    return normalizedExplicit;
  }

  return (
    normalizeRoundToken(row?.title) ||
    normalizeRoundToken(row?.project) ||
    ''
  );
}

function normalizeRoundToken(value) {
  const match = String(value || '').match(/\bR\s*(\d+)\b/i);
  if (!match) return '';
  return `R${Number(match[1])}`;
}

function normalizeRoundList(list) {
  if (!Array.isArray(list)) return [];

  const rounds = list
    .map(item => {
      const match = String(item || '').match(/\bR\s*(\d+)\b/i);
      return match ? `R${Number(match[1])}` : null;
    })
    .filter(Boolean);

  return Array.from(new Set(rounds)).sort(sortRound);
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

function sortRound(a, b) {
  return toRoundNumber(a) - toRoundNumber(b);
}

function toRoundNumber(round) {
  return Number(String(round || '').replace(/[^0-9]/g, '')) || 0;
}

function hideSections() {
  document.getElementById('roundSection').classList.add('hidden');
  document
    .getElementById('roundDetailSection')
    .classList.add('hidden');
  document
    .getElementById('modificationSection')
    .classList.add('hidden');
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

function toInputAmount(value) {
  return Math.round(toNumber(value));
}

function formatCurrency(value) {
  return currencyFormatter.format(toNumber(value));
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

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') {
    return window.CSS.escape(String(value || ''));
  }

  return String(value || '').replace(/(["'\\#.:\[\]\(\)\s])/g, '\\$1');
}

function showMessage(message, type) {
  const area = document.getElementById('messageArea');

  area.innerHTML = `
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
