import type Anthropic from "@anthropic-ai/sdk";
import type { ToolHandler } from "../../src/plugins/types.js";
import {
  createNote,
  listNotes,
  readNote,
  findNoteByTitle,
  updateNote,
  deleteNote,
} from "../../src/db/queries.js";

function formatTimeAgo(unixSeconds: number): string {
  const diffMs = Date.now() - unixSeconds * 1000;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function createTools(_secrets: Record<string, string>): {
  tools: Anthropic.Tool[];
  handlers: Record<string, ToolHandler>;
} {
  const tools: Anthropic.Tool[] = [
    {
      name: "note_create",
      description:
        "Create a new note. Use for saving any kind of text: todo lists, shopping lists, journal entries, snippets, ideas.",
      input_schema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "Note title" },
          content: {
            type: "string",
            description: "Note content (can be multi-line)",
          },
        },
        required: ["title", "content"],
      },
    },
    {
      name: "note_list",
      description:
        "List all notes for the user. Shows titles and last updated time.",
      input_schema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "note_read",
      description: "Read a note by ID or title (partial match).",
      input_schema: {
        type: "object" as const,
        properties: {
          id: { type: "number", description: "Note ID" },
          title: {
            type: "string",
            description: "Search by title (partial match)",
          },
        },
      },
    },
    {
      name: "note_update",
      description:
        "Update a note's title or content. Use when user wants to add to, modify, or replace note content.",
      input_schema: {
        type: "object" as const,
        properties: {
          id: { type: "number", description: "Note ID to update" },
          title: { type: "string", description: "New title (optional)" },
          content: {
            type: "string",
            description: "New content (replaces existing)",
          },
        },
        required: ["id"],
      },
    },
    {
      name: "note_delete",
      description: "Delete a note by ID.",
      input_schema: {
        type: "object" as const,
        properties: {
          id: { type: "number", description: "Note ID to delete" },
        },
        required: ["id"],
      },
    },
  ];

  const handlers: Record<string, ToolHandler> = {
    async note_create(input, _secrets, chatId) {
      const { title, content } = input as { title: string; content: string };
      const id = createNote(chatId!, title, content);
      return `Note "${title}" created (id: ${id}).`;
    },

    async note_list(_input, _secrets, chatId) {
      const notes = listNotes(chatId!);
      if (notes.length === 0) return "No notes yet.";
      return notes
        .map((n) => {
          const ago = formatTimeAgo(n.updatedAt);
          const pin = n.pinned ? " [pinned]" : "";
          return `${n.id}. ${n.title}${pin} (${ago})`;
        })
        .join("\n");
    },

    async note_read(input, _secrets, chatId) {
      const { id, title } = input as { id?: number; title?: string };
      const note = id
        ? readNote(chatId!, id)
        : title
          ? findNoteByTitle(chatId!, title)
          : undefined;
      if (!note) return "Note not found.";
      return `**${note.title}**${note.pinned ? " [pinned]" : ""}\n\n${note.content}`;
    },

    async note_update(input, _secrets, chatId) {
      const { id, title, content } = input as {
        id: number;
        title?: string;
        content?: string;
      };
      const updates: Record<string, unknown> = {};
      if (title) updates.title = title;
      if (content) updates.content = content;
      const ok = updateNote(chatId!, id, updates);
      return ok ? `Note ${id} updated.` : "Note not found.";
    },

    async note_delete(input, _secrets, chatId) {
      const { id } = input as { id: number };
      const ok = deleteNote(chatId!, id);
      return ok ? `Note ${id} deleted.` : "Note not found.";
    },
  };

  return { tools, handlers };
}
