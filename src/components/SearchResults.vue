<script setup>
import { fmtTime } from '../lib/format';

defineProps({
  results: { type: Array, required: true },
  searched: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
});

const emit = defineEmits(['open']);
</script>

<template>
  <div v-if="loading" class="search-results empty">搜索中…</div>
  <div v-else-if="!searched" class="search-results empty">输入关键词后可跨会话搜索</div>
  <div v-else-if="!results.length" class="search-results empty">没有结果</div>
  <div v-else class="search-results">
    <div v-for="result in results" :key="`${result.sessionKey}-${result.timestamp}-${result.text}`" class="result-item">
      <div><strong>{{ result.label || result.sessionId }}</strong> <span class="badge">{{ result.agent }}</span></div>
      <div class="meta">{{ result.role || 'event' }} · {{ fmtTime(result.timestamp) }}</div>
      <div class="snippet">{{ result.text }}</div>
      <button type="button" class="jump-button" @click="emit('open', result.agent, result.sessionId, result.sessionKey)">打开此会话</button>
    </div>
  </div>
</template>
