/**
 * Checklist persistence tests.
 *
 * Mirrors the existing `ask_question`/`pending_questions` persistence block
 * in `deliverSessionMessages`: delivering a message with
 * `content.type === 'checklist'` must write one `checklist_items` row per
 * item (all `checked: false`) before the channel-delivery call, and must be
 * idempotent under retry (same checklistId/index pairs on a second attempt
 * must not throw).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-delivery-checklist',
    GROUPS_DIR: '/tmp/nanoclaw-test-delivery-checklist/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-delivery-checklist';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup, getDb } from './db/index.js';
import { outboundDbPath } from './mailbox/sqlite/paths.js';
import { resolveSession } from './session-manager.js';
import { deliverSessionMessages, setDeliveryAdapter } from './delivery.js';

function now(): string {
  return new Date().toISOString();
}

async function seedAgentAndChannel(): Promise<void> {
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'telegram:123',
    name: 'Test Chat',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
}

function insertChecklistOutbound(
  agentGroupId: string,
  sessionId: string,
  msgId: string,
  content: Record<string, unknown>,
): void {
  const db = new Database(outboundDbPath(agentGroupId, sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, datetime('now'), 'chat', 'telegram:123', 'telegram', ?)`,
  ).run(msgId, JSON.stringify(content));
  db.close();
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  setDeliveryAdapter({
    async deliver() {
      return 'plat-msg';
    },
  });
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('deliverSessionMessages — checklist persistence', () => {
  it('writes one checklist_items row per item, unchecked, with session/routing fields', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertChecklistOutbound('ag-1', session.id, 'chk-out-1', {
      type: 'checklist',
      checklistId: 'clist-1',
      title: 'Shopping list',
      items: [
        { index: 0, text: 'Milk' },
        { index: 1, text: 'Eggs' },
      ],
      sourceFile: '/workspace/shopping.md',
    });

    await deliverSessionMessages(session);

    const rows = await getDb().all<{
      checklist_id: string;
      item_index: number;
      text: string;
      title: string;
      checked: number;
      session_id: string;
      message_out_id: string;
      platform_id: string | null;
      channel_type: string | null;
      thread_id: string | null;
      source_file: string | null;
    }>('SELECT * FROM checklist_items WHERE checklist_id = ? ORDER BY item_index', 'clist-1');

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      checklist_id: 'clist-1',
      item_index: 0,
      text: 'Milk',
      title: 'Shopping list',
      checked: 0,
      session_id: session.id,
      message_out_id: 'chk-out-1',
      platform_id: 'telegram:123',
      channel_type: 'telegram',
      source_file: '/workspace/shopping.md',
    });
    expect(rows[1]).toMatchObject({
      checklist_id: 'clist-1',
      item_index: 1,
      text: 'Eggs',
      checked: 0,
    });
  });

  it('defaults source_file to null when the checklist has no tracked file', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertChecklistOutbound('ag-1', session.id, 'chk-out-2', {
      type: 'checklist',
      checklistId: 'clist-2',
      title: 'Todo',
      items: [{ index: 0, text: 'Call the bank' }],
    });

    await deliverSessionMessages(session);

    const row = await getDb().get<{ source_file: string | null }>(
      'SELECT source_file FROM checklist_items WHERE checklist_id = ? AND item_index = 0',
      'clist-2',
    );
    expect(row?.source_file).toBeNull();
  });

  // The bridge's render branch refuses to deliver a titleless checklist
  // (logs an error, posts nothing). Persisting rows here anyway would leave
  // orphan checklist_items with no card to tap, so both sites must agree.
  it('persists nothing when the checklist has no title (matches the render branch refusing it)', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertChecklistOutbound('ag-1', session.id, 'chk-out-untitled', {
      type: 'checklist',
      checklistId: 'clist-untitled',
      items: [{ index: 0, text: 'Milk' }],
    });

    await deliverSessionMessages(session);

    const rows = await getDb().all('SELECT * FROM checklist_items WHERE checklist_id = ?', 'clist-untitled');
    expect(rows).toHaveLength(0);
  });

  it('is idempotent under delivery retry: re-delivering the same checklistId does not throw', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertChecklistOutbound('ag-1', session.id, 'chk-out-3', {
      type: 'checklist',
      checklistId: 'clist-3',
      title: 'Retry list',
      items: [{ index: 0, text: 'One' }],
    });

    // First attempt succeeds and creates the row.
    await deliverSessionMessages(session);

    // Simulate a retry by inserting a fresh outbound row with the SAME
    // checklistId/index pair — mirroring what a re-queued/duplicate
    // send_checklist call would produce. createChecklistItems must not
    // throw a UNIQUE constraint error on the (checklist_id, item_index)
    // primary key.
    insertChecklistOutbound('ag-1', session.id, 'chk-out-3-retry', {
      type: 'checklist',
      checklistId: 'clist-3',
      title: 'Retry list',
      items: [{ index: 0, text: 'One' }],
    });
    await expect(deliverSessionMessages(session)).resolves.not.toThrow();

    const rows = await getDb().all('SELECT * FROM checklist_items WHERE checklist_id = ?', 'clist-3');
    expect(rows).toHaveLength(1);
  });
});
