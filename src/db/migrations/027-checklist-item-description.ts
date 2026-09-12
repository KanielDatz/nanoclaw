import type { Migration } from './index.js';

/**
 * Per-item description text, shown as a `CardText` line under that item's
 * button row rather than crammed into the button label — Telegram buttons
 * render as short, single-line, unwrapped text, so a real description needs
 * its own text block. Unlike `title`/`source_file`/`section_heading` (all
 * denormalized because they're constant across a checklist's rows), this one
 * genuinely varies per item — "take out trash" and "water plants" have
 * different descriptions — so it isn't denormalization, just a column.
 *
 * NULL means no description; that item's row renders exactly as before this
 * migration (button only, no text underneath).
 */
export const migration027: Migration = {
  version: 27,
  name: 'checklist-item-description',
  async up(db) {
    await db.exec(`ALTER TABLE checklist_items ADD COLUMN description TEXT;`);
  },
};
