import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const context = vm.createContext({ window: {}, Intl });
vm.runInContext(readFileSync(new URL('../shared.js', import.meta.url), 'utf8'), context);
const { BudgetUI, ModRender } = context.window;
const budget = [
  { title: 'Project R10', activity_title: 'A', object_code: '1100', budget: 100, budget_item_description: 'First description' },
  { title: 'Project R10', activity_title: 'A', object_code: '1200', budget: 50, budget_item_description: 'Second description' },
  { title: 'Project R10', activity_title: 'B', object_code: '1000', budget: 100, budget_item_description: 'Third description' },
  { title: 'Project R10', activity_title: 'B', object_code: '2000', budget: 300, budget_item_description: 'Equipment' }
];

test('project/category expenditures are counted once, with per-category coverage warnings', () => {
  const result = BudgetUI.renderBudget(budget, [
    { project: 'Project R10', object_category: '1000s', expenditure_amount: 260 },
    { project: 'Project R10', object_code: '2000', expenditure_amount: 10 },
    { project: 'Project R10', object_category: '6000s', expenditure_amount: 5 }
  ]);
  assert.equal(result.budgetTotal, 550);
  assert.equal(result.expenditureTotal, 275);
  assert.equal(result.remaining, 275);
  assert.equal(result.deficitCount, 2);
  assert.match(result.html, /First description/);
  assert.match(result.html, /Second description/);
  assert.match(result.html, /Third description/);
  for (const category of BudgetUI.categories) assert.ok(result.html.includes(category));
  const summary = BudgetUI.renderProjectSummary(budget, [
    { project: 'Project R10', object_category: '1000s', expenditure_amount: 260 }
  ], 'Project R10');
  assert.match(summary, /\$250\.00/);
  assert.match(summary, /\$260\.00/);
  assert.ok(!summary.includes('activity-card'));
});

test('unbudgeted projects and empty views retain six categories without phantom spending', () => {
  const empty = BudgetUI.renderBudget([], [], []);
  assert.equal(empty.budgetTotal, 0);
  assert.equal(empty.expenditureTotal, 0);
  for (const category of BudgetUI.categories) assert.ok(empty.html.includes(category));
  const unbudgeted = BudgetUI.renderBudget([], [
    { project: '<Unknown>', object_category: '3000s', expenditure_amount: 17 }
  ], [{ project: 'Configured', activities: ['Activity'] }]);
  assert.equal(unbudgeted.expenditureTotal, 17);
  assert.equal(unbudgeted.remaining, -17);
  assert.match(unbudgeted.html, /&lt;Unknown&gt;/);
  assert.match(unbudgeted.html, /Configured/);
});

test('edit and review renderers preserve all categories and descriptions', () => {
  const projects = BudgetUI.buildProjects(budget);
  assert.equal(projects[0].activities[0].categoryRows.length, 6);
  assert.equal(projects[0].activities[0].categoryRows[0].current_budget, 150);
  assert.match(projects[0].activities[0].categoryRows[0].current_budget_description, /Second description/);
  const editor = BudgetUI.renderEditor(projects);
  assert.match(editor, /data-field="proposed_budget_description"/);
  assert.match(editor, /aria-label=/);
  const review = ModRender.render([{ title: 'Project', activity_title: 'Activity', object_category: '1000s',
    current_budget: 0, proposed_budget: 0, current_budget_description: '', proposed_budget_description: '' }]);
  for (const category of BudgetUI.categories) {
    assert.ok(review.includes(category));
    assert.ok(ModRender.render([]).includes(category));
  }
});
