import type { Migration } from './index.js';

/**
 * Which markdown heading in `source_file` a checklist's items live under, for
 * the sourceFile-sync toggle logic (`itemsSectionRange` in
 * chat-sdk-bridge.ts). Denormalized onto every item row for the same reason
 * `title` is (see migration 025) — constant per checklist, read host-side on
 * every tap.
 *
 * NULL means "Items" (the original, pre-this-migration behavior) — every
 * checklist created before this column existed, and any future checklist
 * that doesn't need a different section name, keeps working unchanged.
 */
export const migration026: Migration = {
  version: 26,
  name: 'checklist-section-heading',
  async up(db) {
    await db.exec(`ALTER TABLE checklist_items ADD COLUMN section_heading TEXT;`);
  },
};
