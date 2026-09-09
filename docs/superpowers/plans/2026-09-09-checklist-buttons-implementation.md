# Tappable Checklist Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent post a list (e.g. a shopping list) as a Telegram message with one tappable button per item. Tapping toggles that item's checked state instantly — no LLM turn, no container wake — and if the checklist was created from a tracked file, the toggle mirrors into that real file (checked = removed from the file, since "bought" means "no longer needed"; a second tap undoes it).

**Architecture:** Reuses nanoclaw's existing generic Chat SDK "card with buttons" rendering (`Card`/`CardText`/`Actions`/`Button`, the same primitives `ask_user_question` already uses) and the existing `chat.onAction` dispatch point in `src/channels/chat-sdk-bridge.ts`. Unlike `ask_user_question` (single-shot: one tap resolves the question, deletes the row, wakes the agent), a checklist is **non-consuming** — many independent taps over the life of one message, handled entirely host-side by editing the message and (optionally) a tracked file in place. No new response-registry wiring is needed: the new `chk:` action-id branch in `chat.onAction` returns before reaching `setupConfig.onAction`, so it never touches `pending_questions`/`response-registry.ts` or wakes any container.

**Tech Stack:** TypeScript, Node (host), the existing `@chat-adapter/telegram` Chat SDK bridge already installed on this fork, SQLite via the existing `DbDriver` (`src/db/connection.ts`), the same migration system as `src/db/migrations/`.

**Spec:** No separate spec doc — this plan was scoped directly from live codebase investigation (see Global Constraints below for what that investigation established as fact, not assumption).

## Global Constraints

- Base commit for this branch: `b76fcb3d` (`fix(agent-runner): tell the agent send_card drops callback actions (#3427)`) — this is the exact commit currently deployed on the target Mac (`gromit@192.168.1.19:~/nanoclaw`), so the implementation must work against this commit's code, not a newer or older upstream state.
- A toggle must NEVER wake a container or write to a session's `inbound.db` — this is a hard behavioral requirement (the whole point is sub-second, no-LLM-turn toggling). Any code path that calls `requestWake`, `writeSessionMessage`, or goes through `response-registry.ts` for a `chk:` action is a bug.
- Telegram's `callback_data` cap is 64 bytes — action ids must stay short. `chk:<checklistId>:<index>` where `checklistId` is a short generated id (not a UUID) and `index` is a small integer satisfies this the same way `ncq:<questionId>:<index>` already does for `ask_user_question`.
- `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` must pass for any `container/agent-runner/src/` changes (separate tsconfig from the host). Host changes verify via `pnpm run build` and `pnpm test` (vitest) from repo root. Container-runner tests use `bun:test`, not vitest — see existing `container/agent-runner/src/mcp-tools/*.test.ts` for the pattern.
- Do not modify `src/channels/telegram.ts`, `src/channels/telegram-pairing.ts`, or any other locally-installed-by-skill Telegram-specific file — those are the `/add-telegram` skill's install output, tracked as local diffs on the Mac, not part of this repo's trunk history, and out of scope. All work in this plan lives in trunk files (`src/channels/chat-sdk-bridge.ts`, `src/delivery.ts`, `src/db/`, `container/agent-runner/src/mcp-tools/`) that exist independent of which channels are installed.
- `checklist_items` is a new **unconditional** (not module-guarded) table, following `pending_questions`' own precedent in `src/db/migrations/001-initial.ts` — `send_checklist` is core agent tooling, not a channel- or module-specific add-on.

---

### Task 1: DB migration + checklist CRUD helpers

**Files:**
- Create: `src/db/migrations/025-checklist-items.ts`
- Modify: `src/db/migrations/index.ts` (register the new migration — check how `022`/`023`/`024` are registered there and follow the exact same pattern)
- Create: `src/db/checklists.ts`
- Test: `src/db/checklists.test.ts`

**Interfaces:**
- Produces:
  - `export interface ChecklistItem { checklistId: string; itemIndex: number; text: string; checked: boolean; sessionId: string; messageOutId: string; platformId: string | null; channelType: string | null; threadId: string | null; sourceFile: string | null; createdAt: string; }`
  - `export async function createChecklistItems(items: ChecklistItem[]): Promise<void>` — bulk insert, one row per item, all sharing the same `checklistId`. Idempotent the same way `createPendingQuestion` is (delivery retries must not throw UNIQUE): use `INSERT ... ON CONFLICT (checklist_id, item_index) DO NOTHING`.
  - `export async function getChecklistItem(checklistId: string, itemIndex: number): Promise<ChecklistItem | undefined>`
  - `export async function getChecklistItems(checklistId: string): Promise<ChecklistItem[]>` — all items for one checklist, ordered by `item_index`.
  - `export async function setChecklistItemChecked(checklistId: string, itemIndex: number, checked: boolean): Promise<void>`

- [ ] **Step 1: Write the migration**

Read `src/db/migrations/001-initial.ts` lines ~100-110 first (the `pending_questions` table) to match column style exactly, and read `src/db/migrations/022-messaging-group-detached.ts` in full for the file-level format (imports, doc comment, `Migration` object shape, `version`/`name`/`up`).

```typescript
import type { Migration } from './index.js';

/**
 * Checklist items — backs the `send_checklist` MCP tool. Unlike
 * `pending_questions` (one row per question, deleted once answered), a
 * checklist keeps all its item rows for the life of the message: each tap
 * flips `checked` in place, never deletes the row, and the message gets
 * re-rendered with updated buttons. See `src/channels/chat-sdk-bridge.ts`'s
 * `chk:` action-id branch for the toggle handler.
 */
export const migration025: Migration = {
  version: 25,
  name: 'checklist-items',
  async up(db) {
    await db.exec(`
      CREATE TABLE checklist_items (
        checklist_id   TEXT NOT NULL,
        item_index     INTEGER NOT NULL,
        text           TEXT NOT NULL,
        checked        INTEGER NOT NULL DEFAULT 0,
        session_id     TEXT NOT NULL REFERENCES sessions(id),
        message_out_id TEXT NOT NULL,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        source_file    TEXT,
        created_at     TEXT NOT NULL,
        PRIMARY KEY (checklist_id, item_index)
      );
    `);
  },
};
```

Register it in `src/db/migrations/index.ts` — open that file first and match exactly how migration `024` (`host-coordination`, the current latest) is imported and added to whatever array/list the file exports. Do not guess the registration shape; read the file.

- [ ] **Step 2: Write the failing tests**

Create `src/db/checklists.test.ts`. Look at `src/db/sessions.test.ts` (or wherever `pending_questions` CRUD — `createPendingQuestion`/`getPendingQuestion`/`deletePendingQuestion` — is tested today) first, and match its test-setup pattern exactly (in-memory DB, migrations run, etc.) — don't invent a different harness. Cover:

```typescript
test('createChecklistItems inserts all items, getChecklistItems returns them ordered by index', async () => { /* ... */ });
test('createChecklistItems is idempotent — calling twice with the same checklistId/index does not throw or duplicate', async () => { /* ... */ });
test('getChecklistItem returns undefined for an unknown checklistId/index pair', async () => { /* ... */ });
test('setChecklistItemChecked flips only the targeted item, leaves siblings untouched', async () => { /* ... */ });
```

- [ ] **Step 3: Run tests, confirm they fail** (table/functions don't exist yet)

- [ ] **Step 4: Write `src/db/checklists.ts`**

Mirror `src/db/sessions.ts`'s `createPendingQuestion`/`getPendingQuestion` style exactly (named `@param` bindings, `getDb()` from `./connection.js`, the `ON CONFLICT ... DO NOTHING` idempotency pattern shown in that file's own doc comment on `createPendingQuestion`).

- [ ] **Step 5: Run tests, confirm pass**

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations/025-checklist-items.ts src/db/migrations/index.ts src/db/checklists.ts src/db/checklists.test.ts
git commit -m "feat(checklist): add checklist_items table and CRUD helpers"
```

---

### Task 2: `send_checklist` MCP tool

**Files:**
- Create: `container/agent-runner/src/mcp-tools/checklist.ts`
- Test: `container/agent-runner/src/mcp-tools/checklist.test.ts`
- Modify: wherever `core.ts`'s tools get registered into the full tool list (check `container/agent-runner/src/mcp-tools/server.ts` or an index/barrel file — read it first) to add this new tool alongside `sendMessage`/`sendFile`/`editMessage`/`addReaction`.

**Interfaces:**
- Consumes: `registerTools` and `McpToolDefinition` from `./server.js`/`./types.js` (same imports `core.ts` uses); `findByName`/`getAllDestinations` from `../destinations.js`; `writeMessageOut` from `../db/messages-out.js`; `getCurrentInReplyTo` from `../db/session-state.js` — read `container/agent-runner/src/mcp-tools/core.ts` in full first (it's ~240 lines) and copy its exact `resolveRouting`/`ok`/`err`/`generateId` helper style rather than reimplementing differently.
- Produces: a `messages_out` row with `content: JSON.stringify({ type: 'checklist', checklistId, title, items: [{index, text}], sourceFile })` — this exact shape is what Task 3 and Task 4 consume.

- [ ] **Step 1: Write the tool**

```typescript
import { findByName, getAllDestinations } from '../destinations.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getCurrentInReplyTo } from '../db/session-state.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

// (copy resolveRouting, destinationList, ok, err, generateId verbatim from
// core.ts — do not reimplement; if a shared-helpers module would be cleaner,
// that's a bigger refactor out of scope here, just duplicate the ~15 lines)

function generateChecklistId(): string {
  // Short — this becomes part of a Telegram callback_data string capped at
  // 64 bytes: "chk:<id>:<index>". Keep it well under 20 chars.
  return `cl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export const sendChecklist: McpToolDefinition = {
  tool: {
    name: 'send_checklist',
    description:
      'Send a tappable checklist to a destination — one button per item. Tapping toggles it (checked/unchecked) instantly, no reply needed from you. If sourceFile is given, checking an item off removes its line from that file (relative to memory/, e.g. "tracking/shopping-list.md") and unchecking restores it — use this for a shared list so the button and the file stay in sync.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Destination name.' },
        title: { type: 'string', description: 'Checklist title shown above the items.' },
        items: {
          type: 'array',
          items: { type: 'string' },
          description: 'Item text, one per line/button, in the order shown.',
        },
        sourceFile: {
          type: 'string',
          description:
            'Optional. Path relative to this group\'s memory/ directory (e.g. "tracking/shopping-list.md"). When set, each item\'s exact text must match a line in that file (after stripping a leading "- ") so toggling can add/remove it there.',
        },
      },
      required: ['to', 'title', 'items'],
    },
  },
  async handler(args) {
    const to = args.to as string;
    const title = args.title as string;
    const items = args.items as string[];
    const sourceFile = (args.sourceFile as string) || null;
    if (!to) return err('to is required');
    if (!title) return err('title is required');
    if (!Array.isArray(items) || items.length === 0) return err('items must be a non-empty array');

    const routing = resolveRouting(to);
    if ('error' in routing) return err(routing.error);

    const checklistId = generateChecklistId();
    const id = generateId();
    const seq = await writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({
        type: 'checklist',
        checklistId,
        title,
        items: items.map((text, index) => ({ index, text })),
        sourceFile,
      }),
    });

    return ok(`Checklist sent to ${routing.resolvedName} (id: ${seq})`);
  },
};

registerTools([sendChecklist]);
```

Wire it into whatever barrel/import list makes `core.ts`'s tools actually load at runtime (read that file first — likely a single `import './core.js'; import './checklist.js';`-style file, or an explicit array; match the existing pattern exactly).

- [ ] **Step 2: Write tests** in `checklist.test.ts` mirroring `core.test.ts`'s (or wherever `sendMessage` is tested) structure: missing `to`/`title`/`items`, empty `items` array, unknown destination, successful send producing the right `content` JSON shape (assert on the parsed JSON, not a string match).

- [ ] **Step 3: Run** `cd container/agent-runner && bun test` **— confirm pass**

- [ ] **Step 4: Typecheck** — `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` from repo root, confirm clean

- [ ] **Step 5: Commit**

```bash
cd container/agent-runner && git add src/mcp-tools/checklist.ts src/mcp-tools/checklist.test.ts <the barrel file you edited>
git commit -m "feat(checklist): add send_checklist MCP tool"
```

---

### Task 3: Host-side persistence in `delivery.ts`

**Files:**
- Modify: `src/delivery.ts`
- Test: whatever file currently tests the `ask_question`/`pending_questions` persistence block in `delivery.ts` (search for `createPendingQuestion` in a `.test.ts` file first) — add checklist coverage there rather than starting a new test file, unless that file doesn't exist, in which case create `src/delivery-checklist.test.ts`.

**Interfaces:**
- Consumes: `createChecklistItems`, `ChecklistItem` from Task 1's `src/db/checklists.ts`.
- Produces: nothing new downstream — this task's whole job is populating `checklist_items` rows before delivery, mirroring the existing `pending_questions` block exactly.

- [ ] **Step 1: Read the existing block**

Read `src/delivery.ts` around the `content.type === 'ask_question'` block (search for `createPendingQuestion` — it's roughly lines 450-475 as of the base commit, but confirm by searching, don't trust the line number). Note exactly: where it sits relative to the channel-delivery call below it, how `hasTable` guards it, and how it reads `session.id`.

- [ ] **Step 2: Write the failing test** — assert that delivering a message with `content.type === 'checklist'` results in one `checklist_items` row per item, `checked: false`, correct `session_id`/`platform_id`/`channel_type`/`thread_id`/`source_file`. Also test idempotency (same as `pending_questions`': delivering twice with the same `checklistId` must not throw).

- [ ] **Step 3: Confirm it fails**

- [ ] **Step 4: Add the block**, placed the same way as the `ask_question` block (before the channel-delivery call, guarded by `hasTable(getDb(), 'checklist_items')` the same way):

```typescript
if (content.type === 'checklist' && content.checklistId && Array.isArray(content.items) && (await hasTable(getDb(), 'checklist_items'))) {
  const checklistId = content.checklistId as string;
  const sourceFile = (content.sourceFile as string) || null;
  const items = content.items as Array<{ index: number; text: string }>;
  await createChecklistItems(
    items.map((item) => ({
      checklistId,
      itemIndex: item.index,
      text: item.text,
      checked: false,
      sessionId: session.id,
      messageOutId: msg.id,
      platformId: msg.platformId,
      channelType: msg.channelType,
      threadId: msg.threadId,
      sourceFile,
      createdAt: new Date().toISOString(),
    })),
  );
}
```

Do not delete or restructure the existing `ask_question` block — this is a sibling `if`, not a replacement.

- [ ] **Step 5: Run tests, confirm pass**

- [ ] **Step 6: Commit**

```bash
git add src/delivery.ts <the test file>
git commit -m "feat(checklist): persist checklist_items on delivery"
```

---

### Task 4: Render + toggle handling in `chat-sdk-bridge.ts`

This is the core of the feature. Read `src/channels/chat-sdk-bridge.ts` in full around two areas before writing anything:
1. The `ask_question` render block (search `content.type === 'ask_question'`, ~lines 831-859 at the base commit) — the `Card`/`CardText`/`Actions`/`Button` construction and `adapter.postMessage` call.
2. The `chat.onAction` handler (search `chat.onAction`, ~lines 678-712) — specifically the `ncq:` branch's structure: parsing `event.actionId`, using `event.threadId`/`event.messageId`/`event.user`, and calling `adapter.editMessage(tid, messageId, { markdown } | { card, fallbackText })`.

Also read `src/db/agent-groups.ts`'s `getAgentGroup(id)` and `src/config.ts`'s `GROUPS_DIR` export — needed to resolve a session's group folder for the `sourceFile` sync.

**Files:**
- Modify: `src/channels/chat-sdk-bridge.ts`
- Test: `src/channels/chat-sdk-bridge.test.ts` (existing file — add to it, following however the `ask_question` render/action tests are structured there)

**Interfaces:**
- Consumes: `getChecklistItem`, `getChecklistItems`, `setChecklistItemChecked` from Task 1; `getAgentGroup` from `src/db/agent-groups.ts`; `GROUPS_DIR` from `src/config.ts`; `getSession` from `src/db/sessions.ts` (to go from `session_id` on the stored row to the session's `agent_group_id`).

- [ ] **Step 1: Write the failing render test**

Assert that delivering `{type: 'checklist', checklistId: 'cl1', title: 'Shopping', items: [{index:0,text:'milk'},{index:1,text:'eggs'}]}` results in `adapter.postMessage` being called with a `Card` containing two `Button`s with ids `chk:cl1:0` and `chk:cl1:1`, labels `⬜ milk` / `⬜ eggs`.

- [ ] **Step 2: Write the render branch**, placed alongside (not replacing) the `ask_question` branch:

```typescript
// Checklist card — one button per item, toggled independently, never consumed.
if (content.type === 'checklist' && content.checklistId && Array.isArray(content.items)) {
  const checklistId = content.checklistId as string;
  const title = content.title as string;
  const items = content.items as Array<{ index: number; text: string }>;
  if (!title) {
    log.error('checklist missing required title — skipping delivery', { checklistId });
    return;
  }
  const card = Card({
    title,
    children: [
      Actions(
        items.map((item) =>
          Button({
            id: `chk:${checklistId}:${item.index}`,
            label: `⬜ ${item.text}`,
            value: String(item.index),
          }),
        ),
      ),
    ],
  });
  const result = await adapter.postMessage(tid, {
    card,
    fallbackText: `${title}\n${items.map((i) => `⬜ ${i.text}`).join('\n')}`,
  });
  return result?.id;
}
```

Match whatever the surrounding code's actual return-value convention is (the `ask_question` block `return`s the id directly — check whether the enclosing function expects a bare `return` or `return result?.id` by reading a few lines above/below; do not guess).

- [ ] **Step 3: Run render test, confirm pass**

- [ ] **Step 4: Write the failing toggle test**

Set up: a `checklist_items` row for `checklistId='cl1', itemIndex=0, text='milk', checked=false, sourceFile=null`. Simulate a `chk:cl1:0` action event (however the existing `ncq:` action tests simulate `chat.onAction` firing — copy that harness). Assert:
- `adapter.editMessage` was called with the same `messageId`, a `Card` whose item-0 button now reads `✅ milk` (strikethrough per whatever the actual `Button`/`CardText` API offers for strikethrough — check the `Card`/`Button` type definitions under `node_modules/@chat-adapter/telegram` or wherever `Card`/`Button` are imported from at the top of `chat-sdk-bridge.ts`; if no strikethrough option exists, `✅ milk` alone is sufficient — do not invent a markdown syntax that isn't in the actual API).
- `getChecklistItem('cl1', 0)` now returns `checked: true`.
- No call was made to `requestWake`, `writeSessionMessage`, or `setupConfig.onAction` — assert this explicitly (spy/mock and assert not-called), since the Global Constraints make this a hard requirement.

Write a second test for the `sourceFile` case: item `checked: false → true` removes the matching line from a temp file; a second tap (`checked: true → false`) restores it.

- [ ] **Step 5: Confirm both fail**

- [ ] **Step 6: Write the toggle branch**, added inside `chat.onAction` before the existing `if (!event.actionId.startsWith('ncq:')) return;` early-return — i.e. as a sibling branch, checked first, that also `return`s so it never falls through to the `ncq:` logic or `setupConfig.onAction`:

```typescript
if (event.actionId.startsWith('chk:')) {
  const [, checklistId, indexStr] = event.actionId.split(':');
  const itemIndex = Number(indexStr);
  const item = await getChecklistItem(checklistId, itemIndex);
  if (!item) return;

  const newChecked = !item.checked;
  await setChecklistItemChecked(checklistId, itemIndex, newChecked);

  if (item.sourceFile) {
    try {
      const session = await getSession(item.sessionId);
      const group = session ? await getAgentGroup(session.agent_group_id) : undefined;
      if (group) {
        const filePath = path.resolve(GROUPS_DIR, group.folder, 'memory', item.sourceFile);
        const raw = await fs.readFile(filePath, 'utf-8');
        const lines = raw.split('\n');
        const itemLine = `- ${item.text}`;
        if (newChecked) {
          const idx = lines.findIndex((l) => l.trim() === itemLine);
          if (idx !== -1) lines.splice(idx, 1);
        } else if (!lines.some((l) => l.trim() === itemLine)) {
          // Re-insert before the first blank line under "## Items", or at
          // end of file if that heading isn't found — read the actual
          // shopping-list.md structure (src/../groups/household/memory/tracking/shopping-list.md
          // on the deployed Mac, or ask the operator for its current
          // content) before finalizing this insertion point; don't guess
          // blindly, the file has a "## How this file works" section
          // after the items that must not get an item appended past it.
        }
        await fs.writeFile(filePath, lines.join('\n'), 'utf-8');
      }
    } catch (err) {
      log.warn('Failed to sync checklist toggle to source file', { err, checklistId, itemIndex });
      // Continue anyway — the button and DB state are still updated; a
      // file-sync failure shouldn't leave the UI stuck.
    }
  }

  const allItems = await getChecklistItems(checklistId);
  const card = Card({
    title: /* the checklist's title isn't stored on checklist_items rows —
             either add a title column in Task 1's migration if this turns
             out to be needed, or re-fetch it from the original messages_out
             row via item.messageOutId. Decide and document which, then
             implement — do not silently drop the title on re-render. */ '',
    children: [
      Actions(
        allItems.map((i) =>
          Button({
            id: `chk:${checklistId}:${i.itemIndex}`,
            label: `${i.checked ? '✅' : '⬜'} ${i.text}`,
            value: String(i.itemIndex),
          }),
        ),
      ),
    ],
  });
  try {
    const tid = event.threadId;
    await adapter.editMessage(tid, event.messageId, {
      card,
      fallbackText: allItems.map((i) => `${i.checked ? '✅' : '⬜'} ${i.text}`).join('\n'),
    });
  } catch (err) {
    log.warn('Failed to update checklist message after toggle', { err, checklistId });
  }
  return;
}
```

Before implementing the title-preservation TODO left in that snippet: check whether `messages_out` rows are queryable by id cheaply (there should be a `getMessageOutById`-style helper near `writeMessageOut`/`getMessageIdBySeq` in `container/agent-runner/src/db/messages-out.ts` or a host-side equivalent — this logic runs host-side, so find the **host-side** equivalent, e.g. in `src/delivery.ts` or `src/db/`, not the container one). If a cheap lookup exists, re-fetch `title` from the original message's `content` JSON on every toggle. If not, add a `title TEXT NOT NULL` column to the Task 1 migration (going back and amending that migration file is fine — Task 1 has not been used by any deployed data yet) and pass it through in Task 2's tool and Task 3's persistence block. Pick one, implement it fully, and remove the placeholder comment — do not leave a checklist that renders with an empty title.

Before implementing the source-file re-insertion TODO: read the actual deployed `shopping-list.md` (fetch it from `gromit@192.168.1.19:~/nanoclaw/groups/household/memory/tracking/shopping-list.md` — the plan author verified this file's structure during research; it has an `## Items` heading, a flat list of `- item` lines, then an `## How this file works` heading) and write the real insertion logic: find the `## Items` line, then the next blank line or next `##` heading, and insert the new `- item` line immediately before that boundary. Write a unit test against a realistic fixture of that exact structure, not a synthetic one-liner.

- [ ] **Step 7: Run toggle tests, confirm pass**

- [ ] **Step 8: Run the full host test suite** (`pnpm test` from repo root) — confirm nothing else broke, especially the existing `ask_question` tests in this same file.

- [ ] **Step 9: Commit**

```bash
git add src/channels/chat-sdk-bridge.ts src/channels/chat-sdk-bridge.test.ts
git commit -m "feat(checklist): render checklist cards and handle toggle taps host-side"
```

---

### Task 5: Household instructions + deployment + live verification

**Files:**
- Modify (on the Mac directly, not in this git worktree — these are per-install runtime files, not trunk source): `~/nanoclaw/groups/household/instructions.prepend.md`

**Interfaces:**
- Consumes: the `send_checklist` tool from Task 2, live in the rebuilt container image.

- [ ] **Step 1: Build and typecheck everything**

From the worktree root: `pnpm run build`, `pnpm test`, `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`, `cd container/agent-runner && bun test`. All must pass before deploying anything.

- [ ] **Step 2: Deploy the branch to the Mac**

The Mac's `~/nanoclaw` checkout is at the exact same base commit (`b76fcb3d`) this branch forked from, plus local uncommitted install-specific diffs (`package.json`'s `@chat-adapter/telegram` dependency, `pnpm-workspace.yaml`, `src/channels/index.ts`, and the `/add-telegram`-installed files under `src/channels/telegram*`) that must NOT be touched or overwritten. Do not `git checkout` or `git reset` anything on the Mac. Instead:

```bash
git -C <this worktree> diff b76fcb3d --stat   # sanity-check the diff only touches the files this plan listed
git -C <this worktree> archive HEAD | ssh -o IdentitiesOnly=yes -i ~/.ssh/spentkatz_mac gromit@192.168.1.19 "cd ~/nanoclaw && tar -x"
```

`git archive` only writes files that exist in the commit — it will not delete the Mac's locally-modified/untracked Telegram files, since none of this plan's changes touch those paths. Confirm after: `ssh ... "cd ~/nanoclaw && git status --short"` should show exactly this plan's files as modified/added, plus the same pre-existing local diff from before (unchanged).

- [ ] **Step 3: Rebuild and restart the host + container image on the Mac**

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/spentkatz_mac gromit@192.168.1.19 '
export PATH=$HOME/.nvm/versions/node/v22.22.0/bin:$PATH
cd ~/nanoclaw
pnpm install --frozen-lockfile
pnpm run build
./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
'
```

Wait for the service to come back up (check `logs/nanoclaw.log` for a clean startup, no crash-loop) before proceeding.

- [ ] **Step 4: Update household's instructions**

Fetch, edit, redeploy `~/nanoclaw/groups/household/instructions.prepend.md` the same way every other instructions edit this session was done (scp down, edit, scp up). Add a short section teaching Gromit: when asked to show/display the shopping list (or chores/dates), use `send_checklist` instead of plain text, with `sourceFile: "tracking/shopping-list.md"` (or the matching file), so recipients can tap items off directly. Restart household's group container (`ncl groups restart --id ag-915385cd-e977-4cfe-8d8e-bf9688898438 --message "checklist tool live"`).

- [ ] **Step 5: Live verification**

This is real production infrastructure — verify with an actual message and an actual tap, not a code-reading confirmation:
1. Send a message in the household Telegram group asking Gromit to show the shopping list.
2. Confirm a message with real tappable buttons (not plain text) arrives.
3. Tap one item. Confirm: the button updates to show ✅ within roughly a second (no visible delay for an LLM turn), and — separately — that the item is actually gone from `~/nanoclaw/groups/household/memory/tracking/shopping-list.md` on the Mac (`ssh ... cat` the file).
4. Tap the same item again. Confirm it reverts to ⬜ and the line reappears in the file.
5. Check `logs/nanoclaw.log` around the tap timestamps for absence of any container wake / session activity tied to those taps — this is the hard no-LLM-turn requirement from Global Constraints, verify it actually held in production, not just in the unit tests.

Report the outcome of all five checks explicitly — do not report this task done on a "should work" basis.
