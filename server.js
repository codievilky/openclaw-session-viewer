const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { marked } = require('marked');
const { JSDOM } = require('jsdom');

const app = express();
const PORT = process.env.PORT || 3847;
const DEFAULT_SESSIONS_ROOT = path.join(os.homedir(), '.openclaw', 'agents');
const CLIENT_DIST_DIR = path.join(__dirname, 'dist');

function resolveSessionsRoot() {
  const configured = (process.env.OPENCLAW_SESSIONS_ROOT || process.env.OPENCLAW_AGENTS_ROOT || '').trim();
  if (!configured) return DEFAULT_SESSIONS_ROOT;
  if (configured.startsWith('~/')) {
    return path.join(os.homedir(), configured.slice(2));
  }
  return path.resolve(configured);
}

const window = new JSDOM('').window;
const DOMPurify = require('dompurify')(window);

marked.setOptions({
  gfm: true,
  breaks: true,
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(CLIENT_DIST_DIR, {
  index: false,
  etag: true,
  maxAge: '1y',
  immutable: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  },
}));

const sessionFileCache = new Map();

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function parseJsonl(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { type: 'parse_error', raw: line };
        }
      });
  } catch {
    return [];
  }
}

function getFirstMessageTimestamp(events) {
  for (const event of events || []) {
    if (event?.type !== 'message' || !event.message) continue;
    return event.timestamp || event.message.timestamp || null;
  }
  return null;
}

function getContentText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      if (item.type === 'text') return String(item.text || '');
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function safeParseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getAgentIdFromSessionKey(sessionKey = '') {
  const match = String(sessionKey || '').match(/^agent:([^:]+):/);
  return match ? match[1] : null;
}

function extractChildCompletionRecords(events) {
  const records = [];

  for (const event of events || []) {
    if (event?.type !== 'message' || !event.message) continue;
    const message = event.message;
    const text = getContentText(message.content);
    if (!text.includes('[Internal task completion event]')) continue;

    const sessionIdMatch = text.match(/\nsession_id:\s*([^\n]+)/);
    const sessionKeyMatch = text.match(/\nsession_key:\s*([^\n]+)/);
    const sessionId = sessionIdMatch ? sessionIdMatch[1].trim() : null;
    const childSessionKey = sessionKeyMatch ? sessionKeyMatch[1].trim() : null;
    if (!sessionId && !childSessionKey) continue;

    records.push({
      timestamp: event.timestamp || message.timestamp || null,
      sessionId,
      childSessionKey,
      agentId: getAgentIdFromSessionKey(childSessionKey),
    });
  }

  return records;
}

function extractSessionsSpawnRecords(events) {
  const records = [];

  for (const event of events || []) {
    if (event?.type !== 'message' || !event.message) continue;
    const message = event.message;
    const toolName = message.toolName || message.name || '';
    if (String(message.role || '').toLowerCase() !== 'toolresult' || toolName !== 'sessions_spawn') continue;

    const parsed = safeParseJson(message.details)
      || safeParseJson(getContentText(message.content))
      || null;
    const childSessionKey = parsed?.childSessionKey || message.childSessionKey || null;
    if (!childSessionKey) continue;

    records.push({
      timestamp: event.timestamp || message.timestamp || null,
      childSessionKey,
      agentId: getAgentIdFromSessionKey(childSessionKey),
    });
  }

  return records;
}

function getFileFingerprint(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

function getSessionFileSnapshot(filePath) {
  const fingerprint = getFileFingerprint(filePath);
  if (!fingerprint) {
    return { events: [], summary: summarizeEvents([]) };
  }

  const cached = sessionFileCache.get(filePath);
  if (cached && cached.mtimeMs === fingerprint.mtimeMs && cached.size === fingerprint.size) {
    return cached;
  }

  const events = parseJsonl(filePath);
  const snapshot = {
    mtimeMs: fingerprint.mtimeMs,
    size: fingerprint.size,
    events,
    summary: summarizeEvents(events),
    firstMessageAt: getFirstMessageTimestamp(events),
    spawnRecords: extractSessionsSpawnRecords(events),
    completionRecords: extractChildCompletionRecords(events),
  };
  sessionFileCache.set(filePath, snapshot);
  return snapshot;
}

function walkSessionDirs() {
  const sessionsRoot = resolveSessionsRoot();
  if (!fs.existsSync(sessionsRoot)) return [];
  const agents = fs.readdirSync(sessionsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  return agents.map((agent) => ({
    agent,
    sessionsDir: path.join(sessionsRoot, agent, 'sessions'),
  })).filter((x) => fs.existsSync(x.sessionsDir));
}

function getTextParts(content) {
  if (!Array.isArray(content)) return [];
  return content
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      if (item.type === 'text') {
        const text = String(item.text || '');
        return text ? { type: 'text', text } : null;
      }
      return null;
    })
    .filter(Boolean);
}

function stripEnvelopePrefix(text) {
  let output = String(text || '');

  const bracketPrefixes = [
    /^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?\s+(?:GMT|UTC)[^\]]*\]\s*/i,
    /^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{4}\s+\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:\s+[A-Z][A-Za-z0-9_+:-]*)?\]\s*/i,
    /^\[(?:\d{4}-\d{2}-\d{2}|\d{4}\/\d{2}\/\d{2})\s+\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:\s+(?:GMT|UTC)[^\]]*)?\]\s*/i,
    /^\[(?:\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?)(?:\s+(?:GMT|UTC)[^\]]*)?\]\s*/i,
  ];
  const labelledEnvelopePrefixes = [
    /^\[(?:Subagent Context|Subagent Task)\]:\s*/i,
    /^\[(?:compacted|truncated):[^\]]*\]\s*/i,
  ];

  let changed = true;
  while (changed) {
    changed = false;
    output = output.replace(/^\s+/, '');

    for (const pattern of [...bracketPrefixes, ...labelledEnvelopePrefixes]) {
      if (pattern.test(output)) {
        output = output.replace(pattern, '');
        changed = true;
      }
    }

    if (/^\[[^\]]+\]\s*/.test(output)) {
      const firstLine = output.split(/\r?\n/, 1)[0] || '';
      const bracketChunks = firstLine.match(/^((?:\[[^\]\r\n]+\]\s*){1,6})/);
      if (bracketChunks) {
        const candidate = bracketChunks[1];
        const markers = [
          /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/i,
          /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i,
          /\b(?:GMT|UTC)(?:[+-]\d+)?\b/i,
          /\b\d{4}-\d{2}-\d{2}\b/,
          /\b\d{1,2}:\d{2}(?::\d{2})?\b/,
          /\b(?:Subagent Context|Subagent Task|internal task completion event|inter-session message)\b/i,
        ];
        if (markers.some((pattern) => pattern.test(candidate))) {
          output = output.slice(candidate.length).replace(/^\s+/, '');
          changed = true;
        }
      }
    }
  }

  output = output.replace(/^(?:Subagent Context|Subagent Task):\s*/i, '');
  return output.replace(/^[\s:：\-—]+/, '');
}

function stripMetadataBlock(text, marker) {
  let output = String(text || '');
  while (true) {
    const idx = output.indexOf(marker);
    if (idx === -1) break;
    const before = output.slice(0, idx);
    const rest = output.slice(idx + marker.length);
    const fencedMatch = rest.match(/^\s*```(?:json)?\s*[\r\n]+[\s\S]*?```\s*(?:\n+|$)/);
    const jsonMatch = rest.match(/^\s*\{[\s\S]*?\}\s*(?:\n+|$)/);
    const match = fencedMatch || jsonMatch;
    if (match) {
      output = `${before}${rest.slice(match[0].length)}`;
      continue;
    }
    output = before.trimEnd();
    break;
  }
  return output;
}

function stripConversationMetadataBlock(text) {
  return stripMetadataBlock(text, 'Conversation info (untrusted metadata):');
}

function stripSenderMetadataBlock(text) {
  return stripMetadataBlock(text, 'Sender (untrusted metadata):');
}

function cleanDisplayText(text) {
  let output = String(text || '');
  output = stripEnvelopePrefix(output);
  output = stripConversationMetadataBlock(output);
  output = stripSenderMetadataBlock(output);
  output = output.replace(/\[\[reply_to_current\]\]/g, '');
  output = output.replace(/\[\[reply_to:[^\]]+\]\]/g, '');
  output = output.replace(/\n{3,}/g, '\n\n').trim();
  return output;
}

function getTextContent(content) {
  return cleanDisplayText(getTextParts(content).map((part) => part.text).join('\n'));
}

function summarizeJson(value, maxLen = 120) {
  if (value == null) return '';
  let text = '';
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

function safeStringify(value, spacing = 2) {
  if (value == null) return '';
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, null, spacing);
  } catch {
    return String(value);
  }
}

function getDisplayValue(value) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    const text = getTextContent(value).trim();
    return text || value;
  }
  return value;
}

function pickToolOutput(item) {
  if (!item || typeof item !== 'object') return null;
  return getDisplayValue(
    item.result
    ?? item.output
    ?? item.response
    ?? item.content
    ?? item.details
    ?? item.text
    ?? null,
  );
}

function getToolResultLabel(item) {
  const output = pickToolOutput(item);
  return safeStringify(output, 2);
}

function describeMessageLifecycle(message) {
  if (!message || typeof message !== 'object') return '';

  const stopReason = String(message.stopReason || '').trim();
  if (stopReason) {
    if (stopReason === 'stop') return '系统处理结束';
    return `系统处理结束（${stopReason}）`;
  }

  const finishReason = String(message.finishReason || '').trim();
  if (finishReason) {
    return finishReason === 'stop'
      ? '系统处理结束'
      : `系统处理结束（${finishReason}）`;
  }

  return '';
}

function pickToolArguments(item) {
  return item.arguments ?? item.args ?? item.input ?? item.params ?? item.parameters ?? null;
}

function getToolEntriesFromContent(content, fallbackTimestamp = null) {
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    if (item.type === 'toolCall') {
      const args = pickToolArguments(item);
      return [{
        type: 'toolCall',
        name: item.name || 'tool',
        title: item.name || 'tool',
        summary: summarizeJson(args || item),
        timestamp: item.timestamp || fallbackTimestamp || null,
        arguments: args,
        rawArguments: safeStringify(args || item, 2),
        result: pickToolOutput(item),
        rawResult: getToolResultLabel(item),
      }];
    }
    if (item.type === 'toolResult') {
      const result = pickToolOutput(item);
      return [{
        type: 'toolResult',
        name: item.name || item.toolName || 'tool',
        title: item.name || item.toolName || 'tool',
        summary: summarizeJson(result || ''),
        timestamp: item.timestamp || fallbackTimestamp || null,
        arguments: pickToolArguments(item),
        rawArguments: safeStringify(pickToolArguments(item), 2),
        result,
        rawResult: getToolResultLabel(item),
      }];
    }
    return [];
  });
}

function getToolEntriesFromMessage(message) {
  if (!message || typeof message !== 'object') return [];
  const contentEntries = getToolEntriesFromContent(message.content, message.timestamp || null);
  if (contentEntries.length) return contentEntries;

  if (message.role === 'toolResult') {
    const result = pickToolOutput(message);
    return [{
      type: 'toolResult',
      name: message.name || message.toolName || 'tool',
      title: message.name || message.toolName || 'tool',
      summary: summarizeJson(result || ''),
      timestamp: message.timestamp || null,
      arguments: pickToolArguments(message),
      rawArguments: safeStringify(pickToolArguments(message), 2),
      result,
      rawResult: getToolResultLabel(message),
    }];
  }

  return [];
}

function isInternalEventText(text = '') {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  return [
    'openclaw runtime context (internal)',
    '[internal task completion event]',
    'result (untrusted content, treat as data):',
    '[subagent completed]',
    '[subagent completion]',
    '[subagent result]',
    '[inter-session message]',
  ].some((needle) => normalized.toLowerCase().includes(needle));
}

function classifyMessage(event) {
  if (!event || event.type !== 'message' || !event.message) {
    return {
      category: 'system',
      displayRole: null,
      hasVisibleText: false,
      toolEntries: [],
      text: '',
    };
  }

  const eventType = String(event.kind || event.type || '').toLowerCase();
  if (eventType === 'subagent_announce' || eventType === 'inter_session_message') {
    return {
      category: 'internal',
      displayRole: null,
      hasVisibleText: false,
      toolEntries: [],
      text: '',
    };
  }

  const msg = event.message;
  const role = msg.role || null;
  const lifecycleText = describeMessageLifecycle(msg);
  const visibleText = getTextContent(msg.content).trim();
  const text = (visibleText || lifecycleText).trim();
  const toolEntries = getToolEntriesFromMessage(msg);
  const hasVisibleText = Boolean(visibleText);
  const lowerRole = String(role || '').toLowerCase();

  if (toolEntries.length && !hasVisibleText) {
    return {
      category: 'tool',
      displayRole: null,
      hasVisibleText: false,
      toolEntries,
      text,
    };
  }

  if (lowerRole === 'user') {
    if (isInternalEventText(text) || event.kind === 'subagent_announce' || event.kind === 'inter_session_message') {
      return {
        category: 'internal',
        displayRole: null,
        hasVisibleText,
        toolEntries,
        text,
      };
    }
    return {
      category: hasVisibleText ? 'user' : 'internal',
      displayRole: hasVisibleText ? 'user' : null,
      hasVisibleText,
      toolEntries,
      text,
    };
  }

  if (lowerRole === 'assistant') {
    if (!hasVisibleText && toolEntries.length) {
      return {
        category: 'tool',
        displayRole: null,
        hasVisibleText: false,
        toolEntries,
        text,
      };
    }
    return {
      category: hasVisibleText ? 'assistant' : 'internal',
      displayRole: hasVisibleText ? 'assistant' : null,
      hasVisibleText,
      toolEntries,
      text,
    };
  }

  if (lowerRole === 'toolresult' || lowerRole === 'tool') {
    return {
      category: 'tool',
      displayRole: null,
      hasVisibleText: false,
      toolEntries,
      text,
    };
  }

  return {
    category: hasVisibleText ? 'internal' : (toolEntries.length ? 'tool' : 'system'),
    displayRole: null,
    hasVisibleText,
    toolEntries,
    text,
  };
}

function sanitizeMarkdown(text) {
  const rawHtml = marked.parse(text || '');
  const sanitizedHtml = DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel'],
  });

  if (!sanitizedHtml || !sanitizedHtml.includes('<a')) return sanitizedHtml;

  const document = new JSDOM(sanitizedHtml).window.document;
  for (const anchor of document.querySelectorAll('a[href]')) {
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noopener noreferrer');
  }
  return document.body.innerHTML;
}

function summarizeEvents(events) {
  let firstUser = '';
  let lastText = '';
  let messageCount = 0;
  let visibleMessageCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let startAt = null;
  let endAt = null;

  for (const e of events) {
    const ts = e.timestamp || e?.message?.timestamp || null;
    if (ts && !startAt) startAt = ts;
    if (ts) endAt = ts;

    if (e.type === 'message' && e.message) {
      messageCount += 1;
      const text = getTextContent(e.message.content).trim();
      const classified = classifyMessage(e);

      if (!firstUser && classified.category === 'user' && text) firstUser = text;
      if (classified.category === 'user' || classified.category === 'assistant') {
        if (text) lastText = text;
      }

      if ((classified.category === 'user' || classified.category === 'assistant') && text) {
        visibleMessageCount += 1;
      }

      for (const item of classified.toolEntries) {
        if (item.type === 'toolCall') toolCallCount += 1;
        if (item.type === 'toolResult') toolResultCount += 1;
      }
    }
  }

  return { startAt, endAt, firstUser, lastText, messageCount, visibleMessageCount, toolCallCount, toolResultCount };
}

function stripHistorySuffix(sessionKey = '') {
  return String(sessionKey || '').replace(/::(?:reset|deleted):.+$/, '');
}

function normalizeTimestampValue(value) {
  if (!value) return value;
  if (typeof value !== 'string') return value;
  return value.replace(/T(\d{2})-(\d{2})-(\d{2}(?:\.\d+)?Z)$/, 'T$1:$2:$3');
}

function getRowTimestamp(row, field = 'default') {
  let value = null;

  if (field === 'firstMessage') {
    value = row?.firstMessageAt || row?.summary?.startAt || null;
  } else if (row?.isHistory) {
    value = row?.historySnapshotAt || row?.updatedAt || row?.summary?.endAt || row?.firstMessageAt || row?.summary?.startAt || null;
  } else {
    value = row?.summary?.endAt || row?.updatedAt || row?.firstMessageAt || row?.summary?.startAt || row?.historySnapshotAt || null;
  }

  const timestamp = new Date(normalizeTimestampValue(value) || 0).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function getMissingHistoryChild(sessionKey, timestamp, childSessionKey) {
  return {
    missing: true,
    sessionKey: childSessionKey || `missing:${sessionKey}:${timestamp || 'unknown'}`,
    agent: getAgentIdFromSessionKey(childSessionKey) || 'subagent',
    label: '历史会话找不到',
    startAt: timestamp || null,
    endAt: timestamp || null,
    visibleMessageCount: 0,
  };
}

function inferHistoryParentLinks(rows) {
  const bySessionKey = new Map(rows.map((row) => [row.sessionKey, row]));
  const byBaseSessionKey = new Map(rows.map((row) => [row.baseSessionKey || row.sessionKey, row]));
  const bySessionId = new Map(rows.map((row) => [row.sessionId, row]));
  const historyCandidatesByAgent = new Map();

  for (const row of rows) {
    row.missingChildren = [];
    if (!row.isHistory || row.agent === 'main' || row.spawnedBy) continue;
    if (!historyCandidatesByAgent.has(row.agent)) historyCandidatesByAgent.set(row.agent, []);
    historyCandidatesByAgent.get(row.agent).push(row);
  }

  for (const list of historyCandidatesByAgent.values()) {
    list.sort((a, b) => getRowTimestamp(a, 'firstMessage') - getRowTimestamp(b, 'firstMessage'));
  }

  const mainRows = rows.filter((row) => row.agent === 'main');

  for (const parent of mainRows) {
    for (const completion of parent.completionRecords || []) {
      const exactBySessionId = completion.sessionId ? bySessionId.get(completion.sessionId) : null;
      const exactBySessionKey = completion.childSessionKey ? (bySessionKey.get(completion.childSessionKey) || byBaseSessionKey.get(completion.childSessionKey) || null) : null;
      const exactChild = exactBySessionId || exactBySessionKey || null;
      if (!exactChild || exactChild.spawnedBy) continue;
      exactChild.spawnedBy = parent.sessionKey;
      exactChild.inferredSpawnedBy = true;
      exactChild.spawnDepth = exactChild.spawnDepth ?? 1;
    }

    for (const record of parent.spawnRecords || []) {
      const exactChild = bySessionKey.get(record.childSessionKey) || byBaseSessionKey.get(record.childSessionKey) || null;
      if (exactChild && !exactChild.spawnedBy) {
        exactChild.spawnedBy = parent.sessionKey;
        exactChild.spawnDepth = exactChild.spawnDepth ?? 1;
        continue;
      }

      if (!parent.isHistory) continue;

      const agentId = record.agentId;
      if (!agentId) {
        parent.missingChildren.push(getMissingHistoryChild(parent.sessionKey, record.timestamp, record.childSessionKey));
        continue;
      }

      const spawnAt = new Date(normalizeTimestampValue(record.timestamp) || 0).getTime();
      const parentSnapshotAt = getRowTimestamp(parent);
      const candidates = (historyCandidatesByAgent.get(agentId) || [])
        .filter((candidate) => !candidate.spawnedBy)
        .filter((candidate) => candidate.historyType === parent.historyType)
        .map((candidate) => ({
          candidate,
          startDelta: Math.abs(getRowTimestamp(candidate, 'firstMessage') - spawnAt),
          snapshotDelta: Math.abs(getRowTimestamp(candidate) - parentSnapshotAt),
        }))
        .filter(({ startDelta, snapshotDelta }) => startDelta <= 2 * 60 * 1000 && snapshotDelta <= 10 * 60 * 1000)
        .sort((a, b) => (a.startDelta - b.startDelta) || (a.snapshotDelta - b.snapshotDelta));

      if (!candidates.length) {
        parent.missingChildren.push(getMissingHistoryChild(parent.sessionKey, record.timestamp, record.childSessionKey));
        continue;
      }

      const matched = candidates[0].candidate;
      matched.spawnedBy = parent.sessionKey;
      matched.inferredSpawnedBy = true;
      matched.spawnDepth = matched.spawnDepth ?? 1;
    }
  }

  return rows;
}

function isMainSession(row) {
  if (!row) return false;
  return !row.spawnedBy;
}

function loadRegistry() {
  const rows = [];

  for (const { agent, sessionsDir } of walkSessionDirs()) {
    const sessionsJson = safeReadJson(path.join(sessionsDir, 'sessions.json')) || {};
    const fileEntries = fs.readdirSync(sessionsDir).filter((name) => (
      name.endsWith('.jsonl') || name.includes('.jsonl.reset.') || name.includes('.jsonl.deleted.')
    ));

    const sessionMap = new Map();
    const seenSessionIds = new Set();

    for (const [sessionKey, meta] of Object.entries(sessionsJson)) {
      const filePath = meta.sessionFile || path.join(sessionsDir, `${meta.sessionId}.jsonl`);
      sessionMap.set(meta.sessionId, { sessionKey, meta, filePath });
    }

    for (const fileName of fileEntries) {
      const historyMatch = fileName.match(/^(.+)\.jsonl\.(reset|deleted)\.(.+)$/);
      const isHistory = Boolean(historyMatch);
      const sessionId = isHistory ? historyMatch[1] : fileName.replace(/\.jsonl$/, '');
      const historyType = isHistory ? historyMatch[2] : null;
      const historySnapshotAt = isHistory ? historyMatch[3] : null;
      if (!isHistory) seenSessionIds.add(sessionId);
      const reg = sessionMap.get(sessionId);
      const filePath = path.join(sessionsDir, fileName);
      const snapshot = getSessionFileSnapshot(filePath);
      const summary = snapshot.summary;
      const meta = reg?.meta || {};
      const sessionKey = isHistory
        ? `${reg?.sessionKey || `agent:${agent}:session:${sessionId}`}::${historyType}:${historySnapshotAt}`
        : (reg?.sessionKey || `agent:${agent}:session:${sessionId}`);
      rows.push({
        agent,
        sessionId,
        sessionKey,
        baseSessionKey: stripHistorySuffix(sessionKey),
        filePath,
        label: meta.label || (isHistory ? `${historyType} (${historySnapshotAt})` : null),
        spawnedBy: meta.spawnedBy || null,
        spawnDepth: meta.spawnDepth ?? null,
        model: meta.model || null,
        modelProvider: meta.modelProvider || null,
        updatedAt: meta.updatedAt || historySnapshotAt || null,
        channel: meta.channel || meta.lastChannel || null,
        summary,
        firstMessageAt: snapshot.firstMessageAt || null,
        spawnRecords: snapshot.spawnRecords || [],
        completionRecords: snapshot.completionRecords || [],
        isHistory,
        historyType,
        historySnapshotAt,
      });
    }

    for (const [sessionKey, meta] of Object.entries(sessionsJson)) {
      const sessionId = meta.sessionId;
      if (!sessionId || seenSessionIds.has(sessionId)) continue;
      rows.push({
        agent,
        sessionId,
        sessionKey,
        baseSessionKey: stripHistorySuffix(sessionKey),
        filePath: meta.sessionFile || path.join(sessionsDir, `${sessionId}.jsonl`),
        label: meta.label || null,
        spawnedBy: meta.spawnedBy || null,
        spawnDepth: meta.spawnDepth ?? null,
        model: meta.model || null,
        modelProvider: meta.modelProvider || null,
        updatedAt: meta.updatedAt || null,
        channel: meta.channel || meta.lastChannel || null,
        summary: summarizeEvents([]),
        firstMessageAt: null,
        spawnRecords: [],
        completionRecords: [],
      });
    }
  }

  rows.sort((a, b) => {
    const ta = new Date(a.summary.endAt || a.updatedAt || 0).getTime();
    const tb = new Date(b.summary.endAt || b.updatedAt || 0).getTime();
    return tb - ta;
  });

  return inferHistoryParentLinks(rows);
}

function buildSessionGraph(registry) {
  const bySessionKey = new Map(registry.map((x) => [x.sessionKey, x]));
  return registry.map((row) => ({
    ...row,
    parent: row.spawnedBy ? bySessionKey.get(row.spawnedBy) || null : null,
    children: row.isHistory ? [] : [
      ...registry.filter((x) => x.spawnedBy === row.sessionKey)
        .sort((a, b) => compareByTime(
          { timestamp: a.summary.startAt || a.summary.endAt || a.updatedAt },
          { timestamp: b.summary.startAt || b.summary.endAt || b.updatedAt },
        ))
        .map((x) => ({
          sessionKey: x.sessionKey,
          sessionId: x.sessionId,
          agent: x.agent,
          label: x.label || x.agent,
          endAt: x.summary.endAt,
          startAt: x.summary.startAt,
          visibleMessageCount: x.summary.visibleMessageCount,
          missing: false,
        })),
      ...((row.missingChildren || []).map((x) => ({
        sessionKey: x.sessionKey,
        sessionId: null,
        agent: x.agent,
        label: x.label,
        endAt: x.endAt,
        startAt: x.startAt,
        visibleMessageCount: 0,
        missing: true,
      }))),
    ],
  }));
}

function getDisplaySessionName(session) {
  if (!session) return '';
  return session.agent || session.label || 'unknown';
}

function normalizeEvent(event, session) {
  const baseTimestamp = event.timestamp || event?.message?.timestamp || null;

  if (event.type !== 'message' || !event.message) {
    return {
      kind: event.type,
      timestamp: baseTimestamp,
      role: null,
      text: '',
      html: '',
      category: 'system',
      displayRole: null,
      isVisibleMessage: false,
      toolEntries: [],
      sessionKey: session.sessionKey,
      sessionLabel: getDisplaySessionName(session),
      agent: session.agent,
      raw: event,
    };
  }

  const classified = classifyMessage(event);

  return {
    kind: event.type,
    timestamp: baseTimestamp,
    role: event.message.role || null,
    displayRole: classified.displayRole,
    text: classified.text,
    html: classified.text && (classified.category === 'user' || classified.category === 'assistant' || classified.category === 'internal')
      ? sanitizeMarkdown(classified.text)
      : '',
    category: classified.category,
    isVisibleMessage: classified.category === 'user' || classified.category === 'assistant',
    toolEntries: classified.toolEntries,
    sessionKey: session.sessionKey,
    sessionLabel: getDisplaySessionName(session),
    agent: session.agent,
    raw: event,
  };
}

function compareByTime(a, b) {
  const ta = new Date(a.timestamp || 0).getTime();
  const tb = new Date(b.timestamp || 0).getTime();
  return ta - tb;
}

function loadAllSessionEvents(registry) {
  return new Map(registry.map((session) => {
    const events = getSessionFileSnapshot(session.filePath).events.map((event) => normalizeEvent(event, session));
    return [session.sessionKey, events];
  }));
}

function getChildrenByParent(registry) {
  const childrenByParent = new Map();

  for (const row of registry) {
    if (!row.spawnedBy) continue;
    if (!childrenByParent.has(row.spawnedBy)) {
      childrenByParent.set(row.spawnedBy, []);
    }
    childrenByParent.get(row.spawnedBy).push(row);
  }

  for (const children of childrenByParent.values()) {
    children.sort((a, b) => compareByTime(
      { timestamp: a.summary.startAt || a.summary.endAt || a.updatedAt },
      { timestamp: b.summary.startAt || b.summary.endAt || b.updatedAt },
    ));
  }

  return childrenByParent;
}

function collectSessionSubtreeKeys(sessionKey, registry) {
  const childrenByParent = getChildrenByParent(registry);
  const collected = new Set();
  const queue = [sessionKey];

  while (queue.length) {
    const currentKey = queue.shift();
    if (!currentKey || collected.has(currentKey)) continue;
    collected.add(currentKey);

    for (const child of childrenByParent.get(currentKey) || []) {
      queue.push(child.sessionKey);
    }
  }

  return collected;
}

function loadSessionEvents(registry, sessionKeys = null) {
  const wantedKeys = sessionKeys ? new Set(sessionKeys) : null;

  return new Map(registry
    .filter((session) => !wantedKeys || wantedKeys.has(session.sessionKey))
    .map((session) => {
      const events = getSessionFileSnapshot(session.filePath).events.map((event) => normalizeEvent(event, session));
      return [session.sessionKey, events];
    }));
}

function buildSearchExcerpt(text, query, radius = 42) {
  const normalizedText = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalizedText) return '';
  const lowerText = normalizedText.toLowerCase();
  const index = lowerText.indexOf(query);
  if (index < 0) return normalizedText.slice(0, 140);

  const start = Math.max(0, index - radius);
  const end = Math.min(normalizedText.length, index + query.length + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < normalizedText.length ? '…' : '';
  return `${prefix}${normalizedText.slice(start, end)}${suffix}`;
}

function findVisibleMessageMatch(session, query) {
  if (!session?.filePath || !query) return null;
  const events = getSessionFileSnapshot(session.filePath).events;

  for (const event of events) {
    const normalized = normalizeEvent(event, session);
    if (!normalized.isVisibleMessage) continue;
    if (!String(normalized.text || '').toLowerCase().includes(query)) continue;

    const roleLabel = normalized.displayRole === 'user' ? 'User' : 'Assistant';
    const sourceLabel = session.label && session.label !== session.agent ? session.label : session.agent;
    const excerpt = buildSearchExcerpt(normalized.text, query);

    return {
      text: normalized.text,
      role: normalized.displayRole,
      timestamp: normalized.timestamp,
      agent: session.agent,
      sessionKey: session.sessionKey,
      sessionLabel: sourceLabel,
      preview: `命中 ${roleLabel} · ${sourceLabel}: ${excerpt}`,
    };
  }

  return null;
}

function findSessionContentMatch(row, query, rawRegistry, { includeSubtree = false } = {}) {
  if (!row || !query) return null;

  const currentSession = rawRegistry.find((session) => session.sessionKey === row.sessionKey) || null;
  const candidateSessions = [];
  if (currentSession) candidateSessions.push(currentSession);

  if (includeSubtree) {
    const subtreeKeys = collectSessionSubtreeKeys(row.sessionKey, rawRegistry);
    for (const session of rawRegistry) {
      if (session.sessionKey === row.sessionKey) continue;
      if (!subtreeKeys.has(session.sessionKey)) continue;
      candidateSessions.push(session);
    }
  }

  for (const session of candidateSessions) {
    const match = findVisibleMessageMatch(session, query);
    if (match) return match;
  }

  return null;
}

function mergeSystemItems(items) {
  const merged = [];

  for (const item of items) {
    const prev = merged[merged.length - 1];
    if (
      item.type === 'tool-group'
      && prev
      && prev.type === 'tool-group'
      && prev.sessionKey === item.sessionKey
    ) {
      prev.entries.push(...item.entries);
      if (item.timestamp && (!prev.timestamp || new Date(item.timestamp).getTime() > new Date(prev.timestamp).getTime())) {
        prev.timestamp = item.timestamp;
      }
      continue;
    }
    merged.push(item);
  }

  return merged;
}

function buildTimelineForSession(sessionKey, registry, eventMap, options = {}, depth = 0) {
  const includeSystemEvents = Boolean(options.includeSystemEvents);
  const bySessionKey = new Map(registry.map((row) => [row.sessionKey, row]));
  const root = bySessionKey.get(sessionKey);
  if (!root) return null;

  const children = root.isHistory ? [] : registry
    .filter((row) => row.spawnedBy === sessionKey)
    .sort((a, b) => compareByTime(
      { timestamp: a.summary.startAt || a.summary.endAt || a.updatedAt },
      { timestamp: b.summary.startAt || b.summary.endAt || b.updatedAt },
    ));

  const rootEvents = (eventMap.get(sessionKey) || []).flatMap((ev) => {
    if (ev.category === 'user' || ev.category === 'assistant') {
      return [{ type: 'message', ...ev }];
    }

    if (!includeSystemEvents) return [];

    if (ev.category === 'tool') {
      return [{
        type: 'tool-group',
        timestamp: ev.timestamp,
        sessionKey: ev.sessionKey,
        sessionLabel: ev.sessionLabel,
        agent: ev.agent,
        entries: ev.toolEntries,
      }];
    }

    if (ev.category === 'internal' || ev.category === 'system') {
      return [{
        type: 'system',
        timestamp: ev.timestamp,
        sessionKey: ev.sessionKey,
        sessionLabel: ev.sessionLabel,
        agent: ev.agent,
        kind: ev.category,
        text: ev.text,
        html: ev.html,
      }];
    }

    return [];
  });

  const items = [
    ...rootEvents,
    ...children.map((child) => {
      const childEvents = buildTimelineForSession(child.sessionKey, registry, eventMap, options, depth + 1);
      return {
        type: 'subsession',
        timestamp: child.summary.startAt || child.summary.endAt || child.updatedAt || null,
        sessionKey: child.sessionKey,
        sessionLabel: child.agent || child.label || 'unknown',
        agent: child.agent,
        count: child.summary.visibleMessageCount ?? ((childEvents?.items || []).filter((x) => x.type === 'message' && (x.displayRole === 'user' || x.displayRole === 'assistant')).length),
        totalEventCount: childEvents?.items?.length || 0,
        items: childEvents?.items || [],
        depth,
      };
    }),
  ];

  items.sort(compareByTime);

  return {
    root,
    items: includeSystemEvents ? mergeSystemItems(items) : items,
  };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, sessionsRoot: resolveSessionsRoot(), defaultSessionsRoot: DEFAULT_SESSIONS_ROOT });
});

app.get('/api/sessions', (req, res) => {
  const q = (req.query.q || '').toString().trim().toLowerCase();
  const agent = (req.query.agent || '').toString().trim();
  const rootsOnly = !['0', 'false', 'no'].includes(String(req.query.rootsOnly || '1').toLowerCase());
  const rawRegistry = loadRegistry();
  const registry = buildSessionGraph(rawRegistry);
  const contentMatchCache = new Map();

  const filtered = registry.flatMap((row) => {
    if (rootsOnly && !isMainSession(row)) return [];
    if (agent && row.agent !== agent) return [];
    if (!q) return [row];
    const hay = [
      row.agent,
      row.sessionId,
      row.sessionKey,
      row.label || '',
      row.spawnedBy || '',
      row.summary.firstUser || '',
      row.summary.lastText || '',
    ].join('\n').toLowerCase();
    if (hay.includes(q)) return [row];

    const cacheKey = `${row.sessionKey}::${rootsOnly ? 'subtree' : 'self'}::${q}`;
    if (!contentMatchCache.has(cacheKey)) {
      contentMatchCache.set(cacheKey, findSessionContentMatch(row, q, rawRegistry, { includeSubtree: rootsOnly }));
    }
    const searchMatch = contentMatchCache.get(cacheKey);
    return searchMatch ? [{ ...row, searchMatch }] : [];
  });

  res.json({ sessions: filtered });
});

app.get('/api/session/:agent/:sessionId', (req, res) => {
  const { agent, sessionId } = req.params;
  const requestedSessionKey = (req.query.sessionKey || '').toString().trim();
  const rawRegistry = loadRegistry();
  const registry = buildSessionGraph(rawRegistry);
  const session = (requestedSessionKey
    ? registry.find((x) => x.sessionKey === requestedSessionKey)
    : registry.find((x) => x.agent === agent && x.sessionId === sessionId)) || null;

  if (!session) {
    return res.status(404).json({ error: 'session not found' });
  }

  const includeSystemEvents = ['1', 'true', 'yes'].includes(String(req.query.includeSystemEvents || '').toLowerCase());
  const subtreeKeys = collectSessionSubtreeKeys(session.sessionKey, rawRegistry);
  const timelineRegistry = rawRegistry.filter((row) => subtreeKeys.has(row.sessionKey));
  const eventMap = loadSessionEvents(timelineRegistry, subtreeKeys);
  const timeline = buildTimelineForSession(session.sessionKey, timelineRegistry, eventMap, { includeSystemEvents });

  res.json({ session, timeline });
});

app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').toString().trim().toLowerCase();
  if (!q) return res.json({ results: [] });

  const registry = loadRegistry();
  const results = [];

  for (const row of registry) {
    const events = getSessionFileSnapshot(row.filePath).events.map((event) => normalizeEvent(event, row));
    for (const ev of events) {
      const text = (ev.text || '').toLowerCase();
      if (!text.includes(q)) continue;
      if (!ev.isVisibleMessage) continue;
      results.push({
        agent: row.agent,
        sessionId: row.sessionId,
        sessionKey: row.sessionKey,
        label: row.label,
        timestamp: ev.timestamp,
        role: ev.displayRole,
        text: ev.text.slice(0, 1200),
      });
      if (results.length >= 500) return res.json({ results });
    }
  }

  res.json({ results });
});

app.use((_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(CLIENT_DIST_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`OpenClaw Session Viewer running at http://127.0.0.1:${PORT}`);
});
