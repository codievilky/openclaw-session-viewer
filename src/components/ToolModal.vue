<script setup>
import { computed } from 'vue';
import { fmtTime } from '../lib/format';

const props = defineProps({
  entry: { type: Object, default: null },
});

const emit = defineEmits(['close']);

const meta = computed(() => {
  if (!props.entry) return '';
  return `${props.entry.name || 'tool'} · ${fmtTime(props.entry.timestamp)} · ${props.entry.type === 'toolResult' ? '结果' : '调用'}`;
});

const hasArguments = computed(() => Boolean(props.entry?.rawArguments));
const hasResult = computed(() => Boolean(props.entry?.rawResult));
</script>

<template>
  <div v-if="entry" class="modal-backdrop" @click.self="emit('close')">
    <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="toolModalTitle">
      <div class="modal-head">
        <div>
          <h3 id="toolModalTitle">工具详情</h3>
          <p class="modal-meta">{{ meta }}</p>
        </div>
        <button type="button" class="icon-btn" aria-label="关闭" @click="emit('close')">×</button>
      </div>
      <div class="modal-section">
        <div class="modal-label">关键参数</div>
        <div class="modal-summary">{{ entry.summary || '—' }}</div>
      </div>
      <div v-if="hasArguments" class="modal-section">
        <div class="modal-label">Arguments JSON</div>
        <pre class="modal-code">{{ entry.rawArguments }}</pre>
      </div>
      <div v-if="hasResult" class="modal-section">
        <div class="modal-label">返回内容</div>
        <pre class="modal-code">{{ entry.rawResult }}</pre>
      </div>
    </div>
  </div>
</template>
