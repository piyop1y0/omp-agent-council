import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeAgentManager } from "../src/runtime-agents";

const options = {
  memberModels: ["provider/a", "provider/b"], chairModel: "provider/chair",
  toolMode: "readonly" as const, isolateMembers: false,
};

for (const failure of ["abort", "write", "cleanup"] as const) {
  test(`partial preparation rolls back after ${failure}`, async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "council-registration-"));
    const controller = new AbortController();
    let writes = 0;
    const manager = new RuntimeAgentManager({
      agentDir,
      testHooks: {
        async writeTemporaryContents(handle, contents) {
          await handle.writeFile(contents, "utf8");
          if (++writes !== 2) return;
          if (failure === "abort") controller.abort(new Error("injected abort"));
          else if (failure === "write") throw new Error("injected write failure");
          else await manager.cleanupAll();
        },
      },
    });
    try {
      await expect(manager.prepare({ ...options, signal: controller.signal })).rejects.toThrow(
        failure === "abort" ? "injected abort" : failure === "write" ? "injected write failure" : "cleaned up",
      );
      expect(writes).toBe(2);
      expect(await readdir(join(agentDir, "agents"))).toEqual([]);
    } finally { await rm(agentDir, { recursive: true, force: true }); }
  });
}

test("cleanup preserves unrelated files and replaced ownership-marked inodes across later preparation", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "council-registration-"));
  const manager = new RuntimeAgentManager({ agentDir });
  try {
    const prepared = await manager.prepare(options);
    const definitions = join(agentDir, "agents");
    const target = join(definitions, `${prepared.members[0]!.agent}.md`);
    const contents = await readFile(target, "utf8");
    const replacement = join(definitions, "replacement.md");
    await writeFile(replacement, contents);
    await rename(replacement, target);
    const unrelated = join(definitions, "user-owned.md");
    await writeFile(unrelated, "user-owned\n");
    const sessionEvidence = join(agentDir, "session-answer.md");
    await writeFile(sessionEvidence, "retained answer\n");
    await manager.cleanupAll();
    await manager.cleanupAll();
    expect((await readdir(definitions)).sort()).toEqual([`${prepared.members[0]!.agent}.md`, "user-owned.md"]);
    const next = await manager.prepare(options);
    await manager.cleanup(next.run_id);
    expect(await readFile(target, "utf8")).toBe(contents);
    expect(await readFile(unrelated, "utf8")).toBe("user-owned\n");
    expect(await readFile(sessionEvidence, "utf8")).toBe("retained answer\n");
  } finally { await rm(agentDir, { recursive: true, force: true }); }
});

test("stale registration cleanup removes dead owners but retains live definitions", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "council-registration-"));
  try {
    const dead = new RuntimeAgentManager({ agentDir, pid: 424242, isProcessAlive: () => true });
    const stale = await dead.prepare(options);
    const live = new RuntimeAgentManager({ agentDir, isProcessAlive: pid => pid !== 424242 });
    const current = await live.prepare(options);
    const files = await readdir(join(agentDir, "agents"));
    for (const agent of [...stale.members, stale.chair]) expect(files).not.toContain(`${agent.agent}.md`);
    for (const agent of [...current.members, current.chair]) expect(files).toContain(`${agent.agent}.md`);
    await live.cleanupAll();
  } finally { await rm(agentDir, { recursive: true, force: true }); }
});
