// Shared grouped renderer for budget modification lines:
// Project -> Activity -> object category, with changes highlighted.
(function () {
  const CATEGORIES = ['1000s', '2000s', '3000s', '4000s', '5000s', '6000s'];
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

  function esc(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function num(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function signed(value) {
    if (Math.abs(value) < 0.005) return '—';
    return (value > 0 ? '+' : '−') + money.format(Math.abs(value));
  }

  function category(row) {
    for (const value of [row?.object_category, row?.object_code]) {
      const digits = String(value ?? '').trim().replace(/[^0-9]/g, '');
      if (/^[1-6]\d{3}$/.test(digits)) return `${digits[0]}000s`;
    }
    return '6000s';
  }

  function describe(row, which) {
    if (which === 'current') {
      return row.current_budget_description || row.budget_item_description || '';
    }
    return row.proposed_budget_description || row.proposed_description || '';
  }

  function isChanged(row) {
    return Math.abs(num(row.proposed_budget) - num(row.current_budget)) >= 0.005
      || describe(row, 'current').trim() !== describe(row, 'proposed').trim();
  }

  function group(rows) {
    const projects = new Map();
    rows.forEach(row => {
      const projectName = row.title || 'Unassigned';
      const activityName = row.activity_title || 'Unassigned';
      if (!projects.has(projectName)) projects.set(projectName, new Map());
      const activities = projects.get(projectName);
      if (!activities.has(activityName)) activities.set(activityName, { isNew: false, rows: [] });
      const activity = activities.get(activityName);
      if (row.is_new_line) activity.isNew = true;
      activity.rows.push(row);
    });
    return projects;
  }

  function sum(rows, field) {
    return rows.reduce((total, row) => total + num(row[field]), 0);
  }

  function descriptions(rows, which) {
    return rows.map(row => {
      const text = String(describe(row, which));
      if (!text.trim()) return '';
      const source = [row.activity_title, row.object_code].filter(Boolean).join(' / ');
      const detailedCode = row.object_code && String(row.object_code) !== category(row).slice(0, -1);
      return (rows.length > 1 || detailedCode) && source ? `${source}: ${text}` : text;
    }).filter(Boolean).join('\n');
  }

  function blankCategory(cat) {
    return {
      object_category: cat, object_code: cat.slice(0, -1),
      current_budget: 0, current_budget_description: '',
      proposed_budget: 0, proposed_budget_description: '', modified: false
    };
  }

  function buildProjects(budgetRows = [], managedProjects = []) {
    const projects = new Map();
    function activity(projectName, activityName) {
      if (!projects.has(projectName)) projects.set(projectName, new Map());
      const activities = projects.get(projectName);
      if (!activities.has(activityName)) activities.set(activityName, []);
      return activities.get(activityName);
    }
    managedProjects.forEach(project => {
      const name = project.project || 'Unassigned';
      if (!projects.has(name)) projects.set(name, new Map());
      (project.activities || []).forEach(nameOfActivity => activity(name, nameOfActivity));
    });
    budgetRows.forEach(row => activity(row.title || 'Unassigned', row.activity_title || 'Unassigned').push(row));
    return Array.from(projects, ([name, activities]) => ({
      name,
      activities: Array.from(activities, ([activityName, rows]) => ({
        name: activityName, is_new_line: false,
        categoryRows: CATEGORIES.map(cat => {
          const matching = rows.filter(row => category(row) === cat);
          const budget = sum(matching, 'budget');
          const description = descriptions(matching.map(row => ({
            ...row, current_budget_description: row.budget_item_description
          })), 'current');
          return {
            ...blankCategory(cat), current_budget: budget, proposed_budget: budget,
            current_budget_description: description, proposed_budget_description: description
          };
        })
      }))
    }));
  }

  function budgetTable(rows, summary) {
    return `<div class="table-wrapper"><table class="budget-table">
      <thead><tr><th>Category</th><th>Description</th><th class="money">Budget</th>
      ${summary ? '<th class="money">Expenditure</th><th class="money">Remaining</th>' : ''}</tr></thead>
      <tbody>${rows.map(row => `<tr class="${row.remaining < 0 ? 'over-budget-row' : ''}">
        <td>${esc(row.cat)}${row.remaining < 0 ? ' <span class="flag flag-delete">Over budget</span>' : ''}</td>
        <td class="description-cell">${esc(row.description) || '—'}</td>
        <td class="money">${money.format(row.budget)}</td>
        ${summary ? `<td class="money">${money.format(row.expenditure)}</td><td class="money">${money.format(row.remaining)}</td>` : ''}
      </tr>`).join('')}</tbody>
      ${summary ? `<tfoot><tr><th colspan="2">Project total</th>
        <td class="money">${money.format(sum(rows, 'budget'))}</td>
        <td class="money">${money.format(sum(rows, 'expenditure'))}</td>
        <td class="money">${money.format(sum(rows, 'remaining'))}${sum(rows, 'remaining') < 0 ? ' <span class="flag flag-delete">Over budget</span>' : ''}</td>
      </tr></tfoot>` : ''}</table></div>`;
  }

  function projectCategories(project, expenditureRows) {
    const spending = expenditureRows.filter(row => (row.project || 'Unassigned') === project.name);
    return CATEGORIES.map(cat => {
      const lines = project.activities.map(activity => ({
        activity, row: activity.categoryRows.find(row => category(row) === cat)
      }));
      const budget = lines.reduce((total, line) => total + num(line.row?.current_budget), 0);
      const expenditure = sum(spending.filter(row => category(row) === cat), 'expenditure_amount');
      return {
        cat, budget, expenditure, remaining: budget - expenditure,
        description: lines.map(({ activity, row }) => row?.current_budget_description
          ? `${activity.name}: ${row.current_budget_description}` : '').filter(Boolean).join('\n')
      };
    });
  }

  function renderProjectSummary(budgetRows = [], expenditureRows = [], projectName = 'Unassigned') {
    const project = buildProjects(budgetRows).find(project => project.name === projectName);
    const categories = projectCategories(project || { name: projectName, activities: [] }, expenditureRows);
    const unmatched = !project && expenditureRows.some(row => (row.project || 'Unassigned') === projectName);
    return `${unmatched ? '<p class="flag flag-delete">Unmatched expenditure project</p>' : ''}${budgetTable(categories, true)}`;
  }

  function renderBudget(budgetRows = [], expenditureRows = [], managedProjects = []) {
    const projects = buildProjects(budgetRows, managedProjects);
    const known = new Set(projects.map(project => project.name));
    expenditureRows.forEach(row => {
      const name = row.project || 'Unassigned';
      if (!projects.some(project => project.name === name)) projects.push({ name, activities: [] });
    });
    let budgetTotal = 0;
    let expenditureTotal = 0;
    let deficitCount = 0;
    let html = projects.map(project => {
      const categories = projectCategories(project, expenditureRows);
      categories.forEach(row => {
        budgetTotal += row.budget;
        expenditureTotal += row.expenditure;
        if (row.remaining < 0) deficitCount++;
      });
      return `<section class="project-section"><h3 class="project-header">${esc(project.name)}
        ${!known.has(project.name) ? '<span class="flag flag-delete">Unmatched expenditure project</span>' : ''}
        ${sum(categories, 'remaining') < 0 ? '<span class="flag flag-delete">Project over budget</span>' : ''}</h3>
        <div class="project-content"><h4>Project summary</h4>${budgetTable(categories, true)}
        ${project.activities.map(activity => `<article class="activity-card">
          <h4>${esc(activity.name)}</h4>${budgetTable(activity.categoryRows.map(row => ({
            cat: row.object_category, description: row.current_budget_description, budget: row.current_budget
          })), false)}</article>`).join('')}</div></section>`;
    }).join('');
    if (!projects.length) {
      html = `<section class="card"><h3>No budget data</h3>${budgetTable(CATEGORIES.map(cat => ({
        cat, description: '', budget: 0, expenditure: 0, remaining: 0
      })), true)}</section>`;
    }
    return { html, budgetTotal, expenditureTotal, remaining: budgetTotal - expenditureTotal, deficitCount };
  }

  function renderEditor(projects = []) {
    return `<div class="budget-editor">${projects.map((project, projectIndex) => `
      <section class="project-section"><h3 class="project-header">${esc(project.name)}</h3>
      <div class="project-content">${(project.activities || []).map((activity, activityIndex) => `
        <article class="activity-card"><div class="activity-header"><h4>${esc(activity.name)}
        ${activity.is_new_line ? '<span class="flag flag-new">New Activity</span>' : ''}</h4>
        <button type="button" class="button danger small-button" data-action="delete-activity"
          data-project-index="${projectIndex}" data-activity-index="${activityIndex}"
          aria-label="Delete activity ${esc(activity.name)}">Delete activity</button></div>
        <div class="table-wrapper"><table class="activity-table editor-table">
          <colgroup><col class="col-category"><col class="col-current"><col class="col-current-desc">
          <col class="col-proposed"><col class="col-proposed-desc"></colgroup>
          <thead><tr><th>Category</th><th>Current</th><th>Current description</th><th>Proposed</th><th>Proposed description</th></tr></thead>
          <tbody>${CATEGORIES.map(cat => {
            const rows = (activity.categoryRows || []).filter(row => category(row) === cat);
            const attrs = `data-project-index="${projectIndex}" data-activity-index="${activityIndex}" data-category="${cat}"`;
            const label = esc(`${project.name}, ${activity.name}, ${cat}`);
            const invalidAmounts = rows.filter(row => !Number.isFinite(Number(row.proposed_budget ?? 0)));
            const amount = invalidAmounts.length
              ? invalidAmounts.map(row => String(row.proposed_budget)).join('; ')
              : sum(rows, 'proposed_budget');
            return `<tr><td data-label="Category">${cat}</td>
              <td class="money" data-label="Current">${money.format(sum(rows, 'current_budget'))}</td>
              <td class="description-cell" data-label="Current description">${esc(descriptions(rows, 'current')) || '—'}</td>
              <td data-label="Proposed"><input class="amount-input" ${invalidAmounts.length
                ? 'type="text" inputmode="decimal" aria-invalid="true"'
                : 'type="number" step="0.01"'}
                ${attrs} data-field="proposed_budget" aria-label="${label}, proposed budget"
                value="${esc(amount)}">${invalidAmounts.length ? '<span class="hint-text">Enter a valid amount.</span>' : ''}</td>
              <td data-label="Proposed description"><textarea rows="2" ${attrs}
                data-field="proposed_budget_description" aria-label="${label}, proposed description">${esc(descriptions(rows, 'proposed'))}</textarea></td></tr>`;
          }).join('')}</tbody></table></div></article>`).join('')}</div></section>`).join('')}</div>`;
  }

  const growingTextareas = new WeakSet();
  const textareaResizers = new WeakMap();
  const observedWidths = new WeakMap();
  const textareaObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
    entries.forEach(({ target }) => {
      const width = target.getBoundingClientRect().width;
      if (observedWidths.get(target) === width) return;
      observedWidths.set(target, width);
      textareaResizers.get(target)?.();
    });
  }) : null;

  if (typeof window.addEventListener === 'function') {
    window.addEventListener('resize', () => {
      document.querySelectorAll('textarea').forEach(textarea => textareaResizers.get(textarea)?.());
    });
  }

  function autoGrowTextareas(root = document) {
    const textareas = root.matches?.('textarea') ? [root] : root.querySelectorAll('textarea');
    textareas.forEach(textarea => {
      const resize = () => {
        if (!textarea.getClientRects().length) return;
        const style = getComputedStyle(textarea);
        const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
        const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
        textarea.style.height = 'auto';
        const height = textarea.scrollHeight + (style.boxSizing === 'border-box' ? border : -padding);
        textarea.style.height = `${Math.max(Math.ceil(height), 64)}px`;
      };
      if (!growingTextareas.has(textarea)) {
        textarea.addEventListener('input', resize);
        growingTextareas.add(textarea);
        textareaResizers.set(textarea, resize);
        textareaObserver?.observe(textarea);
      }
      textareaResizers.get(textarea)();
    });
  }

  function render(rows) {
    if (!rows || !rows.length) {
      return `<section class="card"><h3>No modification lines were found.</h3>
        <div class="table-wrapper"><table class="review-table"><thead><tr>
        <th>Category</th><th>Current description</th><th>Proposed description</th>
        <th>Current</th><th>Proposed</th><th>Change</th></tr></thead><tbody>
        ${CATEGORIES.map(cat => `<tr><td>${cat}</td><td>—</td><td>—</td>
          <td class="money">${money.format(0)}</td><td class="money">${money.format(0)}</td><td class="money">—</td></tr>`).join('')}
        </tbody></table></div></section>`;
    }

    const changedCount = rows.filter(isChanged).length;
    const currentTotal = sum(rows, 'current_budget');
    const proposedTotal = sum(rows, 'proposed_budget');

    let html = `
      <div class="summary-grid">
        <div class="summary-card"><span>Current Total</span><strong>${money.format(currentTotal)}</strong></div>
        <div class="summary-card"><span>Proposed Total</span><strong>${money.format(proposedTotal)}</strong></div>
        <div class="summary-card"><span>Lines Changed</span><strong>${changedCount}</strong></div>
      </div>
    `;

    group(rows).forEach((activities, projectName) => {
      const projectRows = Array.from(activities.values()).flatMap(activity => activity.rows);
      const delta = sum(projectRows, 'proposed_budget') - sum(projectRows, 'current_budget');

      html += `
        <section class="project-section">
          <h3 class="project-header">
            ${esc(projectName)}
            <span class="project-delta">Net change: ${signed(delta)}</span>
          </h3>
          <div class="project-content">
      `;

      Array.from(activities.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .forEach(([activityName, activity]) => {
          const byCategory = new Map();
          activity.rows.forEach(row => {
            const key = category(row);
            if (!byCategory.has(key)) byCategory.set(key, []);
            byCategory.get(key).push(row);
          });

          const activityChanged = activity.rows.some(isChanged);

          let body = '';
          CATEGORIES.forEach(cat => {
            const catRows = byCategory.get(cat) || [];
            const current = sum(catRows, 'current_budget');
            const proposed = sum(catRows, 'proposed_budget');
            const currentDesc = descriptions(catRows, 'current');
            const proposedDesc = descriptions(catRows, 'proposed');
            const changed = catRows.some(isChanged);

            body += `
              <tr class="${changed ? 'changed-row' : 'unchanged-row'}">
                <td>${changed ? '<span class="modified-indicator">●</span> ' : ''}${esc(cat)}</td>
                <td class="money">${money.format(current)}</td>
                <td class="description-cell">${esc(currentDesc) || '—'}</td>
                <td class="money">${money.format(proposed)}</td>
                <td class="description-cell">${esc(proposedDesc) || '—'}</td>
                <td class="money ${proposed - current > 0 ? 'delta-up' : proposed - current < 0 ? 'delta-down' : ''}">${signed(proposed - current)}</td>
              </tr>
            `;
          });

          html += `
            <article class="activity-card">
              <div class="activity-header">
                <h4>
                  ${esc(activityName)}
                  ${activity.isNew ? '<span class="flag flag-new">New Activity</span>' : ''}
                  ${!activityChanged ? '<span class="flag">No changes</span>' : ''}
                </h4>
              </div>
              <div class="table-wrapper">
                <table class="activity-table review-table">
                  <thead>
                    <tr>
                      <th>Object Category</th>
                      <th class="money">Current</th>
                      <th>Current Description</th>
                      <th class="money">Proposed</th>
                      <th>Proposed Description</th>
                      <th class="money">Change</th>
                    </tr>
                  </thead>
                  <tbody>${body}</tbody>
                </table>
              </div>
            </article>
          `;
        });

      html += '</div></section>';
    });

    return html;
  }

  window.ModRender = { render, isChanged, esc };
  window.BudgetUI = { categories: CATEGORIES.slice(), category, buildProjects, renderBudget, renderProjectSummary, renderEditor, autoGrowTextareas };
})();
