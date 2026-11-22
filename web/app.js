/**
 * Browser controller for the local, single-operator evidence workspace.
 *
 * The server owns persistence and all verification rules. This file renders read
 * models, gathers explicit operator actions, and keeps navigation accessible.
 * Provider and operator strings are assigned with textContent, never innerHTML.
 */

const state = {
  token: '',
  practice: false,
  cases: [],
  caseId: null,
  detail: null,
  observationId: null,
  observation: null,
  reviewer: '',
  reviewDrafts: {},
  loadTicket: 0,
  candidateContext: null,
};

/** Returns an existing, statically named workspace element. */
const byId = (id) => document.getElementById(id);

/** Creates text-bearing elements safely, including strings supplied by listings. */
function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  node.textContent = String(text);
  return node;
}

/** Presents a valid date in the operator's local timezone; absent dates stay absent. */
function dateLabel(value) {
  return value ? new Date(value).toLocaleString() : 'Not recorded';
}

/** Gives storage verdict values short, consistent labels throughout the interface. */
function verdictLabel(verdict) {
  return (
    { match: 'Match', not_match: 'Not a match', unsure: 'Unsure' }[verdict] ||
    'Unreviewed'
  );
}

/** Produces a small textual status; color is never the only indication of state. */
function badge(text, kind = '') {
  return element('span', `badge ${kind}`, text);
}

/** Shows persistent operator feedback instead of swallowing a rejected operation. */
function notify(message, error = false) {
  const notice = byId('notice');
  notice.textContent = message;
  notice.className = error ? 'notice error' : 'notice';
  notice.setAttribute('role', error ? 'alert' : 'status');
  notice.hidden = false;
}

/**
 * Calls the local JSON API with the launch-local session token.
 * @param {string} path Same-origin API path, never a pasted listing URL.
 * @param {object | undefined} body Supplying a body makes this an explicit mutation.
 * @returns {Promise<any>} The server read model or mutation receipt.
 * @throws A readable message from a rejected application operation.
 */
async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'X-Traces-Token': state.token,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || 'The workspace could not complete that operation.');
  }
  return result;
}

/** Loads the case index while preserving a selected case that still exists. */
async function loadCases(preferredCaseId = state.caseId) {
  state.cases = await api('/api/cases');
  renderCases();
  const selected =
    state.cases.find((bike) => bike.id === preferredCaseId) || state.cases[0];
  byId('empty-workspace').hidden = Boolean(selected);
  byId('case-workspace').hidden = !selected;
  if (selected) {
    await loadCase(selected.id);
  }
}

/** Renders a filterable case library with explicit active/closed/practice states. */
function renderCases() {
  byId('case-count').textContent = state.cases.length;
  const query = byId('case-search').value.toLowerCase();
  const list = byId('case-list');
  list.replaceChildren();
  const cases = state.cases.filter((bike) =>
    `${bike.make} ${bike.model} ${bike.stolenLocation} ${bike.id}`
      .toLowerCase()
      .includes(query),
  );
  for (const bike of cases) {
    const button = element('button', 'case-button');
    button.type = 'button';
    button.setAttribute('aria-current', String(bike.id === state.caseId));
    button.append(
      element('strong', '', `${bike.make} ${bike.model}`.trim() || 'Unspecified bicycle'),
      element('small', '', bike.stolenLocation || 'Location not recorded'),
      element(
        'small',
        'case-status',
        `${bike.status === 'open' ? 'Open' : 'Closed'} · ${bike.candidateCount} candidates${bike.staged ? ' · Practice' : ''}`,
      ),
    );
    button.addEventListener('click', () => {
      loadCase(bike.id, null, true).catch((error) => notify(error.message, true));
    });
    list.append(button);
  }
  if (!cases.length) {
    list.append(
      element(
        'p',
        'muted',
        state.cases.length ? 'No matching cases.' : 'No cases imported yet.',
      ),
    );
  }
}

/**
 * Loads a current case and then its selected candidate. The ticket prevents a
 * slower earlier request from replacing a case selected more recently.
 */
async function loadCase(caseId, preferredObservationId = null, focusHeading = false) {
  const ticket = ++state.loadTicket;
  const detail = await api(`/api/cases/${encodeURIComponent(caseId)}`);
  if (ticket !== state.loadTicket) {
    return;
  }
  state.caseId = caseId;
  state.detail = detail;
  state.observation = null;
  state.observationId = null;
  byId('empty-workspace').hidden = true;
  byId('case-workspace').hidden = false;
  renderCases();
  renderCaseHeader();
  renderQueue();
  renderMetrics();
  if (focusHeading) {
    byId('case-title').focus();
  }
  const selected =
    detail.candidates.find((item) => item.id === preferredObservationId) ||
    detail.candidates[0];
  if (selected) {
    await selectObservation(selected.id);
  } else {
    renderNoCandidates();
  }
}

/** Shows the current report identity, independently of the scored historical snapshot. */
function renderCaseHeader() {
  const bike = state.detail.bike;
  byId('case-title').textContent =
    `${bike.make} ${bike.model}`.trim() || 'Unspecified bicycle';
  byId('case-location').textContent =
    `${bike.stolenLocation || 'Location not recorded'} · ${bike.id}`;
  const badges = byId('case-badges');
  badges.replaceChildren(
    badge(
      bike.status === 'open' ? 'Open case' : 'Closed case',
      bike.status === 'open' ? '' : 'neutral',
    ),
  );
  if (bike.staged) {
    badges.append(badge('Practice case', 'warning'));
  }
  byId('add-button').disabled = bike.status !== 'open';
  byId('refresh-button').disabled = bike.staged || state.practice;
}

/** Filters the visible queue without removing any underlying case evidence. */
function renderQueue() {
  const candidates = state.detail.candidates;
  const filter = byId('queue-filter').value;
  byId('queue-count').textContent = candidates.length;
  const list = byId('candidate-list');
  list.replaceChildren();
  const visible = candidates.filter((item) => {
    if (filter === 'all') {
      return true;
    }
    if (filter === 'blocked') {
      return !item.reviewable;
    }
    if (filter === 'unreviewed') {
      return !item.verdict || item.verdict === 'unsure';
    }
    return item.verdict === filter;
  });
  for (const item of visible) {
    const button = element('button', 'candidate-button');
    button.type = 'button';
    const selected =
      state.observation?.candidateKey === item.candidateKey ||
      state.observationId === item.id;
    button.setAttribute('aria-current', String(selected));
    const meta = element('div', 'candidate-meta');
    meta.append(
      element(
        'span',
        '',
        item.listing.source === 'staged' ? 'Practice listing' : item.listing.source,
      ),
      element('span', 'rank-score', `${item.score.total} / 100`),
    );
    const badges = element('div', 'badges');
    badges.append(badge(verdictLabel(item.verdict), item.verdict ? '' : 'neutral'));
    if (!item.reviewable) {
      badges.append(badge('Blocked / stale', 'warning'));
    }
    if (item.listing.testData) {
      badges.append(
        badge(item.listing.environment === 'sandbox' ? 'Sandbox' : 'Practice', 'warning'),
      );
    }
    button.append(meta, element('strong', '', item.listing.title), badges);
    button.addEventListener('click', () =>
      selectObservation(item.id).catch((error) => notify(error.message, true)),
    );
    list.append(button);
  }
  if (!visible.length) {
    list.append(
      element(
        'p',
        'muted',
        candidates.length
          ? 'No candidates match this filter.'
          : 'No candidates yet. Add a listing you inspected for this case.',
      ),
    );
  }
}

/** Retrieves a snapshot, ignoring a response if the operator navigated away meanwhile. */
async function selectObservation(id) {
  const caseId = state.caseId;
  state.observationId = id;
  const observation = await api(`/api/observations/${id}`);
  if (state.caseId !== caseId || state.observationId !== id) {
    return;
  }
  state.observation = observation;
  renderQueue();
  renderObservation();
}

/** Presents a clear path forward when an ingested case has no candidates. */
function renderNoCandidates() {
  const panel = element('div', 'panel empty-detail');
  panel.append(
    element('h2', '', 'No candidates yet'),
    element(
      'p',
      '',
      'Find a listing for this case, then add its object details to compare the evidence.',
    ),
  );
  if (state.detail.bike.status === 'open') {
    const button = element('button', 'button primary', 'Add a candidate');
    button.type = 'button';
    button.addEventListener('click', openCandidateDialog);
    panel.append(button);
  }
  byId('candidate-detail').replaceChildren(panel);
}

/** Builds the complete comparison from stored evidence rather than current guesses. */
function renderObservation() {
  const observation = state.observation;
  const container = byId('candidate-detail');
  container.replaceChildren();
  const heading = element('div', 'summary-strip');
  const title = element('div');
  title.append(
    element('h2', '', 'Compare the evidence'),
    element('p', 'muted', 'Inspect object details before recording a verdict.'),
  );
  const score = element('div', 'score-pill');
  score.append(
    element('strong', '', observation.score.total),
    document.createTextNode('/ 100 ranking points'),
  );
  heading.append(title, score);
  container.append(heading);

  if (!observation.reviewable) {
    container.append(
      element(
        'div',
        'blocked-note',
        `${observation.blockReason} Earlier evidence remains visible; new verdicts are blocked.`,
      ),
    );
  }
  if (observation.listing.testData || observation.caseSnapshot.staged) {
    container.append(
      element(
        'div',
        'blocked-note',
        'Practice / sandbox evidence. Excluded from real-case metrics and owner notifications.',
      ),
    );
  }
  const comparison = element('div', 'comparison');
  comparison.append(
    objectCard(observation.caseSnapshot, true),
    objectCard(observation.listing, false),
  );
  container.append(
    comparison,
    evidencePanel(observation),
    provenancePanel(observation),
    reviewPanel(observation),
    historyPanel(observation),
  );
}

/** Creates an external evidence link that sends no referrer and cannot control this tab. */
function sourceLink(url, label) {
  const anchor = element('a', 'source-link', label);
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  return anchor;
}

/**
 * Creates a keyboard-accessible image gallery. Remote images load in the browser
 * only; the Node server does not fetch arbitrary candidate URLs or proxy images.
 */
function gallery(photos, description) {
  const container = element('div', 'gallery');
  const stage = element('div', 'photo-stage');
  const controls = element('div', 'gallery-controls');
  const image = document.createElement('img');
  image.referrerPolicy = 'no-referrer';
  const counter = element('span');
  counter.setAttribute('aria-live', 'polite');
  const previous = element('button', '', 'Previous');
  const next = element('button', '', 'Next');
  previous.type = next.type = 'button';
  previous.setAttribute('aria-label', `Previous ${description} photograph`);
  next.setAttribute('aria-label', `Next ${description} photograph`);
  let index = 0;

  /** Updates one gallery without re-rendering forms or losing unsaved review notes. */
  function showPhoto() {
    stage.replaceChildren();
    if (!photos.length) {
      stage.append(
        element(
          'p',
          'photo-empty',
          'No photographs supplied.\nUse the source record to inspect the object.',
        ),
      );
    } else {
      image.alt = `${description}, photograph ${index + 1} of ${photos.length}`;
      image.src = photos[index];
      stage.append(image);
    }
    counter.textContent = photos.length
      ? `${index + 1} of ${photos.length}`
      : 'No photos';
    previous.disabled = next.disabled = photos.length < 2;
  }
  image.addEventListener('error', () => {
    stage.replaceChildren(
      element(
        'p',
        'photo-empty',
        'This image could not load. Inspect the original source or try the next photograph.',
      ),
    );
  });
  previous.addEventListener('click', () => {
    index = (index + photos.length - 1) % photos.length;
    showPhoto();
  });
  next.addEventListener('click', () => {
    index = (index + 1) % photos.length;
    showPhoto();
  });
  controls.append(previous, counter, next);
  container.append(stage, controls);
  showPhoto();
  return container;
}

/** Adds an object attribute with an explicit missing-value label. */
function attribute(label, value, wide = false) {
  const row = element('div', wide ? 'wide' : '');
  row.append(element('dt', '', label), element('dd', '', value || 'Not recorded'));
  return row;
}

/** Builds one side of the comparison, identifying the stored case snapshot explicitly. */
function objectCard(record, isCase) {
  const card = element('article', 'object-card');
  const attributes = isCase ? record : record.attributes;
  const title = isCase ? `${record.make} ${record.model}` : record.title;
  card.append(
    element(
      'div',
      'card-label',
      isCase ? 'Case evidence · scored snapshot' : 'Listing candidate',
    ),
    gallery(record.photos, isCase ? 'Case object' : 'Listing object'),
  );
  const body = element('div', 'object-body');
  body.append(element('h3', '', title));
  if (isCase && record.reportUrl) {
    body.append(sourceLink(record.reportUrl, 'View Bike Index report'));
  } else if (!isCase) {
    body.append(sourceLink(record.url, 'View original listing'));
  } else {
    body.append(element('p', 'muted', 'Synthetic case · no owner report'));
  }
  const grid = element('dl', 'attribute-grid');
  grid.append(
    attribute('Make', attributes.make),
    attribute('Model', attributes.model),
    attribute('Colors', attributes.colors?.join(', ')),
    attribute('Serial', attributes.serial),
    attribute('Components', attributes.components?.join('\n'), true),
    attribute('Distinctive markings', attributes.markings?.join('\n'), true),
  );
  if (!isCase) {
    grid.append(
      attribute('Price', record.price),
      attribute('Listing location', record.location),
    );
  }
  grid.append(
    attribute(
      isCase ? 'Reported stolen' : 'Posted',
      dateLabel(isCase ? record.stolenAt : record.postedAt),
      true,
    ),
    attribute('Object description', record.description, true),
  );
  body.append(grid);
  card.append(body);
  return card;
}

/** Shows every attribute contribution and explains why conflict caps may reduce the total. */
function evidencePanel(observation) {
  const panel = element('section', 'panel');
  panel.append(
    element('h2', '', 'Why this candidate ranked here'),
    element(
      'p',
      'muted',
      'Ranking points express shared attributes, not a probability or a conclusion.',
    ),
  );
  if (observation.score.conflicts.length) {
    panel.append(
      element(
        'p',
        'conflict-list',
        `Conflicts: ${observation.score.conflicts.join('; ')}. A conflict cap may reduce the final score below the sum of positive evidence.`,
      ),
    );
  }
  const table = element('table', 'evidence-table');
  const caption = element('caption', 'sr-only', 'Attribute scoring explanation');
  const head = element('thead');
  const header = element('tr');
  for (const label of ['Attribute', 'Points', 'Evidence', 'Explanation']) {
    const cell = element('th', '', label);
    cell.scope = 'col';
    header.append(cell);
  }
  head.append(header);
  const body = element('tbody');
  for (const entry of observation.score.evidence) {
    const row = element('tr');
    const evidence = element('td');
    evidence.append(
      badge(
        entry.state.replaceAll('_', ' '),
        entry.state === 'conflict'
          ? 'danger'
          : entry.state === 'matched'
            ? ''
            : 'neutral',
      ),
    );
    row.append(
      element('td', '', entry.attribute),
      element('td', '', `${entry.points} / ${entry.possible}`),
      evidence,
      element('td', '', entry.detail),
    );
    body.append(row);
  }
  table.append(caption, head, body);
  panel.append(table);
  // Narrow screens hide the long table column; the full explanation remains
  // available through this readable disclosure rather than disappearing.
  const full = element('details', 'provenance');
  full.append(element('summary', '', 'Full evidence explanations'));
  for (const entry of observation.score.evidence) {
    full.append(element('p', 'muted', `${entry.attribute}: ${entry.detail}`));
  }
  panel.append(full);
  return panel;
}

/** Displays query provenance, snapshot navigation, and the exact original case JSON. */
function provenancePanel(observation) {
  const panel = element('section', 'panel');
  const heading = element('div', 'section-heading');
  heading.append(element('h2', '', 'Source & snapshot history'));
  panel.append(heading);
  const pickerLabel = element('label', '', 'Listing snapshot');
  const picker = element('select', 'snapshot-picker');
  picker.setAttribute('aria-label', 'Listing snapshot');
  for (const snapshot of [...observation.snapshots].sort((a, b) => b.id - a.id)) {
    const option = element(
      'option',
      '',
      `Snapshot ${snapshot.id} · ${dateLabel(snapshot.capturedAt)}${snapshot.reviewable ? '' : ' · blocked / earlier'}`,
    );
    option.value = snapshot.id;
    option.selected = snapshot.id === observation.id;
    picker.append(option);
  }
  picker.addEventListener('change', () =>
    selectObservation(Number(picker.value)).catch((error) => notify(error.message, true)),
  );
  pickerLabel.append(picker);
  panel.append(pickerLabel);
  const provenance = element('dl', 'attribute-grid');
  provenance.append(
    attribute('Search source', observation.run.source),
    attribute('Search terms', observation.run.query),
    attribute('Captured / imported', dateLabel(observation.capturedAt)),
    attribute('Scoring version', observation.score.version),
    attribute('Listing URL', observation.listing.url, true),
  );
  panel.append(provenance);
  const snapshot = element('details', 'provenance');
  snapshot.append(
    element('summary', '', 'Inspect original case snapshot and current report'),
    element(
      'p',
      'muted',
      'The comparison uses the case as it existed when this listing was scored. Changed reports require fresh evidence before review.',
    ),
    element('h3', '', 'Scored case snapshot'),
    element('pre', '', JSON.stringify(observation.caseSnapshot, null, 2)),
    element('h3', '', 'Current case record'),
    element('pre', '', JSON.stringify(state.detail.bike, null, 2)),
  );
  panel.append(snapshot);
  return panel;
}

/**
 * Collects a deliberate human verdict. Disabled controls are an affordance only:
 * Store.current checks again on the server even if a client bypasses this form.
 */
function reviewPanel(observation) {
  const panel = element('section', 'panel');
  panel.append(element('h2', '', 'Record your assessment'));
  const form = element('form');
  const draft = state.reviewDrafts[observation.id];
  const fieldset = document.createElement('fieldset');
  fieldset.disabled = !observation.reviewable;
  fieldset.append(element('legend', '', 'Does the object evidence support a match?'));
  const choices = element('div', 'verdict-options');
  for (const value of ['match', 'not_match', 'unsure']) {
    const label = element('label', 'verdict-option');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'verdict';
    input.value = value;
    input.required = true;
    input.checked = (draft?.verdict || observation.verdict) === value;
    label.append(input, document.createTextNode(verdictLabel(value)));
    choices.append(label);
  }
  const reviewerLabel = element('label', '', 'Reviewer');
  const reviewer = document.createElement('input');
  reviewer.name = 'reviewer';
  reviewer.required = true;
  reviewer.maxLength = 100;
  reviewer.value = draft?.reviewer ?? (state.reviewer || observation.reviewer || '');
  reviewer.placeholder = 'Your name';
  reviewerLabel.append(reviewer);
  const notesLabel = element('label', '', 'Evidence notes');
  const notes = document.createElement('textarea');
  notes.name = 'notes';
  notes.rows = 3;
  notes.required = true;
  notes.maxLength = 5000;
  notes.placeholder = 'Which identifiers agree or differ? What remains uncertain?';
  notes.value = draft?.notes ?? (observation.notes || '');
  notesLabel.append(notes);
  const submit = element('div', 'review-submit');
  const button = element('button', 'button primary', 'Save verdict');
  button.type = 'submit';
  submit.append(
    element('p', 'muted', 'Saves a review only. No notification is sent.'),
    button,
  );
  fieldset.append(choices, reviewerLabel, notesLabel, submit);
  form.append(fieldset);
  // Retain unsaved notes in session memory when the operator compares another
  // candidate. These drafts never count as saved verdicts or evaluation data.
  form.addEventListener('input', () => {
    state.reviewDrafts[observation.id] = Object.fromEntries(new FormData(form));
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    state.reviewer = values.reviewer;
    button.disabled = true;
    try {
      await api(`/api/observations/${observation.id}/reviews`, values);
      delete state.reviewDrafts[observation.id];
      await loadCase(observation.caseId, observation.id);
      notify('Verdict saved. The previous review history is preserved.');
    } catch (error) {
      notify(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
  panel.append(form);
  return panel;
}

/** Shows append-only reviewer notes so a correction does not erase earlier judgments. */
function historyPanel(observation) {
  const panel = element('section', 'panel');
  panel.append(element('h2', '', 'Review history'));
  if (!observation.reviews.length) {
    panel.append(
      element('p', 'muted', 'No verdict has been recorded for this snapshot.'),
    );
  }
  for (const review of observation.reviews) {
    const item = element('div', 'history-item');
    item.append(
      badge(verdictLabel(review.verdict)),
      element('p', '', review.notes),
      element('small', '', `${review.reviewer} · ${dateLabel(review.createdAt)}`),
    );
    panel.append(item);
  }
  return panel;
}

/** Renders real-case evaluation separately from practice work and raw time records. */
function renderMetrics() {
  const { metrics, bike, candidates, sessions } = state.detail;
  const container = byId('metrics-content');
  container.replaceChildren();
  const cards = element('div', 'metric-cards');
  const definitive = metrics.matches + metrics.rejected;
  const values = [
    [
      'Candidates',
      candidates.length,
      bike.staged ? 'Practice queue only' : 'Latest listing snapshots',
    ],
    [
      'Reviewed precision',
      metrics.reviewedPrecision === null
        ? '—'
        : `${Math.round(metrics.reviewedPrecision * 100)}%`,
      `${definitive} definitive real verdicts`,
    ],
    [
      'Unsure',
      bike.staged
        ? candidates.filter((item) => item.reviewable && item.verdict === 'unsure').length
        : metrics.unsure,
      bike.staged ? 'Practice queue only' : 'Still unresolved',
    ],
    [
      'Stale evidence',
      candidates.filter((item) => !item.reviewable).length,
      'Review blocked',
    ],
  ];
  for (const [label, value, description] of values) {
    const card = element('div', 'metric-card');
    card.append(
      element('span', '', label),
      element('strong', '', value),
      element('small', '', description),
    );
    cards.append(card);
  }
  const explanation = element('div', 'panel');
  explanation.append(
    element(
      'h2',
      '',
      bike.staged ? 'Practice records are separate' : 'What these measurements mean',
    ),
    element(
      'p',
      'muted',
      bike.staged
        ? 'Reviews and time entries here help you try the workflow. They do not enter real-case evaluation metrics.'
        : 'Reviewed precision uses only match and not-a-match verdicts. It is a human judgment metric, not confirmed recovery precision. False-positive and miss rates need a separate labeled experiment.',
    ),
  );
  const current = metrics.perCase[0];
  if (current) {
    const totals = element('dl', 'attribute-grid');
    totals.append(
      attribute(
        'Assisted active time',
        current.assistedMinutes === null
          ? 'Not recorded'
          : `${current.assistedMinutes} min`,
      ),
      attribute(
        'Manual baseline',
        current.manualMinutes === null ? 'Not recorded' : `${current.manualMinutes} min`,
      ),
      attribute(
        'Difference in active time',
        current.minutesSaved === null
          ? 'Record both methods to compare'
          : `${current.minutesSaved} min (manual minus assisted)`,
        true,
      ),
    );
    explanation.append(totals);
  }
  container.append(cards, explanation);
  const history = byId('time-history');
  history.replaceChildren();
  for (const session of sessions) {
    const row = element('div', 'time-row');
    row.append(
      element(
        'span',
        '',
        `${session.method === 'manual' ? 'Manual baseline' : 'Assisted work'} · ${session.minutes} min`,
      ),
      element('span', 'muted', dateLabel(session.createdAt)),
    );
    history.append(row);
  }
  if (!sessions.length) {
    history.append(element('p', 'muted', 'No active work time recorded for this case.'));
  }
}

/** Captures the case fingerprint when the entry form opens, preventing stale imports. */
function openCandidateDialog() {
  if (!state.detail || state.detail.bike.status !== 'open') {
    return;
  }
  const form = byId('candidate-form');
  form.reset();
  form.querySelector('.form-error').hidden = true;
  state.candidateContext = {
    caseId: state.caseId,
    fingerprint: state.detail.fingerprint,
  };
  byId('candidate-case').textContent =
    `${state.detail.bike.make} ${state.detail.bike.model} · ${state.caseId}`;
  byId('candidate-dialog').showModal();
  form.elements.namedItem('query').focus();
}

/** Selects an accessible tab with matching keyboard focus and panel visibility. */
function activateTab(name, focus = false) {
  for (const tab of ['evidence', 'metrics']) {
    const active = tab === name;
    byId(`${tab}-tab`).setAttribute('aria-selected', String(active));
    byId(`${tab}-tab`).tabIndex = active ? 0 : -1;
    byId(`${tab}-panel`).hidden = !active;
  }
  if (focus) {
    byId(`${name}-tab`).focus();
  }
}

/** Splits line-oriented object fields without interpreting them as executable markup. */
const lines = (value) =>
  value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);

/** Binds fixed shell controls once; candidate-specific controls are bound as rendered. */
function bindControls() {
  byId('case-search').addEventListener('input', renderCases);
  byId('queue-filter').addEventListener('change', renderQueue);
  byId('add-button').addEventListener('click', openCandidateDialog);
  for (const id of ['import-button', 'empty-import']) {
    byId(id).addEventListener('click', () => {
      byId('import-form').querySelector('.form-error').hidden = true;
      byId('import-dialog').showModal();
    });
  }
  document.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', () => byId(button.dataset.close).close());
  });
  for (const tab of ['evidence', 'metrics']) {
    byId(`${tab}-tab`).addEventListener('click', () => activateTab(tab));
    byId(`${tab}-tab`).addEventListener('keydown', (event) => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next =
          event.key === 'Home'
            ? 'evidence'
            : event.key === 'End'
              ? 'metrics'
              : tab === 'metrics'
                ? 'evidence'
                : 'metrics';
        activateTab(next, true);
      }
    });
  }
  byId('refresh-button').addEventListener('click', async () => {
    const button = byId('refresh-button');
    const caseId = state.caseId;
    button.disabled = true;
    try {
      await api(`/api/cases/${encodeURIComponent(caseId)}/refresh`, {});
      await loadCases(caseId);
      notify(
        'Report refreshed. Changed evidence requires a fresh listing snapshot before review.',
      );
    } catch (error) {
      notify(error.message, true);
    } finally {
      button.disabled = state.detail?.bike.staged || state.practice;
    }
  });
  bindImportForm();
  bindCandidateForm();
  bindTimeForm();
}

/** Imports a deliberately bounded real Bike Index batch with inline failure feedback. */
function bindImportForm() {
  const form = byId('import-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('[type=submit]');
    const errorLine = form.querySelector('.form-error');
    errorLine.hidden = true;
    button.disabled = true;
    button.textContent = 'Importing…';
    try {
      const result = await api(
        '/api/cases/ingest',
        Object.fromEntries(new FormData(form)),
      );
      byId('import-dialog').close();
      await loadCases(result.cases[0]?.id);
      notify(`${result.ingested} open cases imported.`);
    } catch (error) {
      errorLine.textContent = error.message;
      errorLine.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = 'Import cases';
    }
  });
}

/** Converts the object-entry form into the same normalized listing shape as the CLI. */
function bindCandidateForm() {
  const form = byId('candidate-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('[type=submit]');
    const errorLine = form.querySelector('.form-error');
    const values = Object.fromEntries(new FormData(form));
    const context = state.candidateContext;
    errorLine.hidden = true;
    button.disabled = true;
    try {
      const result = await api(
        `/api/cases/${encodeURIComponent(context.caseId)}/candidates`,
        {
          caseFingerprint: context.fingerprint,
          query: values.query,
          listing: {
            url: values.url,
            title: values.title,
            description: values.description,
            photos: lines(values.photos),
            price: values.price,
            location: values.location,
            postedAt: values.postedAt,
            attributes: {
              make: values.make,
              model: values.model,
              colors: values.colors
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean),
              serial: values.serial,
              components: lines(values.components),
              markings: lines(values.markings),
            },
          },
        },
      );
      byId('candidate-dialog').close();
      byId('queue-filter').value = 'all';
      await loadCase(context.caseId, result.observationId);
      activateTab('evidence');
      // Refresh sidebar progress without replacing the just-selected observation.
      state.cases = await api('/api/cases');
      renderCases();
      notify('Candidate added with its query, evidence, and score explanation.');
    } catch (error) {
      errorLine.textContent = error.message;
      errorLine.hidden = false;
    } finally {
      button.disabled = false;
    }
  });
}

/** Records active minutes for the case selected when the time form was submitted. */
function bindTimeForm() {
  const form = byId('time-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const caseId = state.caseId;
    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    try {
      const detail = await api(
        `/api/cases/${encodeURIComponent(caseId)}/time`,
        Object.fromEntries(new FormData(form)),
      );
      if (state.caseId === caseId) {
        state.detail = detail;
        renderMetrics();
        form.reset();
      }
      notify('Active work time recorded.');
    } catch (error) {
      notify(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
}

/** Establishes a local session before reading any case data from the API. */
async function start() {
  bindControls();
  const response = await fetch('/api/session');
  if (!response.ok) {
    throw new Error('Unable to establish the local workspace session.');
  }
  const session = await response.json();
  state.token = session.token;
  state.practice = session.practice;
  byId('mode-badge').textContent = state.practice
    ? 'Practice workspace'
    : 'Local workspace';
  byId('mode-badge').className = state.practice ? 'badge warning' : 'badge';
  byId('practice-banner').hidden = !state.practice;
  byId('import-button').disabled = state.practice;
  byId('empty-import').disabled = state.practice;
  await loadCases();
}

start().catch((error) => notify(error.message, true));
