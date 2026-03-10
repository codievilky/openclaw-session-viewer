<script setup>
import { computed, ref } from 'vue';
import SessionGraph from './components/SessionGraph.vue';
import SessionList from './components/SessionList.vue';
import SearchResults from './components/SearchResults.vue';
import TimelineNode from './components/TimelineNode.vue';
import ToolModal from './components/ToolModal.vue';
import { useSessionViewer } from './composables/useSessionViewer';

const viewer = useSessionViewer();
const copyFeedback = ref('');
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
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
}

function scrollToTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
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
        <input v-model="viewer.sidebarQuery.value" placeholder="搜索主会话、agent、首条消息..." />
      </div>

      <SessionList
        :sessions="viewer.sessions.value"
        :current-key="viewer.currentKey.value"
        @open="viewer.openSession"
      />
    </aside>

    <main class="main">
      <section class="hero">
        <div>
          <h2>{{ viewer.detailTitle.value }}</h2>
          <p>{{ viewer.detailMeta.value }}</p>
        </div>
        <div class="hero-actions">
          <label class="toggle-row">
            <input v-model="viewer.showSystemEvents.value" type="checkbox" />
            <span>显示系统事件</span>
          </label>
          <div class="search-inline">
            <input v-model="viewer.globalQuery.value" placeholder="全文搜索消息内容" @keydown.enter="viewer.doSearch" />
            <button type="button" @click="viewer.doSearch">搜索</button>
          </div>
        </div>
      </section>

      <section class="panel-grid">
        <section class="panel">
          <h3>会话链路</h3>
          <SessionGraph :session="viewer.currentGraphSession.value" @focus-subsession="viewer.focusSubsession" />
        </section>

        <section class="panel panel-timeline">
          <div class="panel-head">
            <h3>聊天时间线</h3>
            <span v-if="viewer.loadingSession.value" class="loading-pill">加载中…</span>
          </div>

          <div v-if="viewer.currentGraphSession.value" class="timeline-floatbar">
            <div class="timeline-floatbar-main">
              <div class="timeline-floatbar-path" :title="currentSessionFilePath">{{ currentSessionPathShort }}</div>
            </div>
            <div class="timeline-floatbar-actions">
              <button type="button" :disabled="!currentSessionFilePath" @click="copySessionPath">{{ copyFeedback || '复制路径' }}</button>
              <button type="button" @click="scrollToTop">顶部</button>
              <button type="button" @click="scrollToBottom">底部</button>
            </div>
          </div>

          <div v-if="!viewer.currentTimelineItems.value.length" class="timeline empty">{{ timelineEmptyText }}</div>
          <div v-else class="timeline">
            <TimelineNode
              v-for="item in viewer.currentTimelineItems.value"
              :key="`${item.type}-${item.sessionKey || ''}-${item.timestamp || ''}-${item.text || item.kind || ''}`"
              :item="item"
              :expanded-sessions="viewer.expandedSessions"
              :new-message-keys="viewer.newMessageKeys.value"
              :new-subsession-keys="viewer.newSubsessionKeys.value"
              @toggle-session="viewer.toggleExpandedSession"
              @open-tool="viewer.openTool"
            />
          </div>
        </section>
      </section>

      <section class="panel search-panel">
        <h3>全文搜索结果</h3>
        <SearchResults
          :results="viewer.searchResults.value"
          :searched="viewer.searchPerformed.value"
          :loading="viewer.searchLoading.value"
          @open="viewer.openSession"
        />
      </section>
    </main>

    <ToolModal :entry="viewer.selectedToolDetail.value" @close="viewer.closeTool" />
  </div>
</template>
