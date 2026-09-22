import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import uploadRouter from "../uploadRouter";
import { startBackupScheduler, checkAndRunBackupIfNeeded } from "../backup-scheduler";
import { jsonErrorHandler } from "./jsonErrorHandler";
import { ENV } from "./env";
import { LOCAL_STORAGE_DIR } from "../storageLocal";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);
  // Outside Manus (no Forge storage credentials configured — e.g. local
  // `pnpm dev`), server/storage.ts falls back to writing files under
  // LOCAL_STORAGE_DIR; serve them back out at the same path its signed URLs
  // point to. No-op (and harmless) when Forge is configured.
  if (!ENV.forgeApiUrl || !ENV.forgeApiKey) {
    app.use("/local-storage", express.static(LOCAL_STORAGE_DIR));
  }
  // Trigger backup check on every request (non-blocking)
  app.use((_req, _res, next) => {
    checkAndRunBackupIfNeeded();
    next();
  });
  app.use(uploadRouter);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // JSON-only error handler for the API surface. Must be registered after
  // every /api route (including the body parsers above) so a malformed
  // request body, a multer limit, or any other error reaching Express
  // before a route's own try/catch comes back as JSON instead of falling
  // through to Express's default HTML error page.
  app.use("/api", jsonErrorHandler);
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  // Keep PORT accurate after findAvailablePort may have bumped it, so the
  // local storage adapter's signed URLs (which read process.env.PORT at
  // call time) point at wherever the server actually ended up listening.
  process.env.PORT = String(port);

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
    // Start backup scheduler after server is up
    startBackupScheduler();
  });
}

startServer().catch(console.error);
