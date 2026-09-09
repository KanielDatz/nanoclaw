import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initSqliteTestDb, closeDb } from './connection.js';
import { runMigrations } from './migrations/index.js';
import { createAgentGroup } from './agent-groups.js';
import { createSession } from './sessions.js';
import { createChecklistItems, getChecklistItem, getChecklistItems, setChecklistItemChecked } from './checklists.js';
import type { ChecklistItem } from './checklists.js';

function now() {
  return new Date().toISOString();
}

beforeEach(async () => {
  const db = await initSqliteTestDb();
  await runMigrations(db);

  await createAgentGroup({
    id: 'ag-1',
    name: 'Agent',
    folder: 'agent',
    agent_provider: null,
    created_at: now(),
  });
  await createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
});

afterEach(async () => {
  await closeDb();
});

function item(overrides: Partial<ChecklistItem> = {}): ChecklistItem {
  return {
    checklistId: 'chk-1',
    itemIndex: 0,
    text: 'Milk',
    checked: false,
    sessionId: 'sess-1',
    messageOutId: 'msg-out-1',
    platformId: 'chan-1',
    channelType: 'telegram',
    threadId: null,
    sourceFile: null,
    createdAt: now(),
    ...overrides,
  };
}

describe('checklist items', () => {
  it('createChecklistItems inserts all items, getChecklistItems returns them ordered by index', async () => {
    await createChecklistItems([
      item({ itemIndex: 1, text: 'Eggs' }),
      item({ itemIndex: 0, text: 'Milk' }),
      item({ itemIndex: 2, text: 'Bread' }),
    ]);

    const items = await getChecklistItems('chk-1');
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.itemIndex)).toEqual([0, 1, 2]);
    expect(items.map((i) => i.text)).toEqual(['Milk', 'Eggs', 'Bread']);
    expect(items[0].checked).toBe(false);
    expect(items[0].sessionId).toBe('sess-1');
    expect(items[0].messageOutId).toBe('msg-out-1');
  });

  it('createChecklistItems is idempotent — calling twice with the same checklistId/index does not throw or duplicate', async () => {
    const items = [item({ itemIndex: 0, text: 'Milk' }), item({ itemIndex: 1, text: 'Eggs' })];
    await createChecklistItems(items);
    await expect(createChecklistItems(items)).resolves.not.toThrow();

    const result = await getChecklistItems('chk-1');
    expect(result).toHaveLength(2);
  });

  it('getChecklistItem returns undefined for an unknown checklistId/index pair', async () => {
    await createChecklistItems([item({ itemIndex: 0 })]);
    expect(await getChecklistItem('chk-1', 99)).toBeUndefined();
    expect(await getChecklistItem('chk-unknown', 0)).toBeUndefined();
  });

  it('setChecklistItemChecked flips only the targeted item, leaves siblings untouched', async () => {
    await createChecklistItems([item({ itemIndex: 0, text: 'Milk' }), item({ itemIndex: 1, text: 'Eggs' })]);

    await setChecklistItemChecked('chk-1', 1, true);

    const zero = await getChecklistItem('chk-1', 0);
    const one = await getChecklistItem('chk-1', 1);
    expect(zero!.checked).toBe(false);
    expect(one!.checked).toBe(true);

    await setChecklistItemChecked('chk-1', 1, false);
    expect((await getChecklistItem('chk-1', 1))!.checked).toBe(false);
  });
});
