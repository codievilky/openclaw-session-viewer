const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { marked } = require('marked');
const { JSDOM } = require('jsdom');

const app = express();
const PORT = process.env.PORT || 3847;
const DEFAULT_SESSIONS_ROOT = path.join(os.homedir(), '.openclaw', 'agents');

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
app.use(express.static(path.join(__dirname, 'public')));

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

function stripSenderMetadataBlock(text) {
  const marker = 'Sender (untrusted metadata):';
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

function cleanDisplayText(text) {
  let output = String(text || '');
  output = stripEnvelopePrefix(output);
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
      }];
    }
    if (item.type === 'toolResult') {
      return [{
        type: 'toolResult',
        name: item.name || item.toolName || 'tool',
        title: item.name || item.toolName || 'tool',
        summary: summarizeJson(item.result || item.output || item.content || ''),
        timestamp: item.timestamp || fallbackTimestamp || null,
        arguments: pickToolArguments(item),
        rawArguments: safeStringify(pickToolArguments(item), 2),
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
    return [{
      type: 'toolResult',
      name: message.name || message.toolName || 'tool',
      title: message.name || message.toolName || 'tool',
      summary: summarizeJson(message.result || message.output || message.content || message.text || ''),
      timestamp: message.timestamp || null,
      arguments: pickToolArguments(message),
      rawArguments: safeStringify(pickToolArguments(message), 2),
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
  const text = getTextContent(msg.content).trim();
  const toolEntries = getToolEntriesFromMessage(msg);
  const hasVisibleText = Boolean(text);
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
  return DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
  });
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

function isMainSession(row) {
  if (!row) return false;
  return !row.spawnedBy;
}

function loadRegistry() {
  const rows = [];

  for (const { agent, sessionsDir } of walkSessionDirs()) {
    const sessionsJson = safeReadJson(path.join(sessionsDir, 'sessions.json')) || {};
    const fileEntries = fs.readdirSync(sessionsDir).filter((name) => name.endsWith('.jsonl'));

    const sessionMap = new Map();
    const seenSessionIds = new Set();

    for (const [sessionKey, meta] of Object.entries(sessionsJson)) {
      const filePath = meta.sessionFile || path.join(sessionsDir, `${meta.sessionId}.jsonl`);
      sessionMap.set(meta.sessionId, { sessionKey, meta, filePath });
    }

    for (const fileName of fileEntries) {
      const sessionId = fileName.replace(/\.jsonl$/, '');
      seenSessionIds.add(sessionId);
      const reg = sessionMap.get(sessionId);
      const filePath = path.join(sessionsDir, fileName);
      const events = parseJsonl(filePath);
      const summary = summarizeEvents(events);
      const meta = reg?.meta || {};
      const sessionKey = reg?.sessionKey || `agent:${agent}:session:${sessionId}`;
      rows.push({
        agent,
        sessionId,
        sessionKey,
        filePath,
        label: meta.label || null,
        spawnedBy: meta.spawnedBy || null,
        spawnDepth: meta.spawnDepth ?? null,
        model: meta.model || null,
        modelProvider: meta.modelProvider || null,
        updatedAt: meta.updatedAt || null,
        channel: meta.channel || meta.lastChannel || null,
        summary,
      });
    }

    for (const [sessionKey, meta] of Object.entries(sessionsJson)) {
      const sessionId = meta.sessionId;
      if (!sessionId || seenSessionIds.has(sessionId)) continue;
      rows.push({
        agent,
        sessionId,
        sessionKey,
        filePath: meta.sessionFile || path.join(sessionsDir, `${sessionId}.jsonl`),
        label: meta.label || null,
        spawnedBy: meta.spawnedBy || null,
        spawnDepth: meta.spawnDepth ?? null,
        model: meta.model || null,
        modelProvider: meta.modelProvider || null,
        updatedAt: meta.updatedAt || null,
        channel: meta.channel || meta.lastChannel || null,
        summary: summarizeEvents([]),
      });
    }
  }

  rows.sort((a, b) => {
    const ta = new Date(a.summary.endAt || a.updatedAt || 0).getTime();
    const tb = new Date(b.summary.endAt || b.updatedAt || 0).getTime();
    return tb - ta;
  });

  return rows;
}

function buildSessionGraph(registry) {
  const bySessionKey = new Map(registry.map((x) => [x.sessionKey, x]));
  return registry.map((row) => ({
    ...row,
    parent: row.spawnedBy ? bySessionKey.get(row.spawnedBy) || null : null,
    children: registry.filter((x) => x.spawnedBy === row.sessionKey)
      .sort((a, b) => compareByTime(
        { timestamp: a.summary.startAt || a.summary.endAt || a.updatedAt },
        { timestamp: b.summary.startAt || b.summary.endAt || b.updatedAt },
      ))
      .map((x) => ({
        sessionKey: x.sessionKey,
        sessionId: x.sessionId,
        agent: x.agent,
        label: x.label,
        endAt: x.summary.endAt,
        startAt: x.summary.startAt,
        visibleMessageCount: x.summary.visibleMessageCount,
      })),
  }));
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
      sessionLabel: session.label || session.sessionId,
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
    sessionLabel: session.label || session.sessionId,
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
    const events = parseJsonl(session.filePath).map((event) => normalizeEvent(event, session));
    return [session.sessionKey, events];
  }));
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

  const children = registry
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
        sessionLabel: child.label || child.sessionId,
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
  const registry = buildSessionGraph(loadRegistry());

  const filtered = registry.filter((row) => {
    if (rootsOnly && !isMainSession(row)) return false;
    if (agent && row.agent !== agent) return false;
    if (!q) return true;
    const hay = [
      row.agent,
      row.sessionId,
      row.sessionKey,
      row.label || '',
      row.spawnedBy || '',
      row.summary.firstUser || '',
      row.summary.lastText || '',
    ].join('\n').toLowerCase();
    return hay.includes(q);
  });

  res.json({ sessions: filtered });
});

app.get('/api/session/:agent/:sessionId', (req, res) => {
  const { agent, sessionId } = req.params;
  const registry = buildSessionGraph(loadRegistry());
  const session = registry.find((x) => x.agent === agent && x.sessionId === sessionId) || null;

  if (!session) {
    return res.status(404).json({ error: 'session not found' });
  }

  const includeSystemEvents = ['1', 'true', 'yes'].includes(String(req.query.includeSystemEvents || '').toLowerCase());
  const rawRegistry = loadRegistry();
  const eventMap = loadAllSessionEvents(rawRegistry);
  const timeline = buildTimelineForSession(session.sessionKey, rawRegistry, eventMap, { includeSystemEvents });

  res.json({ session, timeline });
});

app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').toString().trim().toLowerCase();
  if (!q) return res.json({ results: [] });

  const registry = loadRegistry();
  const results = [];

  for (const row of registry) {
    const events = parseJsonl(row.filePath).map((event) => normalizeEvent(event, row));
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
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`OpenClaw Session Viewer running at http://127.0.0.1:${PORT}`);
});
