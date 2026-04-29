import path from "node:path";

export const CONTEXT_INJECTION_MODES = ["always", "new-session", "off"];
export const HISTORY_INJECTION_MODES = CONTEXT_INJECTION_MODES;
export const DEFAULT_CONTEXT_TRACKING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_CONTEXT_TRACKING_MAX_ENTRIES = 2048;

export function parseSessionKey(sessionKey) {
  if (!sessionKey.startsWith("agent:")) return null;
  const parts = sessionKey.split(":");
  if (parts.length < 3) return null;

  const rest = parts.slice(2);
  if (rest.length === 1 && rest[0] === "main") {
    return {
      kind: "dm",
      entityId: "main",
    };
  }

  if ((rest[0] === "dm" || rest[0] === "direct") && rest.length >= 2) {
    return {
      kind: "dm",
      entityId: rest.slice(1).join(":"),
    };
  }

  const directIndex = rest.indexOf("direct");
  if (directIndex > 0 && directIndex < rest.length - 1) {
    const [channel, accountId] = parsePrefixParts(rest.slice(0, directIndex));
    return {
      kind: "dm",
      channel,
      accountId,
      entityId: rest.slice(directIndex + 1).join(":"),
    };
  }

  const dmIndex = rest.indexOf("dm");
  if (dmIndex > 0 && dmIndex < rest.length - 1) {
    const [channel, accountId] = parsePrefixParts(rest.slice(0, dmIndex));
    return {
      kind: "dm",
      channel,
      accountId,
      entityId: rest.slice(dmIndex + 1).join(":"),
    };
  }

  const conversationMarker = findConversationMarker(rest);
  if (!conversationMarker) return null;

  const [channel, accountId] = parsePrefixParts(rest.slice(0, conversationMarker.index));
  return {
    kind: "group",
    channel,
    accountId,
    scopeType: conversationMarker.kind,
    entityId: rest.slice(conversationMarker.index + 1).join(":"),
  };
}

export function isLegacyMemoryPath(workspaceDir, filePath) {
  const normalizedTarget = normalizeForComparison(resolveToolPath(workspaceDir, filePath));
  const rootMemoryFiles = [
    normalizeForComparison(path.join(workspaceDir, "MEMORY.md")),
    normalizeForComparison(path.join(workspaceDir, "memory.md")),
  ];
  if (rootMemoryFiles.includes(normalizedTarget)) return true;

  const memoryDir = normalizeForComparison(path.join(workspaceDir, "memory")) + path.sep;
  return normalizedTarget.startsWith(memoryDir) && normalizedTarget.endsWith(".md");
}

export function getRedirectedLegacyMemoryPath(workspaceDir, userMemoryFile, notesDir, filePath) {
  const resolvedPath = resolveToolPath(workspaceDir, filePath);
  const normalizedTarget = normalizeForComparison(resolvedPath);
  const rootMemoryFiles = new Set([
    normalizeForComparison(path.join(workspaceDir, "MEMORY.md")),
    normalizeForComparison(path.join(workspaceDir, "memory.md")),
  ]);

  if (rootMemoryFiles.has(normalizedTarget)) {
    return userMemoryFile;
  }

  const legacyMemoryDir = path.join(workspaceDir, "memory");
  const relativePath = path.relative(legacyMemoryDir, resolvedPath);
  if (!relativePath || relativePath.startsWith("..")) return null;

  const safeRelativePath = relativePath
    .split(path.sep)
    .map((segment) => sanitizeSegment(segment))
    .join(path.sep);
  return path.join(notesDir, safeRelativePath);
}

export function collectStartupWarnings(config) {
  const warnings = [];
  const dmScope = readConfiguredDmScope(config);

  if (dmScope === "main") {
    warnings.push(
      "session.dmScope is set to \"main\". memory-layer will run in single-user fallback mode for DMs, so different DM users will share the same personal memory layer.",
    );
  }

  if (isSessionMemoryHookEnabled(config)) {
    warnings.push(
      "hooks.internal.entries.session-memory is enabled. This can write personal memory back into legacy shared paths and undermine layered memory isolation.",
    );
  }

  return warnings;
}

export function decideLayeredContextInjection(mode, sessionKey, sessionId, injectedTokens, pendingKeys, now = Date.now()) {
  if (mode === "off") {
    return { includeLayeredContext: false, includeRecentHistory: false };
  }

  if (mode === "always") {
    return { includeLayeredContext: true, includeRecentHistory: true };
  }

  const token = getHistoryInjectionToken(sessionKey, sessionId);
  const pending = pendingKeys.get(sessionKey);
  if (pending) {
    pendingKeys.delete(sessionKey);
    touchTrackedEntry(injectedTokens, token, now);
    return {
      includeLayeredContext: true,
      includeRecentHistory: pending.includeRecentHistory === true,
    };
  }

  if (!injectedTokens.has(token)) {
    touchTrackedEntry(injectedTokens, token, now);
    return { includeLayeredContext: true, includeRecentHistory: true };
  }

  touchTrackedEntry(injectedTokens, token, now);
  return { includeLayeredContext: false, includeRecentHistory: false };
}

export function adjustLayeredContextInjectionForPrompt(mode, prompt, injection) {
  if (
    mode === "new-session"
    && injection?.includeLayeredContext
    && looksLikeSyntheticSessionResetPrompt(prompt)
  ) {
    return {
      ...injection,
      includeRecentHistory: false,
    };
  }

  return injection;
}

export function shouldInjectLayeredContext(mode, sessionKey, sessionId, injectedTokens, pendingKeys, now = Date.now()) {
  return decideLayeredContextInjection(
    mode,
    sessionKey,
    sessionId,
    injectedTokens,
    pendingKeys,
    now,
  ).includeLayeredContext;
}

export function markContextInjectionReset(
  sessionKey,
  pendingKeys,
  now = Date.now(),
  options = {},
) {
  const includeRecentHistory = options.includeRecentHistory === true;
  touchTrackedEntry(pendingKeys, sessionKey, {
    seenAt: now,
    includeRecentHistory,
  });
}

export function shouldInjectRecentHistory(mode, sessionKey, sessionId, injectedTokens, pendingKeys) {
  return decideLayeredContextInjection(
    mode,
    sessionKey,
    sessionId,
    injectedTokens,
    pendingKeys,
  ).includeRecentHistory;
}

export function markHistoryInjectionReset(sessionKey, pendingKeys) {
  markContextInjectionReset(sessionKey, pendingKeys);
}

export function pruneContextTrackingState(
  injectedTokens,
  pendingKeys,
  now = Date.now(),
  ttlMs = DEFAULT_CONTEXT_TRACKING_TTL_MS,
  maxEntries = DEFAULT_CONTEXT_TRACKING_MAX_ENTRIES,
) {
  pruneTrackedMap(injectedTokens, now, ttlMs, maxEntries);
  pruneTrackedMap(pendingKeys, now, ttlMs, maxEntries);
}

export function buildSystemGuidance(hasLayeredContext, mode) {
  const lines = [
    "The memory-layer plugin manages layered memory for this session.",
    "The canonical shared-memory file is .memory-layer/shared/memory.md unless sharedFilePath explicitly overrides it.",
    "Do not use the deprecated .memory-layer/shared.md path.",
    "Do not rely on legacy workspace memory files under MEMORY.md or memory/YYYY-MM-DD.md as the source of truth for plugin-managed sessions.",
    "Do not call legacy memory_search or memory_get for plugin-managed sessions. Use the layered memory context when it is present, or read the relevant .memory-layer files directly if absolutely necessary.",
    "Legacy shared MEMORY.md remains compatibility-only context; new personal memory belongs to the current user's layer.",
    "If the user explicitly says '记住：...' or 'remember: ...', that content is saved to personal memory.",
    "If the user explicitly says '共享记忆：...' or 'remember-shared: ...', that content is saved to shared memory.",
  ];

  if (mode === "off") {
    lines.unshift(
      "Layered memory context injection is disabled for this session. Do not assume shared, personal, notes, or history context is attached.",
    );
  } else if (hasLayeredContext) {
    lines.unshift(
      "A layered memory context block is attached for this turn. Use it as the canonical shared/personal/history recall source.",
    );
  } else {
    lines.unshift(
      "Layered memory context is not attached on every turn. Do not assume shared, personal, notes, or history context is present unless it appears in the conversation.",
    );
  }

  return lines.join("\n");
}

export function sanitizeSharedMemoryForPrompt(content) {
  return sanitizeMemoryForPrompt(content, "shared");
}

export function sanitizePersonalMemoryForPrompt(content) {
  return sanitizeMemoryForPrompt(content, "personal");
}

export function shouldHandleEnabledChannel(enabledChannels, scopeChannel) {
  if (!Array.isArray(enabledChannels) || enabledChannels.length === 0) return true;
  return typeof scopeChannel === "string" && enabledChannels.includes(scopeChannel);
}

export function joinRecentDatedContents(buffers, maxChars) {
  return truncateFromEnd(buffers.join("\n\n"), maxChars);
}

export function looksLikeSyntheticSessionResetPrompt(text) {
  const normalized = typeof text === "string" ? extractUserTextAfterMetadata(text).trim() : "";
  if (!normalized) return false;
  if (looksLikeStandaloneSessionResetCommand(normalized)) return true;

  return (
    (normalized.includes("/new") || normalized.includes("/reset"))
    && /\b(?:run|execute)\s+your\s+session\s+startup\s+sequence\b/i.test(normalized)
    && /\b(?:new|fresh)\s+session\b/i.test(normalized)
  );
}

export function shouldArchiveRecentHistoryTurn(rawUserPrompt) {
  return !looksLikeSyntheticSessionResetPrompt(rawUserPrompt);
}

export function isManualSessionResetEvent(event) {
  const reason = readSessionResetReason(event);
  return reason === "new" || reason === "reset";
}

export function stripInjectedLayeredContext(text) {
  const normalized = typeof text === "string" ? text.trim() : "";
  if (!normalized.startsWith("# Layered Memory Context")) return normalized;

  const extracted = extractUserTextAfterMetadata(normalized);
  if (extracted !== normalized) return extracted;

  return normalized;
}

function parsePrefixParts(parts) {
  if (parts.length === 0) return [undefined, undefined];
  if (parts.length === 1) return [parts[0], undefined];
  return [parts[0], parts.slice(1).join(":")];
}

function findConversationMarker(parts) {
  for (let index = 0; index < parts.length; index += 1) {
    const value = parts[index];
    if (value === "group" || value === "channel") {
      return { kind: value, index };
    }
    if (value === "thread" || value === "topic") {
      return { kind: value, index };
    }
  }
  return null;
}

function normalizeForComparison(value) {
  return path.normalize(value).toLowerCase();
}

function getHistoryInjectionToken(sessionKey, sessionId) {
  return sessionId ? `${sessionKey}::${sessionId}` : sessionKey;
}

function resolveToolPath(workspaceDir, filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(workspaceDir, filePath);
}

function sanitizeMemoryForPrompt(content, kind) {
  if (!content?.trim()) return "";

  let lines = content.replace(/\r\n/g, "\n").split("\n");
  lines = stripLeadingBlankLines(lines);
  lines = stripTopHeading(lines, kind);
  lines = stripLeadingBlankLines(lines);

  if (kind === "personal") {
    lines = stripPlaceholderMetadata(lines);
    lines = stripNamedSections(lines, new Set(["Silent Replies", "Runtime"]));
  }

  lines = lines.filter((line) => !shouldDropMemoryPromptLine(line, kind));
  return compactBlankLines(lines).join("\n").trim();
}

function extractUserTextAfterMetadata(text) {
  const match = text.match(
    /Conversation info \(untrusted metadata\):\n```json[\s\S]*?```\n\nSender \(untrusted metadata\):\n```json[\s\S]*?```\n\n?([\s\S]*)$/,
  );
  return match?.[1]?.trim() ?? text.trim();
}

function looksLikeStandaloneSessionResetCommand(text) {
  return /^\/(?:new|reset)(?:\s+[^\r\n]+)?$/i.test(text.trim());
}

function readSessionResetReason(event) {
  if (!isRecord(event)) return undefined;
  return typeof event.reason === "string" ? event.reason.trim().toLowerCase() : undefined;
}

function truncateFromEnd(value, maxChars) {
  if (maxChars <= 0 || value.length <= maxChars) return value;
  return `...[truncated]\n${value.slice(value.length - maxChars)}`;
}

function stripLeadingBlankLines(lines) {
  const copy = [...lines];
  while (copy.length > 0 && copy[0].trim() === "") copy.shift();
  return copy;
}

function stripTopHeading(lines, kind) {
  if (lines.length === 0) return lines;
  const first = lines[0].trim();
  const patterns = kind === "shared"
    ? [/^#\s*(Shared Memory|共享记忆)\s*$/i]
    : [/^#\s*(Personal Memory|长期记忆)\s*$/i];

  if (patterns.some((pattern) => pattern.test(first))) {
    return lines.slice(1);
  }
  return lines;
}

function stripPlaceholderMetadata(lines) {
  return lines.filter((line) => ![
    /^-\s*Scope:\s*/i,
    /^-\s*Channel:\s*/i,
    /^-\s*Account:\s*/i,
    /^-\s*User Key:\s*/i,
  ].some((pattern) => pattern.test(line.trim())));
}

function stripNamedSections(lines, sectionNames) {
  const next = [];
  let skip = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s+/.test(trimmed)) {
      const sectionName = trimmed.replace(/^##\s+/, "").trim();
      skip = sectionNames.has(sectionName);
      if (skip) continue;
    }
    if (!skip) next.push(line);
  }
  return next;
}

function shouldDropMemoryPromptLine(line, kind) {
  const trimmed = line.trim();
  if (!trimmed) return false;

  if (kind === "shared" && trimmed === "Store team-wide facts and reusable knowledge here.") {
    return true;
  }
  if (kind === "personal" && trimmed === "Store durable facts that should only apply to this user here.") {
    return true;
  }

  return [
    /^The memory-layer plugin manages layered memory for this session\./,
    /^The memory-layer plugin injects three scopes of context:/,
    /^A layered memory context block is attached/,
    /^Layered memory context is not attached on every turn\./,
    /^Layered memory context injection is disabled for this session\./,
    /^The canonical shared-memory file is /,
    /^Do not use the deprecated \.memory-layer\/shared\.md path\./,
    /^Do not rely on legacy workspace memory files under /,
    /^Do not call legacy memory_search or memory_get /,
    /^Legacy shared MEMORY\.md remains compatibility-only context; /,
    /^If the user explicitly says '记住：\.\.\.' or 'remember: \.\.\.', /,
    /^If the user explicitly says '共享记忆：\.\.\.' or 'remember-shared: \.\.\.', /,
    /^For plugin-managed sessions, /,
    /^Runtime:\s*/,
    /^Reasoning:\s*/,
    /^1\.\s+Shared Memory:/,
    /^2\.\s+Personal Memory:/,
    /^3\.\s+Recent History:/,
  ].some((pattern) => pattern.test(trimmed));
}

function compactBlankLines(lines) {
  const next = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" && next[next.length - 1] === "") continue;
    next.push(trimmed === "" ? "" : line);
  }
  while (next.length > 0 && next[0] === "") next.shift();
  while (next.length > 0 && next[next.length - 1] === "") next.pop();
  return next;
}

function touchTrackedEntry(map, key, value) {
  map.delete(key);
  map.set(key, value);
}

function pruneTrackedMap(map, now, ttlMs, maxEntries) {
  const expiresBefore = now - ttlMs;
  for (const [key, entry] of map.entries()) {
    const seenAt = typeof entry === "number" ? entry : entry?.seenAt;
    if (typeof seenAt !== "number" || seenAt < expiresBefore) map.delete(key);
  }

  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

function sanitizeSegment(value) {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, "_").slice(0, 120) || "default";
}

function readConfiguredDmScope(config) {
  if (!isRecord(config)) return undefined;
  const session = isRecord(config.session) ? config.session : null;
  return typeof session?.dmScope === "string" ? session.dmScope : undefined;
}

function isSessionMemoryHookEnabled(config) {
  if (!isRecord(config)) return false;

  const hooks = isRecord(config.hooks) ? config.hooks : null;
  const internal = isRecord(hooks?.internal) ? hooks.internal : null;
  if (internal?.enabled === false) return false;

  const entries = isRecord(internal?.entries) ? internal.entries : null;
  const sessionMemory = isRecord(entries?.["session-memory"]) ? entries["session-memory"] : null;
  if (sessionMemory?.enabled === false) return false;

  return true;
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}
