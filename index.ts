import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  adjustLayeredContextInjectionForPrompt,
  CONTEXT_INJECTION_MODES,
  buildSystemGuidance,
  collectStartupWarnings,
  decideLayeredContextInjection,
  DEFAULT_CONTEXT_TRACKING_MAX_ENTRIES,
  DEFAULT_CONTEXT_TRACKING_TTL_MS,
  getRedirectedLegacyMemoryPath as getRedirectedLegacyMemoryPathCore,
  isLegacyMemoryPath as isLegacyMemoryPathCore,
  isManualSessionResetEvent,
  joinRecentDatedContents,
  looksLikeSyntheticSessionResetPrompt,
  markContextInjectionReset,
  parseSessionKey as parseSessionKeyCore,
  pruneContextTrackingState,
  sanitizePersonalMemoryForPrompt,
  sanitizeSharedMemoryForPrompt,
  shouldHandleEnabledChannel,
  shouldArchiveRecentHistoryTurn,
  stripInjectedLayeredContext as stripInjectedLayeredContextCore,
} from "./core.mjs";

type MemoryLayerConfig = {
  enabledAgents?: string[];
  enabledChannels?: string[];
  includeGroups: boolean;
  baseDir: string;
  sharedFilePath?: string;
  recentHistoryDays: number;
  maxSharedChars: number;
  maxPersonalChars: number;
  maxHistoryChars: number;
  maxTurnChars: number;
  maxStoredSharedChars: number;
  maxStoredPersonalChars: number;
  maxStoredHistoryChars: number;
  autoCreateFiles: boolean;
  allowInlineSaveCommands: boolean;
  contextInjectionMode: "always" | "new-session" | "off";
};

type SessionScope =
  | {
      kind: "dm";
      channel?: string;
      accountId?: string;
      entityId: string;
    }
  | {
      kind: "group";
      channel?: string;
      accountId?: string;
      scopeType: "group" | "channel" | "thread" | "topic";
      entityId: string;
    };

type ScopePaths = {
  agentId: string;
  workspaceDir: string;
  sessionKey: string;
  scope: SessionScope;
  baseDir: string;
  sharedFile: string;
  userDir: string;
  userMemoryFile: string;
  notesDir: string;
  historyDir: string;
  metaFile: string;
};

type AgentHookContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
};

type AgentEndEvent = {
  messages: unknown[];
  success: boolean;
  error?: string;
};

type BeforeResetHookContext = AgentHookContext;
type MessageHookContext = AgentHookContext;

type PendingTurn = {
  userText?: string;
  assistantText?: string;
  updatedAt: number;
};

type PendingContextInjectionState = {
  seenAt: number;
  includeRecentHistory: boolean;
};

const DEFAULT_CONFIG: MemoryLayerConfig = {
  includeGroups: false,
  baseDir: ".memory-layer",
  recentHistoryDays: 2,
  maxSharedChars: 5000,
  maxPersonalChars: 5000,
  maxHistoryChars: 6000,
  maxTurnChars: 2000,
  maxStoredSharedChars: 20000,
  maxStoredPersonalChars: 20000,
  maxStoredHistoryChars: 30000,
  autoCreateFiles: true,
  allowInlineSaveCommands: true,
  contextInjectionMode: "new-session",
};

const pendingTurns = new Map<string, PendingTurn>();
const pendingResetTurns = new Map<string, number>();
const injectedContextTokens = new Map<string, number>();
const pendingContextInjectionKeys = new Map<string, PendingContextInjectionState>();
const fileWriteQueues = new Map<string, Promise<void>>();

export default function register(api: OpenClawPluginApi) {
  const config = normalizeConfig(api.pluginConfig);
  emitStartupDiagnostics(api);

  api.on("before_prompt_build", async (event, ctx) => {
    const scopePaths = resolveScopePaths(api, config, ctx);
    if (!scopePaths) return;

    await ensureScopeFiles(scopePaths, config);
    await enforceManagedFileLimits(scopePaths, config);
    await sanitizeRecentHistoryFiles(scopePaths.historyDir, config);
    const injection = adjustLayeredContextInjectionForPrompt(
      config.contextInjectionMode,
      event.prompt,
      getLayeredContextInjection(config, ctx),
    );
    const prependContext = await buildPromptContext(
      scopePaths,
      config,
      injection.includeLayeredContext,
      injection.includeRecentHistory,
    );
    const systemGuidance = buildSystemGuidance(
      injection.includeLayeredContext,
      config.contextInjectionMode,
    );
    if (!prependContext) {
      return { appendSystemContext: systemGuidance };
    }

    return {
      appendSystemContext: systemGuidance,
      prependContext,
    };
  });

  api.on("message_received", async (event, ctx) => {
    const scopePaths = resolveScopePaths(api, config, ctx as MessageHookContext);
    if (!scopePaths) return;

    const hookMessageText = extractHookMessageText(event);
    if (looksLikeSyntheticSessionResetPrompt(hookMessageText)) {
      markContextInjectionReset(scopePaths.sessionKey, pendingContextInjectionKeys);
      rememberPendingResetTurn(scopePaths.sessionKey);
    }

    const rawUserText = normalizeRawInboundUserText(hookMessageText);
    if (!rawUserText) return;

    rememberPendingTurn(scopePaths.sessionKey, { userText: rawUserText });
  });

  api.on("before_reset", async (event, ctx) => {
    const hookCtx = ctx as BeforeResetHookContext;
    if (!hookCtx.sessionKey) return;
    if (!isManualSessionResetEvent(event)) return;

    markContextInjectionReset(hookCtx.sessionKey, pendingContextInjectionKeys);
    rememberPendingResetTurn(hookCtx.sessionKey);
  });

  api.on("message_sent", async (event, ctx) => {
    const scopePaths = resolveScopePaths(api, config, ctx as MessageHookContext);
    if (!scopePaths) return;

    const assistantText = normalizeAssistantText(extractHookMessageText(event));
    if (!assistantText) return;

    rememberPendingTurn(scopePaths.sessionKey, { assistantText });
  });

  api.on("agent_end", async (event, ctx) => {
    const scopePaths = resolveScopePaths(api, config, ctx);
    if (!scopePaths) return;

    await ensureScopeFiles(scopePaths, config);
    await enforceManagedFileLimits(scopePaths, config);
    await sanitizeRecentHistoryFiles(scopePaths.historyDir, config);

    const pendingTurn = consumePendingTurn(scopePaths.sessionKey);
    const latestUserRoleText = findLatestRoleText(event, "user");
    const rawUserText = pendingTurn?.userText
      ?? normalizeRawInboundUserText(latestUserRoleText);
    const lastUserText = removeInlineCommands(rawUserText);
    const userTextForHistory = lastUserText || rawUserText;
    const lastAssistantText = pendingTurn?.assistantText
      ?? normalizeAssistantText(findLatestRoleText(event, "assistant"));

    if (config.allowInlineSaveCommands) {
      const commands = extractInlineCommands(rawUserText);
      let wroteMemory = false;
      if (commands.personal.length > 0) {
        await appendBulletEntries(
          scopePaths.userMemoryFile,
          "Personal Saves",
          commands.personal,
          config.maxStoredPersonalChars,
        );
        wroteMemory = true;
      }
      if (commands.shared.length > 0) {
        await appendBulletEntries(
          scopePaths.sharedFile,
          "Shared Saves",
          commands.shared,
          config.maxStoredSharedChars,
        );
        wroteMemory = true;
      }
      if (wroteMemory) {
        markContextInjectionReset(scopePaths.sessionKey, pendingContextInjectionKeys);
      }
    }

    if (consumePendingResetTurn(scopePaths.sessionKey)) return;
    if (!shouldArchiveRecentHistoryTurn(latestUserRoleText)) return;
    if (!userTextForHistory && !lastAssistantText) return;

    const historyFile = path.join(scopePaths.historyDir, `${formatLocalDate(new Date())}.md`);
    await appendTurnHistory(historyFile, {
      userText: truncate(userTextForHistory, config.maxTurnChars),
      assistantText: truncate(lastAssistantText, config.maxTurnChars),
      success: event.success,
      error: event.error,
    }, config.maxStoredHistoryChars);
  });

  api.on("before_tool_call", async (event, ctx) => {
    const scopePaths = resolveScopePaths(api, config, ctx);
    if (!scopePaths) return;

    return rewriteLegacyMemoryToolCall(event, scopePaths, config);
  });
}

function normalizeConfig(pluginConfig: Record<string, unknown> | undefined): MemoryLayerConfig {
  const source = pluginConfig ?? {};
  return {
    enabledAgents: readStringArray(source.enabledAgents),
    enabledChannels: readStringArray(source.enabledChannels),
    includeGroups: readBoolean(source.includeGroups, DEFAULT_CONFIG.includeGroups),
    baseDir: readString(source.baseDir, DEFAULT_CONFIG.baseDir),
    sharedFilePath: readOptionalString(source.sharedFilePath),
    recentHistoryDays: readNumber(source.recentHistoryDays, DEFAULT_CONFIG.recentHistoryDays),
    maxSharedChars: readNumber(source.maxSharedChars, DEFAULT_CONFIG.maxSharedChars),
    maxPersonalChars: readNumber(source.maxPersonalChars, DEFAULT_CONFIG.maxPersonalChars),
    maxHistoryChars: readNumber(source.maxHistoryChars, DEFAULT_CONFIG.maxHistoryChars),
    maxTurnChars: readNumber(source.maxTurnChars, DEFAULT_CONFIG.maxTurnChars),
    maxStoredSharedChars: readNumber(
      source.maxStoredSharedChars,
      DEFAULT_CONFIG.maxStoredSharedChars,
    ),
    maxStoredPersonalChars: readNumber(
      source.maxStoredPersonalChars,
      DEFAULT_CONFIG.maxStoredPersonalChars,
    ),
    maxStoredHistoryChars: readNumber(
      source.maxStoredHistoryChars,
      DEFAULT_CONFIG.maxStoredHistoryChars,
    ),
    autoCreateFiles: readBoolean(source.autoCreateFiles, DEFAULT_CONFIG.autoCreateFiles),
    allowInlineSaveCommands: readBoolean(
      source.allowInlineSaveCommands,
      DEFAULT_CONFIG.allowInlineSaveCommands,
    ),
    contextInjectionMode: readContextInjectionMode(
      source.contextInjectionMode ?? source.historyInjectionMode,
      DEFAULT_CONFIG.contextInjectionMode,
    ),
  };
}

function resolveScopePaths(
  api: OpenClawPluginApi,
  config: MemoryLayerConfig,
  ctx: AgentHookContext,
): ScopePaths | null {
  if (!ctx.agentId || !ctx.sessionKey) return null;
  if (config.enabledAgents?.length && !config.enabledAgents.includes(ctx.agentId)) return null;

  const workspaceDir = resolveWorkspaceDir(api, ctx);
  if (!workspaceDir) return null;

  const scope = parseSessionKey(ctx.sessionKey);
  if (!scope) return null;
  if (scope.kind === "group" && !config.includeGroups) return null;
  if (!shouldHandleEnabledChannel(config.enabledChannels, scope.channel)) return null;

  const baseDir = path.resolve(workspaceDir, config.baseDir);
  const sharedFile = config.sharedFilePath
    ? resolveFilePath(workspaceDir, config.sharedFilePath)
    : path.join(baseDir, "shared", "memory.md");

  const userDir = path.join(
    baseDir,
    scope.kind === "group" ? "groups" : "users",
    sanitizeSegment(scope.channel ?? "default"),
    sanitizeSegment(scope.accountId ?? "default"),
    makeStableDirName(scope.entityId),
  );

  return {
    agentId: ctx.agentId,
    workspaceDir,
    sessionKey: ctx.sessionKey,
    scope,
    baseDir,
    sharedFile,
    userDir,
    userMemoryFile: path.join(userDir, "memory.md"),
    notesDir: path.join(userDir, "notes"),
    historyDir: path.join(userDir, "history"),
    metaFile: path.join(userDir, "meta.json"),
  };
}

function resolveWorkspaceDir(api: OpenClawPluginApi, ctx: AgentHookContext): string | null {
  if (ctx.workspaceDir) return ctx.workspaceDir;

  const agents = Array.isArray(api.config?.agents?.list) ? api.config.agents.list : [];
  const matchingAgent = agents.find((item) => item && item.id === ctx.agentId);
  const workspace = typeof matchingAgent?.workspace === "string"
    ? matchingAgent.workspace
    : typeof api.config?.agents?.defaults?.workspace === "string"
      ? api.config.agents.defaults.workspace
      : undefined;

  return workspace ? api.resolvePath(workspace) : null;
}

function parseSessionKey(sessionKey: string): SessionScope | null {
  return (parseSessionKeyCore(sessionKey) as SessionScope | null);
}

async function ensureScopeFiles(scopePaths: ScopePaths, config: MemoryLayerConfig): Promise<void> {
  await mkdir(scopePaths.historyDir, { recursive: true });
  await mkdir(scopePaths.notesDir, { recursive: true });
  await mkdir(path.dirname(scopePaths.sharedFile), { recursive: true });

  if (!config.autoCreateFiles) return;

  await ensureFile(
    scopePaths.sharedFile,
    "# Shared Memory\n\nStore team-wide facts and reusable knowledge here.\n",
  );
  await ensureFile(
    scopePaths.userMemoryFile,
    [
      "# Personal Memory",
      "",
      `- Scope: ${scopePaths.scope.kind}`,
      `- Channel: ${scopePaths.scope.channel ?? "unknown"}`,
      `- Account: ${scopePaths.scope.accountId ?? "default"}`,
      `- User Key: ${scopePaths.scope.entityId}`,
      "",
      "Store durable facts that should only apply to this user here.",
      "",
    ].join("\n"),
  );
  await ensureFile(
    scopePaths.metaFile,
    JSON.stringify(
      {
        kind: scopePaths.scope.kind,
        channel: scopePaths.scope.channel ?? null,
        accountId: scopePaths.scope.accountId ?? null,
        entityId: scopePaths.scope.entityId,
        sessionKey: scopePaths.sessionKey,
        workspaceDir: scopePaths.workspaceDir,
      },
      null,
      2,
    ),
  );
}

async function buildPromptContext(
  scopePaths: ScopePaths,
  config: MemoryLayerConfig,
  includeLayeredContext: boolean,
  includeRecentHistory: boolean,
): Promise<string | null> {
  if (!includeLayeredContext) return null;

  const sections: string[] = [];
  const shared = sanitizeSharedMemoryForPrompt(
    await readTail(scopePaths.sharedFile, config.maxSharedChars),
  );
  const personal = sanitizePersonalMemoryForPrompt(
    await readTail(scopePaths.userMemoryFile, config.maxPersonalChars),
  );
  const recentNotesLimit = Math.floor(config.maxHistoryChars / 2);
  const recentHistoryLimit = config.maxHistoryChars - recentNotesLimit;
  const notes = await readRecentDatedFiles(
    scopePaths.notesDir,
    config.recentHistoryDays,
    recentNotesLimit,
    { matchDatedPrefixes: true, labelFiles: true },
  );
  const history = includeRecentHistory
    ? await readRecentDatedFiles(
        scopePaths.historyDir,
        config.recentHistoryDays,
        recentHistoryLimit,
        { matchDatedPrefixes: false, labelFiles: false },
      )
    : "";

  if (shared) {
    sections.push(["## Shared Memory", shared].join("\n\n"));
  }
  if (personal) {
    sections.push(["## Personal Memory", personal].join("\n\n"));
  }
  if (notes) {
    sections.push(["## Recent Personal Notes", notes].join("\n\n"));
  }
  if (history) {
    sections.push(["## Recent Personal History", history].join("\n\n"));
  }

  if (sections.length === 0) return null;
  return ["# Layered Memory Context", ...sections].join("\n\n");
}

async function readRecentDatedFiles(
  dirPath: string,
  days: number,
  maxChars: number,
  options?: { matchDatedPrefixes?: boolean; labelFiles?: boolean },
): Promise<string> {
  const entries = await safeReadDir(dirPath);
  const recentDateKeys = await getRecentPopulatedDateKeys(
    dirPath,
    entries,
    days,
    options?.matchDatedPrefixes === true,
  );
  const buffers: string[] = [];
  for (const dateKey of recentDateKeys) {
    const fileNames = entries
      .filter((entry) => matchesDatedFile(entry, dateKey, options?.matchDatedPrefixes === true))
      .sort((left, right) => left.localeCompare(right));
    for (const fileName of fileNames) {
      const filePath = path.join(dirPath, fileName);
      const content = await readTail(filePath, maxChars);
      if (!content) continue;
      buffers.push(options?.labelFiles ? `### ${fileName}\n\n${content}` : content);
    }
  }
  return joinRecentDatedContents(buffers, maxChars);
}

async function rewriteLegacyMemoryToolCall(
  event: { toolName: string; params: Record<string, unknown> },
  scopePaths: ScopePaths,
  config: MemoryLayerConfig,
): Promise<{ params?: Record<string, unknown>; block?: boolean; blockReason?: string } | void> {
  if (event.toolName === "memory_search" || event.toolName === "memory_get") {
    return {
      block: true,
      blockReason: `The memory-layer plugin manages recall for this session. Do not use ${event.toolName}; rely on injected layered memory context or read .memory-layer files directly.`,
    };
  }

  const filePath = typeof event.params.path === "string" ? event.params.path : undefined;
  if (!filePath) return;
  if (!isLegacyMemoryPath(scopePaths.workspaceDir, filePath)) return;

  await ensureScopeFiles(scopePaths, config);

  const redirectedPath = getRedirectedLegacyMemoryPath(scopePaths, filePath);
  if (!redirectedPath || redirectedPath === filePath) return;

  await ensureParentDir(redirectedPath);
  if (event.toolName === "read" && config.autoCreateFiles) {
    await ensureFile(redirectedPath, "");
  }

  return {
    params: {
      ...event.params,
      path: redirectedPath,
    },
  };
}

function isLegacyMemoryPath(workspaceDir: string, filePath: string): boolean {
  return isLegacyMemoryPathCore(workspaceDir, filePath);
}

function getRedirectedLegacyMemoryPath(scopePaths: ScopePaths, filePath: string): string | null {
  return getRedirectedLegacyMemoryPathCore(
    scopePaths.workspaceDir,
    scopePaths.userMemoryFile,
    scopePaths.notesDir,
    filePath,
  );
}

function normalizeForComparison(value: string): string {
  return path.normalize(value).toLowerCase();
}

async function appendTurnHistory(
  filePath: string,
  params: { userText: string; assistantText: string; success: boolean; error?: string },
  maxStoredChars: number,
): Promise<void> {
  const lines = [
    `## ${formatTimestamp(new Date())}`,
    "",
    "User:",
    params.userText || "(empty)",
    "",
    "Assistant:",
    params.assistantText || (params.success ? "(empty)" : "(failed)"),
  ];

  if (!params.success && params.error) {
    lines.push("", `Error: ${params.error}`);
  }

  lines.push("", "---", "");
  await appendText(filePath, `${lines.join("\n")}`, {
    maxStoredChars,
    preserveHeader: false,
  });
}

async function appendBulletEntries(
  filePath: string,
  heading: string,
  entries: string[],
  maxStoredChars: number,
): Promise<void> {
  if (entries.length === 0) return;
  const lines = [`## ${heading} - ${formatTimestamp(new Date())}`, ""];
  for (const entry of entries) {
    lines.push(`- ${entry}`);
  }
  lines.push("", "");
  await appendText(filePath, lines.join("\n"), {
    maxStoredChars,
    preserveHeader: true,
  });
}

function extractInlineCommands(text: string): { personal: string[]; shared: string[] } {
  const personal = extractCommandLines(text, [/^记住[:：]\s*(.+)$/gim, /^remember[:：]\s*(.+)$/gim]);
  const shared = extractCommandLines(text, [/^共享记忆[:：]\s*(.+)$/gim, /^remember-shared[:：]\s*(.+)$/gim]);
  return { personal, shared };
}

function extractCommandLines(text: string, patterns: RegExp[]): string[] {
  const values: string[] = [];
  for (const pattern of patterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      const value = match[1]?.trim();
      if (value) values.push(value);
    }
  }
  return values;
}

function removeInlineCommands(text: string): string {
  return text
    .replace(/^记住[:：].*$/gim, "")
    .replace(/^remember[:：].*$/gim, "")
    .replace(/^共享记忆[:：].*$/gim, "")
    .replace(/^remember-shared[:：].*$/gim, "")
    .trim();
}

function normalizeRawInboundUserText(text: string): string {
  const withoutInjectedContext = stripInjectedLayeredContext(text);
  const withoutMetadata = cleanInboundText(withoutInjectedContext);
  const normalized = stripSyntheticSessionPrompts(withoutMetadata);
  return normalized.trim();
}

function normalizeAssistantText(text: string): string {
  return text.replace(/\bNO_REPLY\b/g, "").trim();
}

function findLatestRoleText(event: AgentEndEvent, role: "user" | "assistant"): string {
  for (let index = event.messages.length - 1; index >= 0; index -= 1) {
    const candidate = event.messages[index];
    const message = isRecord(candidate) && isRecord(candidate.message) ? candidate.message : isRecord(candidate) ? candidate : null;
    if (!message || message.role !== role) continue;
    return extractText(message.content);
  }
  return "";
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((item) => extractText(item))
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }
  if (!isRecord(value)) return "";

  if (typeof value.text === "string") return value.text.trim();
  if (typeof value.content === "string") return value.content.trim();
  if (value.type === "text" && typeof value.text === "string") return value.text.trim();
  if ("content" in value) return extractText(value.content);
  return "";
}

function cleanInboundText(text: string): string {
  const extracted = extractUserTextAfterMetadata(text);
  return extracted.trim();
}

function extractHookMessageText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((item) => extractHookMessageText(item))
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }
  if (!isRecord(value)) return "";
  if (typeof value.text === "string") return value.text.trim();
  if (typeof value.content === "string") return value.content.trim();
  if (isRecord(value.message)) return extractHookMessageText(value.message);
  if (Array.isArray(value.content) || isRecord(value.content)) return extractText(value.content);
  return "";
}

function extractUserTextAfterMetadata(text: string): string {
  const match = text.match(
    /Conversation info \(untrusted metadata\):\n```json[\s\S]*?```\n\nSender \(untrusted metadata\):\n```json[\s\S]*?```\n\n?([\s\S]*)$/,
  );
  return match?.[1]?.trim() ?? text.trim();
}

function stripInjectedLayeredContext(text: string): string {
  return stripInjectedLayeredContextCore(text);
}

function stripSyntheticSessionPrompts(text: string): string {
  if (looksLikeSyntheticSessionResetPrompt(text)) {
    return "";
  }
  return text;
}

async function ensureFile(filePath: string, content: string): Promise<void> {
  await ensureParentDir(filePath);
  await withFileWriteLock(filePath, async () => {
    try {
      await stat(filePath);
    } catch {
      await writeFile(filePath, content, "utf8");
    }
  });
}

async function appendText(
  filePath: string,
  content: string,
  options?: { maxStoredChars?: number; preserveHeader?: boolean },
): Promise<void> {
  await ensureParentDir(filePath);
  await withFileWriteLock(filePath, async () => {
    const existing = await safeRead(filePath);
    const next = existing ? `${existing}${existing.endsWith("\n") ? "" : "\n"}${content}` : content;
    await writeFile(
      filePath,
      trimStoredContent(next, options?.maxStoredChars ?? 0, options?.preserveHeader ?? false),
      "utf8",
    );
  });
}

async function readTail(filePath: string, maxChars: number): Promise<string> {
  const content = await safeRead(filePath);
  if (!content) return "";
  return truncateFromEnd(content.trim(), maxChars);
}

async function safeRead(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function safeReadDir(dirPath: string): Promise<string[]> {
  try {
    return await readdir(dirPath);
  } catch {
    return [];
  }
}

function resolveFilePath(workspaceDir: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(workspaceDir, inputPath);
}

function makeStableDirName(raw: string): string {
  const normalized = sanitizeSegment(raw);
  if (normalized === raw && normalized.length <= 80) return normalized;
  const short = normalized.slice(0, 48) || "user";
  const hash = createHash("sha1").update(raw).digest("hex").slice(0, 8);
  return `${short}-${hash}`;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, "_").slice(0, 120) || "default";
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTimestamp(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-") + ` ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

function truncate(value: string, maxChars: number): string {
  if (!value) return "";
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n...[truncated]`;
}

function truncateFromEnd(value: string, maxChars: number): string {
  if (maxChars <= 0 || value.length <= maxChars) return value;
  return `...[truncated]\n${value.slice(value.length - maxChars)}`;
}

function trimStoredContent(value: string, maxChars: number, preserveHeader: boolean): string {
  if (maxChars <= 0 || value.length <= maxChars) return value;
  if (!preserveHeader) return truncateFromEnd(value.trim(), maxChars);

  const normalized = value.trim();
  const firstSectionBreak = normalized.indexOf("\n\n");
  if (firstSectionBreak <= 0) return truncateFromEnd(normalized, maxChars);

  const header = normalized.slice(0, firstSectionBreak).trim();
  const body = normalized.slice(firstSectionBreak + 2).trim();
  const remainingChars = maxChars - header.length - 2;
  if (remainingChars <= 0) return truncateFromEnd(normalized, maxChars);

  return `${header}\n\n${truncateFromEnd(body, remainingChars)}`.trim();
}

function matchesDatedFile(fileName: string, dateKey: string, matchDatedPrefixes: boolean): boolean {
  if (fileName === `${dateKey}.md`) return true;
  if (!matchDatedPrefixes) return false;
  return fileName.startsWith(`${dateKey}-`) && fileName.endsWith(".md");
}

function getRecentDateKeys(
  entries: string[],
  days: number,
  matchDatedPrefixes: boolean,
): string[] {
  if (days <= 0) return [];

  const unique = new Set<string>();
  for (const entry of entries) {
    const dateKey = extractDateKeyFromFileName(entry, matchDatedPrefixes);
    if (dateKey) unique.add(dateKey);
  }

  return Array.from(unique)
    .sort((left, right) => right.localeCompare(left))
    .slice(0, days)
    .sort((left, right) => left.localeCompare(right));
}

async function getRecentPopulatedDateKeys(
  dirPath: string,
  entries: string[],
  days: number,
  matchDatedPrefixes: boolean,
): Promise<string[]> {
  const candidateDateKeys = getRecentDateKeys(entries, Number.MAX_SAFE_INTEGER, matchDatedPrefixes);
  const selected: string[] = [];

  for (const dateKey of candidateDateKeys.slice().reverse()) {
    if (await dateBucketHasContent(dirPath, entries, dateKey, matchDatedPrefixes)) {
      selected.push(dateKey);
      if (selected.length >= days) break;
    }
  }

  return selected.sort((left, right) => left.localeCompare(right));
}

async function dateBucketHasContent(
  dirPath: string,
  entries: string[],
  dateKey: string,
  matchDatedPrefixes: boolean,
): Promise<boolean> {
  const fileNames = entries
    .filter((entry) => matchesDatedFile(entry, dateKey, matchDatedPrefixes))
    .sort((left, right) => left.localeCompare(right));

  for (const fileName of fileNames) {
    const content = await safeRead(path.join(dirPath, fileName));
    if (content.trim()) return true;
  }

  return false;
}

function extractDateKeyFromFileName(
  fileName: string,
  matchDatedPrefixes: boolean,
): string | null {
  const exactMatch = fileName.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
  if (exactMatch) return exactMatch[1];
  if (!matchDatedPrefixes) return null;

  const prefixedMatch = fileName.match(/^(\d{4}-\d{2}-\d{2})-.*\.md$/);
  return prefixedMatch?.[1] ?? null;
}

async function trimFileIfNeeded(filePath: string, maxChars: number): Promise<void> {
  if (maxChars <= 0) return;
  await withFileWriteLock(filePath, async () => {
    const current = await safeRead(filePath);
    if (!current || current.length <= maxChars) return;
    await writeFile(filePath, trimStoredContent(current, maxChars, true), "utf8");
  });
}

async function enforceManagedFileLimits(
  scopePaths: ScopePaths,
  config: MemoryLayerConfig,
): Promise<void> {
  await trimFileIfNeeded(scopePaths.sharedFile, config.maxStoredSharedChars);
  await trimFileIfNeeded(scopePaths.userMemoryFile, config.maxStoredPersonalChars);
}

async function sanitizeRecentHistoryFiles(
  historyDir: string,
  config: MemoryLayerConfig,
): Promise<void> {
  const entries = await safeReadDir(historyDir);
  const recentDateKeys = getRecentDateKeys(entries, config.recentHistoryDays, false);
  for (const dateKey of recentDateKeys) {
    const filePath = path.join(historyDir, `${dateKey}.md`);
    await withFileWriteLock(filePath, async () => {
      const current = await safeRead(filePath);
      if (!current) return;

      const sanitized = sanitizeHistoryContent(current);
      const trimmed = trimStoredContent(sanitized, config.maxStoredHistoryChars, false);
      if (trimmed !== current) {
        await writeFile(filePath, trimmed, "utf8");
      }
    });
  }
}

function sanitizeHistoryContent(content: string): string {
  const sections = content
    .split(/\n---\n/g)
    .map((section) => section.trim())
    .filter(Boolean)
    .filter((section) => !looksLikeInjectedHistoryEntry(section));

  if (sections.length === 0) return "";
  return `${sections.join("\n\n---\n\n")}\n`;
}

function looksLikeInjectedHistoryEntry(section: string): boolean {
  return (
    section.includes("# Layered Memory Context")
    || looksLikeSyntheticSessionResetPrompt(section)
  );
}

function rememberPendingTurn(
  sessionKey: string,
  partial: { userText?: string; assistantText?: string },
): void {
  prunePendingTurns();
  const existing = pendingTurns.get(sessionKey);
  pendingTurns.set(sessionKey, {
    userText: partial.userText ?? existing?.userText,
    assistantText: partial.assistantText ?? existing?.assistantText,
    updatedAt: Date.now(),
  });
}

function consumePendingTurn(sessionKey: string): PendingTurn | undefined {
  const value = pendingTurns.get(sessionKey);
  pendingTurns.delete(sessionKey);
  return value;
}

function prunePendingTurns(): void {
  const expiresBefore = Date.now() - 60 * 60 * 1000;
  for (const [sessionKey, entry] of pendingTurns.entries()) {
    if (entry.updatedAt < expiresBefore) {
      pendingTurns.delete(sessionKey);
    }
  }
}

function rememberPendingResetTurn(sessionKey: string): void {
  prunePendingResetTurns();
  pendingResetTurns.set(sessionKey, Date.now());
}

function consumePendingResetTurn(sessionKey: string): boolean {
  prunePendingResetTurns();
  const exists = pendingResetTurns.has(sessionKey);
  pendingResetTurns.delete(sessionKey);
  return exists;
}

function prunePendingResetTurns(): void {
  const expiresBefore = Date.now() - 60 * 60 * 1000;
  for (const [sessionKey, seenAt] of pendingResetTurns.entries()) {
    if (seenAt < expiresBefore) {
      pendingResetTurns.delete(sessionKey);
    }
  }
}

async function withFileWriteLock<T>(filePath: string, action: () => Promise<T>): Promise<T> {
  const key = normalizeForComparison(filePath);
  const previous = fileWriteQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  fileWriteQueues.set(key, queued);

  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (fileWriteQueues.get(key) === queued) {
      fileWriteQueues.delete(key);
    }
  }
}

async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return items.length > 0 ? items : undefined;
}

function readContextInjectionMode(
  value: unknown,
  fallback: MemoryLayerConfig["contextInjectionMode"],
): MemoryLayerConfig["contextInjectionMode"] {
  return typeof value === "string" && CONTEXT_INJECTION_MODES.includes(value)
    ? value as MemoryLayerConfig["contextInjectionMode"]
    : fallback;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function emitStartupDiagnostics(api: OpenClawPluginApi): void {
  for (const warning of collectStartupWarnings(api.config)) {
    console.warn(`[memory-layer] ${warning}`);
  }
}

function getLayeredContextInjection(
  config: MemoryLayerConfig,
  ctx: AgentHookContext,
): { includeLayeredContext: boolean; includeRecentHistory: boolean } {
  pruneContextTrackingState(
    injectedContextTokens,
    pendingContextInjectionKeys,
    Date.now(),
    DEFAULT_CONTEXT_TRACKING_TTL_MS,
    DEFAULT_CONTEXT_TRACKING_MAX_ENTRIES,
  );

  if (!ctx.sessionKey) {
    return {
      includeLayeredContext: config.contextInjectionMode !== "off",
      includeRecentHistory: config.contextInjectionMode === "always",
    };
  }

  return decideLayeredContextInjection(
    config.contextInjectionMode,
    ctx.sessionKey,
    ctx.sessionId,
    injectedContextTokens,
    pendingContextInjectionKeys,
  );
}
