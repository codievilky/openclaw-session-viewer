<script setup>
import { computed } from 'vue';
import { fmtTime, getMessageStableKey, getSubsessionStableKey, getSystemDetailStableKey, highlightHtmlText } from '../lib/format';

defineOptions({ name: 'TimelineNode' });

const props = defineProps({
  item: { type: Object, required: true },
  expandedSessions: { type: Object, required: true },
  newMessageKeys: { type: Object, required: true },
  newSubsessionKeys: { type: Object, required: true },
  activeSearchMessageKey: { type: String, default: '' },
  activeSearchQuery: { type: String, default: '' },
});

const emit = defineEmits(['toggle-session', 'open-tool']);

const isSubsessionExpanded = computed(() => props.expandedSessions.has(props.item.sessionKey));
const isNewMessage = computed(() => props.newMessageKeys.has(getMessageStableKey(props.item)));
const isNewSubsession = computed(() => props.newSubsessionKeys.has(getSubsessionStableKey(props.item)));
const messageStableKey = computed(() => getMessageStableKey(props.item));
const isActiveSearchMessage = computed(() => messageStableKey.value && props.activeSearchMessageKey === messageStableKey.value);
const renderedMessageHtml = computed(() => {
  const fallback = '<p>（无文本）</p>';
  const html = props.item.html || fallback;
  if (!isActiveSearchMessage.value || !props.activeSearchQuery) return html;
  return highlightHtmlText(html, props.activeSearchQuery);
});

function handleToggle(event) {
  emit('toggle-session', props.item.sessionKey, event.target.open);
}
</script>

<template>
  <div v-if="item.type === 'subsession'" class="message-row subsession" :class="{ 'is-new': isNewSubsession }" :id="`subsession-wrap-${item.sessionKey}`">
    <details class="subsession-card" :class="{ 'is-new': isNewSubsession }" :data-session-key="item.sessionKey" :open="isSubsessionExpanded" @toggle="handleToggle">
      <summary class="subsession-summary">
        <span>{{ item.sessionLabel || item.agent }} 子会话，共 {{ item.count || 0 }} 条可见消息</span>
        <span class="meta">{{ item.agent }} · {{ fmtTime(item.timestamp) }}</span>
      </summary>
      <div class="subsession-content timeline">
        <TimelineNode
          v-for="child in item.items || []"
          :key="`${child.type}-${child.sessionKey || ''}-${child.timestamp || ''}-${child.text || child.kind || ''}`"
          :item="child"
          :expanded-sessions="expandedSessions"
          :new-message-keys="newMessageKeys"
          :new-subsession-keys="newSubsessionKeys"
          :active-search-message-key="activeSearchMessageKey"
          :active-search-query="activeSearchQuery"
          @toggle-session="(...args) => emit('toggle-session', ...args)"
          @open-tool="(entry) => emit('open-tool', entry)"
        />
        <div v-if="!(item.items || []).length" class="empty">子会话内没有可展示消息</div>
      </div>
    </details>
  </div>

  <div
    v-else-if="item.type === 'message' && (item.displayRole === 'user' || item.displayRole === 'assistant')"
    class="message-row"
    :class="[item.displayRole, { 'is-new': isNewMessage, 'is-search-hit': isActiveSearchMessage }]"
  >
    <article class="bubble" :data-message-key="messageStableKey">
      <div class="message-head">
        <span>{{ item.displayRole === 'user' ? 'User' : 'Assistant' }} · {{ item.sessionLabel || item.agent }}</span>
        <span>{{ fmtTime(item.timestamp) }}</span>
      </div>
      <div class="message-body" v-html="renderedMessageHtml"></div>
    </article>
  </div>

  <div v-else-if="item.type === 'tool-group'" class="system-lane">
    <div class="system-ribbon tool-ribbon">
      <div class="system-ribbon-head">
        <span>工具事件 · {{ item.sessionLabel || item.agent }}</span>
        <span>{{ fmtTime(item.timestamp) }}</span>
      </div>
      <div class="tool-chip-row">
        <button
          v-for="(entry, index) in item.entries || []"
          :key="`${entry.type}-${entry.name}-${index}`"
          type="button"
          class="tool-chip"
          :title="`${entry.type === 'toolResult' ? '结果' : '调用'}: ${entry.title || entry.name || 'tool'}${entry.summary ? `\n${entry.summary}` : ''}`"
          @click="emit('open-tool', { ...entry, _index: index })"
        >
          <span class="tool-chip-icon">{{ entry.type === 'toolResult' ? '◧' : '◩' }}</span>
          <span class="tool-chip-label">{{ entry.name || 'tool' }}</span>
        </button>
      </div>
    </div>
  </div>

  <div v-else-if="item.type === 'system'" class="system-lane">
    <details class="system-ribbon system-detail" :data-system-detail-key="getSystemDetailStableKey(item)">
      <summary class="system-ribbon-head">
        <span>系统事件 · {{ item.sessionLabel || item.agent }}</span>
        <span>{{ fmtTime(item.timestamp) }}</span>
      </summary>
      <div v-if="item.html" class="system-detail-body" v-html="item.html"></div>
      <div v-else class="system-detail-body"><pre>{{ item.text || item.kind || 'event' }}</pre></div>
    </details>
  </div>
</template>
