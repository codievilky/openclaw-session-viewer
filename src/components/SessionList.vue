<script setup>
import { computed, ref, watch } from 'vue';
import { fmtTime, formatClockTime, formatDayLabel, getTodayDayKey, toLocalDayKey } from '../lib/format';

const props = defineProps({
  sessions: { type: Array, required: true },
  currentKey: { type: String, default: null },
  searchQuery: { type: String, default: '' },
});

const emit = defineEmits(['open']);

const expandedDayKeys = ref(new Set());
const initializedDayKeys = new Set();
let lastCurrentKey = null;

function getSessionTimestamp(session) {
  return session.summary?.endAt || session.updatedAt || session.summary?.startAt || session.historySnapshotAt || null;
}

const groupedSessions = computed(() => {
  const groups = [];
  const groupMap = new Map();
  const todayKey = getTodayDayKey();

  for (const session of props.sessions) {
    const dayKey = toLocalDayKey(getSessionTimestamp(session));
    if (!groupMap.has(dayKey)) {
      const group = {
        dayKey,
        label: formatDayLabel(dayKey),
        isToday: dayKey === todayKey,
        sessions: [],
      };
      groupMap.set(dayKey, group);
      groups.push(group);
    }
    groupMap.get(dayKey).sessions.push(session);
  }

  return groups;
});

const allExpanded = computed(() => {
  if (!groupedSessions.value.length) return false;
  return groupedSessions.value.every((group) => expandedDayKeys.value.has(group.dayKey));
});

function applyDefaultExpandedState() {
  const next = new Set();
  for (const group of groupedSessions.value) {
    if (group.isToday) next.add(group.dayKey);
  }
  expandedDayKeys.value = next;
}

function ensureExpandedDefaults() {
  const next = new Set(expandedDayKeys.value);
  const available = new Set(groupedSessions.value.map((group) => group.dayKey));

  for (const group of groupedSessions.value) {
    if (initializedDayKeys.has(group.dayKey)) continue;
    initializedDayKeys.add(group.dayKey);
    if (group.isToday) next.add(group.dayKey);
  }

  for (const dayKey of [...next]) {
    if (!available.has(dayKey)) next.delete(dayKey);
  }

  expandedDayKeys.value = next;
}

function ensureCurrentGroupExpanded() {
  if (!props.currentKey) return;
  const currentGroup = groupedSessions.value.find((group) => group.sessions.some((session) => session.sessionKey === props.currentKey));
  if (!currentGroup) return;
  const next = new Set(expandedDayKeys.value);
  next.add(currentGroup.dayKey);
  expandedDayKeys.value = next;
}

watch(groupedSessions, () => {
  ensureExpandedDefaults();
}, { immediate: true });

watch(() => props.currentKey, (nextKey) => {
  if (!nextKey || nextKey === lastCurrentKey) return;
  lastCurrentKey = nextKey;
  ensureCurrentGroupExpanded();
}, { immediate: true });

function toggleDay(dayKey) {
  const next = new Set(expandedDayKeys.value);
  if (next.has(dayKey)) next.delete(dayKey);
  else next.add(dayKey);
  expandedDayKeys.value = next;
}

function toggleExpandAll() {
  if (allExpanded.value) {
    applyDefaultExpandedState();
    return;
  }
  expandedDayKeys.value = new Set(groupedSessions.value.map((group) => group.dayKey));
}

function getSessionTitle(session) {
  if (session.isHistory) return formatClockTime(getSessionTimestamp(session));
  return session.label || session.agent;
}

function getSessionMeta(session) {
  if (session.isHistory) return `${session.agent} · 历史会话`;
  return `${fmtTime(getSessionTimestamp(session))} · ${session.model || 'unknown model'}`;
}

function getSessionSnippet(session) {
  if (session.isHistory) return '';
  if (session.searchMatch?.preview) return session.searchMatch.preview;
  return (session.summary?.firstUser || session.summary?.lastText || '').slice(0, 140);
}

function isDayExpanded(dayKey) {
  return expandedDayKeys.value.has(dayKey);
}

function openSessionFromList(session) {
  const searchQuery = String(props.searchQuery || '').trim();
  const options = searchQuery
    ? { searchQuery, triggerSearchFocus: true }
    : undefined;
  emit('open', session.agent, session.sessionId, session.sessionKey, options);
}
</script>

<template>
  <div v-if="!sessions.length" class="session-list empty">没有找到会话</div>
  <div v-else class="session-list grouped-session-list">
    <button type="button" class="session-group-toggle-all" @click="toggleExpandAll">
      {{ allExpanded ? '恢复默认' : '展开全部' }}
    </button>

    <section v-for="group in groupedSessions" :key="group.dayKey" class="session-day-group">
      <button type="button" class="session-day-header" @click="toggleDay(group.dayKey)">
        <span>{{ group.label }}</span>
        <span class="session-day-meta">{{ group.sessions.length }} 个 · {{ isDayExpanded(group.dayKey) ? '收起' : '展开' }}</span>
      </button>

      <div v-if="isDayExpanded(group.dayKey)" class="session-day-list">
        <button
          v-for="session in group.sessions"
          :key="session.sessionKey"
          type="button"
          class="session-item"
          :class="{ active: currentKey === session.sessionKey, historical: session.isHistory }"
          @click="openSessionFromList(session)"
        >
          <div class="top">
            <div class="title">{{ getSessionTitle(session) }}</div>
            <div class="badge">{{ session.agent }}</div>
          </div>
          <div class="meta">{{ getSessionMeta(session) }}</div>
          <div v-if="getSessionSnippet(session)" class="snippet">{{ getSessionSnippet(session) }}</div>
        </button>
      </div>
    </section>
  </div>
</template>
