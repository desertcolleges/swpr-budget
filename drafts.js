function captureBaseline() {
  state.baselineHash = state.fingerprints[state.selectedRound] || state.emptyFingerprint;
  state.baselineRows = structuredClone(getRowsForRound(state.selectedRound));
  state.baselineStale = false;
  document.getElementById('draftBaselineWarning').classList.add('hidden');
}

function clearDraftSession() {
  clearTimeout(state.autosaveTimer);
  state.draftToken = '';
  state.draftVersion = 0;
  state.hasUnsavedChanges = false;
  state.baselineStale = false;
  document.getElementById('draftSaveStatus').textContent = '';
  document.getElementById('resumeDraftLink').classList.add('hidden');
  document.getElementById('draftBaselineWarning').classList.add('hidden');
  if (new URLSearchParams(location.hash.slice(1)).has('draft')) history.replaceState(null, '', location.pathname + location.search);
}

function markModificationDirty() {
  state.hasUnsavedChanges = true;
  state.editVersion += 1;
  clearTimeout(state.autosaveTimer);
  if (state.draftVersion && !state.submitting) {
    document.getElementById('draftSaveStatus').textContent = 'Unsaved changes';
    state.autosaveTimer = setTimeout(() => saveDraft(false), 1500);
  }
}

async function draftRequest(body) {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/budget-draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Draft operation failed');
  return result;
}

async function saveDraft(sendEmail) {
  if (state.submitting) return;
  if (state.savingDraft) {
    await state.savingDraft;
    if (!sendEmail) return;
  }
  clearTimeout(state.autosaveTimer);
  const name = document.getElementById('requesterName').value.trim();
  const email = document.getElementById('requesterEmail').value.trim();
  const status = document.getElementById('draftSaveStatus');
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    status.textContent = 'Not saved: provide your name and a valid email using Save Draft.';
    return;
  }
  if (!getFlattenedModifications().every(row => Number.isSafeInteger(row.proposed_budget) && row.proposed_budget >= 0)) {
    status.textContent = 'Not saved: budget amounts must be nonnegative whole dollars.';
    return;
  }
  if (!state.draftToken) state.draftToken = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
  const token = state.draftToken;
  const editVersion = state.editVersion;
  const payload = {
    projects: structuredClone(state.modificationProjects), isNewBudget: state.isNewBudget,
    justification: document.getElementById('justification').value,
    baselineHash: state.baselineHash, baselineRows: state.baselineRows
  };
  status.textContent = 'Saving draft...';
  document.getElementById('saveDraftButton').disabled = true;
  state.savingDraft = (async () => {
    try {
      const result = await draftRequest({
        action: 'save', token, version: state.draftVersion, institution: state.institution,
        round: state.selectedRound, requesterName: name, requesterEmail: email, payload, sendEmail
      });
      if (state.draftToken !== token) return;
      state.draftVersion = result.version;
      state.hasUnsavedChanges = state.editVersion !== editVersion;
      const link = new URL(location.pathname, location.origin);
      link.hash = `draft=${token}`;
      const anchor = document.getElementById('resumeDraftLink');
      anchor.href = link.href;
      anchor.classList.remove('hidden');
      history.replaceState(null, '', link.pathname + link.hash);
      status.textContent = result.email_warning
        ? `Draft saved, but confirmation email failed: ${result.email_warning}. Use Save Draft to retry delivery.`
        : `Draft saved at ${new Date(result.updated_at).toLocaleTimeString()}.${sendEmail ? ' Confirmation email sent.' : ''}`;
      if (state.hasUnsavedChanges && !state.submitting) state.autosaveTimer = setTimeout(() => saveDraft(false), 1500);
    } catch (error) {
      if (state.draftToken !== token) return;
      status.textContent = 'Draft was not saved: ' + error.message;
      state.hasUnsavedChanges = true;
    } finally {
      document.getElementById('saveDraftButton').disabled = false;
    }
  })();
  await state.savingDraft;
  state.savingDraft = null;
}

async function resumeDraft(token) {
  try {
    showLoading(true);
    const draft = await draftRequest({ action: 'load', token });
    if (draft.submitted_request) {
      showSubmissionSuccess(draft.submitted_request, 'was already submitted. This saved draft is no longer editable.');
      return;
    }
    document.getElementById('institutionSelect').value = draft.institution;
    await loadSelectedInstitution();
    if (state.institution !== draft.institution) throw new Error('Unable to load the draft institution');
    if (!state.visibleRounds.includes(draft.round)) throw new Error('This draft round is not currently available. Contact an administrator.');
    state.selectedRound = draft.round;
    state.draftToken = token;
    state.draftVersion = draft.version;
    state.modificationProjects = draft.payload.projects;
    state.isNewBudget = Boolean(draft.payload.isNewBudget);
    state.baselineHash = draft.payload.baselineHash;
    state.baselineRows = draft.payload.baselineRows || [];
    state.baselineCurrentTotal = state.allocations[draft.round] || 0;
    state.baselineStale = state.baselineHash !== (state.fingerprints[draft.round] || state.emptyFingerprint);
    state.approvedActivitiesByProject = buildApprovedActivities(getRowsForRound(draft.round));
    document.getElementById('requesterName').value = draft.requester_name;
    document.getElementById('requesterEmail').value = draft.requester_email;
    document.getElementById('justification').value = draft.payload.justification || '';
    await loadRoundHistory(draft.round);
    hideSections();
    document.getElementById('modificationSection').classList.remove('hidden');
    document.getElementById('newProjectControls').classList.toggle('hidden', !state.isNewBudget);
    document.getElementById('projectOptions').innerHTML = getKnownProjects().map(name => `<option value="${escapeAttribute(name)}"></option>`).join('');
    document.getElementById('modificationHeading').textContent = `Continue ${draft.round} Draft`;
    document.getElementById('draftSaveStatus').textContent = `Saved draft loaded (${formatDateTime(draft.updated_at)}). Not submitted for approval.`;
    document.getElementById('draftBaselineWarning').classList.toggle('hidden', !state.baselineStale);
    const link = document.getElementById('resumeDraftLink');
    link.href = `${location.pathname}#draft=${token}`;
    link.classList.remove('hidden');
    history.replaceState(null, '', link.href);
    document.getElementById('submitButton').textContent = state.openRequest ? 'Resubmit for Approval' : 'Submit Round Request';
    renderModificationProjects();
    updateModificationTotals();
  } catch (error) {
    showMessage('Unable to continue draft: ' + error.message, 'error');
  } finally {
    showLoading(false);
  }
}

async function reviewCurrentBudget() {
  try {
    const { data, error } = await supabaseClient.rpc('get_budget_snapshot', { p_institution: state.institution, p_round: state.selectedRound });
    if (error) throw error;
    if (!confirm('Update this draft to the latest budget? Your proposed edits and deletions will be retained. Newly budgeted activities will be added for review. Review every proposed category before submitting.')) return;
    const latest = window.BudgetUI.buildProjects(data.rows);
    const previous = window.BudgetUI.buildProjects(state.baselineRows);
    const key = (project, activity) => JSON.stringify([project.name.toLowerCase(), activity.name.toLowerCase()]);
    const previousActivities = new Set(previous.flatMap(p => p.activities.map(a => key(p, a))));
    const latestMap = new Map(latest.flatMap(p => p.activities.map(a => [key(p, a), a])));
    const draftActivities = new Set(state.modificationProjects.flatMap(p => p.activities.map(a => key(p, a))));
    state.modificationProjects.forEach(project => project.activities.forEach(activity => {
      const current = latestMap.get(key(project, activity));
      activity.categoryRows.forEach(row => {
        const replacement = current?.categoryRows.find(r => r.object_category === row.object_category);
        const wasChanged = isObjectRowModified(row);
        row.current_budget = replacement?.current_budget || 0;
        row.current_budget_description = replacement?.current_budget_description || '';
        row.object_code = replacement?.object_code || '';
        if (!wasChanged) {
          row.proposed_budget = row.current_budget;
          row.proposed_budget_description = row.current_budget_description;
        }
        row.modified = isObjectRowModified(row);
      });
    }));
    latest.forEach(project => project.activities.forEach(activity => {
      if (draftActivities.has(key(project, activity)) || previousActivities.has(key(project, activity))) return;
      let target = state.modificationProjects.find(p => p.name.toLowerCase() === project.name.toLowerCase());
      if (!target) {
        target = { name: project.name, activities: [] };
        state.modificationProjects.push(target);
      }
      target.activities.push(activity);
    }));
    state.budgetRows = state.budgetRows.filter(r => r.inferred_round !== state.selectedRound).concat(data.rows.map(r => ({ ...r, inferred_round: state.selectedRound })));
    state.fingerprints = { ...state.fingerprints, ...data.fingerprints, [state.selectedRound]: data.fingerprints[state.selectedRound] || data.empty_fingerprint };
    captureBaseline();
    state.approvedActivitiesByProject = buildApprovedActivities(getRowsForRound(state.selectedRound));
    renderModificationProjects();
    updateModificationTotals();
    markModificationDirty();
    showMessage('Latest budget loaded. Review proposed amounts and descriptions before submitting.', 'success');
  } catch (error) {
    showMessage('Unable to update draft baseline: ' + error.message, 'error');
  }
}

async function renderExpenditureFreshness() {
  const { data, error } = await supabaseClient.from('expenditure_sync_state').select('*').eq('id', 1).single();
  const element = document.getElementById('expenditureFreshness');
  if (error) {
    element.textContent = 'Unable to verify expenditure freshness: ' + error.message;
    element.className = 'difference-invalid';
    return;
  }
  const stale = data.last_success_at && Date.now() - Date.parse(data.last_success_at) > 2 * 60 * 60 * 1000;
  element.className = stale || data.last_error ? 'difference-invalid' : 'hint';
  element.textContent = data.last_success_at
    ? `Expenditures updated ${formatDateTime(data.last_success_at)}.${stale ? ' Data may be out of date.' : ''}${data.last_error ? ' Latest sync failed: ' + data.last_error : ''}`
    : `Expenditures use the existing reference data; Google Sheet sync has not completed.${data.last_error ? ' Sync failed: ' + data.last_error : ''}`;
}
