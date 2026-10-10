import { randomBytes, randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, join } from "node:path";

export type ToolMode = "readonly" | "full";

export interface PreparedCouncilMember {
  id: string;
  agent: string;
  model: string;
}

export interface PreparedCouncilChair {
  id: "chair";
  agent: string;
  model: string;
}

export interface PreparedCouncilAgents {
  run_id: string;
  tool_mode: ToolMode;
  isolate_members: boolean;
  members: PreparedCouncilMember[];
  chair: PreparedCouncilChair;
}

export interface PrepareCouncilAgentsOptions {
  memberModels: readonly string[];
  chairModel: string;
  toolMode: ToolMode;
  isolateMembers: boolean;
  signal?: AbortSignal;
}

export interface RuntimeAgentManagerOptions {
  agentDir: string;
  templateDir?: string;
  pid?: number;
  createRunId?: () => string;
  isProcessAlive?: (pid: number) => boolean;
  testHooks?: RuntimeAgentManagerTestHooks;
}

export interface RuntimeAgentManagerTestHooks {
  writeTemporaryContents?: (handle: FileHandle, contents: string) => Promise<void>;
  beforeClaimedDefinitionUnlink?: (originalPath: string) => void | Promise<void>;
}

interface RuntimeOwnershipMarker {
  version: 1;
  run_id: string;
  pid: number;
  agent: string;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface OwnedAgentFile {
  path: string;
  fileName: string;
  identity: FileIdentity;
  marker: RuntimeOwnershipMarker;
}

interface OwnedRun {
  active: boolean;
  files: OwnedAgentFile[];
}

interface AgentDefinition {
  agent: string;
  fileName: string;
  template: string;
  templateName: "member.md.tmpl" | "chair.md.tmpl";
  description: string;
  model: string;
}

interface InspectedDefinition {
  identity: FileIdentity;
  marker?: RuntimeOwnershipMarker;
}

const MIN_MEMBER_COUNT = 2;
const MAX_MEMBER_COUNT = 8;
const RUNTIME_MARKER_PREFIX = "<!-- omp-agent-council runtime-agent ";
const RUNTIME_MARKER_SUFFIX = " -->";
const MEMBER_TOOLS_FRONTMATTER: Record<ToolMode, string> = {
  readonly: "tools: read, grep, glob, web_search, write, eval",
  full: "",
};
const CHAIR_TOOLS_FRONTMATTER = "tools: eval, read, wait, write";
const MODE_GUIDANCE: Record<ToolMode, string> = {
  readonly:
    "Inspect and analyze relevant sources. Do not modify repository state or files outside `local://` evidence and answer artifacts. Eval is not sandboxed; apply this read-only boundary to every tool and helper. Do not delegate.",
  full:
    "You may modify files and repository state as requested by the brief. Verify the result, then report what changed, the verification evidence and residual uncertainty. Do not delegate.",
};
const RUN_ID_PATTERN = /^[0-9a-f]{16}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function createCompactRunId(): string {
  return randomBytes(8).toString("hex");
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(
    typeof signal.reason === "string" ? signal.reason : "Council agent preparation aborted",
  );
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function identityOf(stats: { dev: bigint; ino: bigint }): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameMarker(
  left: RuntimeOwnershipMarker,
  right: RuntimeOwnershipMarker,
): boolean {
  return (
    left.version === right.version &&
    left.run_id === right.run_id &&
    left.pid === right.pid &&
    left.agent === right.agent
  );
}

function memberAgentName(runId: string, index: number): string {
  return `agent-council-${runId}-member-${index + 1}`;
}

function chairAgentName(runId: string): string {
  return `agent-council-${runId}-chair`;
}

function markerLine(marker: RuntimeOwnershipMarker): string {
  return `${RUNTIME_MARKER_PREFIX}${JSON.stringify(marker)}${RUNTIME_MARKER_SUFFIX}`;
}

function parseRuntimeMarker(
  contents: string,
  fileName: string,
): RuntimeOwnershipMarker | undefined {
  const lines = contents.split(/\r?\n/);
  const markerLines = lines.filter(
    line =>
      line.startsWith(RUNTIME_MARKER_PREFIX) &&
      line.endsWith(RUNTIME_MARKER_SUFFIX),
  );
  if (markerLines.length !== 1) return undefined;

  const line = markerLines[0];
  if (!line) return undefined;
  const serialized = line.slice(
    RUNTIME_MARKER_PREFIX.length,
    -RUNTIME_MARKER_SUFFIX.length,
  );

  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "agent,pid,run_id,version") return undefined;
  if (
    record.version !== 1 ||
    !nonEmptyString(record.run_id) ||
    !RUN_ID_PATTERN.test(record.run_id) ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid as number) <= 0 ||
    !nonEmptyString(record.agent)
  ) {
    return undefined;
  }

  const runId = record.run_id;
  const agent = record.agent;
  const expectedPrefix = `agent-council-${runId}-`;
  const suffix = agent.slice(expectedPrefix.length);
  const temporaryPrefix = `.omp-agent-council-${runId}-`;
  const temporaryId = fileName.startsWith(temporaryPrefix)
    ? fileName.slice(temporaryPrefix.length, -".tmp".length)
    : "";
  const hasOwnedFileName =
    fileName === `${agent}.md` ||
    (fileName.endsWith(".tmp") && UUID_PATTERN.test(temporaryId));
  if (
    !agent.startsWith(expectedPrefix) ||
    (suffix !== "chair" && !/^member-[1-8]$/.test(suffix)) ||
    !hasOwnedFileName
  ) {
    return undefined;
  }

  const marker: RuntimeOwnershipMarker = {
    version: 1,
    run_id: runId,
    pid: record.pid as number,
    agent,
  };
  return line === markerLine(marker) ? marker : undefined;
}

function renderTemplate(
  template: string,
  templateName: string,
  values: Readonly<Record<string, string>>,
): string {
  const missingKeys = new Set(Object.keys(values));
  const rendered = template.replace(/\{\{([A-Z_]+)\}\}/g, (placeholder, key: string) => {
    if (!Object.hasOwn(values, key)) {
      throw new Error(`Template ${templateName} has unresolved placeholder ${placeholder}`);
    }
    missingKeys.delete(key);
    return values[key]!;
  });
  const missingKey = missingKeys.values().next().value;
  if (missingKey !== undefined) {
    throw new Error(
      `Template ${templateName} is missing required placeholder {{${missingKey}}}`,
    );
  }
  return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
}

function commonTemplateValues(
  definition: AgentDefinition,
  toolMode: ToolMode,
  marker: RuntimeOwnershipMarker,
): Record<string, string> {
  const isChair = definition.templateName === "chair.md.tmpl";
  return {
    NAME: JSON.stringify(definition.agent),
    DESCRIPTION: JSON.stringify(definition.description),
    MODEL: JSON.stringify(definition.model),
    TOOLS: isChair ? CHAIR_TOOLS_FRONTMATTER : MEMBER_TOOLS_FRONTMATTER[toolMode],
    ...(isChair ? {} : { MODE_GUIDANCE: MODE_GUIDANCE[toolMode] }),
    RUNTIME_OWNERSHIP_MARKER: markerLine(marker),
  };
}

export class RuntimeAgentManager {
  readonly #agentDir: string;
  readonly #definitionsDir: string;
  readonly #templateDir: string;
  readonly #pid: number;
  readonly #createRunId: () => string;
  readonly #isProcessAlive: (pid: number) => boolean;
  readonly #testHooks: RuntimeAgentManagerTestHooks;
  readonly #runs = new Map<string, OwnedRun>();
  readonly #protectedDefinitions = new Set<string>();

  constructor(options: RuntimeAgentManagerOptions) {
    if (!nonEmptyString(options.agentDir)) {
      throw new Error("Agent directory must not be empty");
    }
    const pid = options.pid ?? process.pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error("Runtime agent owner pid must be a positive integer");
    }

    this.#agentDir = options.agentDir;
    this.#definitionsDir = join(options.agentDir, "agents");
    this.#templateDir = options.templateDir ?? join(import.meta.dir, "..", "templates");
    this.#pid = pid;
    this.#createRunId = options.createRunId ?? createCompactRunId;
    this.#isProcessAlive = options.isProcessAlive ?? processIsAlive;
    this.#testHooks = options.testHooks ?? {};
  }

  async prepare(
    options: PrepareCouncilAgentsOptions,
  ): Promise<PreparedCouncilAgents> {
    if (
      options.memberModels.length < MIN_MEMBER_COUNT ||
      options.memberModels.length > MAX_MEMBER_COUNT
    ) {
      throw new Error("Council requires between 2 and 8 member models");
    }
    for (const [index, model] of options.memberModels.entries()) {
      if (!nonEmptyString(model)) {
        throw new Error(`Council member model ${index + 1} must not be empty`);
      }
    }
    if (!nonEmptyString(options.chairModel)) {
      throw new Error("Council chair model must not be empty");
    }
    if (options.toolMode !== "readonly" && options.toolMode !== "full") {
      throw new Error('Council tool mode must be "readonly" or "full"');
    }
    if (typeof options.isolateMembers !== "boolean") {
      throw new Error("Council member isolation must be a boolean");
    }

    throwIfAborted(options.signal);
    const runId = this.#createRunId();
    if (!RUN_ID_PATTERN.test(runId)) {
      throw new Error("Council run id generator must return 16 lowercase hexadecimal characters");
    }
    if (this.#runs.has(runId)) {
      throw new Error(`Council run id collision for ${JSON.stringify(runId)}`);
    }

    const run: OwnedRun = { active: true, files: [] };
    this.#runs.set(runId, run);
    try {
      await this.#ensureDefinitionsDirectory();
      await this.#reclaimStaleDefinitions();
      throwIfAborted(options.signal);
      if (!run.active) throw new Error("Council agent preparation was cleaned up");

      const [memberTemplate, chairTemplate] = await Promise.all([
        readFile(join(this.#templateDir, "member.md.tmpl"), "utf8"),
        readFile(join(this.#templateDir, "chair.md.tmpl"), "utf8"),
      ]);
      const members = options.memberModels.map((model, index) => {
        const agent = memberAgentName(runId, index);
        return {
          id: `member-${index + 1}`,
          agent,
          model,
        };
      });
      const chair: PreparedCouncilChair = {
        id: "chair",
        agent: chairAgentName(runId),
        model: options.chairModel,
      };
      const chairTemplateValues = {
        SPAWNS: JSON.stringify(members.map(member => member.agent)),
      };
      const definitions: AgentDefinition[] = [
        ...members.map<AgentDefinition>((member, index) => ({
          agent: member.agent,
          fileName: `${member.agent}.md`,
          template: memberTemplate,
          templateName: "member.md.tmpl",
          description:
            `Use only through Council orchestration as independent blind ` +
            `${options.toolMode} member ${index + 1}.`,
          model: member.model,
        })),
        {
          agent: chair.agent,
          fileName: `${chair.agent}.md`,
          template: chairTemplate,
          templateName: "chair.md.tmpl",
          description:
            `Use only through Council orchestration as the neutral ` +
            `${options.toolMode} synthesis chair.`,
          model: chair.model,
        },
      ];

      for (const definition of definitions) {
        throwIfAborted(options.signal);
        if (!run.active) throw new Error("Council agent preparation was cleaned up");
        const marker: RuntimeOwnershipMarker = {
          version: 1,
          run_id: runId,
          pid: this.#pid,
          agent: definition.agent,
        };
        const commonValues = commonTemplateValues(definition, options.toolMode, marker);
        const contents = renderTemplate(
          definition.template,
          definition.templateName,
          definition.templateName === "chair.md.tmpl"
            ? { ...commonValues, ...chairTemplateValues }
            : commonValues,
        );
        const file = await this.#createDefinition(definition.fileName, contents, marker);
        run.files.push(file);
        if (!run.active) {
          await this.#removeMatchingDefinition(file);
          throw new Error("Council agent preparation was cleaned up");
        }
      }

      throwIfAborted(options.signal);
      return {
        run_id: runId,
        tool_mode: options.toolMode,
        isolate_members: options.isolateMembers,
        members,
        chair,
      };
    } catch (error) {
      run.active = false;
      try {
        await this.#removeRunFiles(runId, run);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Council agent preparation and cleanup both failed for run ${runId}`,
        );
      }
      throw error;
    }
  }

  async cleanup(runId: string): Promise<void> {
    if (!nonEmptyString(runId)) throw new Error("Council run id must not be empty");
    const run = this.#runs.get(runId);
    if (!run) return;
    run.active = false;
    await this.#removeRunFiles(runId, run);
  }

  async cleanupAll(): Promise<void> {
    const failures: unknown[] = [];
    for (const [runId, run] of this.#runs) {
      run.active = false;
      try {
        await this.#removeRunFiles(runId, run);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Could not clean up every owned council run");
    }
  }

  async #ensureDefinitionsDirectory(): Promise<void> {
    await mkdir(this.#agentDir, { recursive: true, mode: 0o700 });
    const agentDirStats = await lstat(this.#agentDir);
    if (agentDirStats.isSymbolicLink() || !agentDirStats.isDirectory()) {
      throw new Error(
        `Refusing to use agent directory because it is not a real directory: ${this.#agentDir}`,
      );
    }

    try {
      await mkdir(this.#definitionsDir, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    await this.#assertDefinitionsDirectory();
  }

  async #assertDefinitionsDirectory(): Promise<void> {
    const stats = await lstat(this.#definitionsDir);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(
        `Refusing to use runtime agents path because it is not a real directory: ${this.#definitionsDir}`,
      );
    }
  }

  async #createDefinition(
    fileName: string,
    contents: string,
    marker: RuntimeOwnershipMarker,
  ): Promise<OwnedAgentFile> {
    await this.#assertDefinitionsDirectory();
    const destination = join(this.#definitionsDir, fileName);
    const temporary = join(
      this.#definitionsDir,
      `.omp-agent-council-${marker.run_id}-${randomUUID()}.tmp`,
    );
    let temporaryIdentity: FileIdentity | undefined;
    let linked = false;

    try {
      const handle = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const stats = await handle.stat({ bigint: true });
        if (!stats.isFile()) {
          throw new Error(`Refusing to create non-regular runtime agent file: ${fileName}`);
        }
        temporaryIdentity = identityOf(stats);
        if (this.#testHooks.writeTemporaryContents) {
          await this.#testHooks.writeTemporaryContents(handle, contents);
        } else {
          await handle.writeFile(contents, "utf8");
        }
        await handle.sync();
      } finally {
        await handle.close();
      }

      await this.#assertDefinitionsDirectory();
      try {
        const existing = await lstat(destination);
        const kind = existing.isSymbolicLink() ? "symbolic link" : "existing path";
        throw new Error(`Refusing to overwrite ${kind}: ${destination}`);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }

      try {
        await link(temporary, destination);
        linked = true;
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          throw new Error(`Refusing to overwrite existing runtime agent path: ${destination}`, {
            cause: error,
          });
        }
        throw error;
      }

      const stats = await lstat(destination, { bigint: true });
      const identity = identityOf(stats);
      if (
        stats.isSymbolicLink() ||
        !stats.isFile() ||
        !temporaryIdentity ||
        !sameIdentity(identity, temporaryIdentity)
      ) {
        throw new Error(`Runtime agent destination changed during creation: ${destination}`);
      }

      return { path: destination, fileName, identity, marker };
    } catch (error) {
      if (linked && temporaryIdentity) {
        await this.#removeCreatedPath(destination, temporaryIdentity);
      }
      throw error;
    } finally {
      if (temporaryIdentity) {
        try {
          await this.#removeCreatedPath(temporary, temporaryIdentity);
        } catch (error) {
          if (!linked) throw error;
        }
      }
    }
  }

  async #claimPath(path: string): Promise<string | undefined> {
    const quarantine = join(
      this.#definitionsDir,
      `.omp-agent-council-quarantine-${randomUUID()}`,
    );
    try {
      await rename(path, quarantine);
      return quarantine;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
  }

  async #restoreClaimedPath(original: string, quarantine: string): Promise<void> {
    try {
      await link(quarantine, original);
    } catch (error) {
      throw new Error(
        `Could not restore ${original}; claimed inode is preserved at ${quarantine}`,
        { cause: error },
      );
    }
    try {
      await unlink(quarantine);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }

  async #inspectIdentity(path: string): Promise<FileIdentity | undefined> {
    let handle: FileHandle;
    try {
      handle = await open(
        path,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ELOOP") return undefined;
      throw error;
    }

    try {
      const stats = await handle.stat({ bigint: true });
      return stats.isFile() ? identityOf(stats) : undefined;
    } finally {
      await handle.close();
    }
  }

  async #sharedPathKind(path: string): Promise<"regular" | "absent" | "other"> {
    try {
      const stats = await lstat(path);
      return !stats.isSymbolicLink() && stats.isFile() ? "regular" : "other";
    } catch (error) {
      if (errorCode(error) === "ENOENT") return "absent";
      throw error;
    }
  }

  async #removeCreatedPath(path: string, identity: FileIdentity): Promise<void> {
    const sharedKind = await this.#sharedPathKind(path);
    if (sharedKind !== "regular") return;

    const quarantine = await this.#claimPath(path);
    if (!quarantine) return;

    let claimedIdentity: FileIdentity | undefined;
    try {
      claimedIdentity = await this.#inspectIdentity(quarantine);
    } catch (error) {
      await this.#restoreClaimedPath(path, quarantine);
      throw error;
    }
    if (!claimedIdentity || !sameIdentity(claimedIdentity, identity)) {
      await this.#restoreClaimedPath(path, quarantine);
      return;
    }

    try {
      await unlink(quarantine);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }

  async #inspectDefinition(
    path: string,
    fileName: string,
  ): Promise<InspectedDefinition | undefined> {
    let handle: FileHandle;
    try {
      handle = await open(
        path,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ELOOP") return undefined;
      throw error;
    }

    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) return undefined;
      const contents = await handle.readFile({ encoding: "utf8" });
      const after = await handle.stat({ bigint: true });
      const beforeIdentity = identityOf(before);
      const afterIdentity = identityOf(after);
      if (!after.isFile() || !sameIdentity(beforeIdentity, afterIdentity)) return undefined;
      const marker = parseRuntimeMarker(contents, fileName);
      return {
        identity: afterIdentity,
        ...(marker ? { marker } : {}),
      };
    } finally {
      await handle.close();
    }
  }

  async #removeMatchingDefinition(
    file: OwnedAgentFile,
  ): Promise<"removed" | "absent" | "mismatch"> {
    const sharedKind = await this.#sharedPathKind(file.path);
    if (sharedKind === "absent") return "absent";
    if (sharedKind === "other") return "mismatch";

    const quarantine = await this.#claimPath(file.path);
    if (!quarantine) return "absent";

    let inspected: InspectedDefinition | undefined;
    try {
      inspected = await this.#inspectDefinition(quarantine, file.fileName);
    } catch {
      await this.#restoreClaimedPath(file.path, quarantine);
      return "mismatch";
    }
    if (
      !inspected ||
      !sameIdentity(inspected.identity, file.identity) ||
      !inspected.marker ||
      !sameMarker(inspected.marker, file.marker)
    ) {
      await this.#restoreClaimedPath(file.path, quarantine);
      return "mismatch";
    }

    try {
      await this.#testHooks.beforeClaimedDefinitionUnlink?.(file.path);
    } catch (error) {
      await this.#restoreClaimedPath(file.path, quarantine);
      throw error;
    }
    try {
      await unlink(quarantine);
      return "removed";
    } catch (error) {
      if (errorCode(error) === "ENOENT") return "absent";
      throw error;
    }
  }

  async #removeRunFiles(runId: string, run: OwnedRun): Promise<void> {
    const failures: unknown[] = [];
    for (const file of run.files) {
      try {
        const result = await this.#removeMatchingDefinition(file);
        if (result === "mismatch") {
          this.#protectedDefinitions.add(`${runId}\0${file.marker.agent}`);
        }
      } catch (error) {
        this.#protectedDefinitions.add(`${runId}\0${file.marker.agent}`);
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Could not clean up every runtime agent for run ${runId}`,
      );
    }
  }

  async #reclaimStaleDefinitions(): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.#definitionsDir, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      const isRuntimeCandidate =
        entry.name.endsWith(".md") ||
        (entry.name.startsWith(".omp-agent-council-") &&
          entry.name.endsWith(".tmp"));
      if (!isRuntimeCandidate) continue;
      if (
        entry.isDirectory() ||
        entry.isBlockDevice() ||
        entry.isCharacterDevice() ||
        entry.isFIFO() ||
        entry.isSocket()
      ) {
        continue;
      }
      const path = join(this.#definitionsDir, entry.name);
      let inspected: InspectedDefinition | undefined;
      try {
        inspected = await this.#inspectDefinition(path, entry.name);
      } catch {
        continue;
      }
      const marker = inspected?.marker;
      if (!inspected || !marker) continue;

      const protectedKey = `${marker.run_id}\0${marker.agent}`;
      if (this.#protectedDefinitions.has(protectedKey)) continue;
      const knownRun = this.#runs.get(marker.run_id);
      const knownInactive =
        marker.pid === this.#pid && knownRun !== undefined && !knownRun.active;
      if (!knownInactive && this.#isProcessAlive(marker.pid)) continue;

      const staleFile: OwnedAgentFile = {
        path,
        fileName: basename(path),
        identity: inspected.identity,
        marker,
      };
      await this.#removeMatchingDefinition(staleFile);
    }
  }
}
