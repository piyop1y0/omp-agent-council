---
name: council
description: Run a Council or multi-model panel when the user requests one or another skill directs one; not for ordinary questions, research, or comparisons.
---

# Council

State the user's substantive task and constraints faithfully in the Council brief; concise restatement is allowed. Keep Council orchestration instructions (such as replacing a run or selecting member/Chair models) out of the member-facing brief; apply them when preparing or controlling the run instead. Add useful context or source references separately. Context may be summarized and may include `local://`, `artifact://`, repository paths, or web URLs.

## Run

1. Call `council_prepare_agents` directly. Pass only needed overrides: `member_models`, `chair_model`, `tool_mode`, and/or `isolate_members`; otherwise pass `{}`. For a requested thinking level, set `:<level>` on the corresponding selector, replacing an existing thinking suffix without stripping a literal model-ID suffix. For a level-only request, locate the active user directory with `omp config path` and read its `agent-council.json` plus the project `.omp/agent-council.json`; retain selected models (project overrides user, then built-in defaults). Pass the full selected member array when overriding any member. Leave other selectors unchanged.
2. Write the brief to `local://agent-council-<run_id>-request.md`, using the returned run ID. Write the **complete preparation details** unchanged as JSON to the companion `local://agent-council-<run_id>-config.json`; this carries generated agent names and isolation settings.

   ```markdown
   # User Request

   <substantive user task and constraints; omit Council orchestration instructions>

   # Context

   <useful context and source references, or empty if none>
   ```

3. Launch the generated Chair with JavaScript eval, replacing the placeholders with the canonical request URL and returned `chair_agent`. Retain the original handle and printed live instance ID for follow-ups.

   ```js
   var councilRequest = "<request artifact URL>";
   var councilBase = councilRequest.replace(/-request\.md$/, "");
   var councilChair = await agent(councilRequest, { agent: "<prepared chair_agent>" });
   print({ instanceId: councilChair.id });
   ```

4. In a separate eval with `timeout: 0`, await the initial handle once and persist the answer immediately:

   ```js
   var councilAnswer = String(await councilChair.wait());
   if (!councilAnswer.trim()) throw new Error("Council Chair returned an empty answer");
   var councilAnswerFile = `${councilBase}-chair-response.md`;
   await write(councilAnswerFile, councilAnswer);
   print(councilAnswerFile);
   ```

   If either eval backgrounds, use native `wait` until that eval finishes. Process other owned job results as well; do not discard a returned batch while waiting for a particular job. A wait cap or interrupt is not completion: wait again with no elapsed-time limit. Never cancel, kill or abandon a Chair because of elapsed time; stop only when the user explicitly asks to stop this Council run. A terminal launch/execution failure is reportable, not permission to substitute your own Council answer.
5. Read the persisted answer with `:raw`, recover any omissions, then briefly relay or act on it as requested.

## Follow up with the original Chair

1. Use native `write` to message the original Chair at `agent://<instanceId>` with the follow-up and a fresh `local://` synthesis destination. Keep short follow-ups inline. For a lengthy question or context, save the complete brief to a fresh `local://` file and ask the Chair to read its URI with `:raw`.

   ```text
   Consult the original members: <follow-up question>.
   Write your complete standalone synthesis to local://agent-council-<run_id>-followup-2.md and return only that URI.
   ```

2. Use native `wait` for the original Chair's completion referencing that fresh URI; an earlier result is not this answer. Read the destination with `:raw`, recover omissions, and relay or act on it.

Keep the original Chair and saved files for consecutive follow-ups, choosing a fresh destination each time. Do not prepare replacements or reuse the initial handle's cached `wait()` result. Continue waiting without an elapsed-time limit; stop only at the user's request. Report an unavailable or failed Chair rather than answer on its behalf.
