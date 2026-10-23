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
    if (row.object_category) return row.object_category;
    const digits = String(row.object_code || '').replace(/[^0-9]/g, '');
    const lead = Number(digits[0]);
    return lead >= 1 && lead <= 6 ? `${lead}000s` : '6000s';
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

  function render(rows) {
    if (!rows || !rows.length) {
      return '<p class="card">No modification lines were found.</p>';
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
            const catRows = byCategory.get(cat);
            if (!catRows) return;
            const current = sum(catRows, 'current_budget');
            const proposed = sum(catRows, 'proposed_budget');
            const currentDesc = describe(catRows[0], 'current');
            const proposedDesc = describe(catRows[0], 'proposed');
            const changed = catRows.some(isChanged);
            if (!changed && current === 0 && proposed === 0 && !currentDesc && !proposedDesc) return;

            body += `
              <tr class="${changed ? 'changed-row' : 'unchanged-row'}">
                <td>${changed ? '<span class="modified-indicator">●</span> ' : ''}${esc(cat)}</td>
                <td class="money">${money.format(current)}</td>
                <td>${esc(currentDesc) || '—'}</td>
                <td class="money">${money.format(proposed)}</td>
                <td>${esc(proposedDesc) || '—'}</td>
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
})();
