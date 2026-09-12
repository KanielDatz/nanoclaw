import { getDb } from './connection.js';

// ── Checklist Items ──

export interface ChecklistItem {
  checklistId: string;
  itemIndex: number;
  text: string;
  /** The checklist's title, denormalized onto every row (see migration 025). */
  title: string;
  checked: boolean;
  sessionId: string;
  messageOutId: string;
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  sourceFile: string | null;
  /** Markdown heading `sourceFile`'s items live under. `null` means "Items". */
  sectionHeading: string | null;
  createdAt: string;
}

interface ChecklistItemRow {
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
  section_heading: string | null;
  created_at: string;
}

function fromRow(row: ChecklistItemRow): ChecklistItem {
  return {
    checklistId: row.checklist_id,
    itemIndex: row.item_index,
    text: row.text,
    title: row.title,
    checked: row.checked !== 0,
    sessionId: row.session_id,
    messageOutId: row.message_out_id,
    platformId: row.platform_id,
    channelType: row.channel_type,
    threadId: row.thread_id,
    sourceFile: row.source_file,
    sectionHeading: row.section_heading,
    createdAt: row.created_at,
  };
}

/**
 * Bulk insert checklist item rows, all sharing the same `checklistId`.
 * Idempotent the same way `createPendingQuestion` is: when delivery fails
 * and retries, the second attempt calls this again with the same
 * checklistId/itemIndex pairs — without `ON CONFLICT ... DO NOTHING` that
 * would throw UNIQUE on the (checklist_id, item_index) primary key and
 * prevent the retry from reaching the actual send step.
 */
export async function createChecklistItems(items: ChecklistItem[]): Promise<void> {
  const db = getDb();
  await db.transaction(async () => {
    for (const item of items) {
      await db.run(
        `INSERT INTO checklist_items
             (checklist_id, item_index, text, title, checked, session_id, message_out_id, platform_id, channel_type, thread_id, source_file, section_heading, created_at)
           VALUES
             (@checklist_id, @item_index, @text, @title, @checked, @session_id, @message_out_id, @platform_id, @channel_type, @thread_id, @source_file, @section_heading, @created_at)
           ON CONFLICT (checklist_id, item_index) DO NOTHING`,
        {
          checklist_id: item.checklistId,
          item_index: item.itemIndex,
          text: item.text,
          title: item.title,
          checked: item.checked ? 1 : 0,
          session_id: item.sessionId,
          message_out_id: item.messageOutId,
          platform_id: item.platformId,
          channel_type: item.channelType,
          thread_id: item.threadId,
          source_file: item.sourceFile,
          section_heading: item.sectionHeading,
          created_at: item.createdAt,
        },
      );
    }
  });
}

export async function getChecklistItem(checklistId: string, itemIndex: number): Promise<ChecklistItem | undefined> {
  const row = await getDb().get<ChecklistItemRow>(
    'SELECT * FROM checklist_items WHERE checklist_id = ? AND item_index = ?',
    checklistId,
    itemIndex,
  );
  return row ? fromRow(row) : undefined;
}

/** All items for one checklist, ordered by `item_index`. */
export async function getChecklistItems(checklistId: string): Promise<ChecklistItem[]> {
  const rows = await getDb().all<ChecklistItemRow>(
    'SELECT * FROM checklist_items WHERE checklist_id = ? ORDER BY item_index',
    checklistId,
  );
  return rows.map(fromRow);
}

export async function setChecklistItemChecked(checklistId: string, itemIndex: number, checked: boolean): Promise<void> {
  await getDb().run(
    'UPDATE checklist_items SET checked = ? WHERE checklist_id = ? AND item_index = ?',
    checked ? 1 : 0,
    checklistId,
    itemIndex,
  );
}
