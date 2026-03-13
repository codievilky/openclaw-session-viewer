export function fmtTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

export function formatClockTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function toLocalDayKey(value) {
  if (!value) return 'unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getTodayDayKey() {
  return toLocalDayKey(new Date());
}

export function formatDayLabel(dayKey) {
  if (!dayKey || dayKey === 'unknown') return '更早';

  const today = new Date();
  const todayKey = toLocalDayKey(today);
  if (dayKey === todayKey) return '今天';

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (dayKey === toLocalDayKey(yesterday)) return '昨天';

  const parsed = new Date(`${dayKey}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return dayKey;
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][parsed.getDay()];
  return `${dayKey} ${weekday}`;
}

export function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function getMessageStableKey(item) {
  return [item.sessionKey || '', item.timestamp || '', item.displayRole || '', item.text || ''].join('::');
}

export function getSubsessionStableKey(item) {
  return [item.sessionKey || '', item.timestamp || '', item.count || 0].join('::');
}

export function getSystemDetailStableKey(item) {
  return [item.sessionKey || '', item.timestamp || '', item.kind || '', item.text || ''].join('::');
}

export function highlightHtmlText(html, query, className = 'search-hit') {
  if (!html || !query || typeof document === 'undefined' || typeof NodeFilter === 'undefined') return html;

  const normalizedQuery = String(query || '').trim().toLowerCase();
  if (!normalizedQuery) return html;

  const container = document.createElement('div');
  container.innerHTML = html;

  const textNodes = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let currentNode = walker.nextNode();
  while (currentNode) {
    if (String(currentNode.nodeValue || '').toLowerCase().includes(normalizedQuery)) {
      textNodes.push(currentNode);
    }
    currentNode = walker.nextNode();
  }

  for (const textNode of textNodes) {
    const source = String(textNode.nodeValue || '');
    const lowerSource = source.toLowerCase();
    const fragment = document.createDocumentFragment();
    let cursor = 0;

    while (cursor < source.length) {
      const hitIndex = lowerSource.indexOf(normalizedQuery, cursor);
      if (hitIndex < 0) {
        fragment.append(document.createTextNode(source.slice(cursor)));
        break;
      }

      if (hitIndex > cursor) {
        fragment.append(document.createTextNode(source.slice(cursor, hitIndex)));
      }

      const mark = document.createElement('mark');
      mark.className = className;
      mark.textContent = source.slice(hitIndex, hitIndex + normalizedQuery.length);
      fragment.append(mark);
      cursor = hitIndex + normalizedQuery.length;
    }

    textNode.parentNode?.replaceChild(fragment, textNode);
  }

  return container.innerHTML;
}

export function isNearBottom(threshold = 48) {
  const scroller = document.scrollingElement || document.documentElement;
  return scroller.scrollHeight - (scroller.scrollTop + window.innerHeight) <= threshold;
}

export function snapshotScrollState() {
  const scroller = document.scrollingElement || document.documentElement;
  return {
    wasNearBottom: isNearBottom(),
    scrollTop: scroller.scrollTop,
  };
}

export function restoreScrollState({ wasNearBottom, scrollTop = 0 }) {
  const scroller = document.scrollingElement || document.documentElement;
  if (wasNearBottom) {
    window.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' });
    return;
  }
  const nextTop = Math.max(0, scrollTop);
  window.scrollTo({ top: nextTop, behavior: 'auto' });
}
