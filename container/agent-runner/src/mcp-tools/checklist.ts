/**
 * `send_checklist` MCP tool: posts a tappable checklist (one button per
 * item) to a destination. This tool only writes the outbound `messages_out`
 * row shaped `{type:'checklist', checklistId, title,
 * items:[{index,text,description}], sourceFile, section}` — the host-side
 * rendering, the `chk:` action-id dispatch, and any file-sync behavior for
 * `sourceFile` are handled elsewhere (see src/channels/chat-sdk-bridge.ts
 * and src/delivery.ts).
 *
 * Helper style (resolveRouting/destinationList/ok/err/generateId) is
 * duplicated from core.ts rather than shared — see core.ts's own doc
 * comment on why outbound tools resolve destinations this way.
 */
import { findByName, getAllDestinations } from '../destinations.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getCurrentInReplyTo } from '../db/session-state.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function destinationList(): string {
  const all = getAllDestinations();
  if (all.length === 0) return '(none)';
  return all.map((d) => d.name).join(', ');
}

/**
 * Resolve a destination name to routing fields.
 *
 * Look up the explicitly named destination. If it resolves to
 * the same channel the session is bound to, the session's thread_id is
 * preserved so replies land in the correct thread. Otherwise thread_id
 * is null (a cross-destination send starts a new conversation).
 */
function resolveRouting(
  to: string,
): { channel_type: string; platform_id: string; thread_id: string | null; resolvedName: string } | { error: string } {
  const dest = findByName(to);
  if (!dest) return { error: `Unknown destination "${to}". Known: ${destinationList()}` };
  if (dest.type === 'channel') {
    // If the destination is the same channel the session is bound to,
    // preserve the thread_id so replies land in the correct thread.
    const session = getSessionRouting();
    const threadId =
      session.channel_type === dest.channelType && session.platform_id === dest.platformId ? session.thread_id : null;
    return {
      channel_type: dest.channelType!,
      platform_id: dest.platformId!,
      thread_id: threadId,
      resolvedName: to,
    };
  }
  return { channel_type: 'agent', platform_id: dest.agentGroupId!, thread_id: null, resolvedName: to };
}

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
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  description: { type: 'string' },
                },
                required: ['text'],
              },
            ],
          },
          description:
            'One entry per button, in the order shown. A bare string is the button label with no extra text. Use {text, description} when the item needs real explanation — description renders as its own text line under that item\'s button (buttons can\'t wrap or show more than a short label), and any item in the list having one switches ALL items in this checklist to one-per-row layout so each description sits under the right button.',
        },
        sourceFile: {
          type: 'string',
          description:
            'Optional. Path relative to this group\'s memory/ directory (e.g. "tracking/shopping-list.md"). When set, each item\'s exact text must match a line in that file (after stripping a leading "- ") so toggling can add/remove it there.',
        },
        section: {
          type: 'string',
          description:
            'Optional, only meaningful with sourceFile. The markdown heading (without "##", e.g. "Open / this week") that bounds where items live in that file — toggling only searches/inserts inside this section, never the file\'s other sections (e.g. a chores file\'s "Standing responsibilities"). Defaults to "Items" if omitted, matching shopping-list.md\'s convention.',
        },
      },
      required: ['to', 'title', 'items'],
    },
  },
  async handler(args) {
    const to = args.to as string;
    const title = args.title as string;
    const rawItems = args.items as Array<string | { text: string; description?: string }>;
    const sourceFile = (args.sourceFile as string) || null;
    const section = (args.section as string) || null;
    if (!to) return err(`to is required. Options: ${destinationList()}`);
    if (!title) return err('title is required');
    if (!Array.isArray(rawItems) || rawItems.length === 0) return err('items must be a non-empty array');
    const items: Array<{ text: string; description: string | null }> = [];
    for (const raw of rawItems) {
      if (typeof raw === 'string') {
        if (!raw) return err('an item cannot be an empty string');
        items.push({ text: raw, description: null });
      } else if (raw && typeof raw === 'object' && typeof raw.text === 'string' && raw.text) {
        items.push({ text: raw.text, description: raw.description || null });
      } else {
        return err('each item must be a non-empty string, or an object with a non-empty "text" field');
      }
    }

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
        items: items.map((item, index) => ({ index, text: item.text, description: item.description })),
        sourceFile,
        section,
      }),
    });

    return ok(`Checklist sent to ${routing.resolvedName} (id: ${seq})`);
  },
};

registerTools([sendChecklist]);
