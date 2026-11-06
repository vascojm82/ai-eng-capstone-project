import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Router, type Response } from "express";
import { appConfig } from "../lib/config.ts";
import { takeMcpAuthFailure, tooManyMcpAuthFailures } from "../lib/limits.ts";
import { findKeyOwner } from "../mcp-server/keys.ts";
import { createMcpServer } from "../mcp-server/server.ts";

// The HTTP endpoint of the MCP server (mcp-server/server.ts), for external agents:
//
//   agent ── POST /api/mcp (Authorization: Bearer sam_…) ──▶ find_manuals / search_manuals
//
// - Streamable HTTP, stateless: every request gets a new server and transport,
//   so nothing is kept between requests (as in the rest of the app).
// - Every request needs an API key from `npm run mcp:keys` (mcp-server/keys.ts),
//   instead of the login cookie: this router is mounted before requireAuth().
// - Wrong keys are limited per IP address; the tool calls themselves are
//   limited per key in mcp-server/server.ts.
// - No DNS-rebinding check is needed: a web page can't send the key, and no
//   CORS headers are set, so a browser can't read the answers.

const router = Router();

/** A JSON-RPC error body, for requests refused before they reach the MCP server */
const rpcError = (res: Response, status: number, message: string) =>
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });

// POST /api/mcp (MCP Streamable HTTP). GET (a server-to-client stream) and
// DELETE (ending a session) aren't used by a stateless server: they get 405,
// as the MCP spec asks, rather than falling through to requireAuth()'s 401.
router.all("/mcp", async (req, res) => {
  if (req.method !== "POST") {
    res.set("Allow", "POST");
    rpcError(res, 405, "Method not allowed: this MCP server is stateless, send every request as a POST");
    return;
  }
  try {
    const { db, openai } = await appConfig();
    if (!db || !openai) {
      rpcError(res, 503, "The manual tools are not configured on this server (database or OpenAI settings missing)");
      return;
    }

    const ip = req.ip ?? "unknown";
    if (tooManyMcpAuthFailures(ip)) {
      res.set("Retry-After", "900");
      rpcError(res, 429, "Too many requests with a wrong API key. Try again in 15 minutes.");
      return;
    }
    const key = req.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const owner = key ? await findKeyOwner(db, key) : null;
    if (!owner) {
      takeMcpAuthFailure(ip);
      res.set("WWW-Authenticate", 'Bearer realm="mcp"');
      rpcError(res, 401, "A valid API key is required: Authorization: Bearer <key>");
      return;
    }

    const server = createMcpServer(db, owner);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("POST /mcp failed:", err);
    if (!res.headersSent) rpcError(res, 500, "Something went wrong, please try again");
  }
});

export default router;
