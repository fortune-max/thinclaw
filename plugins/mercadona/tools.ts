import type Anthropic from "@anthropic-ai/sdk";
import type { ToolHandler } from "../../src/plugins/types.js";

const ALGOLIA_APP_ID = process.env.MERCADONA_ALGOLIA_APP_ID || "";
const ALGOLIA_API_KEY = process.env.MERCADONA_ALGOLIA_API_KEY || "";
const ALGOLIA_INDEX = process.env.MERCADONA_ALGOLIA_INDEX || "products_prod_bcn1_es";
const PRODUCT_API = "https://tienda.mercadona.es/api/products";

export function createTools(_secrets: Record<string, string>): {
  tools: Anthropic.Tool[];
  handlers: Record<string, ToolHandler>;
} {
  const tools: Anthropic.Tool[] = [
    {
      name: "mercadona_search",
      description:
        "Search for products on Mercadona by name. Returns product IDs, names, prices, and thumbnails. Use this to find products and their prices.",
      input_schema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Product search query (e.g., 'leche avena', 'pan integral')",
          },
          limit: {
            type: "number",
            description: "Max results to return (default 5)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "mercadona_product",
      description:
        "Get full details of a Mercadona product by ID. Returns price, nutrition info, ingredients, brand, packaging, and photo URLs. Use after searching to get complete info.",
      input_schema: {
        type: "object" as const,
        properties: {
          product_id: {
            type: "string",
            description: "Product ID from mercadona_search results",
          },
        },
        required: ["product_id"],
      },
    },
    {
      name: "mercadona_product_images",
      description:
        "Get high-resolution image URLs for a Mercadona product. Returns zoom-level images (1600x1600) useful for reading ingredient labels and nutrition facts on the packaging.",
      input_schema: {
        type: "object" as const,
        properties: {
          product_id: {
            type: "string",
            description: "Product ID from mercadona_search results",
          },
        },
        required: ["product_id"],
      },
    },
  ];

  const handlers: Record<string, ToolHandler> = {
    async mercadona_search(input) {
      const { query, limit = 5 } = input as { query: string; limit?: number };

      const url =
        `https://${ALGOLIA_APP_ID.toLowerCase()}-dsn.algolia.net/1/indexes/${ALGOLIA_INDEX}/query` +
        `?x-algolia-agent=${encodeURIComponent("Algolia for JavaScript (5.44.0); Search (5.44.0); Browser")}` +
        `&x-algolia-api-key=${ALGOLIA_API_KEY}` +
        `&x-algolia-application-id=${ALGOLIA_APP_ID}`;

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, hitsPerPage: limit, page: 0 }),
      });

      if (!res.ok) throw new Error(`Algolia search failed: ${res.status}`);

      const data = await res.json();

      const hits = data.hits.map((hit: any) => ({
        id: hit.id || hit.objectID,
        name: hit.display_name,
        brand: hit.brand,
        packaging: hit.packaging,
        price: hit.price_instructions?.unit_price,
        price_unit: hit.price_instructions?.reference_format,
        thumbnail: hit.thumbnail,
      }));

      if (hits.length === 0) return `No products found for "${query}"`;
      return JSON.stringify(hits, null, 2);
    },

    async mercadona_product(input) {
      const { product_id } = input as { product_id: string };

      const res = await fetch(`${PRODUCT_API}/${product_id}/`, {
        headers: { "Accept-Language": "es" },
      });

      if (!res.ok) throw new Error(`Mercadona product API ${res.status}`);

      const data = await res.json();

      return JSON.stringify(
        {
          id: data.id,
          name: data.display_name,
          brand: data.brand,
          packaging: data.packaging,
          ean: data.ean,
          price: data.price_instructions?.unit_price,
          price_unit: data.price_instructions?.reference_format,
          bulk_price: data.price_instructions?.bulk_price,
          details: data.details,
          nutrition: data.nutrition_information,
          photo_count: (data.photos || []).length,
        },
        null,
        2,
      );
    },

    async mercadona_product_images(input) {
      const { product_id } = input as { product_id: string };

      const res = await fetch(`${PRODUCT_API}/${product_id}/`, {
        headers: { "Accept-Language": "es" },
      });

      if (!res.ok) throw new Error(`Mercadona product API ${res.status}`);

      const data = await res.json();

      const photos = (data.photos || []).map((photo: any, i: number) => ({
        index: i,
        zoom: photo.zoom, // 1600x1600 — good for reading labels
        regular: photo.regular, // 600x600
        thumbnail: photo.thumbnail, // 300x300
      }));

      if (photos.length === 0) return `No images found for product ${product_id}`;

      return JSON.stringify(
        {
          product_name: data.display_name,
          photos,
        },
        null,
        2,
      );
    },
  };

  return { tools, handlers };
}
