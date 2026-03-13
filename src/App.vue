<script setup>
import { computed, ref } from 'vue';
import SessionList from './components/SessionList.vue';
import TimelineNode from './components/TimelineNode.vue';
import ToolModal from './components/ToolModal.vue';
import { useSessionViewer } from './composables/useSessionViewer';

const viewer = useSessionViewer();
const copyFeedback = ref('');
const heroSection = ref(null);
const timelineBottomAnchor = ref(null);
let copyFeedbackTimer = null;

const timelineEmptyText = computed(() => {
  if (viewer.loadingSession.value) return '正在加载会话…';
  if (viewer.detailError.value) return viewer.detailError.value;
  return '没有可展示的对话消息';
});

const currentSessionFilePath = computed(() => viewer.currentGraphSession.value?.filePath || '');
const currentSessionPathShort = computed(() => {
  const filePath = currentSessionFilePath.value;
  if (!filePath) return '';
  if (filePath.length <= 56) return filePath;
  return `...${filePath.slice(-53)}`;
});

async function copySessionPath() {
  if (!currentSessionFilePath.value) return;
  try {
    await navigator.clipboard.writeText(currentSessionFilePath.value);
    copyFeedback.value = '已复制';
  } catch {
    copyFeedback.value = '复制失败';
  }
  if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
  copyFeedbackTimer = setTimeout(() => {
    copyFeedback.value = '';
  }, 1400);
}

function scrollToBottom() {
  if (timelineBottomAnchor.value) {
    timelineBottomAnchor.value.scrollIntoView({ behavior: 'auto', block: 'end' });
    return;
  }
  window.scrollTo({ top: document.documentElement?.scrollHeight || document.body?.scrollHeight || 0, behavior: 'auto' });
}

function scrollToTop() {
  if (heroSection.value) {
    heroSection.value.scrollIntoView({ behavior: 'auto', block: 'start' });
    return;
  }
  window.scrollTo({ top: 0, behavior: 'auto' });
}
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">◎</div>
        <div>
          <h1>Session Viewer</h1>
          <p>OpenClaw 本地会话时间线 · Vue</p>
        </div>
      </div>

      <div class="controls stack">
        <input v-model="viewer.searchQuery.value" placeholder="统一搜索会话、agent、消息内容..." />
      </div>

      <SessionList
        :sessions="viewer.sessions.value"
        :current-key="viewer.currentKey.value"
        :search-query="viewer.searchQuery.value"
        @open="viewer.openSession"
      />
    </aside>

    <main class="main">
      <section ref="heroSection" class="hero">
        <div>
          <h2>{{ viewer.detailTitle.value }}</h2>
          <p>{{ viewer.detailMeta.value }}</p>
        </div>
        <div v-if="viewer.currentGraphSession.value" class="hero-actions">
          <div class="hero-path" :title="currentSessionFilePath">{{ currentSessionPathShort }}</div>
          <div class="hero-action-row">
            <button type="button" :disabled="!currentSessionFilePath" @click="copySessionPath">{{ copyFeedback || '复制路径' }}</button>
          </div>
        </div>
      </section>

      <section class="panel panel-timeline">
        <div class="panel-head">
          <h3>聊天时间线</h3>
          <span v-if="viewer.loadingSession.value" class="loading-pill">加载中…</span>
        </div>

        <div v-if="!viewer.currentTimelineItems.value.length" class="timeline empty">{{ timelineEmptyText }}</div>
        <div v-else class="timeline">
          <TimelineNode
            v-for="item in viewer.currentTimelineItems.value"
            :key="`${item.type}-${item.sessionKey || ''}-${item.timestamp || ''}-${item.text || item.kind || ''}`"
            :item="item"
            :expanded-sessions="viewer.expandedSessions.value"
            :new-message-keys="viewer.newMessageKeys.value"
            :new-subsession-keys="viewer.newSubsessionKeys.value"
            :active-search-message-key="viewer.activeSearchMessageKey.value"
            :active-search-query="viewer.activeSearchQuery.value"
            @toggle-session="viewer.toggleExpandedSession"
            @open-tool="viewer.openTool"
          />
          <div ref="timelineBottomAnchor" class="timeline-anchor" aria-hidden="true"></div>
        </div>
      </section>

      <div v-if="viewer.currentGraphSession.value" class="page-fab" aria-label="页面操作">
        <div class="page-fab-actions">
          <button type="button" class="page-fab-btn" @click="scrollToTop">顶部</button>
          <button type="button" class="page-fab-btn" @click="scrollToBottom">底部</button>
        </div>
        <label class="page-fab-switch" :class="{ active: viewer.showSystemEvents.value }">
          <span class="page-fab-switch-label">系统事件</span>
          <input v-model="viewer.showSystemEvents.value" type="checkbox" />
          <span class="page-fab-switch-track" aria-hidden="true">
            <span class="page-fab-switch-thumb"></span>
          </span>
        </label>
      </div>
    </main>

    <ToolModal :entry="viewer.selectedToolDetail.value" @close="viewer.closeTool" />
  </div>
</template>
