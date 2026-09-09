/**
 * Tests for the `send_checklist` MCP tool: arg validation and the exact
 * `messages_out` content shape (`{type:'checklist', checklistId, title,
 * items:[{index,text}], sourceFile}`) that Task 3 and Task 4 consume.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { sendChecklist } from './checklist.js';

beforeEach(() => {
  initTestSessionDb();
  // Seed a channel destination
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('family', 'Family', 'channel', 'telegram', 'chat-123', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

describe('send_checklist MCP tool', () => {
  it('requires to', async () => {
    const result = await sendChecklist.handler({ title: 'Shopping', items: ['milk'] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('to is required');
  });

  it('requires title', async () => {
    const result = await sendChecklist.handler({ to: 'family', items: ['milk'] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('title is required');
  });

  it('requires a non-empty items array', async () => {
    const missing = await sendChecklist.handler({ to: 'family', title: 'Shopping' });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('items must be a non-empty array');

    const empty = await sendChecklist.handler({ to: 'family', title: 'Shopping', items: [] });
    expect(empty.isError).toBe(true);
    expect(empty.content[0].text).toContain('items must be a non-empty array');
  });

  it('rejects an unknown destination', async () => {
    const result = await sendChecklist.handler({ to: 'nope', title: 'Shopping', items: ['milk'] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown destination');
  });

  it('writes a messages_out row with the checklist content shape', async () => {
    const result = await sendChecklist.handler({
      to: 'family',
      title: 'Shopping List',
      items: ['milk', 'eggs', 'bread'],
      sourceFile: 'tracking/shopping-list.md',
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Checklist sent to family');

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('chat');
    expect(out[0].channel_type).toBe('telegram');
    expect(out[0].platform_id).toBe('chat-123');

    const content = JSON.parse(out[0].content);
    expect(content.type).toBe('checklist');
    expect(typeof content.checklistId).toBe('string');
    expect(content.checklistId.length).toBeLessThan(20);
    expect(content.title).toBe('Shopping List');
    expect(content.items).toEqual([
      { index: 0, text: 'milk' },
      { index: 1, text: 'eggs' },
      { index: 2, text: 'bread' },
    ]);
    expect(content.sourceFile).toBe('tracking/shopping-list.md');
  });

  it('defaults sourceFile to null when omitted', async () => {
    await sendChecklist.handler({ to: 'family', title: 'Shopping', items: ['milk'] });

    const out = getUndeliveredMessages();
    const content = JSON.parse(out[0].content);
    expect(content.sourceFile).toBeNull();
  });
});
