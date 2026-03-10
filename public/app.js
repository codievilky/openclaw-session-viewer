const sessionListEl = document.getElementById('sessionList');
const searchInputEl = document.getElementById('searchInput');
const refreshBtnEl = document.getElementById('refreshBtn');
const detailTitleEl = document.getElementById('detailTitle');
const detailMetaEl = document.getElementById('detailMeta');
const sessionGraphEl = document.getElementById('sessionGraph');
const timelineEl = document.getElementById('timeline');
const globalSearchInputEl = document.getElementById('globalSearchInput');
const globalSearchBtnEl = document.getElementById('globalSearchBtn');
const searchResultsEl = document.getElementById('searchResults');
const showSystemEventsEl = document.getElementById('showSystemEvents');
const toolModalEl = document.getElementById('toolModal');
const toolModalCloseEl = document.getElementById('toolModalClose');
const toolModalMetaEl = document.getElementById('toolModalMeta');
const toolModalSummaryEl = document.getElementById('toolModalSummary');
const toolModalArgsEl = document.getElementById('toolModalArgs');

let sessions = [];
let currentKey = null;
let currentSession = null;
let currentTimelineItems = [];
let currentGraphSession = null;
let autoRefreshTimer = null;
const expandedSessions = new Set();
let pendingFocusSessionKey = null;
let selectedToolDetail = null;
const seenTimelineMessageKeys = new Set();
const seenTimelineSubsessionKeys = new Set();

function fmtTime(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString();
}

function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function escapeAttr(str) {
  return escapeHtml(str);
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function getScroller() {
  return document.scrollingElement || document.documentElement;
}

function isNearBottom(threshold = 48) {
  const scroller = getScroller();
  return scroller.scrollHeight - (scroller.scrollTop + window.innerHeight) <= threshold;
}

function preserveScrollWhile(fn) {
  const scroller = getScroller();
  const wasNearBottom = isNearBottom();
  const previousBottomOffset = scroller.scrollHeight - scroller.scrollTop;
  fn();
  if (wasNearBottom) {
    window.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' });
  } else {
    const nextTop = Math.max(0, scroller.scrollHeight - previousBottomOffset);
    window.scrollTo({ top: nextTop, behavior: 'auto' });
  }
}

async function loadSessions({ silent = false } = {}) {
  const q = encodeURIComponent(searchInputEl.value.trim());
  const res = await fetch(`/api/sessions?q=${q}&rootsOnly=1`);
  const data = await res.json();
  const nextSessions = data.sessions || [];
  const changed = !deepEqual(sessions, nextSessions);
  sessions = nextSessions;
  if (changed || !silent) renderSessionList();
  return changed;
}

function renderSessionList() {
  if (!sessions.length) {
    sessionListEl.innerHTML = '<div class="empty">没有找到会话</div>';
    return;
  }
  sessionListEl.innerHTML = sessions.map((s) => `
    <div class="session-item ${currentKey === s.sessionKey ? 'active' : ''}" data-agent="${escapeAttr(s.agent)}" data-id="${escapeAttr(s.sessionId)}">
      <div class="top">
        <div class="title">${escapeHtml(s.label || s.agent)}</div>
        <div class="badge">${escapeHtml(s.agent)}</div>
      </div>
      <div class="meta">${fmtTime(s.summary.endAt || s.updatedAt)} · ${escapeHtml(s.model || 'unknown model')}</div>
      <div class="snippet">${escapeHtml((s.summary.firstUser || s.summary.lastText || '').slice(0, 140))}</div>
    </div>
  `).join('');

  document.querySelectorAll('.session-item').forEach((el) => {
    el.addEventListener('click', () => openSession(el.dataset.agent, el.dataset.id));
  });
}

async function fetchSession(agent, sessionId) {
  const includeSystemEvents = showSystemEventsEl.checked ? '1' : '0';
  const res = await fetch(`/api/session/${encodeURIComponent(agent)}/${encodeURIComponent(sessionId)}?includeSystemEvents=${includeSystemEvents}`);
  if (!res.ok) return null;
  return res.json();
}

function updateDetailHeader(session) {
  detailTitleEl.textContent = `${session?.label || currentSession?.sessionId || '选择一个会话'}`;
  detailMetaEl.textContent = session
    ? `${session.agent} · ${session.modelProvider || ''} ${session.model || ''} · ${fmtTime(session.summary?.startAt)} → ${fmtTime(session.summary?.endAt)} · 可见消息 ${session.summary?.visibleMessageCount ?? 0}`
    : '默认只显示 user / assistant 对话；子会话会折叠插入到同一时间线里。';
}

function renderGraph(session) {
  currentGraphSession = session;
  if (!session) {
    sessionGraphEl.innerHTML = '<div class="empty">无链路信息</div>';
    return;
  }
  const parent = session.parent;
  const children = [...(session.children || [])].sort((a, b) => new Date(a.startAt || a.endAt || 0) - new Date(b.startAt || b.endAt || 0));
  const parts = [];
  if (parent) {
    parts.push(`<div class="graph-node"><div class="badge">Parent</div><div>${escapeHtml(parent.label || parent.sessionId)}</div><div class="meta">${escapeHtml(parent.agent)}</div></div>`);
  }
  parts.push(`<div class="graph-node current"><div class="badge">Current</div><div>${escapeHtml(session.label || session.sessionId)}</div><div class="meta">${escapeHtml(session.agent)}</div></div>`);
  if (children.length) {
    for (const c of children) {
      parts.push(`
        <button class="graph-node graph-node-link" data-target-session-key="${escapeAttr(c.sessionKey)}">
          <div class="badge">Child</div>
          <div>${escapeHtml(c.label || c.sessionId)}</div>
          <div class="meta">${escapeHtml(c.agent)} · ${fmtTime(c.startAt || c.endAt)} · ${c.visibleMessageCount || 0} 条消息</div>
        </button>
      `);
    }
  }
  sessionGraphEl.innerHTML = parts.join('');
  sessionGraphEl.querySelectorAll('[data-target-session-key]').forEach((el) => {
    el.addEventListener('click', () => focusSubsession(el.dataset.targetSessionKey));
  });
}

function getMessageStableKey(item) {
  return [item.sessionKey || '', item.timestamp || '', item.displayRole || '', item.text || ''].join('::');
}

function getSubsessionStableKey(item) {
  return [item.sessionKey || '', item.timestamp || '', item.count || 0].join('::');
}

function collectNewTimelineKeys(items, state = { messages: new Set(), subsessions: new Set() }) {
  for (const item of items || []) {
    if (item.type === 'message' && (item.displayRole === 'user' || item.displayRole === 'assistant')) {
      const key = getMessageStableKey(item);
      if (!seenTimelineMessageKeys.has(key)) state.messages.add(key);
    }
    if (item.type === 'subsession') {
      const subKey = getSubsessionStableKey(item);
      if (!seenTimelineSubsessionKeys.has(subKey)) state.subsessions.add(subKey);
      collectNewTimelineKeys(item.items || [], state);
    }
  }
  return state;
}

function rememberTimelineKeys(items) {
  for (const item of items || []) {
    if (item.type === 'message' && (item.displayRole === 'user' || item.displayRole === 'assistant')) {
      seenTimelineMessageKeys.add(getMessageStableKey(item));
    }
    if (item.type === 'subsession') {
      seenTimelineSubsessionKeys.add(getSubsessionStableKey(item));
      rememberTimelineKeys(item.items || []);
    }
  }
}

function renderTimeline(items, { preserveScroll = false } = {}) {
  const nextItems = items || [];
  const newKeys = collectNewTimelineKeys(currentTimelineItems, nextItems);
  const render = () => {
    currentTimelineItems = nextItems;
    if (!nextItems.length) {
      timelineEl.className = 'timeline empty';
      timelineEl.textContent = '没有可展示的对话消息';
      return;
    }
    timelineEl.className = 'timeline';
    timelineEl.innerHTML = nextItems.map((item) => renderTimelineItem(item, newKeys)).join('');
    bindTimelineInteractions();
    restoreExpandedSessions();
    requestAnimationFrame(() => {
      timelineEl.querySelectorAll('.is-new').forEach((el) => {
        el.classList.remove('is-new');
      });
    });
    rememberTimelineKeys(nextItems);
    if (pendingFocusSessionKey) {
      const key = pendingFocusSessionKey;
      pendingFocusSessionKey = null;
      focusSubsession(key, { scrollBehavior: 'smooth' });
    }
  };

  if (preserveScroll) {
    preserveScrollWhile(render);
  } else {
    render();
  }
}

function renderTimelineItem(item, newKeys = { messages: new Set(), subsessions: new Set() }) {
  if (item.type === 'subsession') {
    const isExpanded = expandedSessions.has(item.sessionKey);
    const isNew = newKeys.subsessions.has(getSubsessionStableKey(item));
    return `
      <div class="message-row subsession${isNew ? ' is-new' : ''}" id="subsession-wrap-${escapeAttr(item.sessionKey)}">
        <details class="subsession-card${isNew ? ' is-new' : ''}" data-session-key="${escapeAttr(item.sessionKey)}" ${isExpanded ? 'open' : ''}>
          <summary class="subsession-summary">
            <span>${escapeHtml(item.sessionLabel || item.agent)} 子会话，共 ${item.count || 0} 条可见消息</span>
            <span class="meta">${escapeHtml(item.agent)} · ${fmtTime(item.timestamp)}</span>
          </summary>
          <div class="subsession-content timeline">
            ${(item.items || []).map((child) => renderTimelineItem(child, newKeys)).join('') || '<div class="empty">子会话内没有可展示消息</div>'}
          </div>
        </details>
      </div>
    `;
  }

  if (item.type === 'message' && (item.displayRole === 'user' || item.displayRole === 'assistant')) {
    const isNew = newKeys.messages.has(getMessageStableKey(item));
    return `
      <div class="message-row ${item.displayRole}${isNew ? ' is-new' : ''}">
        <article class="bubble">
          <div class="message-head">
            <span>${item.displayRole === 'user' ? 'User' : 'Assistant'} · ${escapeHtml(item.sessionLabel || item.agent)}</span>
            <span>${fmtTime(item.timestamp)}</span>
          </div>
          <div class="message-body">${item.html || '<p>（无文本）</p>'}</div>
        </article>
      </div>
    `;
  }

  if (item.type === 'tool-group') {
    return `
      <div class="system-lane">
        <div class="system-ribbon tool-ribbon">
          <div class="system-ribbon-head">
            <span>工具事件 · ${escapeHtml(item.sessionLabel || item.agent)}</span>
            <span>${fmtTime(item.timestamp)}</span>
          </div>
          <div class="tool-chip-row">
            ${(item.entries || []).map((entry, index) => renderToolChip(entry, index)).join('')}
          </div>
        </div>
      </div>
    `;
  }

  if (item.type === 'system') {
    return `
      <div class="system-lane">
        <details class="system-ribbon system-detail">
          <summary class="system-ribbon-head">
            <span>系统事件 · ${escapeHtml(item.sessionLabel || item.agent)}</span>
            <span>${fmtTime(item.timestamp)}</span>
          </summary>
          <div class="system-detail-body">${item.html || `<pre>${escapeHtml(item.text || item.kind || 'event')}</pre>`}</div>
        </details>
      </div>
    `;
  }

  return '';
}

function renderToolChip(entry, index) {
  const kind = entry.type === 'toolResult' ? '结果' : '调用';
  const icon = entry.type === 'toolResult' ? '◧' : '◩';
  const title = `${kind}: ${entry.title || entry.name || 'tool'}${entry.summary ? `\n${entry.summary}` : ''}`;
  const encoded = encodeAttrJson({ ...entry, _index: index });
  return `<button class="tool-chip" data-tool-entry="${encoded}" title="${escapeAttr(title)}"><span class="tool-chip-icon">${icon}</span><span class="tool-chip-label">${escapeHtml(entry.name || 'tool')}</span></button>`;
}

function encodeAttrJson(value) {
  return escapeAttr(JSON.stringify(value));
}

function bindTimelineInteractions() {
  timelineEl.querySelectorAll('details[data-session-key]').forEach((detailsEl) => {
    detailsEl.addEventListener('toggle', () => {
      const { sessionKey } = detailsEl.dataset;
      if (!sessionKey) return;
      if (detailsEl.open) expandedSessions.add(sessionKey);
      else expandedSessions.delete(sessionKey);
    });
  });

  timelineEl.querySelectorAll('[data-tool-entry]').forEach((el) => {
    el.addEventListener('click', () => {
      try {
        const entry = JSON.parse(el.dataset.toolEntry);
        openToolModal(entry);
      } catch {
        // ignore malformed payload
      }
    });
  });
}

function restoreExpandedSessions() {
  timelineEl.querySelectorAll('details[data-session-key]').forEach((detailsEl) => {
    const { sessionKey } = detailsEl.dataset;
    detailsEl.open = expandedSessions.has(sessionKey);
  });
}

function expandPathToSession(sessionKey, root = timelineEl) {
  const target = root.querySelector(`details[data-session-key="${cssEscape(sessionKey)}"]`);
  if (!target) return null;
  let node = target;
  while (node) {
    if (node.tagName === 'DETAILS' && node.dataset.sessionKey) {
      node.open = true;
      expandedSessions.add(node.dataset.sessionKey);
    }
    node = node.parentElement?.closest?.('details[data-session-key]') || null;
  }
  return target;
}

function focusSubsession(sessionKey, { scrollBehavior = 'smooth' } = {}) {
  const targetDetails = expandPathToSession(sessionKey);
  if (!targetDetails) {
    pendingFocusSessionKey = sessionKey;
    return;
  }
  const targetWrap = document.getElementById(`subsession-wrap-${sessionKey}`) || targetDetails;
  targetWrap.classList.remove('flash-focus');
  void targetWrap.offsetWidth;
  targetWrap.classList.add('flash-focus');
  targetWrap.scrollIntoView({ behavior: scrollBehavior, block: 'start' });
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
  return String(value).replace(/([#.;?+*~':"!^$\[\]()=>|/@])/g, '\\$1');
}

function openToolModal(entry) {
  selectedToolDetail = entry;
  toolModalMetaEl.textContent = `${entry.name || 'tool'} · ${fmtTime(entry.timestamp)} · ${entry.type === 'toolResult' ? '结果' : '调用'}`;
  toolModalSummaryEl.textContent = entry.summary || '—';
  toolModalArgsEl.textContent = entry.rawArguments || '—';
  toolModalEl.classList.remove('hidden');
}

function closeToolModal() {
  selectedToolDetail = null;
  toolModalEl.classList.add('hidden');
}

async function openSession(agent, sessionId, options = {}) {
  const data = await fetchSession(agent, sessionId);
  if (!data) return;
  const s = data.session;
  const nextItems = data.timeline?.items || [];
  const sessionChanged = currentSession?.agent !== agent || currentSession?.sessionId !== sessionId;
  const timelineChanged = !deepEqual(currentTimelineItems, nextItems);
  const graphChanged = !deepEqual(currentGraphSession, s);

  currentSession = { agent, sessionId };
  currentKey = s?.sessionKey || null;
  if (sessionChanged) renderSessionList(); else renderSessionList();

  updateDetailHeader(s);
  if (graphChanged || sessionChanged) renderGraph(s);
  if (timelineChanged || sessionChanged) {
    renderTimeline(nextItems, { preserveScroll: options.preserveScroll && !sessionChanged });
  }
}

async function doSearch() {
  const q = globalSearchInputEl.value.trim();
  if (!q) return;
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  const data = await res.json();
  const results = data.results || [];
  if (!results.length) {
    searchResultsEl.className = 'search-results empty';
    searchResultsEl.textContent = '没有结果';
    return;
  }
  searchResultsEl.className = 'search-results';
  searchResultsEl.innerHTML = results.map((r) => `
    <div class="result-item">
      <div><strong>${escapeHtml(r.label || r.sessionId)}</strong> <span class="badge">${escapeHtml(r.agent)}</span></div>
      <div class="meta">${escapeHtml(r.role || 'event')} · ${fmtTime(r.timestamp)}</div>
      <div class="snippet">${escapeHtml(r.text)}</div>
      <div class="jump" data-agent="${escapeAttr(r.agent)}" data-id="${escapeAttr(r.sessionId)}">打开此会话</div>
    </div>
  `).join('');
  document.querySelectorAll('.jump').forEach((el) => {
    el.addEventListener('click', () => openSession(el.dataset.agent, el.dataset.id));
  });
}

async function autoRefreshTick() {
  try {
    await loadSessions({ silent: true });
    if (currentSession) {
      await openSession(currentSession.agent, currentSession.sessionId, { preserveScroll: true });
    }
  } catch (error) {
    console.error('auto refresh failed', error);
  }
}

function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(autoRefreshTick, 1000);
}

refreshBtnEl.addEventListener('click', async () => {
  await loadSessions();
  if (currentSession) await openSession(currentSession.agent, currentSession.sessionId, { preserveScroll: true });
});
searchInputEl.addEventListener('input', () => loadSessions());
globalSearchBtnEl.addEventListener('click', doSearch);
globalSearchInputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
showSystemEventsEl.addEventListener('change', () => {
  if (currentSession) openSession(currentSession.agent, currentSession.sessionId, { preserveScroll: true });
});

toolModalCloseEl.addEventListener('click', closeToolModal);
toolModalEl.addEventListener('click', (e) => {
  if (e.target === toolModalEl) closeToolModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && selectedToolDetail) closeToolModal();
});

loadSessions();
startAutoRefresh();
