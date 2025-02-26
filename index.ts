// index.ts - Main server file

import { serve, ServerWebSocket } from "bun";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

// Define types
interface Document {
  id: string;
  title: string;
  content: string;
  updated_at: number;
}

interface DocumentResponse {
  id: string;
  title: string;
  content: string;
  updatedAt: number;
}

interface DocumentListItem {
  id: string;
  title: string;
  updatedAt: number;
}

interface JoinMessage {
  type: "join";
  documentId: string;
}

interface UpdateMessage {
  type: "update";
  content: string;
  cursor?: {
    start: number;
    end: number;
  };
}

interface CursorMessage {
  type: "cursor";
  position: {
    start: number;
    end: number;
  };
}

interface HeartbeatMessage {
  type: "heartbeat";
  timestamp: number;
}

// Custom WebSocket data type
interface WSData {
  clientId: string;
}

// Message union type
type WebSocketMessage =
  | JoinMessage
  | UpdateMessage
  | CursorMessage
  | HeartbeatMessage;

// Initialize SQLite database
const db = new Database("documents.sqlite");
db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

// Prepare statements
const getDocumentStmt = db.prepare("SELECT * FROM documents WHERE id = ?");
const listDocumentsStmt = db.prepare(
  "SELECT id, title, updated_at FROM documents ORDER BY updated_at DESC"
);
const createDocumentStmt = db.prepare(
  "INSERT INTO documents VALUES (?, ?, ?, ?)"
);
const updateDocumentStmt = db.prepare(
  "UPDATE documents SET content = ?, updated_at = ? WHERE id = ?"
);
const deleteDocumentStmt = db.prepare("DELETE FROM documents WHERE id = ?");

// Active connections by document
const documentConnections = new Map<string, Set<ServerWebSocket<WSData>>>();

// Keep track of client document IDs
const clientDocuments = new Map<ServerWebSocket<WSData>, string>();

// All active connections for heartbeats
const allConnections = new Set<ServerWebSocket<WSData>>();

// Read HTML template
const indexHtml = readFileSync("./public/index.html", "utf8");

// Start the server
const server = serve({
  port: process.env.PORT ? parseInt(process.env.PORT) : 3000,
  fetch(req, server) {
    const url = new URL(req.url);

    // Handle WebSocket upgrade
    if (url.pathname === "/ws") {
      const clientId = Math.random().toString(36).substring(2, 10);
      const upgraded = server.upgrade(req, {
        data: { clientId },
      });

      if (upgraded) {
        // Connection was upgraded
        return;
      }
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // API routes
    if (url.pathname.startsWith("/api")) {
      // List documents
      if (url.pathname === "/api/documents" && req.method === "GET") {
        const documents = listDocumentsStmt.all() as any[];
        const response: DocumentListItem[] = documents.map((doc) => ({
          id: doc.id,
          title: doc.title,
          updatedAt: doc.updated_at,
        }));

        return Response.json(response);
      }

      // Get a specific document
      if (
        url.pathname.match(/^\/api\/documents\/[\w-]+$/) &&
        req.method === "GET"
      ) {
        const documentId = url.pathname.split("/").pop() as string;
        const document = getDocumentStmt.get(documentId) as Document | null;

        if (!document) {
          return new Response(JSON.stringify({ error: "Document not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        const response: DocumentResponse = {
          id: document.id,
          title: document.title,
          content: document.content,
          updatedAt: document.updated_at,
        };

        return Response.json(response);
      }

      // Create a new document
      if (url.pathname === "/api/documents" && req.method === "POST") {
        return req.json().then((body) => {
          const { title, content } = body as {
            title?: string;
            content?: string;
          };

          if (!title || !content) {
            return new Response(
              JSON.stringify({ error: "Title and content are required" }),
              {
                status: 400,
                headers: { "Content-Type": "application/json" },
              }
            );
          }

          const documentId = crypto.randomUUID();
          const timestamp = Date.now();

          createDocumentStmt.run(documentId, title, content, timestamp);

          // Broadcast document list update to all connected clients
          const documentListUpdateMessage = JSON.stringify({
            type: "document_list_update",
          });

          for (const ws of allConnections) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(documentListUpdateMessage);
            }
          }

          return Response.json(
            {
              id: documentId,
              title: title,
              content: content,
              updatedAt: timestamp,
            },
            { status: 201 }
          );
        });
      }

      // Delete a document
      if (
        url.pathname.match(/^\/api\/documents\/[\w-]+$/) &&
        req.method === "DELETE"
      ) {
        const documentId = url.pathname.split("/").pop() as string;

        // Check if document exists
        const document = getDocumentStmt.get(documentId) as Document | null;

        if (!document) {
          return new Response(JSON.stringify({ error: "Document not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Delete the document
        deleteDocumentStmt.run(documentId);

        // Close any WebSocket connections related to this document
        if (documentConnections.has(documentId)) {
          const connections =
            documentConnections.get(documentId) ||
            new Set<ServerWebSocket<WSData>>();

          for (const ws of connections) {
            // Send a notification that the document was deleted
            ws.send(
              JSON.stringify({
                type: "document_deleted",
                documentId: documentId,
              })
            );

            // Remove document association
            clientDocuments.delete(ws);
          }

          // Clear the document connections
          documentConnections.delete(documentId);
        }

        // Broadcast document list update to all connected clients
        const documentListUpdateMessage = JSON.stringify({
          type: "document_list_update",
        });

        for (const ws of allConnections) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(documentListUpdateMessage);
          }
        }

        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Serve static files
    if (url.pathname.startsWith("/public/")) {
      try {
        const filePath = `.${url.pathname}`;
        const file = Bun.file(filePath);
        return new Response(file);
      } catch (error) {
        return new Response("Not Found", { status: 404 });
      }
    }

    // Default: serve the app
    return new Response(indexHtml, {
      headers: { "Content-Type": "text/html" },
    });
  },
  websocket: {
    open(ws: ServerWebSocket<WSData>) {
      // Add to all connections set for heartbeats
      allConnections.add(ws);
    },
    message(ws: ServerWebSocket<WSData>, message: string) {
      try {
        const data = JSON.parse(message) as WebSocketMessage;

        switch (data.type) {
          case "join": {
            const documentId = data.documentId;

            // Store document ID for this client
            clientDocuments.set(ws, documentId);

            // Get document content
            const document = getDocumentStmt.get(documentId) as Document | null;
            if (document) {
              ws.send(
                JSON.stringify({
                  type: "document",
                  content: document.content,
                })
              );
            }

            // Add to active connections
            if (!documentConnections.has(documentId)) {
              documentConnections.set(documentId, new Set());
            }
            documentConnections.get(documentId)?.add(ws);
            break;
          }

          case "update": {
            const updateDocId = clientDocuments.get(ws);
            if (!updateDocId) return;

            // Update document in database
            updateDocumentStmt.run(data.content, Date.now(), updateDocId);

            // Broadcast to all connected clients except sender
            const connections =
              documentConnections.get(updateDocId) ||
              new Set<ServerWebSocket<WSData>>();
            for (const client of connections) {
              if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(
                  JSON.stringify({
                    type: "update",
                    content: data.content,
                    cursor: data.cursor,
                  })
                );
              }
            }
            break;
          }

          case "cursor": {
            const cursorDocId = clientDocuments.get(ws);
            if (!cursorDocId) return;

            // Broadcast cursor position to all clients except sender
            const clients =
              documentConnections.get(cursorDocId) ||
              new Set<ServerWebSocket<WSData>>();
            for (const client of clients) {
              if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(
                  JSON.stringify({
                    type: "cursor",
                    position: data.position,
                    clientId:
                      ws.data?.clientId ||
                      Math.random().toString(36).substring(2, 10),
                  })
                );
              }
            }
            break;
          }
        }
      } catch (error) {
        console.error("WebSocket message error:", error);
      }
    },
    close(ws: ServerWebSocket<WSData>) {
      // Get document ID for this client
      const documentId = clientDocuments.get(ws);

      // Remove from connections
      if (documentId && documentConnections.has(documentId)) {
        documentConnections.get(documentId)?.delete(ws);

        // Clean up empty document connections
        if (documentConnections.get(documentId)?.size === 0) {
          documentConnections.delete(documentId);
        }
      }

      // Remove from client documents map
      clientDocuments.delete(ws);

      // Remove from all connections
      allConnections.delete(ws);
    },
  },
});

console.log(`Server running at http://localhost:${server.port}`);

// Send a heartbeat to all connected clients every 30 seconds
setInterval(() => {
  const heartbeatMessage = JSON.stringify({
    type: "heartbeat",
    timestamp: Date.now(),
  });

  // Send to all active connections
  for (const ws of allConnections) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(heartbeatMessage);
    }
  }
}, 30000);
