import type { Migration } from './index.js';

/**
 * Checklist items — backs the `send_checklist` MCP tool. Unlike
 * `pending_questions` (one row per question, deleted once answered), a
 * checklist keeps all its item rows for the life of the message: each tap
 * flips `checked` in place, never deletes the row, and the message gets
 * re-rendered with updated buttons. See `src/channels/chat-sdk-bridge.ts`'s
 * `chk:` action-id branch for the toggle handler.
 *
 * `title` is denormalized onto every item row (rather than being re-read from
 * the originating `messages_out` row) because the toggle handler runs
 * host-side on every tap and re-renders the whole card: the alternative would
 * mean opening the session's `outbound.db` across the container mount per tap
 * just to recover one string. It is constant across a checklist's rows.
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
        title          TEXT NOT NULL,
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
