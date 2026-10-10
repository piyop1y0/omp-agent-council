import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import {
  Settings, settings as runtimeSettings, zod, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { resolveModelRoleValue } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import agentCouncilExtension from "../index";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { discoverAgents, TaskTool } from "@oh-my-pi/pi-coding-agent/task";

interface PreparedRun {
  run_id: string;
  chair_agent: string;
  members: Array<{ id: string; agent: string }>;
  tool_mode: "readonly" | "full";
  isolate_members: boolean;
}
interface PreparedPolicies extends PreparedRun {
  chair_model: string;
  members: Array<{ id: string; agent: string; model: string }>;
}
interface RegisteredCouncilTool {
  strict?: boolean;
  parameters: {
    safeParse(value: unknown): { success: boolean };
    toJsonSchema(): Record<string, unknown>;
  };
  execute(
    toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined,
    onUpdate: undefined, context: ExtensionContext,
  ): Promise<{ details: PreparedRun }>;
}

function model(id: string, defaultLevel = ThinkingLevel.Medium) {
  return buildModel({
    id, name: id, provider: "council-test", api: "openai-responses", baseUrl: "https://example.invalid",
    reasoning: true, input: ["text"], contextWindow: 100000, maxTokens: 10000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinking: { mode: "effort", efforts: [ThinkingLevel.Low, ThinkingLevel.Medium, ThinkingLevel.High], defaultLevel },
  });
}

async function fixture(
  overrides: Record<string, unknown> = {},
  extraIds: readonly string[] = [],
  configText?: string,
) {
  const root = await mkdtemp(join(tmpdir(), "agent-council-config-test-"));
  // Native discovery uses profile/project roots, not Settings.init's custom agentDir.
  // Keep the temporary registry in a real ancestor project root.
  const agentDir = join(root, ".omp");
  const cwd = join(root, "project");
  await Promise.all([mkdir(agentDir), mkdir(cwd)]);
  const configPath = join(root, "overlay.yml");
  if (configText !== undefined) await writeFile(configPath, configText);
  resetSettingsForTest();
  const settings = await Settings.init({
    agentDir, cwd, inMemory: true,
    ...(configText === undefined ? {} : { configFiles: [configPath] }),
    overrides: {
      ...(configText === undefined ? { "task.maxRecursionDepth": 2, "defaultThinkingLevel": "high" } : {}),
      modelRoles: { slow: "council-test/worker:low", default: "council-test/chair:medium" }, ...overrides,
    },
  });
  let extensionSettings = runtimeSettings;
  let liveThinkingLevel: ThinkingLevel | undefined = ThinkingLevel.Low;
  let tool: RegisteredCouncilTool | undefined;
  let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  const pi = {
    pi: { get settings() { return extensionSettings; } },
    zod, setLabel() {}, getThinkingLevel: () => liveThinkingLevel,
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) { handlers.set(event, handler); },
    registerTool(definition: unknown) { tool = definition as RegisteredCouncilTool; },
    registerCommand(name: string, options: { handler: typeof command }) {
      if (name === "council-config") command = options.handler;
    },
  } as unknown as ExtensionAPI;
  agentCouncilExtension(pi);
  if (!tool || !command) throw new Error("Council registration failed");
  const models = [model("main"), model("worker"), model("chair"), model("literal:max"), ...extraIds.map(id => model(id))];
  let current = models[0]!;
  const notices: Array<{ message: string; type?: string }> = [];
  const prefills: string[] = [];
  let onResolve: (() => void) | undefined;
  const context = {
    cwd, hasUI: true,
    ui: {
      notify(message: string, type?: string) { notices.push({ message, ...(type === undefined ? {} : { type }) }); },
      async editor(_title: string, prefill?: string) { prefills.push(prefill ?? ""); return undefined; },
    },
    models: {
      current: () => current,
      list: () => models,
      resolve(selector: string) {
        onResolve?.();
        return resolveModelRoleValue(selector, models, { settings: extensionSettings }).model;
      },
    },
  } as unknown as ExtensionCommandContext;
  return {
    root, agentDir, cwd, tool, command, context, notices, prefills,
    settings,
    useSettings(scope: Settings) { extensionSettings = scope; },
    setThinkingLevel(level: ThinkingLevel | undefined) { liveThinkingLevel = level; },
    changeCurrent() { current = models[2]!; },
    onResolve(callback: () => void) { onResolve = callback; },
    async prepare(params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<PreparedPolicies> {
      const { details } = await tool!.execute("prepare", params, signal, undefined, context);
      const { agents } = await discoverAgents(cwd);
      const chair = agents.find(agent => agent.name === details.chair_agent)!;
      const members = details.members.map(member => {
        const definition = agents.find(agent => agent.name === member.agent)!;
        return { ...member, model: definition.model![0]! };
      });
      return { ...details, chair_model: chair.model![0]!, members };
    },
    async transition(event: string) { await handlers.get(event)!({}, context); },
    async nativeTask() {
      return TaskTool.create({
        cwd, settings, effectiveExtensionRoots: () => undefined,
        getPlanModeState: () => undefined, getSessionAgents: () => [],
        getSessionSpawns: () => "*", taskDepth: 0,
      } as never);
    },
    cleanup: async () => {
      await handlers.get("session_shutdown")!({}, context);
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("pins models and effective effort at Main preparation, independently of Chair's live model", async () => {
  const f = await fixture();
  try {
    const run = await f.prepare({ member_models: ["@default", "@slow:xhigh"], chair_model: "council-test/chair:high" });
    expect(run.run_id).toMatch(/^[0-9a-f]{16}$/);
    expect(run.chair_agent).toBe(`agent-council-${run.run_id}-chair`);
    expect(run.chair_model).toBe("council-test/chair:high");
    expect(run.members).toEqual([
      { id: "member-1", agent: `agent-council-${run.run_id}-member-1`, model: "council-test/main:low" },
      { id: "member-2", agent: `agent-council-${run.run_id}-member-2`, model: "council-test/worker:high" },
    ]);
    f.changeCurrent();
    expect(run.members[0]!.model).toBe("council-test/main:low");
    const changed = await f.prepare({ member_models: ["@default:medium", "council-test/worker"] });
    expect(changed.members.map(member => member.model)).toEqual(["council-test/chair:medium", "council-test/worker:medium"]);
    expect(changed.chair_model).toBe("council-test/chair:low");
    expect(await readdir(join(f.agentDir, "agents"))).toHaveLength(6);
    expect(await readdir(f.cwd)).toEqual([]);
  } finally { await f.cleanup(); }
});

test("resolves configured role effort and literal suffix model IDs with native precedence", async () => {
  const f = await fixture();
  try {
    const run = await f.prepare({ member_models: ["@slow", "council-test/literal:max"] });
    expect(run.members.map(member => member.model)).toEqual(["council-test/worker:low", "council-test/literal:max:medium"]);
  } finally { await f.cleanup(); }
});

test("native default aliases and surrounding whitespace still pin Main rather than its configured default role", async () => {
  const f = await fixture();
  try {
    const run = await f.prepare({
      member_models: [" @default:hi ", " @default "], chair_model: "@default:med",
    });
    expect(run.members.map(member => member.model)).toEqual(["council-test/main:high", "council-test/main:low"]);
    expect(run.chair_model).toBe("council-test/main:medium");
  } finally { await f.cleanup(); }
});

test("all native default spellings preserve Main identity and explicit versus inherited effort", async () => {
  const f = await fixture();
  try {
    for (const alias of ["@default", "pi/default", "*", "default"]) {
      const inherited = await f.prepare({ member_models: [alias, `${alias}:inherit`] });
      expect(inherited.members.map(member => member.model)).toEqual(["council-test/main:low", "council-test/main:low"]);
      const explicit = await f.prepare({ member_models: [`${alias}:med`, `${alias}:max`] });
      expect(explicit.members.map(member => member.model)).toEqual(["council-test/main:medium", "council-test/main:high"]);
    }
  } finally { await f.cleanup(); }
});

test("rejects a base model effort pin shadowed by a different literal model at native launch", async () => {
  const f = await fixture({}, ["worker:medium"]);
  try {
    // Native exact/fuzzy literal-ID precedence shadows the canonical spelling
    // and its accepted abbreviations; none can safely pin the base worker.
    await expect(f.prepare({ member_models: ["council-test/worker", "@default"] })).rejects.toThrow("without changing model identity or effort");
    expect(await readdir(f.agentDir)).toEqual([]);
    expect(await readdir(f.cwd)).toEqual([]);
  } finally { await f.cleanup(); }
});


test("merges explicit, project, user and built-in configuration per key", async () => {
  const f = await fixture({ "task.isolation.enabled": true });
  try {
    await writeFile(join(f.agentDir, "agent-council.json"), JSON.stringify({
      member_models: ["@slow:medium", "@default:high"], tool_mode: "full", isolate_members: true,
    }));
    await mkdir(join(f.cwd, ".omp"));
    await writeFile(join(f.cwd, ".omp", "agent-council.json"), JSON.stringify({ chair_model: "council-test/chair:medium", isolate_members: false }));
    const run = await f.prepare();
    expect(run.chair_model).toBe("council-test/chair:medium");
    expect(run.members.map(member => member.model)).toEqual(["council-test/worker:medium", "council-test/main:high"]);
    expect(run.members.map(member => member.agent)).toEqual([1, 2].map(index => `agent-council-${run.run_id}-member-${index}`));
    expect(run.isolate_members).toBe(false);
    const override = await f.prepare({ member_models: ["@default:medium", "@slow:high"], chair_model: "@default", tool_mode: "readonly", isolate_members: true });
    expect(override.chair_model).toBe("council-test/main:low");
    expect(override.members.map(member => member.model)).toEqual(["council-test/main:medium", "council-test/worker:high"]);
    expect(override.tool_mode).toBe("readonly");
    expect(override.isolate_members).toBe(true);
    await rm(join(f.agentDir, "agent-council.json"));
    await rm(join(f.cwd, ".omp", "agent-council.json"));
    const defaults = await f.prepare();
    expect(defaults.members.map(member => member.model)).toEqual(Array(3).fill("council-test/worker:low"));
    expect(defaults.chair_model).toBe("council-test/main:low");
  } finally { await f.cleanup(); }
});

test("rejects invalid selectors/configuration and aborts without preparation filesystem writes", async () => {
  const f = await fixture();
  try {
    for (const params of [
      { member_models: ["@slow", "missing/model"] },
      { chair_model: "missing/model" },
    ]) await expect(f.prepare(params)).rejects.toThrow("Could not resolve");
    const early = new AbortController();
    early.abort(new Error("early abort"));
    await expect(f.prepare({}, early.signal)).rejects.toThrow("early abort");
    const during = new AbortController();
    f.onResolve(() => during.abort(new Error("during resolution")));
    await expect(f.prepare({}, during.signal)).rejects.toThrow("during resolution");
    expect(await readdir(f.agentDir)).toEqual([]);
    expect(await readdir(f.cwd)).toEqual([]);
    await writeFile(join(f.agentDir, "agent-council.json"), '{"chair_thinking_level":"high"}');
    await expect(f.prepare()).rejects.toThrow("unknown key");
    expect(await readdir(f.agentDir)).toEqual(["agent-council.json"]);
    expect(await readdir(f.cwd)).toEqual([]);
  } finally { await f.cleanup(); }
});

test("enforces native recursion and isolation prerequisites without generating definitions", async () => {
  for (const depth of [0, 1]) {
    const f = await fixture({ "task.maxRecursionDepth": depth });
    try {
      await expect(f.prepare()).rejects.toThrow("task.maxRecursionDepth >= 2");
      expect(await readdir(f.agentDir)).toEqual([]);
    } finally { await f.cleanup(); }
  }
  const f = await fixture({ "task.maxRecursionDepth": -1, "task.isolation.enabled": false });
  try {
    await f.prepare();
    await f.transition("session_switch");
    await expect(f.prepare({ isolate_members: true })).rejects.toThrow("task.isolation.enabled: true");
    expect(await readdir(join(f.agentDir, "agents"))).toEqual([]);
  } finally { await f.cleanup(); }
});

test("reads the injected live native settings scope rather than the process singleton", async () => {
  const f = await fixture({ "task.maxRecursionDepth": 1, "task.isolation.enabled": false });
  try {
    const scope = f.settings.overlay({
      "task.maxRecursionDepth": -3,
      "task.isolation.enabled": true,
      defaultThinkingLevel: "medium",
      modelRoles: { slow: "council-test/chair:high" },
    });
    f.useSettings(scope);
    f.setThinkingLevel(undefined);
    const run = await f.prepare({ member_models: ["@default:inherit", "@slow"], isolate_members: true });
    expect(run.members.map(member => member.model)).toEqual(["council-test/main:medium", "council-test/chair:high"]);
    expect(run.chair_model).toBe("council-test/main:medium");
    expect(run.isolate_members).toBe(true);
    expect(lookup("task.maxRecursionDepth")!.get(f.settings)).toBe(1);
    expect(lookup("task.isolation.enabled")!.get(f.settings)).toBe(false);

    lookup("defaultThinkingLevel")!.override(scope, "high");
    const updated = await f.prepare({ member_models: ["@default", "@default:inherit"] });
    expect(updated.members.map(member => member.model)).toEqual(["council-test/main:high", "council-test/main:high"]);
    lookup("task.isolation.enabled")!.override(scope, false);
    await expect(f.prepare({ isolate_members: true })).rejects.toThrow("task.isolation.enabled: true");
    lookup("task.maxRecursionDepth")!.override(scope, 0);
    await expect(f.prepare()).rejects.toThrow("task.maxRecursionDepth >= 2");
    f.useSettings(f.settings.overlay({ "task.maxRecursionDepth": -1, defaultThinkingLevel: "low" }));
    expect((await f.prepare()).chair_model).toBe("council-test/main:low");
  } finally { await f.cleanup(); }
});

test("uses native config overlays and live runtime overrides for preparation and config validation", async () => {
  const f = await fixture({}, [], "defaultThinkingLevel: low\ntask:\n  maxRecursionDepth: 1\n  isolation:\n    enabled: true\n");
  try {
    f.setThinkingLevel(undefined);
    await expect(f.prepare()).rejects.toThrow("task.maxRecursionDepth >= 2");
    lookup("task.maxRecursionDepth")!.override(f.settings, -1);
    const configured = await f.prepare({ isolate_members: true });
    expect(configured.chair_model).toBe("council-test/main:low");
    expect(configured.isolate_members).toBe(true);
    const scope = f.settings.overlay({ modelRoles: { slow: "missing/model" } });
    f.useSettings(scope);
    await f.command('user {"member_models":["@slow","@default"]}', f.context);
    expect(f.notices.at(-1)!.type).toBe("error");
    expect(await readdir(f.agentDir)).toEqual(["agents"]);
    f.useSettings(f.settings);
    await f.command('user {"member_models":["@slow","@default"]}', f.context);
    expect(f.notices.at(-1)!.type).toBe("info");
    expect((await f.prepare()).members.map(member => member.model)).toEqual(["council-test/worker:low", "council-test/main:low"]);
  } finally { await f.cleanup(); }
});

test("config command validates before atomic replacement and cancelled editor preserves saved defaults", async () => {
  const f = await fixture();
  try {
    expect(f.tool.strict).toBe(false);
    expect(f.tool.parameters.safeParse({}).success).toBe(true);
    expect(f.tool.parameters.toJsonSchema().required).toBeUndefined();
    expect(f.tool.parameters.safeParse({ chair_thinking_level: "high" }).success).toBe(false);
    const config = { member_models: ["@slow:low", "@default:medium"], chair_model: "@default:high" };
    await f.command(`user ${JSON.stringify(config)}`, f.context);
    const path = join(f.agentDir, "agent-council.json");
    const saved = await readFile(path, "utf8");
    expect(JSON.parse(saved)).toEqual(config);
    for (const input of [
      'user {"member_models":', 'user {"member_models":["one"]}',
      'user {"chair_model":"missing/model"}', 'user {"member_thinking_levels":["high"]}',
    ]) {
      await f.command(input, f.context);
      expect(f.notices.at(-1)!.type).toBe("error");
      expect(await readFile(path, "utf8")).toBe(saved);
    }
    await f.command("", f.context);
    expect(JSON.parse(f.prefills.at(-1)!)).toEqual(config);
    expect(await readFile(path, "utf8")).toBe(saved);
    await f.command('project {"chair_model":"missing/model"}', f.context);
    expect(await readdir(f.cwd)).toEqual([]);
    await f.command('project {"chair_model":"council-test/chair:medium"}', f.context);
    expect(JSON.parse(await readFile(join(f.cwd, ".omp", "agent-council.json"), "utf8"))).toEqual({ chair_model: "council-test/chair:medium" });
    expect(await readdir(f.agentDir)).toEqual(["agent-council.json"]);
  } finally { await f.cleanup(); }
});

test("preparation refreshes an existing native task consumer and transition cleanup removes only definitions", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.agentDir, "agents"));
    const nativeTask = await f.nativeTask();
    const { details: run } = await f.tool.execute("native-consumer", {}, undefined, undefined, f.context);
    expect(run).not.toHaveProperty("chair_model");
    for (const member of run.members) expect(member).not.toHaveProperty("model");
    for (const name of [run.chair_agent, ...run.members.map(member => member.agent)]) {
      expect(nativeTask.description).toContain(name);
    }
    await f.transition("session_branch");
    for (const name of [run.chair_agent, ...run.members.map(member => member.agent)]) {
      expect(nativeTask.description).not.toContain(name);
    }
    expect(await readdir(join(f.agentDir, "agents"))).toEqual([]);
  } finally { await f.cleanup(); }
});

test("a session transition during resolution prevents persistent registration", async () => {
  const f = await fixture();
  try {
    let transition: Promise<void> | undefined;
    f.onResolve(() => { transition ??= f.transition("session_tree"); });
    await expect(f.prepare()).rejects.toThrow("session changed during preparation");
    await transition;
    expect(await readdir(f.agentDir)).toEqual([]);
  } finally { await f.cleanup(); }
});
