import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, Settings } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
// Exported implementation APIs: ctx.models omits effective effort/routing metadata.
// Retain native pinning behavior; compatibility with these APIs is version-sensitive.
import {
  extractExplicitThinkingSelector,
  formatModelStringWithRouting,
  resolveExplicitModelRole,
  resolveModelRoleValue,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { refreshAgentDiscovery } from "@oh-my-pi/pi-coding-agent/task";
import { RuntimeAgentManager } from "./src/runtime-agents";

function readSetting<T extends "string" | "number" | "boolean">(
  settings: Settings,
  id: string,
  type: T,
): { string: string; number: number; boolean: boolean }[T] {
  const handle = lookup(id);
  if (!handle) {
    throw new Error(
      `Council requires native OMP setting ${JSON.stringify(id)}; check the OMP version and built-in setting registration`,
    );
  }
  const value = handle.get(settings);
  if (typeof value !== type) {
    throw new Error(`Council expected native OMP setting ${JSON.stringify(id)} to resolve to a ${type}`);
  }
  return value as { string: string; number: number; boolean: boolean }[T];
}

type ToolMode = "readonly" | "full";

interface CouncilConfig {
  member_models?: string[];
  chair_model?: string;
  tool_mode?: ToolMode;
  isolate_members?: boolean;
}

interface PrepareAgentsParams {
  member_models?: string[];
  chair_model?: string;
  tool_mode?: ToolMode;
  isolate_members?: boolean;
}


const DEFAULT_MEMBER_COUNT = 3;
const DEFAULT_MEMBER_MODEL = "@slow";
const DEFAULT_CHAIR_MODEL = "@default";
const CONFIG_KEYS: Record<keyof CouncilConfig, true> = {
  member_models: true,
  chair_model: true,
  tool_mode: true,
  isolate_members: true,
};

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function validateConfig(value: unknown, source: string): CouncilConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} must contain a JSON object`);
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(key in CONFIG_KEYS)) {
      throw new Error(`${source} contains unknown key ${JSON.stringify(key)}`);
    }
  }

  const config: CouncilConfig = {};
  if (record.member_models !== undefined) {
    if (
      !Array.isArray(record.member_models) ||
      record.member_models.length < 2 ||
      record.member_models.length > 8
    ) {
      throw new Error(`${source}.member_models must contain between 2 and 8 model selectors`);
    }
    config.member_models = record.member_models.map((entry, index) =>
      asNonEmptyString(entry, `${source}.member_models[${index}]`),
    );
  }
  if (record.chair_model !== undefined) {
    config.chair_model = asNonEmptyString(record.chair_model, `${source}.chair_model`);
  }
  if (record.tool_mode !== undefined) {
    if (record.tool_mode !== "readonly" && record.tool_mode !== "full") {
      throw new Error(`${source}.tool_mode must be "readonly" or "full"`);
    }
    config.tool_mode = record.tool_mode;
  }
  if (record.isolate_members !== undefined) {
    if (typeof record.isolate_members !== "boolean") {
      throw new Error(`${source}.isolate_members must be a boolean`);
    }
    config.isolate_members = record.isolate_members;
  }
  return config;
}

async function readConfigText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

async function readConfigFile(path: string): Promise<CouncilConfig | undefined> {
  const contents = await readConfigText(path);
  if (contents === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${path}: ${message}`, { cause: error });
  }
  return validateConfig(parsed, path);
}

async function loadConfig(cwd: string, agentDir: string): Promise<CouncilConfig> {
  const userPath = join(agentDir, "agent-council.json");
  const projectPath = join(cwd, ".omp", "agent-council.json");
  const [user, project] = await Promise.all([
    readConfigFile(userPath),
    readConfigFile(projectPath),
  ]);
  return { ...user, ...project };
}

function resolveSelector(
  ctx: ExtensionContext,
  settings: Settings,
  selector: string,
  field: string,
  liveThinkingLevel: ThinkingLevel | undefined,
): string {
  // @default is a Council Main-session reference, not the Chair's default role.
  const normalized = selector.trim();
  // Use native role/suffix APIs exported by the bundled extension SDK.
  // Prefixing the bare spelling also recognizes default:<native effort>.
  const isDefault = resolveExplicitModelRole(normalized) === "default" ||
    resolveExplicitModelRole(`@${normalized}`) === "default";
  const defaultThinkingLevel = isDefault ? extractExplicitThinkingSelector(normalized) : undefined;
  const model = isDefault ? ctx.models.current() : ctx.models.resolve(normalized);
  if (!model) {
    throw new Error(`Could not resolve ${field} model selector ${JSON.stringify(selector)}`);
  }
  const concrete = formatModelStringWithRouting(model);
  const resolved = resolveModelRoleValue(
    isDefault
      ? `${concrete}:${defaultThinkingLevel === "inherit"
        ? liveThinkingLevel ?? readSetting(settings, "defaultThinkingLevel", "string")
        : defaultThinkingLevel ?? liveThinkingLevel ?? readSetting(settings, "defaultThinkingLevel", "string")}`
      : normalized,
    [model],
    { settings },
  );
  // Unsuffixed selectors use the native configured default, not Main's live effort.
  const thinkingLevel = resolved.thinkingLevel ??
    resolveModelRoleValue(
      `${concrete}:${model.thinking?.defaultLevel ?? readSetting(settings, "defaultThinkingLevel", "string")}`,
      [model],
      { settings },
    ).thinkingLevel;
  const availableModels = ctx.models.list();
  if (thinkingLevel === undefined) {
    const roundTrip = resolveModelRoleValue(concrete, availableModels, { settings });
    if (roundTrip.model && formatModelStringWithRouting(roundTrip.model) === concrete) return concrete;
  } else {
    // A literal colon-suffixed ID can shadow the canonical effort spelling.
    // Try native, unambiguous abbreviations before declaring the pin impossible.
    for (let length = thinkingLevel.length; length >= 2; length -= 1) {
      const suffix = thinkingLevel.slice(0, length);
      if (extractExplicitThinkingSelector(`@default:${suffix}`) !== thinkingLevel) continue;
      const candidate = `${concrete}:${suffix}`;
      const roundTrip = resolveModelRoleValue(candidate, availableModels, { settings });
      if (
        roundTrip.model &&
        formatModelStringWithRouting(roundTrip.model) === concrete &&
        roundTrip.thinkingLevel === thinkingLevel
      ) {
        return candidate;
      }
    }
  }
  throw new Error(
    `Could not pin ${field} model selector ${JSON.stringify(selector)} without changing model identity or effort: ` +
    `native colon-suffixed model ID ambiguity prevents representing ${JSON.stringify(concrete)} ` +
    `at ${JSON.stringify(thinkingLevel ?? "native default")} effort`,
  );
}

function resolveMemberModels(
  ctx: ExtensionContext,
  settings: Settings,
  callSelectors: readonly string[] | undefined,
  config: CouncilConfig,
  liveThinkingLevel: ThinkingLevel | undefined,
): string[] {
  const selectors =
    callSelectors ??
    config.member_models ??
    Array.from({ length: DEFAULT_MEMBER_COUNT }, () => DEFAULT_MEMBER_MODEL);
  return selectors.map((selector, index) =>
    resolveSelector(ctx, settings, selector, `member ${index + 1}`, liveThinkingLevel),
  );
}


function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(
    typeof signal.reason === "string" ? signal.reason : "Council agent preparation aborted",
  );
}

export default function agentCouncilExtension(pi: ExtensionAPI): void {
  const z = pi.zod;
  pi.setLabel("Agent Council");
  const managers = new Map<string, RuntimeAgentManager>();
  let generation = 0;
  const cleanup = async (_event: unknown, ctx: ExtensionContext): Promise<void> => {
    generation += 1;
    try {
      await Promise.all([...managers.values()].map(manager => manager.cleanupAll()));
    } finally {
      await refreshAgentDiscovery(ctx.cwd);
    }
  };
  pi.on("session_shutdown", cleanup);
  pi.on("session_switch", cleanup);
  pi.on("session_branch", cleanup);
  pi.on("session_tree", cleanup);

  pi.registerCommand("council-config", {
    description: "Edit Council defaults (model:level thinking): /council-config [user|project] [JSON]",
    getArgumentCompletions(prefix) {
      if (prefix.includes(" ")) return null;
      return [
        { label: "user", value: "user", description: "Profile-wide Council defaults" },
        { label: "project", value: "project", description: "Defaults for this project" },
      ].filter(item => item.value.startsWith(prefix.trim()));
    },
    async handler(args, ctx) {
      const settings = pi.pi.settings;
      const input = args.trim();
      let scope: "user" | "project" = "user";
      let inline = input.startsWith("{") ? input : undefined;
      if (input && inline === undefined) {
        const match = /^(user|project)(?:\s+([\s\S]+))?$/.exec(input);
        if (!match) {
          ctx.ui.notify("Usage: /council-config [user|project] [JSON]", "error");
          return;
        }
        scope = match[1] as "user" | "project";
        inline = match[2];
      }

      const userPath = join(settings.getAgentDir(), "agent-council.json");
      const projectPath = join(ctx.cwd, ".omp", "agent-council.json");
      const path = scope === "user" ? userPath : projectPath;
      try {
        const contents =
          inline ??
          (await ctx.ui.editor(
            `Council defaults (${scope}): ${path}`,
            (await readConfigText(path)) ?? "{}\n",
          ));
        if (contents === undefined) return;

        const candidate = validateConfig(JSON.parse(contents) as unknown, path);
        const effective =
          scope === "user"
            ? { ...candidate, ...(await readConfigFile(projectPath)) }
            : { ...(await readConfigFile(userPath)), ...candidate };
        resolveMemberModels(ctx, settings, undefined, effective, pi.getThinkingLevel());
        resolveSelector(ctx, settings, effective.chair_model ?? DEFAULT_CHAIR_MODEL, "chair", pi.getThinkingLevel());

        await mkdir(dirname(path), { recursive: true });
        const temporaryPath = `${path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporaryPath, `${JSON.stringify(candidate, null, 2)}\n`, { flag: "wx" });
          await rename(temporaryPath, path);
        } finally {
          await rm(temporaryPath, { force: true });
        }
        ctx.ui.notify(`Council defaults saved to ${path}`, "info");
      } catch (error) {
        ctx.ui.notify(
          `Council defaults not saved: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.registerTool({
    name: "council_prepare_agents",
    label: "Prepare Council Agents",
    description:
      "Call only from the Council skill. Register temporary Council agents with pinned native model definitions.",
    loadMode: "essential",
    strict: false,
    parameters: z.object({
      member_models: z
        .array(z.string().min(1))
        .min(2)
        .max(8)
        .optional()
        .describe("Optional per-run member selectors (model:level or @role:level), overriding configuration"),
      chair_model: z
        .string()
        .min(1)
        .optional()
        .describe("Optional per-run chair selector (model:level or @role:level), overriding configuration"),
      tool_mode: z
        .enum(["readonly", "full"])
        .optional()
        .describe("Native agent tool mode, overriding configuration; defaults to readonly"),
      isolate_members: z
        .boolean()
        .optional()
        .describe(
          "Isolate council members for this run independently of tool mode, overriding configuration; defaults to false",
        ),
    }).strict(),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const settings = pi.pi.settings;
      const preparationGeneration = generation;
      const prepareParams = params as PrepareAgentsParams;
      throwIfAborted(signal);

      const config = await loadConfig(ctx.cwd, settings.getAgentDir());
      const liveThinkingLevel = pi.getThinkingLevel();
      const memberModels = resolveMemberModels(ctx, settings, prepareParams.member_models, config, liveThinkingLevel);
      const chairModel = resolveSelector(
        ctx, settings, prepareParams.chair_model ?? config.chair_model ?? DEFAULT_CHAIR_MODEL,
        "chair", liveThinkingLevel,
      );
      const toolMode = prepareParams.tool_mode ?? config.tool_mode ?? "readonly";
      const isolateMembers =
        prepareParams.isolate_members ?? config.isolate_members ?? false;
      const maxRecursionDepth = readSetting(settings, "task.maxRecursionDepth", "number");
      if (maxRecursionDepth >= 0 && maxRecursionDepth < 2) {
        throw new Error(
          "Council requires task.maxRecursionDepth >= 2 or an unlimited negative value for Main -> chair -> member spawning",
        );
      }
      if (isolateMembers && !readSetting(settings, "task.isolation.enabled", "boolean")) {
        throw new Error(
          "Council member isolation requires task.isolation.enabled: true",
        );
      }

      throwIfAborted(signal);
      if (preparationGeneration !== generation) throw new Error("Council session changed during preparation");
      const agentDir = settings.getAgentDir();
      let manager = managers.get(agentDir);
      if (!manager) {
        manager = new RuntimeAgentManager({ agentDir });
        managers.set(agentDir, manager);
      }
      const prepared = await manager.prepare({
        memberModels, chairModel, toolMode, isolateMembers,
        ...(signal === undefined ? {} : { signal }),
      });
      try {
        throwIfAborted(signal);
        if (preparationGeneration !== generation) throw new Error("Council session changed during preparation");
        await refreshAgentDiscovery(ctx.cwd);
        throwIfAborted(signal);
        if (preparationGeneration !== generation) throw new Error("Council session changed during preparation");
      } catch (error) {
        await manager.cleanup(prepared.run_id);
        await refreshAgentDiscovery(ctx.cwd);
        throw error;
      }
      const result = {
        run_id: prepared.run_id,
        chair_agent: prepared.chair.agent,
        members: prepared.members.map(({ id, agent }) => ({ id, agent })),
        tool_mode: prepared.tool_mode,
        isolate_members: prepared.isolate_members,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
}
