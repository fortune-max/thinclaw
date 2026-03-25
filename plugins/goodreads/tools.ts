import type Anthropic from "@anthropic-ai/sdk";
import type { ToolHandler } from "../../src/plugins/types.js";

const GR_BASE = "https://www.goodreads.com";
const GQL_URL = "https://kxbwmqov6jgg3daaamb744ycu4.appsync-api.us-east-1.amazonaws.com/graphql";

// JWT cache
let jwtToken: string = "";
let jwtExpiry: number = 0;

async function getJwt(secrets: Record<string, string>): Promise<string> {
  // Return cached JWT if still valid (with 30s buffer)
  if (jwtToken && Date.now() < jwtExpiry - 30000) return jwtToken;

  if (!secrets.GOODREADS_AT_MAIN || !secrets.GOODREADS_UBID_MAIN) {
    throw new Error("GOODREADS_AT_MAIN and GOODREADS_UBID_MAIN not set. Get these from browser DevTools → Application → Cookies → goodreads.com.");
  }
  const cookies = `at-main=${secrets.GOODREADS_AT_MAIN}; ubid-main=${secrets.GOODREADS_UBID_MAIN}`;

  // Visit a page to get jwt_token cookie
  const res = await fetch(`${GR_BASE}/book/show/1202`, {
    headers: { Cookie: cookies },
  });

  const setCookies = res.headers.getSetCookie?.() || [];
  const jwtCookie = setCookies.find((c) => c.includes("jwt_token="));

  if (!jwtCookie) {
    throw new Error("Goodreads session cookies expired. Update GOODREADS_COOKIES with fresh cookies from your browser.");
  }

  jwtToken = jwtCookie.split(";")[0].replace("jwt_token=", "");
  jwtExpiry = Date.now() + 5 * 60 * 1000;
  return jwtToken;
}

async function graphql(
  secrets: Record<string, string>,
  operationName: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<any> {
  const jwt = await getJwt(secrets);

  const res = await fetch(GQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ operationName, query, variables }),
  });

  if (!res.ok) {
    if (res.status === 401) {
      jwtToken = "";
      jwtExpiry = 0;
      throw new Error("Goodreads JWT expired. Try again.");
    }
    throw new Error(`Goodreads GraphQL ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  if (data.errors?.length) {
    throw new Error(`Goodreads GraphQL error: ${data.errors[0].message}`);
  }

  return data.data;
}

export function createTools(_secrets: Record<string, string>): {
  tools: Anthropic.Tool[];
  handlers: Record<string, ToolHandler>;
} {
  const tools: Anthropic.Tool[] = [
    {
      name: "goodreads_search",
      description: "Search for books on Goodreads by title, author, or keyword.",
      input_schema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Search query (title, author, keyword)" },
        },
        required: ["query"],
      },
    },
    {
      name: "goodreads_shelve",
      description:
        "Add a book to a Goodreads shelf. Shelves: 'to-read' (want to read), 'currently-reading', 'read', 'did-not-finish'.",
      input_schema: {
        type: "object" as const,
        properties: {
          book_id: {
            type: "string",
            description: "Book ID from Goodreads (the kca:// URI or numeric ID from search)",
          },
          shelf: {
            type: "string",
            enum: ["to-read", "currently-reading", "read", "did-not-finish"],
            description: "Shelf name (default: to-read)",
          },
        },
        required: ["book_id"],
      },
    },
    {
      name: "goodreads_tag",
      description: "Add or remove tags on a book in your Goodreads library.",
      input_schema: {
        type: "object" as const,
        properties: {
          book_id: { type: "string", description: "Book ID (kca:// URI or numeric ID)" },
          add_tags: {
            type: "array",
            items: { type: "string" },
            description: "Tags to add",
          },
          remove_tags: {
            type: "array",
            items: { type: "string" },
            description: "Tags to remove",
          },
        },
        required: ["book_id"],
      },
    },
    {
      name: "goodreads_add_note",
      description: "Add a private note to a book on Goodreads. The note is only visible to you.",
      input_schema: {
        type: "object" as const,
        properties: {
          book_id: { type: "string", description: "Numeric book ID from search" },
          note: { type: "string", description: "Private note text" },
        },
        required: ["book_id", "note"],
      },
    },
    {
      name: "goodreads_shelf_books",
      description: "List books on a specific Goodreads shelf. Can also search within a shelf to check if a specific book is there.",
      input_schema: {
        type: "object" as const,
        properties: {
          shelf: {
            type: "string",
            description: "Shelf name (default: to-read)",
          },
          search: {
            type: "string",
            description: "Optional: search for a specific book within the shelf by title or author",
          },
        },
      },
    },
    {
      name: "goodreads_my_shelves",
      description: "List your Goodreads shelves and tags.",
      input_schema: {
        type: "object" as const,
        properties: {},
      },
    },
  ];

  const handlers: Record<string, ToolHandler> = {
    async goodreads_search(input) {
      const { query } = input as { query: string };

      const res = await fetch(
        `${GR_BASE}/book/auto_complete?format=json&q=${encodeURIComponent(query)}`,
      );

      if (!res.ok) throw new Error(`Goodreads search failed: ${res.status}`);
      const books = await res.json();

      if (books.length === 0) return `No books found for "${query}"`;

      return books
        .slice(0, 8)
        .map(
          (b: any) =>
            `${b.bookId} — "${b.title}" by ${b.author.name} (${b.avgRating}★, ${b.numPages || "?"} pages)`,
        )
        .join("\n");
    },

    async goodreads_shelve(input, secrets) {
      const { book_id, shelf = "to-read" } = input as {
        book_id: string;
        shelf?: string;
      };

      // Resolve numeric ID to kca:// URI if needed
      let bookUri = book_id;
      if (!bookUri.startsWith("kca://")) {
        const bookData = await graphql(
          secrets,
          "getBookByLegacyId",
          `query getBookByLegacyId($legacyId: Int!) {
            getBookByLegacyId(legacyId: $legacyId) {
              id
              title
              __typename
            }
          }`,
          { legacyId: parseInt(bookUri) },
        );
        bookUri = bookData.getBookByLegacyId?.id;
        if (!bookUri) throw new Error(`Book ${book_id} not found.`);
      }

      const data = await graphql(
        secrets,
        "ShelveBook",
        `mutation ShelveBook($input: ShelveBookInput!) {
          shelveBook(input: $input) {
            shelving {
              shelf {
                name
                displayName
                __typename
              }
              book {
                title
                __typename
              }
              __typename
            }
            __typename
          }
        }`,
        { input: { id: bookUri, shelfName: shelf } },
      );

      const result = data.shelveBook?.shelving;
      const bookTitle = result?.book?.title || book_id;
      const shelfName = result?.shelf?.displayName || shelf;
      return `Added "${bookTitle}" to ${shelfName}.`;
    },

    async goodreads_tag(input, secrets) {
      const { book_id, add_tags = [], remove_tags = [] } = input as {
        book_id: string;
        add_tags?: string[];
        remove_tags?: string[];
      };

      let bookUri = book_id;
      if (!bookUri.startsWith("kca://")) {
        const bookData = await graphql(
          secrets,
          "getBookByLegacyId",
          `query getBookByLegacyId($legacyId: Int!) {
            getBookByLegacyId(legacyId: $legacyId) {
              id
              __typename
            }
          }`,
          { legacyId: parseInt(bookUri) },
        );
        bookUri = bookData.getBookByLegacyId?.id;
        if (!bookUri) throw new Error(`Book ${book_id} not found.`);
      }

      const data = await graphql(
        secrets,
        "TagBook",
        `mutation TagBook($input: TagBookInput!) {
          tagBook(input: $input) {
            taggings {
              tag {
                name
                __typename
              }
              __typename
            }
            __typename
          }
        }`,
        {
          input: {
            id: bookUri,
            tagsToApply: add_tags,
            tagsToRemove: remove_tags,
          },
        },
      );

      const tags = data.tagBook?.taggings?.map((t: any) => t.tag.name) || [];
      return `Tags updated. Current tags: ${tags.join(", ") || "none"}`;
    },

    async goodreads_add_note(input, secrets) {
      const { book_id, note } = input as { book_id: string; note: string };

      if (!secrets.GOODREADS_AT_MAIN || !secrets.GOODREADS_UBID_MAIN) {
        throw new Error("Goodreads cookies not set.");
      }
      const cookies = `at-main=${secrets.GOODREADS_AT_MAIN}; ubid-main=${secrets.GOODREADS_UBID_MAIN}`;

      // Get CSRF token from the review edit page (Rails-rendered, has authenticity_token)
      const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
      const pageRes = await fetch(`${GR_BASE}/review/edit/${book_id}`, {
        headers: { Cookie: cookies, "User-Agent": ua },
      });
      const pageHtml = await pageRes.text();
      const csrfToken = pageHtml.match(/authenticity_token[^>]*value="([^"]*)"/)?.[1];

      if (!csrfToken) throw new Error("Could not get CSRF token. Session may be expired.");

      // Update session cookies
      const pageCookies = (pageRes.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
      const allCookies = cookies + (pageCookies ? "; " + pageCookies : "");

      // Submit the note
      const body = new URLSearchParams({
        "utf8": "✓",
        "authenticity_token": csrfToken,
        "shelfChooser": "",
        "review[review]": "",
        "review[spoiler_flag]": "0",
        "readingEditsMade": "",
        "review[notes]": note,
        "review[sell_flag]": "0",
        "next": "Post",
        "source": "form",
      });

      const res = await fetch(`${GR_BASE}/review/update/${book_id}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: allCookies,
          "User-Agent": ua,
        },
        body: body.toString(),
        redirect: "manual",
      });

      if (res.status === 302 || res.status === 200) {
        return `Private note added to book ${book_id}: "${note}"`;
      }
      throw new Error(`Failed to add note: ${res.status}`);
    },

    async goodreads_shelf_books(input, secrets) {
      const { shelf = "to-read", search } = input as { shelf?: string; search?: string };

      if (!secrets.GOODREADS_AT_MAIN || !secrets.GOODREADS_UBID_MAIN) {
        throw new Error("Goodreads cookies not set.");
      }
      const cookies = `at-main=${secrets.GOODREADS_AT_MAIN}; ubid-main=${secrets.GOODREADS_UBID_MAIN}`;

      // Get user ID via GraphQL
      const userData = await graphql(
        secrets,
        "getUser",
        `query getUser { getUser { id: legacyId __typename } }`,
      );
      const userId = userData.getUser?.id;
      if (!userId) throw new Error("Could not get user ID.");

      // Fetch the shelf page, optionally with search
      let url = `${GR_BASE}/review/list/${userId}?shelf=${encodeURIComponent(shelf)}&per_page=20`;
      if (search) url += `&search[query]=${encodeURIComponent(search)}`;

      const res = await fetch(url, {
        headers: { Cookie: cookies },
      });

      if (!res.ok) throw new Error(`Failed to fetch shelf: ${res.status}`);
      const html = await res.text();

      // Parse books from the HTML — split by book block
      const bookBlocks = html.split('class="bookalike review"').slice(1);
      const books: { id: string; title: string; shelves: string[] }[] = [];
      const seen = new Set<string>();

      for (const block of bookBlocks) {
        const idMatch = block.match(/data-resource-id="(\d+)"/);
        const titleMatch = block.match(/field title[\s\S]*?<a[^>]*title="([^"]+)"/) ||
          block.match(/alt="([^"]+)"/);
        if (!idMatch || !titleMatch || seen.has(idMatch[1])) continue;
        seen.add(idMatch[1]);

        // Extract shelf names from shelfLink elements
        const shelfLinks = [...block.matchAll(/class="shelfLink"[^>]*title="([^"]+)"/g)];
        const shelves = shelfLinks
          .map((m) => m[1].replace(/View all books in .*?s /, "").replace(/\.$/, "").trim())
          .filter(Boolean);

        books.push({ id: idMatch[1], title: titleMatch[1], shelves });
      }

      if (books.length === 0) {
        return search
          ? `"${search}" not found on shelf "${shelf}".`
          : `No books found on shelf "${shelf}".`;
      }

      // When searching, filter by the requested shelf since search ignores the shelf param
      const filtered = search
        ? books.filter((b) => b.shelves.some((s) => s.includes(shelf)))
        : books;

      if (filtered.length === 0) {
        return `"${search}" not found on shelf "${shelf}".`;
      }

      return filtered
        .map((b) => `${b.id} — ${b.title}${search ? ` [${b.shelves.join(", ")}]` : ""}`)
        .join("\n");
    },

    async goodreads_my_shelves(_input, secrets) {
      const data = await graphql(
        secrets,
        "getUser",
        `query getUser {
          getUser {
            id: legacyId
            shelvesAndTags {
              shelves {
                name
                displayName
                __typename
              }
              tags {
                name
                __typename
              }
              __typename
            }
            __typename
          }
        }`,
      );

      const shelves = data.getUser?.shelvesAndTags?.shelves || [];
      const tags = data.getUser?.shelvesAndTags?.tags || [];

      const shelfList = shelves.map((s: any) => `📚 ${s.displayName} (${s.name})`).join("\n");
      const tagList = tags.map((t: any) => t.name).join(", ");

      return `Shelves:\n${shelfList}\n\nTags: ${tagList || "none"}`;
    },
  };

  return { tools, handlers };
}
