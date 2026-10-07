'use strict';

/**
 * Adoption Interest Queue
 *
 * One centralised `state` object is the single source of truth. Every change
 * goes through a small action function (add / update / remove), is persisted
 * with saveState(), and the UI is redrawn with render().
 *
 * Pure logic (validation, sanitising, search) lives in core.js.
 *
 * Security: user-supplied text is only ever written with textContent / DOM
 * APIs, or passed through escapeHTML() where a template string is used.
 */
(() => {
  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  const STORAGE_KEY = 'adoption-interest-queue:v1';
  const BACKUP_KEY = 'adoption-interest-queue:corrupt-backup';
  const {
    STATUSES,
    ANIMAL_TYPES,
    LIMITS,
    sanitizeInput,
    escapeHTML,
    generateId,
    normalizeInterests,
    searchAdoptionInterests,
    VALIDATORS,
    validateForm,
  } = window.AdoptionQueueCore;
  const SIMULATED_LATENCY_MS = 700;
  const TOAST_DURATION_MS = Object.freeze({ success: 4000, error: 8000 });
  const MAX_TOASTS = 3;
  const SEARCH_ANNOUNCE_DELAY_MS = 500;
  const SAVE_ERROR_MESSAGE = 'Your changes could not be saved locally. Please try again.';
  // Open the app with ?simulateFailure in the URL to exercise the failed-request paths.
  const SIMULATE_FAILURE = new URLSearchParams(window.location.search).has('simulateFailure');

  const EMPTY_STATES = Object.freeze({
    empty: {
      title: 'No adoption interests yet.',
      message: 'Add an interest to start building the queue.',
      actionLabel: 'Add Interest',
      action: 'add',
    },
    noResults: {
      title: 'No data found',
      message: 'Try adjusting your search.',
      actionLabel: 'Clear search',
      action: 'clear-search',
    },
  });

  const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const state = {
    adoptionInterests: [],
    searchQuery: '',
    loading: false, // add-interest request in flight
    pendingUpdates: new Map(), // id -> { type: 'status', status } | { type: 'remove' }
    storageAvailable: true,
  };

  // Transient UI bookkeeping that is not part of the data model.
  const ui = {
    dialogOpener: null,
    focusAfterDialog: null,
    removalTargetId: null,
    emptyMode: null,
    recentlyAddedId: null,
    searchAnnounceTimer: null,
  };

  const announcements = { polite: [], assertive: [] };
  const dom = {};

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------
  function formatDate(isoString) {
    const date = new Date(isoString);
    return Number.isNaN(date.getTime()) ? 'Unknown date' : dateFormatter.format(date);
  }

  function pluralize(count, singular) {
    return `${singular}${count === 1 ? '' : 's'}`;
  }

  function simulateNetworkRequest(delay = SIMULATED_LATENCY_MS) {
    return new Promise((resolve, reject) => {
      window.setTimeout(() => {
        if (SIMULATE_FAILURE) reject(new Error('Simulated network failure'));
        else resolve();
      }, delay);
    });
  }

  /** Simulated telemetry: console only, and no personal data in the payload. */
  function trackAnalytics(action, details = {}) {
    console.log('[Analytics] User interacted with Adoption Interest Queue', {
      action,
      ...details,
      timestamp: new Date().toISOString(),
    });
  }

  function findInterest(id) {
    return state.adoptionInterests.find((interest) => interest.id === id);
  }

  function isVisible(element) {
    return Boolean(element && element.isConnected && element.getClientRects().length > 0);
  }

  function focusByKey(key) {
    // Keys are built from IDs that match ID_PATTERN, so they are selector-safe.
    const element = document.querySelector(`[data-focus-key="${key}"]`);
    if (element) element.focus();
    return element;
  }

  function createSampleInterests() {
    const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();
    const note = 'Fictional demo record. Safe to remove.';
    const samples = [
      { applicantName: 'Sarah Johnson', email: 'sarah.johnson@example.com', phone: '(555) 010-0101', animalName: 'Max', animalType: 'Dog', status: 'Pending', createdAt: daysAgo(3) },
      { applicantName: 'David Miller', email: 'david.miller@example.com', phone: '(555) 010-0102', animalName: 'Luna', animalType: 'Cat', status: 'Contacted', createdAt: daysAgo(2) },
      { applicantName: 'Emily Brown', email: 'emily.brown@example.com', phone: '(555) 010-0103', animalName: 'Charlie', animalType: 'Rabbit', status: 'Approved', createdAt: daysAgo(1) },
    ].map((sample) => ({ ...sample, notes: note, isSample: true }));

    return normalizeInterests(samples).interests;
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------
  function saveState() {
    if (!state.storageAvailable) return false;
    try {
      const payload = JSON.stringify({ version: 1, interests: state.adoptionInterests });
      window.localStorage.setItem(STORAGE_KEY, payload);
      return true;
    } catch (error) {
      console.warn('Saving to localStorage failed.', error);
      return false;
    }
  }

  function persistChanges() {
    if (!state.storageAvailable) return; // already explained by the startup notice
    if (!saveState()) showToast(SAVE_ERROR_MESSAGE, 'error');
  }

  function backupCorruptData(raw) {
    try {
      window.localStorage.setItem(BACKUP_KEY, raw);
      return true;
    } catch {
      return false;
    }
  }

  /** Loads the queue into state. Returns a user-facing notice when something needed recovering. */
  function loadState() {
    let raw;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      console.warn('localStorage is unavailable.', error);
      state.storageAvailable = false;
      state.adoptionInterests = createSampleInterests();
      return 'Local storage is unavailable in this browser, so changes will be lost when this page is closed.';
    }

    state.storageAvailable = true;

    if (raw === null) {
      state.adoptionInterests = createSampleInterests();
      persistChanges();
      return '';
    }

    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : parsed && parsed.interests;
      if (!Array.isArray(list)) throw new Error('Stored queue has an unexpected shape.');

      const { interests, repairedCount } = normalizeInterests(list);
      state.adoptionInterests = interests;
      if (repairedCount === 0) return '';

      persistChanges();
      return `${repairedCount} saved ${pluralize(repairedCount, 'record')} had missing or duplicate data and ${repairedCount === 1 ? 'was' : 'were'} repaired or skipped.`;
    } catch (error) {
      console.warn('Stored queue data could not be read.', error);
      const backedUp = backupCorruptData(raw);
      state.adoptionInterests = [];
      persistChanges();
      return backedUp
        ? 'Saved queue data was unreadable, so the queue has been reset. A copy of the unreadable data was kept in this browser.'
        : 'Saved queue data was unreadable, so the queue has been reset.';
    }
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------
  function getVisibleEntries() {
    const entries = state.adoptionInterests.map((interest, index) => ({ interest, position: index + 1 }));
    return searchAdoptionInterests(entries, state.searchQuery);
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function render() {
    const active = document.activeElement;
    const focusKey = active && active.dataset ? active.dataset.focusKey : '';

    const entries = getVisibleEntries();
    const total = state.adoptionInterests.length;

    renderSummary(total, entries.length);
    renderSearchControls();

    if (entries.length > 0) renderQueue(entries);
    else renderEmptyState(total === 0 ? 'empty' : 'noResults');

    // Rows are rebuilt on render; put focus back on the equivalent control.
    if (focusKey && !active.isConnected) focusByKey(focusKey);
  }

  function renderSummary(total, visibleCount) {
    dom.queueCount.textContent = String(total);
    dom.queueCountLabel.textContent = `${pluralize(total, 'interest')} in queue`;

    const query = state.searchQuery.trim();
    dom.resultsSummary.textContent = query
      ? `Showing ${visibleCount} of ${total} matching “${query}”`
      : 'Ordered by date added. New interests join the end of the queue.';
  }

  function renderSearchControls() {
    if (dom.searchInput.value !== state.searchQuery) dom.searchInput.value = state.searchQuery;
    dom.clearSearch.hidden = state.searchQuery.length === 0;
  }

  function renderQueue(entries) {
    const fragment = document.createDocumentFragment();
    entries.forEach((entry) => fragment.appendChild(createQueueRow(entry)));
    dom.queueBody.replaceChildren(fragment);

    dom.tableWrapper.hidden = false;
    dom.emptyState.hidden = true;
    ui.emptyMode = null;
  }

  function renderEmptyState(mode) {
    dom.queueBody.replaceChildren();
    dom.tableWrapper.hidden = true;
    dom.emptyState.hidden = false;

    if (ui.emptyMode === mode) return;
    const content = EMPTY_STATES[mode];
    dom.emptyTitle.textContent = content.title;
    dom.emptyMessage.textContent = content.message;
    dom.emptyAction.textContent = content.actionLabel;
    dom.emptyAction.dataset.action = content.action;
    ui.emptyMode = mode;
    announce(`${content.title}. ${content.message}`);
  }

  function createVisuallyHidden(text, tagName = 'span') {
    const element = document.createElement(tagName);
    element.className = 'visually-hidden';
    element.textContent = text;
    return element;
  }

  function createCell(text, className = '') {
    const cell = document.createElement('td');
    if (className) cell.className = className;
    cell.textContent = text;
    return cell;
  }

  function createBusyIndicator(text) {
    const indicator = document.createElement('span');
    indicator.className = 'busy-indicator';
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    spinner.setAttribute('aria-hidden', 'true');
    indicator.append(spinner, document.createTextNode(text));
    return indicator;
  }

  function createApplicantCell(interest) {
    const cell = document.createElement('th');
    cell.scope = 'row';
    cell.textContent = interest.applicantName;
    if (interest.isSample) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'Demo';
      cell.appendChild(tag);
    }
    return cell;
  }

  function createStatusCell(interest, pendingUpdate) {
    const cell = document.createElement('td');
    const selectId = `status-${interest.id}`;
    const displayedStatus = pendingUpdate && pendingUpdate.type === 'status' ? pendingUpdate.status : interest.status;

    const label = createVisuallyHidden(`Status for ${interest.applicantName}`, 'label');
    label.htmlFor = selectId;

    const select = document.createElement('select');
    select.id = selectId;
    select.className = 'status-select';
    select.dataset.id = interest.id;
    select.dataset.focusKey = selectId;
    select.dataset.status = displayedStatus;
    select.disabled = Boolean(pendingUpdate && pendingUpdate.type === 'remove');
    STATUSES.forEach((status) => {
      const isSelected = status === displayedStatus;
      select.add(new Option(status, status, isSelected, isSelected));
    });

    cell.append(label, select);
    if (pendingUpdate) {
      cell.appendChild(createBusyIndicator(pendingUpdate.type === 'remove' ? 'Removing…' : 'Updating…'));
    }
    return cell;
  }

  function createDateCell(isoString) {
    const cell = document.createElement('td');
    cell.className = 'cell--nowrap';
    const time = document.createElement('time');
    time.dateTime = isoString;
    time.textContent = formatDate(isoString);
    cell.appendChild(time);
    return cell;
  }

  function createActionButton({ action, interest, label, context, className, disabled = false }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `btn btn--sm ${className}`;
    button.dataset.action = action;
    button.dataset.id = interest.id;
    button.dataset.focusKey = `${action}-${interest.id}`;
    button.disabled = disabled;
    button.append(document.createTextNode(label), createVisuallyHidden(context));
    return button;
  }

  function createActionsCell(interest, isBusy) {
    const cell = document.createElement('td');
    const group = document.createElement('div');
    group.className = 'row-actions';
    group.append(
      createActionButton({ action: 'view', interest, label: 'View', context: ` details for ${interest.applicantName}`, className: 'btn--secondary' }),
      createActionButton({ action: 'remove', interest, label: 'Remove', context: ` interest from ${interest.applicantName}`, className: 'btn--danger-outline', disabled: isBusy }),
    );
    cell.appendChild(group);
    return cell;
  }

  function createQueueRow({ interest, position }) {
    const pendingUpdate = state.pendingUpdates.get(interest.id);
    const row = document.createElement('tr');
    row.dataset.id = interest.id;
    if (pendingUpdate) row.setAttribute('aria-busy', 'true');
    if (interest.id === ui.recentlyAddedId) row.classList.add('row--added');

    row.append(
      createCell(String(position), 'cell--position'),
      createApplicantCell(interest),
      createCell(interest.email, 'cell--email'),
      createCell(interest.phone, 'cell--nowrap'),
      createCell(interest.animalName),
      createCell(interest.animalType),
      createStatusCell(interest, pendingUpdate),
      createDateCell(interest.createdAt),
      createActionsCell(interest, Boolean(pendingUpdate)),
    );
    return row;
  }

  function renderDetails(interest, position) {
    const rows = [
      ['Queue position', String(position)],
      ['Applicant name', interest.applicantName],
      ['Email', interest.email],
      ['Phone', interest.phone],
      ['Animal name', interest.animalName],
      ['Animal type', interest.animalType],
      ['Status', interest.status],
      ['Date added', formatDate(interest.createdAt)],
      ['Last updated', formatDate(interest.updatedAt)],
      ['Notes', interest.notes || 'No notes provided.'],
      ['Record type', interest.isSample ? 'Demo record (fictional sample data)' : 'Entered by staff'],
      ['Record ID', interest.id],
    ];

    dom.detailsList.innerHTML = rows
      .map(([term, value]) => `<div class="details__row"><dt>${escapeHTML(term)}</dt><dd>${escapeHTML(value)}</dd></div>`)
      .join('');
  }

  // ---------------------------------------------------------------------------
  // Feedback: live-region announcements, toasts and the notice banner
  // ---------------------------------------------------------------------------

  /** Batches messages fired in quick succession so one does not overwrite another. */
  function announce(message, politeness = 'polite') {
    const queue = announcements[politeness];
    const region = politeness === 'assertive' ? dom.liveAssertive : dom.livePolite;
    queue.push(message);
    if (queue.length > 1) return;

    region.textContent = ''; // clearing first lets identical messages be re-announced
    window.setTimeout(() => {
      region.textContent = queue.splice(0).join(' ');
    }, 100);
  }

  function showToast(message, type = 'success') {
    if (!dom.toastRegion) return;

    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;

    const icon = document.createElement('span');
    icon.className = 'toast__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = type === 'error' ? '!' : '✓';

    const text = document.createElement('p');
    text.className = 'toast__message';
    text.textContent = message;

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'toast__dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss notification');
    dismiss.textContent = '×';

    toast.append(icon, text, dismiss);

    let timerId;
    const removeToast = () => {
      window.clearTimeout(timerId);
      const hadFocus = toast.contains(document.activeElement);
      toast.remove();
      if (hadFocus) dom.queueSection.focus();
    };
    const startTimer = () => {
      timerId = window.setTimeout(removeToast, TOAST_DURATION_MS[type] || TOAST_DURATION_MS.success);
    };
    const pauseTimer = () => window.clearTimeout(timerId);

    // Pause auto-dismiss while the user is hovering or focused on the toast.
    toast.addEventListener('mouseenter', pauseTimer);
    toast.addEventListener('mouseleave', startTimer);
    toast.addEventListener('focusin', pauseTimer);
    toast.addEventListener('focusout', startTimer);
    dismiss.addEventListener('click', removeToast);

    dom.toastRegion.appendChild(toast);
    while (dom.toastRegion.children.length > MAX_TOASTS) dom.toastRegion.firstElementChild.remove();
    startTimer();
    announce(message, type === 'error' ? 'assertive' : 'polite');
  }

  function showNotice(message) {
    dom.noticeText.textContent = message;
    dom.notice.hidden = false;
  }

  // ---------------------------------------------------------------------------
  // Loading helpers
  // ---------------------------------------------------------------------------

  // aria-disabled (not `disabled`) keeps focus on the button while it is busy.
  function setAriaDisabled(element, isDisabled) {
    if (isDisabled) element.setAttribute('aria-disabled', 'true');
    else element.removeAttribute('aria-disabled');
  }

  function setButtonLoading(button, isLoading, loadingLabel = '') {
    const label = button.querySelector('.btn__label');
    if (!button.dataset.idleLabel) button.dataset.idleLabel = label.textContent;
    label.textContent = isLoading ? loadingLabel : button.dataset.idleLabel;
    button.classList.toggle('is-loading', isLoading);
    setAriaDisabled(button, isLoading);
  }

  function setAddFormLoading(isLoading) {
    state.loading = isLoading;
    setButtonLoading(dom.submitButton, isLoading, 'Saving…');
    setAriaDisabled(dom.cancelAdd, isLoading);
    dom.addForm.setAttribute('aria-busy', String(isLoading));
    if (isLoading) announce('Saving adoption interest…');
  }

  function setRemoveDialogLoading(isLoading) {
    setButtonLoading(dom.confirmRemove, isLoading, 'Removing…');
    setAriaDisabled(dom.cancelRemove, isLoading);
    if (isLoading) announce('Removing adoption interest…');
  }

  function isRemovalInFlight() {
    return Boolean(ui.removalTargetId && state.pendingUpdates.has(ui.removalTargetId));
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------
  function readFormValues() {
    const { elements } = dom.addForm;
    return {
      applicantName: sanitizeInput(elements.applicantName.value, { maxLength: LIMITS.applicantName }),
      email: sanitizeInput(elements.email.value, { maxLength: LIMITS.email }),
      phone: sanitizeInput(elements.phone.value, { maxLength: LIMITS.phone }),
      animalName: sanitizeInput(elements.animalName.value, { maxLength: LIMITS.animalName }),
      animalType: elements.animalType.value,
      notes: sanitizeInput(elements.notes.value, { maxLength: LIMITS.notes, multiline: true }),
    };
  }

  function setFieldError(field, message) {
    const input = dom.addForm.elements[field];
    const errorElement = document.getElementById(`${input.id}-error`);
    const describedBy = [input.dataset.hintId, message ? errorElement.id : ''].filter(Boolean).join(' ');

    errorElement.textContent = message;
    errorElement.hidden = !message;

    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');

    if (describedBy) input.setAttribute('aria-describedby', describedBy);
    else input.removeAttribute('aria-describedby');
  }

  function showFormSummary(message) {
    dom.formSummary.hidden = !message;
    dom.formSummary.textContent = message;
  }

  function showFormErrors(errors) {
    Object.keys(VALIDATORS).forEach((field) => setFieldError(field, ''));
    errors.forEach(({ field, message }) => setFieldError(field, message));

    if (errors.length === 0) {
      showFormSummary('');
      return;
    }
    showFormSummary(errors.length === 1
      ? 'Please correct the highlighted field before adding this interest.'
      : `Please correct the ${errors.length} highlighted fields before adding this interest.`);
    dom.addForm.elements[errors[0].field].focus();
  }

  function resetAddForm() {
    dom.addForm.reset();
    showFormErrors([]);
  }

  // ---------------------------------------------------------------------------
  // Actions (state mutations)
  // ---------------------------------------------------------------------------
  function addAdoptionInterest(values) {
    const usedIds = new Set(state.adoptionInterests.map((interest) => interest.id));
    const now = new Date().toISOString();
    const interest = {
      id: generateId(usedIds),
      ...values,
      status: 'Pending',
      createdAt: now,
      updatedAt: now,
      isSample: false,
    };

    state.adoptionInterests = [...state.adoptionInterests, interest];

    // Make sure the new record is visible even if a search is active.
    const matchesSearch = searchAdoptionInterests([{ interest, position: 0 }], state.searchQuery).length > 0;
    if (!matchesSearch) state.searchQuery = '';

    persistChanges();
    trackAnalytics('add_interest', { id: interest.id, animalType: interest.animalType });

    ui.recentlyAddedId = interest.id;
    render();
    ui.recentlyAddedId = null;

    const row = dom.queueBody.querySelector(`tr[data-id="${interest.id}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
    return interest;
  }

  async function updateStatus(id, requestedStatus) {
    const interest = findInterest(id);
    if (!interest || !STATUSES.includes(requestedStatus)) return;

    const pending = state.pendingUpdates.get(id);
    if (pending) {
      // A request is already in flight for this row: the latest selection wins when it completes.
      if (pending.type === 'status') pending.status = requestedStatus;
      return;
    }
    if (interest.status === requestedStatus) return;

    state.pendingUpdates.set(id, { type: 'status', status: requestedStatus });
    announce(`Updating status for ${interest.applicantName}…`);
    render();

    let outcome = 'failed';
    try {
      await simulateNetworkRequest();
      const targetStatus = state.pendingUpdates.get(id).status;
      const current = findInterest(id);

      if (!current) {
        outcome = 'missing';
      } else if (current.status === targetStatus) {
        outcome = 'unchanged';
      } else {
        const updatedAt = new Date().toISOString();
        state.adoptionInterests = state.adoptionInterests.map((item) => (
          item.id === id ? { ...item, status: targetStatus, updatedAt } : item
        ));
        persistChanges();
        trackAnalytics('update_status', { id, status: targetStatus });
        outcome = 'updated';
      }
    } catch (error) {
      console.warn('Status update failed.', error);
    } finally {
      state.pendingUpdates.delete(id);
      render();
    }

    if (outcome === 'updated') showToast('Status updated successfully.');
    else if (outcome === 'failed') showToast('The status could not be updated. Please try again.', 'error');
    else if (outcome === 'missing') showToast('This adoption interest no longer exists.', 'error');
  }

  function findNeighborId(id) {
    const entries = getVisibleEntries();
    const index = entries.findIndex(({ interest }) => interest.id === id);
    const neighbor = entries[index + 1] || entries[index - 1];
    return neighbor ? neighbor.interest.id : '';
  }

  async function removeAdoptionInterest(id) {
    if (state.pendingUpdates.has(id)) return;
    if (!findInterest(id)) {
      dom.removeDialog.close();
      showToast('This adoption interest no longer exists.', 'error');
      render();
      return;
    }

    const neighborId = findNeighborId(id);
    state.pendingUpdates.set(id, { type: 'remove' });
    setRemoveDialogLoading(true);
    render();

    let removed = false;
    try {
      await simulateNetworkRequest();
      state.adoptionInterests = state.adoptionInterests.filter((interest) => interest.id !== id);
      persistChanges();
      trackAnalytics('remove_interest', { id });
      removed = true;
    } catch (error) {
      console.warn('Removal failed.', error);
    } finally {
      state.pendingUpdates.delete(id);
      setRemoveDialogLoading(false);
      render();
    }

    if (!removed) {
      showToast('The adoption interest could not be removed. Please try again.', 'error');
      return;
    }

    ui.removalTargetId = null;
    const fallback = dom.emptyState.hidden ? dom.addButton : dom.emptyAction;
    const focusTarget = (neighborId && document.querySelector(`[data-focus-key="view-${neighborId}"]`)) || fallback;
    closeDialogAndFocus(dom.removeDialog, focusTarget);
    showToast('Adoption interest removed.');
  }

  // ---------------------------------------------------------------------------
  // Dialogs
  // ---------------------------------------------------------------------------
  function openDialog(dialog, opener) {
    ui.dialogOpener = opener || document.activeElement;
    ui.focusAfterDialog = null;
    if (!dialog.open) dialog.showModal();
  }

  function closeDialogAndFocus(dialog, target) {
    if (dialog.open) {
      ui.focusAfterDialog = target;
      dialog.close();
    } else if (!document.activeElement || document.activeElement === document.body) {
      target.focus();
    }
  }

  function isDialogBusy(dialog) {
    if (dialog === dom.addDialog) return state.loading;
    if (dialog === dom.removeDialog) return isRemovalInFlight();
    return false;
  }

  function handleDialogClose(event) {
    if (event.target === dom.removeDialog && !isRemovalInFlight()) ui.removalTargetId = null;

    const target = [ui.focusAfterDialog, ui.dialogOpener].find((element) => isVisible(element) && !element.disabled)
      || dom.addButton;
    ui.focusAfterDialog = null;
    ui.dialogOpener = null;
    target.focus();
  }

  function handleDialogCancel(event) {
    // Escape is ignored while the dialog's request is in flight.
    if (isDialogBusy(event.target)) event.preventDefault();
  }

  function openAddDialog(opener) {
    if (!state.loading) resetAddForm();
    openDialog(dom.addDialog, opener);
  }

  function openDetailsDialog(id, opener) {
    const index = state.adoptionInterests.findIndex((interest) => interest.id === id);
    if (index === -1) {
      showToast('This adoption interest no longer exists.', 'error');
      render();
      return;
    }
    renderDetails(state.adoptionInterests[index], index + 1);
    openDialog(dom.detailsDialog, opener);
  }

  function openRemoveDialog(id, opener) {
    const interest = findInterest(id);
    if (!interest) {
      showToast('This adoption interest no longer exists.', 'error');
      render();
      return;
    }
    ui.removalTargetId = id;
    dom.removeSummary.textContent = `${interest.applicantName}: interest in ${interest.animalName} (${interest.animalType})`;
    openDialog(dom.removeDialog, opener);
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------
  async function handleAddSubmit(event) {
    event.preventDefault();
    if (state.loading) return; // prevents duplicate submissions

    const values = readFormValues();
    const errors = validateForm(values, state.adoptionInterests);
    showFormErrors(errors);
    if (errors.length > 0) return;

    setAddFormLoading(true);
    let added = false;
    try {
      await simulateNetworkRequest();
      addAdoptionInterest(values);
      added = true;
    } catch (error) {
      console.warn('Adding the interest failed.', error);
      showFormSummary('The adoption interest could not be saved because the request failed. Your entries are still here. Please try again.');
    } finally {
      setAddFormLoading(false);
    }

    if (!added) return;
    if (dom.addDialog.open) dom.addDialog.close();
    showToast('Adoption interest added successfully.');
  }

  function handleFormInput(event) {
    const field = event.target.name;
    if (!VALIDATORS[field] || event.target.getAttribute('aria-invalid') !== 'true') return;

    // Clear an error as soon as the field becomes valid; new errors wait for the next submit.
    if (!VALIDATORS[field](readFormValues())) {
      setFieldError(field, '');
      if (!dom.addForm.querySelector('[aria-invalid="true"]')) showFormSummary('');
    }
  }

  function scheduleSearchAnnouncement() {
    window.clearTimeout(ui.searchAnnounceTimer);
    ui.searchAnnounceTimer = window.setTimeout(() => {
      const total = state.adoptionInterests.length;
      const visibleCount = getVisibleEntries().length;
      if (total === 0 || visibleCount === 0) return; // the empty state announces itself
      if (!state.searchQuery.trim()) announce(`Showing all ${total} ${pluralize(total, 'interest')}.`);
      else announce(`${visibleCount} ${pluralize(visibleCount, 'result')} found.`);
    }, SEARCH_ANNOUNCE_DELAY_MS);
  }

  function handleSearchInput(event) {
    state.searchQuery = event.target.value.slice(0, LIMITS.search);
    render();
    scheduleSearchAnnouncement();
  }

  function clearSearch() {
    window.clearTimeout(ui.searchAnnounceTimer);
    state.searchQuery = '';
    render();
    dom.searchInput.focus();
    announce('Search cleared.');
  }

  function handleQueueClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const { action, id } = button.dataset;
    if (action === 'view') openDetailsDialog(id, button);
    else if (action === 'remove') openRemoveDialog(id, button);
  }

  function handleQueueChange(event) {
    const select = event.target;
    if (!select.classList.contains('status-select')) return;
    select.dataset.status = select.value;
    updateStatus(select.dataset.id, select.value);
  }

  // ---------------------------------------------------------------------------
  // Initialisation
  // ---------------------------------------------------------------------------
  function cacheDom() {
    const byId = (id) => document.getElementById(id);
    Object.assign(dom, {
      notice: byId('app-notice'),
      noticeText: byId('app-notice-text'),
      noticeDismiss: byId('app-notice-dismiss'),
      queueCount: byId('queue-count'),
      queueCountLabel: byId('queue-count-label'),
      resultsSummary: byId('results-summary'),
      searchForm: byId('search-form'),
      searchInput: byId('search-input'),
      clearSearch: byId('clear-search'),
      addButton: byId('add-interest-button'),
      queueSection: byId('queue-section'),
      tableWrapper: byId('queue-table-wrapper'),
      queueBody: byId('queue-body'),
      emptyState: byId('empty-state'),
      emptyTitle: byId('empty-state-title'),
      emptyMessage: byId('empty-state-message'),
      emptyAction: byId('empty-state-action'),
      addDialog: byId('add-dialog'),
      addForm: byId('add-form'),
      formSummary: byId('form-summary'),
      submitButton: byId('submit-interest'),
      cancelAdd: byId('cancel-add'),
      detailsDialog: byId('details-dialog'),
      detailsList: byId('details-list'),
      closeDetails: byId('close-details'),
      removeDialog: byId('remove-dialog'),
      removeSummary: byId('remove-summary'),
      confirmRemove: byId('confirm-remove'),
      cancelRemove: byId('cancel-remove'),
      toastRegion: byId('toast-region'),
      livePolite: byId('live-polite'),
      liveAssertive: byId('live-assertive'),
    });
  }

  function prepareForm() {
    const typeSelect = dom.addForm.elements.animalType;
    ANIMAL_TYPES.forEach((type) => typeSelect.add(new Option(type, type)));

    // Remember each field's permanent hint so error descriptions can be added alongside it.
    Object.keys(VALIDATORS).forEach((field) => {
      const input = dom.addForm.elements[field];
      const hintId = input.getAttribute('aria-describedby');
      if (hintId) input.dataset.hintId = hintId;
    });
  }

  function bindEvents() {
    dom.addButton.addEventListener('click', () => openAddDialog(dom.addButton));
    dom.emptyAction.addEventListener('click', () => {
      if (dom.emptyAction.dataset.action === 'add') openAddDialog(dom.emptyAction);
      else clearSearch();
    });

    dom.searchForm.addEventListener('submit', (event) => event.preventDefault());
    dom.searchInput.addEventListener('input', handleSearchInput);
    dom.searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && dom.searchInput.value) {
        event.preventDefault();
        clearSearch();
      }
    });
    dom.clearSearch.addEventListener('click', clearSearch);

    dom.queueBody.addEventListener('click', handleQueueClick);
    dom.queueBody.addEventListener('change', handleQueueChange);

    dom.addForm.addEventListener('submit', handleAddSubmit);
    dom.addForm.addEventListener('input', handleFormInput);
    dom.addForm.addEventListener('change', handleFormInput);
    dom.cancelAdd.addEventListener('click', () => {
      if (!state.loading) dom.addDialog.close();
    });

    dom.closeDetails.addEventListener('click', () => dom.detailsDialog.close());
    dom.detailsDialog.addEventListener('click', (event) => {
      if (event.target === dom.detailsDialog) dom.detailsDialog.close(); // backdrop click
    });

    dom.cancelRemove.addEventListener('click', () => {
      if (!isRemovalInFlight()) dom.removeDialog.close();
    });
    dom.confirmRemove.addEventListener('click', () => {
      if (ui.removalTargetId && !isRemovalInFlight()) removeAdoptionInterest(ui.removalTargetId);
    });

    [dom.addDialog, dom.detailsDialog, dom.removeDialog].forEach((dialog) => {
      dialog.addEventListener('close', handleDialogClose);
      dialog.addEventListener('cancel', handleDialogCancel);
    });

    dom.noticeDismiss.addEventListener('click', () => {
      dom.notice.hidden = true;
      dom.queueSection.focus();
    });

  }

  function init() {
    cacheDom();
    prepareForm();
    bindEvents();
    const notice = loadState();
    render();
    if (notice) showNotice(notice);
  }

  try {
    init();
  } catch (error) {
    console.error('The queue could not be started.', error);
    const main = document.getElementById('main');
    if (main) {
      const message = document.createElement('p');
      message.className = 'notice';
      message.setAttribute('role', 'alert');
      message.textContent = 'The queue could not be started. Please refresh the page.';
      main.prepend(message);
    }
  }
})();
