// src/worker.js

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      // Simple GET health check
      if (request.method === "GET") {
        return new Response(
          "MCP Worker is running. Send JSON-RPC 2.0 via POST.",
          { status: 200 }
        );
      }

      if (request.method !== "POST") {
        return jsonRpcError(null, -32600, "Invalid request method (POST required)", 200);
      }

      let body;
      try {
        body = await request.json();
      } catch (e) {
        return jsonRpcError(null, -32700, "Parse error: invalid JSON", 200);
      }

      // JSON-RPC / MCP path
      if (body && body.jsonrpc === "2.0") {
        return await handleJsonRpc(body, env);
      }

      // Optional legacy mode for manual tests: { method, params }
      const { method, params } = body || {};

      if (method === "list_r2_files") {
        let prefix = params?.path ?? "";

        // Handle root
        if (prefix === "" || prefix === "/") {
          prefix = "";
        } else if (!prefix.endsWith("/")) {
          prefix = prefix + "/";
        }

        const list = await env.R2.list({ prefix });
        const files = list.objects.map((obj) => ({
          key: obj.key,
          size: obj.size,
          lastModified: obj.httpMetadata?.lastModified || null,
        }));

        return legacyJson(
          { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] },
          200
        );
      }

      if (method === "read_r2_file") {
        const path = params?.path;
        if (!path) {
          return legacyJson(
            { content: [{ type: "text", text: "Error: missing 'path'" }] },
            200
          );
        }

        const obj = await env.R2.get(path);
        if (!obj) {
          return legacyJson(
            { content: [{ type: "text", text: `Error: File "${path}" not found` }] },
            200
          );
        }

        const bodyText = await obj.text();
        return legacyJson(
          { content: [{ type: "text", text: bodyText }] },
          200
        );
      }

      // ---- Legacy manual testing endpoint for vector search ----
      if (method === "search_vectors") {
        const query = params?.query;
        const topK = params?.topK ?? 5;

        if (!query) {
          return legacyJson(
            { content: [{ type: "text", text: "Error: missing 'query'" }] },
            200
          );
        }

        try {
          const matches = await searchVectors(env, query, topK);
          return legacyJson(
            {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(matches, null, 2),
                },
              ],
            },
            200
          );
        } catch (e) {
          console.error("search_vectors legacy error", e);
          return legacyJson(
            {
              content: [
                {
                  type: "text",
                  text: `Error running search_vectors: ${e.message}`,
                },
              ],
            },
            200
          );
        }
      }

      return legacyJson(
        { content: [{ type: "text", text: `Unknown method: ${method}` }] },
        200
      );
    } catch (err) {
      console.error("Unexpected MCP worker error", err);
      return jsonRpcError(null, -32603, `Internal error: ${err.message}`, 200);
    }
  },
};

// ---------------
// MCP / JSON-RPC handler for ChatGPT
// ---------------

async function handleJsonRpc(body, env) {
  const { id, method, params } = body;

  // ---- initialize handshake ----
  if (method === "initialize") {
    // You can inspect params.protocolVersion, params.capabilities, params.clientInfo if you want
    const result = {
      protocolVersion: "2024-11-05", // a valid MCP protocol version string
      capabilities: {
        // We only implement tools here
        tools: {},
      },
      serverInfo: {
        name: "gencloud-qa-mcp",
        version: "0.1.0",
      },
      instructions:
        "This server exposes tools for listing and reading files from an R2 bucket and performing semantic search over a Cloudflare Vectorize index.",
    };

    return jsonRpcResult(id, result, 200);
  }

  // ---- tools/list: describe tools to ChatGPT ----
  if (method === "tools/list") {
    const result = {
      tools: [
        {
          name: "list_r2_files",
          description: "List files in the bound R2 bucket under an optional prefix path.",
          inputSchema: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "Optional prefix/folder to list under. Example: 'logs/2025/'.",
              },
            },
            additionalProperties: false,
          },
        },
        {
          name: "read_r2_file",
          description: "Read a text file from the bound R2 bucket.",
          inputSchema: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "Full key/path of the file in R2.",
              },
            },
            required: ["path"],
            additionalProperties: false,
          },
        },
        {
          name: "search_vectors",
          description:
            "Semantic search over the Cloudflare Vectorize index. Returns the most relevant chunks with metadata.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Natural language search query.",
              },
              topK: {
                type: "number",
                description: "Number of top results to return (default: 5).",
              },
            },
            required: ["query"],
            additionalProperties: false,
          },
        },
      ],
    };

    return jsonRpcResult(id, result, 200);
  }

  // ---- tools/call: run one of your tools ----
  if (method === "tools/call") {
    const toolName = params?.name;
    const args = params?.arguments || {};

    if (!toolName) {
      return jsonRpcError(id, -32602, "Missing tool name in params.name", 200);
    }

    // list_r2_files
    if (toolName === "list_r2_files") {
      let prefix = args.path ?? "";

      // If no path is provided (or it's "/" or ""), list from bucket root
      if (prefix === "" || prefix === "/") {
        prefix = "";
      } else if (!prefix.endsWith("/")) {
        prefix = prefix + "/";
      }

      const list = await env.R2.list({ prefix });
      const files = list.objects.map((obj) => ({
        key: obj.key,
        size: obj.size,
        lastModified: obj.httpMetadata?.lastModified || null,
      }));

      return jsonRpcResult(
        id,
        {
          content: [
            {
              type: "text",
              text: JSON.stringify(files, null, 2),
            },
          ],
        },
        200
      );
    }

    // read_r2_file
    if (toolName === "read_r2_file") {
      const path = args.path;
      if (!path) {
        return jsonRpcResult(
          id,
          {
            content: [
              {
                type: "text",
                text: "Error: missing 'path' argument",
              },
            ],
          },
          200
        );
      }

      const obj = await env.R2.get(path);
      if (!obj) {
        return jsonRpcResult(
          id,
          {
            content: [
              {
                type: "text",
                text: `Error: File "${path}" not found`,
              },
            ],
          },
          200
        );
      }

      const bodyText = await obj.text();
      return jsonRpcResult(
        id,
        {
          content: [
            {
              type: "text",
              text: bodyText,
            },
          ],
        },
        200
      );
    }

    // search_vectors
    if (toolName === "search_vectors") {
      const query = args.query;
      const topK = args.topK ?? 5;

      if (!query) {
        return jsonRpcResult(
          id,
          {
            content: [
              {
                type: "text",
                text: "Error: missing 'query' argument",
              },
            ],
          },
          200
        );
      }

      try {
        const matches = await searchVectors(env, query, topK);

        // Return matches as JSON text so the client can parse/use them.
        return jsonRpcResult(
          id,
          {
            content: [
              {
                type: "text",
                text: JSON.stringify(matches, null, 2),
              },
            ],
          },
          200
        );
      } catch (e) {
        console.error("search_vectors error", e);
        return jsonRpcResult(
          id,
          {
            content: [
              {
                type: "text",
                text: `Error running search_vectors: ${e.message}`,
              },
            ],
          },
          200
        );
      }
    }

    return jsonRpcError(id, -32601, `Unknown tool: ${toolName}`, 200);
  }

  // Anything else (like resources/list, prompts/list if you don't support them yet)
  return jsonRpcError(id, -32601, `Unknown method: ${method}`, 200);
}

// ---------------
// Vector search helper
// ---------------

//**
//  * Perform semantic search over the Cloudflare Vectorize index.
//  *
//  * Assumptions:
//  * - VECTOR_INDEX is the Vectorize index created by AI Search "billowing-sunset-5bac".
//  * - AI is a Workers AI binding.
//  * - AI Search used @cf/qwen/qwen3-embedding-0.6b for ingestion,
//  *   so we use the same model for query embeddings.
//  *
//  * @param {any} env - Worker environment (with VECTOR_INDEX and AI bindings).
//  * @param {string} query - Natural language query.
//  * @param {number} topK - Number of results to return.
//  * @returns {Promise<Array>} Matches with id, score, and metadata.
//  */
async function searchVectors(env, query, topK) {
  if (!env.VECTOR_INDEX) {
    throw new Error(
      "VECTOR_INDEX binding is missing. Add a [[vectorize]] binding in wrangler.toml."
    );
  }
  if (!env.AI) {
    throw new Error(
      "AI binding is missing. Add an [ai] binding in wrangler.toml or adjust searchVectors to use your embedding provider."
    );
  }

  // 1. Get embedding for the query via Workers AI (Qwen embedding model)
  const embeddingResponse = await env.AI.run(
    "@cf/qwen/qwen3-embedding-0.6b",
    {
      // AI Search also uses this model for ingesting your data
      text: [query],
    }
  );

  // For Workers AI embeddings, the common shape is:
  // { shape: number[], data: number[][] }
  const embedding = embeddingResponse?.data?.[0];

  if (!embedding || !Array.isArray(embedding)) {
    console.error("Unexpected embeddingResponse:", embeddingResponse);
    throw new Error("Could not extract embedding from Workers AI response.");
  }

  // 2. Query the Vectorize index with the same embedding space as ingestion
  const vectorResult = await env.VECTOR_INDEX.query(embedding, {
    topK,
    // If you later configure namespaces / filters in AI Search, you can mirror them here.
  });

  const matches = vectorResult.matches || vectorResult.results || [];

  // 3. Normalize to a simple shape: [{ id, score, metadata, ... }]
  return matches.map((m) => ({
    id: m.id,
    score: m.score,
    // These depend on what AI Search stored into Vectorize metadata
    source: m.metadata?.source,
    text: m.metadata?.text,
    metadata: m.metadata || {},
  }));
}


// ---------------
// Response helpers
// ---------------

function jsonRpcResult(id, result, httpStatus = 200) {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      result,
    }),
    {
      status: httpStatus,
      headers: { "Content-Type": "application/json" },
    }
  );
}

function jsonRpcError(id, code, message, httpStatus = 200) {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    }),
    {
      status: httpStatus,
      headers: { "Content-Type": "application/json" },
    }
  );
}

function legacyJson(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
