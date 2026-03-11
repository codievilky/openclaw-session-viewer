import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { deepEqual, fmtTime, getMessageStableKey, getSubsessionStableKey, restoreScrollState, snapshotScrollState } from '../lib/format';

function safeSet(base) {
  return base instanceof Set ? base : new Set();
}

function collectNewTimelineKeys(items, seenMessageKeys, seenSubsessionKeys, state = { messages: new Set(), subsessions: new Set() }) {
  const nextState = state || { messages: new Set(), subsessions: new Set() };
  const nextMessages = safeSet(nextState.messages);
  const nextSubsessions = safeSet(nextState.subsessions);

  for (const item of items || []) {
    if (item.type === 'message' && (item.displayRole === 'user' || item.displayRole === 'assistant')) {
      const key = getMessageStableKey(item);
      if (!seenMessageKeys.has(key)) nextMessages.add(key);
    }
    if (item.type === 'subsession') {
      const key = getSubsessionStableKey(item);
      if (!seenSubsessionKeys.has(key)) nextSubsessions.add(key);
      collectNewTimelineKeys(item.items || [], seenMessageKeys, seenSubsessionKeys, { messages: nextMessages, subsessions: nextSubsessions });
    }
  }

  return { messages: nextMessages, subsessions: nextSubsessions };
}

function rememberTimelineKeys(items, seenMessageKeys, seenSubsessionKeys) {
  for (const item of items || []) {
    if (item.type === 'message' && (item.displayRole === 'user' || item.displayRole === 'assistant')) {
      seenMessageKeys.add(getMessageStableKey(item));
    }
    if (item.type === 'subsession') {
      seenSubsessionKeys.add(getSubsessionStableKey(item));
      rememberTimelineKeys(item.items || [], seenMessageKeys, seenSubsessionKeys);
    }
  }
}

export function useSessionViewer() {
  const sessions = ref([]);
  const currentKey = ref(null);
  const currentSession = ref(null);
  const currentGraphSession = ref(null);
  const currentTimelineItems = ref([]);
  const showSystemEvents = ref(false);
  const searchQuery = ref('');
  const searchResults = ref([]);
  const searchPerformed = ref(false);
  const searchLoading = ref(false);
  const selectedToolDetail = ref(null);
  const loadingSessions = ref(false);
  const loadingSession = ref(false);
  const detailError = ref('');
  const lastUpdatedAt = ref(null);
  const pendingFocusSessionKey = ref(null);
  const expandedSessions = reactive(new Set());
  const newMessageKeys = ref(new Set());
  const newSubsessionKeys = ref(new Set());
  const seenTimelineMessageKeys = new Set();
  const seenTimelineSubsessionKeys = new Set();

  let autoRefreshTimer = null;
  let autoRefreshInFlight = false;
  let sidebarSearchTimer = null;
  let sessionLoadSeq = 0;
  let sessionAbortController = null;

  const detailTitle = computed(() => currentGraphSession.value?.label || currentSession.value?.sessionId || '选择一个会话');
  const detailMeta = computed(() => {
    const session = currentGraphSession.value;
    if (!session) return '默认只显示 user / assistant 对话；子会话会折叠插入到同一时间线里。';
    return `${session.agent} · ${session.modelProvider || ''} ${session.model || ''} · ${fmtTime(session.summary?.startAt)} → ${fmtTime(session.summary?.endAt)} · 可见消息 ${session.summary?.visibleMessageCount ?? 0}`;
  });

  async function loadSessions({ silent = false } = {}) {
    loadingSessions.value = !silent;
    try {
      const query = encodeURIComponent(searchQuery.value.trim());
      const res = await fetch(`/api/sessions?q=${query}&rootsOnly=1`, { cache: 'no-store' });
      const data = await res.json();
      const nextSessions = data.sessions || [];
      const changed = !deepEqual(sessions.value, nextSessions);
      sessions.value = nextSessions;
      lastUpdatedAt.value = Date.now();

      if (!currentSession.value && sessions.value.length) {
        const first = sessions.value[0];
        await openSession(first.agent, first.sessionId, first.sessionKey);
      }

      return changed;
    } finally {
      loadingSessions.value = false;
    }
  }

  async function fetchSession(agent, sessionId, signal, sessionKey = null) {
    const includeSystemEvents = showSystemEvents.value ? '1' : '0';
    const sessionKeyQuery = sessionKey ? `&sessionKey=${encodeURIComponent(sessionKey)}` : '';
    const res = await fetch(`/api/session/${encodeURIComponent(agent)}/${encodeURIComponent(sessionId)}?includeSystemEvents=${includeSystemEvents}${sessionKeyQuery}`, {
      cache: 'no-store',
      signal,
    });
    if (!res.ok) return null;
    return res.json();
  }

  async function openSession(agent, sessionId, sessionKeyOrOptions = null, maybeOptions = {}) {
    const sessionKey = sessionKeyOrOptions && typeof sessionKeyOrOptions !== 'object' ? sessionKeyOrOptions : null;
    const options = sessionKeyOrOptions && typeof sessionKeyOrOptions === 'object' ? sessionKeyOrOptions : maybeOptions;
    const requestKey = sessionKey || `${agent}:${sessionId}`;
    const requestSeq = ++sessionLoadSeq;
    detailError.value = '';
    loadingSession.value = true;
    if (sessionAbortController) sessionAbortController.abort();
    sessionAbortController = new AbortController();

    const scrollState = options.preserveScroll ? snapshotScrollState() : null;

    try {
      const data = await fetchSession(agent, sessionId, sessionAbortController.signal, sessionKey);
      if (requestSeq !== sessionLoadSeq) return;
      if (!data) {
        detailError.value = '会话不存在或加载失败';
        return;
      }

      const session = data.session;
      const nextItems = data.timeline?.items || [];
      const sessionChanged = currentSession.value?.requestKey !== requestKey;
      const graphChanged = !deepEqual(currentGraphSession.value, session);
      const timelineChanged = !deepEqual(currentTimelineItems.value, nextItems);
      const newKeys = collectNewTimelineKeys(nextItems, seenTimelineMessageKeys, seenTimelineSubsessionKeys, { messages: new Set(), subsessions: new Set() });

      currentSession.value = { agent, sessionId, sessionKey: session?.sessionKey || sessionKey || null, requestKey };
      currentKey.value = session?.sessionKey || null;
      if (graphChanged || sessionChanged) currentGraphSession.value = session;
      if (timelineChanged || sessionChanged) {
        currentTimelineItems.value = nextItems;
        newMessageKeys.value = newKeys.messages;
        newSubsessionKeys.value = newKeys.subsessions;
      }
      rememberTimelineKeys(nextItems, seenTimelineMessageKeys, seenTimelineSubsessionKeys);
      lastUpdatedAt.value = Date.now();

      await nextTick();
      if (scrollState && !sessionChanged) restoreScrollState(scrollState);
      if (pendingFocusSessionKey.value) {
        focusSubsession(pendingFocusSessionKey.value);
        pendingFocusSessionKey.value = null;
      }
    } catch (error) {
      if (error?.name !== 'AbortError') {
        detailError.value = error?.message || '打开会话失败';
      }
    } finally {
      if (requestSeq === sessionLoadSeq) loadingSession.value = false;
    }
  }

  async function doSearch() {
    const query = searchQuery.value.trim();
    if (!query) {
      searchResults.value = [];
      searchPerformed.value = false;
      return;
    }
    searchLoading.value = true;
    searchPerformed.value = true;
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { cache: 'no-store' });
      const data = await res.json();
      searchResults.value = data.results || [];
      lastUpdatedAt.value = Date.now();
    } finally {
      searchLoading.value = false;
    }
  }

  async function autoRefreshTick() {
    if (autoRefreshInFlight || document.hidden) return;
    autoRefreshInFlight = true;
    try {
      await loadSessions({ silent: true });
      if (currentSession.value) {
        await openSession(currentSession.value.agent, currentSession.value.sessionId, currentSession.value.sessionKey || undefined, { preserveScroll: true });
      }
    } finally {
      autoRefreshInFlight = false;
    }
  }

  function startAutoRefresh() {
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    autoRefreshTimer = setInterval(autoRefreshTick, 2000);
  }

  function stopAutoRefresh() {
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }

  function toggleExpandedSession(sessionKey, open) {
    if (!sessionKey) return;
    if (open) expandedSessions.add(sessionKey);
    else expandedSessions.delete(sessionKey);
  }

  function focusSubsession(sessionKey) {
    if (!sessionKey) return;
    expandedSessions.add(sessionKey);
    nextTick(() => {
      const target = document.getElementById(`subsession-wrap-${sessionKey}`) || document.querySelector(`details[data-session-key="${CSS.escape(sessionKey)}"]`);
      if (!target) {
        pendingFocusSessionKey.value = sessionKey;
        return;
      }
      target.classList.remove('flash-focus');
      void target.offsetWidth;
      target.classList.add('flash-focus');
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function openTool(entry) {
    selectedToolDetail.value = entry;
  }

  function closeTool() {
    selectedToolDetail.value = null;
  }

  watch(searchQuery, () => {
    if (sidebarSearchTimer) clearTimeout(sidebarSearchTimer);
    sidebarSearchTimer = setTimeout(() => {
      Promise.all([
        loadSessions(),
        doSearch(),
      ]).catch((error) => {
        detailError.value = error?.message || '加载会话失败';
      });
    }, 180);
  });

  watch(showSystemEvents, () => {
    if (currentSession.value) {
      openSession(currentSession.value.agent, currentSession.value.sessionId, currentSession.value.sessionKey || undefined, { preserveScroll: true });
    }
  });

  onMounted(() => {
    loadSessions().catch((error) => {
      detailError.value = error?.message || '加载会话失败';
    });
    startAutoRefresh();
    window.addEventListener('keydown', handleEscape);
  });

  onBeforeUnmount(() => {
    stopAutoRefresh();
    if (sidebarSearchTimer) clearTimeout(sidebarSearchTimer);
    if (sessionAbortController) sessionAbortController.abort();
    window.removeEventListener('keydown', handleEscape);
  });

  function handleEscape(event) {
    if (event.key === 'Escape' && selectedToolDetail.value) closeTool();
  }

  return {
    sessions,
    currentKey,
    currentGraphSession,
    currentTimelineItems,
    showSystemEvents,
    searchQuery,
    searchResults,
    searchPerformed,
    searchLoading,
    selectedToolDetail,
    loadingSession,
    detailError,
    detailTitle,
    detailMeta,
    expandedSessions,
    newMessageKeys,
    newSubsessionKeys,
    lastUpdatedAt,
    loadSessions,
    openSession,
    doSearch,
    toggleExpandedSession,
    focusSubsession,
    openTool,
    closeTool,
  };
}
