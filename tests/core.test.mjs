import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  adjustLayeredContextInjectionForPrompt,
  buildSystemGuidance,
  collectStartupWarnings,
  decideLayeredContextInjection,
  DEFAULT_CONTEXT_TRACKING_MAX_ENTRIES,
  DEFAULT_CONTEXT_TRACKING_TTL_MS,
  getRedirectedLegacyMemoryPath,
  isLegacyMemoryPath,
  joinRecentDatedContents,
  looksLikeSyntheticSessionResetPrompt,
  markContextInjectionReset,
  parseSessionKey,
  pruneContextTrackingState,
  sanitizePersonalMemoryForPrompt,
  sanitizeSharedMemoryForPrompt,
  shouldHandleEnabledChannel,
  shouldArchiveRecentHistoryTurn,
  stripInjectedLayeredContext,
} from "../core.mjs";

const workspaceDir = path.resolve("C:/workspace/demo");
const userMemoryFile = path.join(workspaceDir, ".memory-layer", "users", "dingtalk", "default", "alice", "memory.md");
const notesDir = path.join(workspaceDir, ".memory-layer", "users", "dingtalk", "default", "alice", "notes");

test("parseSessionKey treats dmScope=main as single-user DM fallback", () => {
  assert.deepEqual(parseSessionKey("agent:main:main"), {
    kind: "dm",
    entityId: "main",
  });
});

test("isLegacyMemoryPath recognizes workspace-relative legacy paths", () => {
  assert.equal(isLegacyMemoryPath(workspaceDir, "MEMORY.md"), true);
  assert.equal(isLegacyMemoryPath(workspaceDir, "memory/2026-04-28.md"), true);
  assert.equal(isLegacyMemoryPath(workspaceDir, "docs/README.md"), false);
});

test("getRedirectedLegacyMemoryPath rewrites relative legacy paths into layered files", () => {
  assert.equal(
    getRedirectedLegacyMemoryPath(workspaceDir, userMemoryFile, notesDir, "MEMORY.md"),
    userMemoryFile,
  );

  assert.equal(
    getRedirectedLegacyMemoryPath(workspaceDir, userMemoryFile, notesDir, "memory/2026-04-28.md"),
    path.join(notesDir, "2026-04-28.md"),
  );

  assert.equal(
    getRedirectedLegacyMemoryPath(workspaceDir, userMemoryFile, notesDir, "memory/archive/2026-04-28.md"),
    path.join(notesDir, "archive", "2026-04-28.md"),
  );
});

test("collectStartupWarnings reports dmScope main fallback and session-memory conflict", () => {
  const warnings = collectStartupWarnings({
    session: { dmScope: "main" },
    hooks: {
      internal: {
        enabled: true,
        entries: {
          "session-memory": { enabled: true },
        },
      },
    },
  });

  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /single-user fallback mode/i);
  assert.match(warnings[1], /session-memory/i);
});

test("collectStartupWarnings stays quiet for safe config", () => {
  const warnings = collectStartupWarnings({
    session: { dmScope: "per-channel-peer" },
    hooks: {
      internal: {
        enabled: true,
        entries: {
          "session-memory": { enabled: false },
        },
      },
    },
  });

  assert.deepEqual(warnings, []);
});

test("collectStartupWarnings still warns when session-memory hook is not explicitly disabled", () => {
  const warnings = collectStartupWarnings({
    session: { dmScope: "per-channel-peer" },
    hooks: {
      internal: {
        enabled: true,
        entries: {},
      },
    },
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /session-memory/i);
});

test("enabledChannels rejects channel-less DM session keys", () => {
  const scope = parseSessionKey("agent:main:dm:alice");
  assert.deepEqual(scope, { kind: "dm", entityId: "alice" });
  assert.equal(shouldHandleEnabledChannel(["dingtalk"], scope.channel), false);
  assert.equal(shouldHandleEnabledChannel(undefined, scope.channel), true);
});

test("new-session mode injects layered context and history once per session token", () => {
  const injectedTokens = new Map();
  const pendingKeys = new Map();

  assert.deepEqual(
    decideLayeredContextInjection("new-session", "agent:main:dingtalk:dm:alice", "sess-1", injectedTokens, pendingKeys),
    { includeLayeredContext: true, includeRecentHistory: true },
  );
  assert.deepEqual(
    decideLayeredContextInjection("new-session", "agent:main:dingtalk:dm:alice", "sess-1", injectedTokens, pendingKeys),
    { includeLayeredContext: false, includeRecentHistory: false },
  );
  assert.deepEqual(
    decideLayeredContextInjection("new-session", "agent:main:dingtalk:dm:alice", "sess-2", injectedTokens, pendingKeys),
    { includeLayeredContext: true, includeRecentHistory: true },
  );
});

test("manual reset reinjects layered context without bringing history back", () => {
  const injectedTokens = new Map();
  const pendingKeys = new Map();
  const sessionKey = "agent:main:dingtalk:dm:alice";

  assert.deepEqual(
    decideLayeredContextInjection("new-session", sessionKey, undefined, injectedTokens, pendingKeys),
    { includeLayeredContext: true, includeRecentHistory: true },
  );
  assert.deepEqual(
    decideLayeredContextInjection("new-session", sessionKey, undefined, injectedTokens, pendingKeys),
    { includeLayeredContext: false, includeRecentHistory: false },
  );

  markContextInjectionReset(sessionKey, pendingKeys);

  assert.deepEqual(
    decideLayeredContextInjection("new-session", sessionKey, "sess-manual", injectedTokens, pendingKeys),
    { includeLayeredContext: true, includeRecentHistory: false },
  );
});

test("memory save reinjects layered context without history on next turn", () => {
  const injectedTokens = new Map();
  const pendingKeys = new Map();
  const sessionKey = "agent:main:dingtalk:dm:alice";
  const sessionId = "sess-1";

  assert.deepEqual(
    decideLayeredContextInjection("new-session", sessionKey, sessionId, injectedTokens, pendingKeys),
    { includeLayeredContext: true, includeRecentHistory: true },
  );
  assert.deepEqual(
    decideLayeredContextInjection("new-session", sessionKey, sessionId, injectedTokens, pendingKeys),
    { includeLayeredContext: false, includeRecentHistory: false },
  );

  markContextInjectionReset(sessionKey, pendingKeys);

  assert.deepEqual(
    decideLayeredContextInjection("new-session", sessionKey, sessionId, injectedTokens, pendingKeys),
    { includeLayeredContext: true, includeRecentHistory: false },
  );
});

test("synthetic /new prompt suppresses recent history on first prompt build", () => {
  const prompt = [
    "A new session was started via /new or /reset.",
    "Run your Session Startup sequence before answering the user.",
  ].join("\n");

  assert.equal(looksLikeSyntheticSessionResetPrompt(prompt), true);
  assert.deepEqual(
    adjustLayeredContextInjectionForPrompt("new-session", prompt, {
      includeLayeredContext: true,
      includeRecentHistory: true,
    }),
    { includeLayeredContext: true, includeRecentHistory: false },
  );
  assert.deepEqual(
    adjustLayeredContextInjectionForPrompt("always", prompt, {
      includeLayeredContext: true,
      includeRecentHistory: true,
    }),
    { includeLayeredContext: true, includeRecentHistory: true },
  );
});

test("synthetic /new prompt is not archived into recent history", () => {
  const prompt = [
    "A new session was started via /new or /reset.",
    "Run your Session Startup sequence before answering the user.",
  ].join("\n");

  assert.equal(shouldArchiveRecentHistoryTurn(prompt), false);
  assert.equal(shouldArchiveRecentHistoryTurn("你好啊"), true);
});

test("recent dated aggregation truncates from the end to keep newest content", () => {
  const aggregated = joinRecentDatedContents([
    "older-note\nolder-note\nolder-note",
    "latest-note\nlatest-note\nlatest-note",
  ], 35);

  assert.match(aggregated, /\.\.\.\[truncated\]/);
  assert.doesNotMatch(aggregated, /^older-note(?:\nolder-note)*/);
  assert.match(aggregated, /latest-note/);
});

test("stripInjectedLayeredContext preserves user text without expected wrapper", () => {
  const text = [
    "# Layered Memory Context",
    "Shared Memory",
    "This is actually user-authored content.",
  ].join("\n");

  assert.equal(stripInjectedLayeredContext(text), text);
});

test("stripInjectedLayeredContext unwraps user text from expected wrapper", () => {
  const text = [
    "# Layered Memory Context",
    "",
    "Conversation info (untrusted metadata):",
    "```json",
    "{\"channel\":\"dingtalk\"}",
    "```",
    "",
    "Sender (untrusted metadata):",
    "```json",
    "{\"id\":\"alice\"}",
    "```",
    "",
    "真正的用户内容",
  ].join("\n");

  assert.equal(stripInjectedLayeredContext(text), "真正的用户内容");
});

test("pruneContextTrackingState evicts stale and excess tracked entries", () => {
  const now = 1_000_000;
  const injectedTokens = new Map([
    ["old", now - DEFAULT_CONTEXT_TRACKING_TTL_MS - 1],
    ["keep-1", now],
    ["keep-2", now + 1],
  ]);
  const pendingKeys = new Map([
    ["pending-old", now - DEFAULT_CONTEXT_TRACKING_TTL_MS - 1],
    ["pending-keep", now],
  ]);

  pruneContextTrackingState(injectedTokens, pendingKeys, now, DEFAULT_CONTEXT_TRACKING_TTL_MS, 2);

  assert.deepEqual(Array.from(injectedTokens.keys()), ["keep-1", "keep-2"]);
  assert.deepEqual(Array.from(pendingKeys.keys()), ["pending-keep"]);
  assert.equal(injectedTokens.size <= DEFAULT_CONTEXT_TRACKING_MAX_ENTRIES, true);
});

test("buildSystemGuidance does not claim injected context in off mode", () => {
  const guidance = buildSystemGuidance(false, "off");
  assert.match(guidance, /disabled for this session/i);
  assert.doesNotMatch(guidance, /injects three scopes of context/i);
});

test("sanitizeSharedMemoryForPrompt drops default template noise", () => {
  assert.equal(
    sanitizeSharedMemoryForPrompt("# Shared Memory\n\nStore team-wide facts and reusable knowledge here.\n"),
    "",
  );

  assert.equal(
    sanitizeSharedMemoryForPrompt("# 共享记忆\n\n## 团队偏好\n- 称呼格式：都加老师后缀\n"),
    "## 团队偏好\n- 称呼格式：都加老师后缀",
  );
});

test("sanitizePersonalMemoryForPrompt removes runtime and plugin noise", () => {
  const content = [
    "# 长期记忆",
    "",
    "## 用户偏好",
    "- 称呼：Ash 哥",
    "",
    "## Silent Replies",
    "When you have nothing to say, respond with ONLY: NO_REPLY",
    "",
    "## Runtime",
    "Runtime: agent=crabcrush",
    "Reasoning: off",
    "",
    "The memory-layer plugin injects three scopes of context:",
    "1. Shared Memory: facts shared across users of this agent or configured shared file.",
    "2. Personal Memory: facts specific to the current user only.",
    "3. Recent History: recent interaction log for continuity; treat it as less reliable than curated memory.",
    "If the user explicitly says '记住：...' or 'remember: ...', that content is saved to personal memory.",
    "",
    "## Personal Saves - 2026-04-28 15:29:32",
    "",
    "- 每个人的称呼后面，都要加上老师后缀",
  ].join("\n");

  assert.equal(
    sanitizePersonalMemoryForPrompt(content),
    [
      "## 用户偏好",
      "- 称呼：Ash 哥",
      "",
      "## Personal Saves - 2026-04-28 15:29:32",
      "",
      "- 每个人的称呼后面，都要加上老师后缀",
    ].join("\n"),
  );
});
