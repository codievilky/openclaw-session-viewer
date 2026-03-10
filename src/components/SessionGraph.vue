<script setup>
import { computed } from 'vue';
import { fmtTime } from '../lib/format';

const props = defineProps({
  session: { type: Object, default: null },
});

const emit = defineEmits(['focus-subsession']);

const sortedChildren = computed(() => {
  if (!props.session?.children?.length) return [];
  return [...props.session.children].sort((a, b) => new Date(a.startAt || a.endAt || 0) - new Date(b.startAt || b.endAt || 0));
});
</script>

<template>
  <div v-if="!session" class="graph empty">无链路信息</div>
  <div v-else-if="session.isHistory" class="graph empty">历史会话不显示链路</div>
  <div v-else class="graph">
    <div v-if="session.parent" class="graph-node">
      <div class="badge">Parent</div>
      <div>{{ session.parent.label || session.parent.sessionId }}</div>
      <div class="meta">{{ session.parent.agent }}</div>
    </div>

    <div class="graph-node current">
      <div class="badge">Current</div>
      <div>{{ session.label || session.sessionId }}</div>
      <div class="meta">{{ session.agent }}</div>
    </div>

    <template v-for="child in sortedChildren" :key="child.sessionKey">
      <button
        v-if="!child.missing"
        type="button"
        class="graph-node graph-node-link"
        @click="emit('focus-subsession', child.sessionKey)"
      >
        <div class="badge">Child</div>
        <div>{{ child.label || child.sessionId }}</div>
        <div class="meta">{{ child.agent }} · {{ fmtTime(child.startAt || child.endAt) }} · {{ child.visibleMessageCount || 0 }} 条消息</div>
      </button>

      <div v-else class="graph-node graph-node-missing">
        <div class="badge">Child</div>
        <div>{{ child.label || '历史会话找不到' }}</div>
        <div class="meta">{{ child.agent }} · {{ fmtTime(child.startAt || child.endAt) }}</div>
      </div>
    </template>
  </div>
</template>
