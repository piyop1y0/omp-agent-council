import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createContext, runInContext, type Context } from "node:vm";

const BASE = "local://agent-council-1111111111111111";
const REQUEST = `${BASE}-request.md`;
const GENERATED_CHAIR = "agent-council-1111111111111111-chair";
const chairSource = await readFile(new URL("../templates/chair.md.tmpl", import.meta.url), "utf8");
const skillSource = await readFile(new URL("../skills/council/SKILL.md", import.meta.url), "utf8");
const chairScripts = [...chairSource.matchAll(/^[ \t]*```js\r?\n([\s\S]*?)\r?\n[ \t]*```$/gm)].map(match => match[1]!);
const mainScripts = [...skillSource.matchAll(/^[ \t]*```js\r?\n([\s\S]*?)\r?\n[ \t]*```$/gm)].map(match => match[1]!);

interface MemberRecord {
  id: string;
  agent: string;
  instanceId?: string;
  answerFile?: string;
  launchFailure?: string;
  terminalFailure?: string;
  emptyAnswer?: string;
}
interface Environment {
  files: Map<string, string>;
  writes: Array<{ path: string; content: string }>;
  context: Context;
}

function prepared(count: number, isolated = false) {
  return {
    run_id: "1111111111111111",
    chair_agent: GENERATED_CHAIR,
    members: Array.from({ length: count }, (_, index) => ({
      id: `member-${index + 1}`,
      agent: `agent-council-1111111111111111-member-${index + 1}`,
    })),
    tool_mode: "readonly",
    isolate_members: isolated,
  };
}

function execute<T>(code: string, context: Context, result: string): Promise<T> {
  return runInContext(`(async () => {\n${code}\nreturn ${result};\n})()`, context) as Promise<T>;
}

function environment(initial: Map<string, string> = new Map()): Environment {
  const files = new Map(initial);
  const writes: Array<{ path: string; content: string }> = [];
  const context = createContext({
    read: async (path: string) => {
      const contents = files.get(path);
      if (contents === undefined) throw new Error(`Missing artifact ${path}`);
      return contents;
    },
    write: async (path: string, content: string) => {
      if (!path.startsWith("local://")) throw new Error("Filesystem helper cannot message agents");
      files.set(path, content);
      writes.push({ path, content });
    },
    print: () => {},
    agent: () => { throw new Error("Unexpected replacement agent"); },
  });
  return { files, writes, context };
}

test("config-driven nonisolated launches route each generated member without isolation flags", async () => {
  const config = prepared(2);
  const env = environment(new Map([[`${BASE}-config.json`, JSON.stringify(config)]]));
  const launched: string[] = [];
  env.context.agent = async (prompt: string, options: { agent: string }) => {
    expect(prompt).toContain(`${REQUEST}:raw`);
    expect(options).toEqual({ agent: config.members[launched.length]!.agent });
    launched.push(options.agent);
    return { id: `OriginalChair.Member${launched.length}` };
  };
  await execute(
    chairScripts[0]!.replace('"<request artifact URL>"', JSON.stringify(REQUEST)), env.context, "launches",
  );
  expect(launched).toEqual(config.members.map(member => member.agent));
});

test("config-driven initial launches preserve full out-of-order answers and every failure", async () => {
  const config = prepared(5, true);
  const env = environment(new Map([[`${BASE}-config.json`, JSON.stringify(config)]]));
  const first = Promise.withResolvers<string>();
  const second = Promise.withResolvers<string>();
  const secondSaved = Promise.withResolvers<void>();
  const initialWrite = env.context.write as (path: string, content: string) => Promise<void>;
  env.context.write = async (path: string, content: string) => {
    await initialWrite(path, content);
    if (path === `${BASE}-response-2.md`) secondSaved.resolve();
  };
  const firstAnswer = `First minority finding\n${"A".repeat(100_000)}\nImportant first conclusion`;
  const secondAnswer = `Second finding\n${"B".repeat(120_000)}\nImportant second conclusion`;
  let launchComplete = false;
  let waits = 0;
  env.context.agent = async (_prompt: string, options: { agent: string; isolated?: boolean; apply?: boolean; merge?: boolean }) => {
    const index = config.members.findIndex(member => member.agent === options.agent);
    if (index < 0 || !options.isolated || options.apply !== false || options.merge !== false) throw new Error("Incorrect launch policy");
    expect(Object.keys(options).sort()).toEqual(["agent", "apply", "isolated", "merge"]);
    if (index === 4) throw new Error("Agent unavailable before launch");
    return {
      id: `OriginalChair.Member${index + 1}`,
      wait: async () => {
        if (!launchComplete) throw new Error("Waiting hid the live roster during launch");
        waits++;
        if (index === 0) return first.promise;
        if (index === 1) return second.promise;
        if (index === 2) throw new Error("Provider stopped mid-answer");
        return " \n ";
      },
    };
  };
  const bindings = await execute<{ base: string; launches: unknown[] }>(
    chairScripts[0]!.replace('"<request artifact URL>"', JSON.stringify(REQUEST)), env.context, "{ base, launches }",
  );
  expect(waits).toBe(0);
  Object.assign(env.context, bindings);
  launchComplete = true;
  const execution = execute(chairScripts[1]!, env.context, "records");
  second.resolve(secondAnswer);
  await Promise.race([secondSaved.promise, execution.then(() => { throw new Error("Second answer was never persisted independently"); })]);
  expect(env.files.get(`${BASE}-response-2.md`)).toBe(secondAnswer);
  expect(env.files.has(`${BASE}-response-1.md`)).toBe(false);
  expect(env.files.has(`${BASE}-responses.json`)).toBe(false);
  first.resolve(firstAnswer);
  await execution;
  expect(env.files.get(`${BASE}-response-1.md`)).toBe(firstAnswer);
  const records = JSON.parse(env.files.get(`${BASE}-responses.json`)!) as MemberRecord[];
  expect(records.map(record => record.id)).toEqual(config.members.map(member => member.id));
  expect(records[2]!.terminalFailure).toContain("Provider stopped mid-answer");
  expect(records[3]!.emptyAnswer).toBeDefined();
  expect(records[4]!.launchFailure).toContain("Agent unavailable before launch");
  expect(env.files.has(`${BASE}-response-3.md`)).toBe(false);
  expect(env.files.has(`${BASE}-response-4.md`)).toBe(false);
  expect(env.files.has(`${BASE}-response-5.md`)).toBe(false);
});

test("main skill launches the prepared Chair and persists its full initial answer", async () => {
  const config = prepared(2);
  const env = environment();
  const result = Promise.withResolvers<string>();
  const completeAnswer = `All member findings\n${"C".repeat(100_000)}\nFinal synthesis`;
  env.context.agent = async (request: string, options: { agent: string }) => {
    expect(request).toBe(REQUEST);
    expect(options).toEqual({ agent: config.chair_agent });
    return { id: "OriginalChair", wait: () => result.promise };
  };
  const bindings = await execute<{ councilBase: string; councilChair: unknown }>(
    mainScripts[0]!
      .replace('"<request artifact URL>"', JSON.stringify(REQUEST))
      .replace('"<prepared chair_agent>"', JSON.stringify(config.chair_agent)),
    env.context, "{ councilBase, councilChair }",
  );
  Object.assign(env.context, bindings);
  const execution = execute(mainScripts[1]!, env.context, "councilAnswerFile");
  result.resolve(completeAnswer);
  const answerFile = await execution as string;
  expect(env.files.get(answerFile)).toBe(completeAnswer);
});

