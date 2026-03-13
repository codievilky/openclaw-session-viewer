import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { deepEqual, fmtTime, getMessageStableKey, getSubsessionStableKey, restoreScrollState, snapshotScrollState } from '../lib/format';

function createReactiveSet(values = []) {
  return reactive(new Set(values));
}

function waitForFrame() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

async function findMessageElement(messageKey, attempts = 6) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const target = document.querySelector(`[data-message-key="${CSS.escape(messageKey)}"]`);
    if (target) return target;
    await nextTick();
    await waitForFrame();
  }
  return null;
}

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

function findTimelineQueryTarget(items, normalizedQuery, ancestorSessionKeys = []) {
  for (const item of items || []) {
    if (item.type === 'message' && (item.displayRole === 'user' || item.displayRole === 'assistant')) {
      if (String(item.text || '').toLowerCase().includes(normalizedQuery)) {
        return { item, ancestorSessionKeys };
      }
    }

    if (item.type === 'subsession') {
      const nextAncestors = item.sessionKey ? [...ancestorSessionKeys, item.sessionKey] : ancestorSessionKeys;
      const found = findTimelineQueryTarget(item.items || [], normalizedQuery, nextAncestors);
      if (found) return found;
    }
  }

  return null;
}

export function useSessionViewer() {
  const sessions = ref([]);
  const currentKey = ref(null);
  const currentSession = ref(null);
  const currentGraphSession = ref(null);
  const currentTimelineItems = ref([]);
  const showSystemEvents = ref(false);
  const searchQuery = ref('');
  const selectedToolDetail = ref(null);
  const loadingSessions = ref(false);
  const loadingSession = ref(false);
  const detailError = ref('');
  const lastUpdatedAt = ref(null);
  const pendingFocusSessionKey = ref(null);
  const expandedSessions = ref(createReactiveSet());
  const newMessageKeys = ref(new Set());
  const newSubsessionKeys = ref(new Set());
  const activeSearchMessageKey = ref('');
  const activeSearchQuery = ref('');
  const seenTimelineMessageKeys = new Set();
  const seenTimelineSubsessionKeys = new Set();
  const sessionViewStates = new Map();

  let autoRefreshTimer = null;
  let autoRefreshInFlight = false;
  let autoRefreshPausedUntil = 0;
  let sidebarSearchTimer = null;
  let sessionLoadSeq = 0;
  let sessionAbortController = null;

  const detailTitle = computed(() => currentGraphSession.value?.label || currentSession.value?.sessionId || '选择一个会话');
  const detailMeta = computed(() => {
    const session = currentGraphSession.value;
    if (!session) return '默认只显示 user / assistant 对话；子会话会折叠插入到同一时间线里。';
    return `${session.agent} · ${session.modelProvider || ''} ${session.model || ''} · ${fmtTime(session.summary?.startAt)} → ${fmtTime(session.summary?.endAt)} · 可见消息 ${session.summary?.visibleMessageCount ?? 0}`;
  });

  function collectOpenSystemDetailKeys() {
    return [...document.querySelectorAll('details[data-system-detail-key][open]')]
      .map((node) => node.dataset.systemDetailKey)
      .filter(Boolean);
  }

  function persistCurrentViewState() {
    const requestKey = currentSession.value?.requestKey;
    if (!requestKey) return;
    sessionViewStates.set(requestKey, {
      scrollState: snapshotScrollState(),
      expandedSessionKeys: [...expandedSessions.value],
      openSystemDetailKeys: collectOpenSystemDetailKeys(),
    });
  }

  function restoreExpandedSessions(expandedSessionKeys = []) {
    expandedSessions.value = createReactiveSet(expandedSessionKeys);
  }

  function restoreOpenSystemDetails(openSystemDetailKeys = []) {
    const nextKeys = new Set(openSystemDetailKeys);
    for (const node of document.querySelectorAll('details[data-system-detail-key]')) {
      node.open = nextKeys.has(node.dataset.systemDetailKey);
    }
  }

  function clearActiveSearchHighlight() {
    activeSearchMessageKey.value = '';
    activeSearchQuery.value = '';
  }

  async function focusSearchQuery(query) {
    const normalizedQuery = String(query || '').trim().toLowerCase();
    if (!normalizedQuery) {
      clearActiveSearchHighlight();
      return false;
    }

    const found = findTimelineQueryTarget(currentTimelineItems.value, normalizedQuery);
    if (!found) {
      clearActiveSearchHighlight();
      return false;
    }

    for (const sessionKey of found.ancestorSessionKeys) {
      expandedSessions.value.add(sessionKey);
    }

    const messageKey = getMessageStableKey(found.item);
    await nextTick();
    const target = await findMessageElement(messageKey);
    if (!target) return false;

    target.scrollIntoView({ behavior: 'auto', block: 'center' });

    activeSearchMessageKey.value = messageKey;
    activeSearchQuery.value = String(query || '').trim();

    await nextTick();
    const refreshedTarget = document.querySelector(`[data-message-key="${CSS.escape(messageKey)}"]`) || target;
    refreshedTarget.classList.remove('flash-focus');
    void refreshedTarget.offsetWidth;
    refreshedTarget.classList.add('flash-focus');
    return true;
  }

  async function restoreSessionViewState(requestKey, { resetScroll = false } = {}) {
    const viewState = sessionViewStates.get(requestKey);
    restoreExpandedSessions(viewState?.expandedSessionKeys || []);
    await nextTick();
    restoreOpenSystemDetails(viewState?.openSystemDetailKeys || []);
    await waitForFrame();
    if (viewState?.scrollState) {
      restoreScrollState(viewState.scrollState);
      return;
    }
    if (resetScroll) {
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
  }

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
    const previousRequestKey = currentSession.value?.requestKey || null;
    const isSessionSwitch = Boolean(previousRequestKey && previousRequestKey !== requestKey);
    const triggerSearchFocus = Boolean(options.triggerSearchFocus);
    const searchFocusQuery = String(options.searchQuery || '').trim();

    if (triggerSearchFocus) {
      autoRefreshPausedUntil = Date.now() + 3000;
    }

    if (isSessionSwitch) {
      persistCurrentViewState();
    }

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

      if (sessionChanged) {
        const hasSavedViewState = sessionViewStates.has(requestKey);
        if (!hasSavedViewState) {
          restoreExpandedSessions();
        }

        await nextTick();

        if (hasSavedViewState) {
          await restoreSessionViewState(requestKey);
        } else {
          restoreOpenSystemDetails([]);
          await waitForFrame();
          if (!options.preserveScroll) {
            window.scrollTo({ top: 0, behavior: 'auto' });
          }
        }
      } else {
        await nextTick();
      }

      if (triggerSearchFocus && searchFocusQuery) {
        await focusSearchQuery(searchFocusQuery);
      } else if (sessionChanged) {
        clearActiveSearchHighlight();
      }

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

  async function autoRefreshTick() {
    if (autoRefreshInFlight || document.hidden || loadingSession.value || Date.now() < autoRefreshPausedUntil) return;
    autoRefreshInFlight = true;
    try {
      await loadSessions({ silent: true });
      if (currentSession.value) {
        await openSession(currentSession.value.agent, currentSession.value.sessionId, currentSession.value.sessionKey || undefined);
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
    if (open) expandedSessions.value.add(sessionKey);
    else expandedSessions.value.delete(sessionKey);
  }

  function focusSubsession(sessionKey) {
    if (!sessionKey) return;
    expandedSessions.value.add(sessionKey);
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
    if (!String(searchQuery.value || '').trim()) {
      clearActiveSearchHighlight();
    }
    sidebarSearchTimer = setTimeout(() => {
      loadSessions().catch((error) => {
        detailError.value = error?.message || '加载会话失败';
      });
    }, 180);
  });

  watch(showSystemEvents, () => {
    if (currentSession.value) {
      openSession(currentSession.value.agent, currentSession.value.sessionId, currentSession.value.sessionKey || undefined);
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
    selectedToolDetail,
    loadingSession,
    detailError,
    detailTitle,
    detailMeta,
    expandedSessions,
    newMessageKeys,
    newSubsessionKeys,
    activeSearchMessageKey,
    activeSearchQuery,
    lastUpdatedAt,
    loadSessions,
    openSession,
    toggleExpandedSession,
    focusSubsession,
    openTool,
    closeTool,
  };
}
