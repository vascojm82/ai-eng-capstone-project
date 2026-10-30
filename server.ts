import "./lib/env.ts";
import express, { type ErrorRequestHandler } from "express";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import authRouter from "./routes/auth.ts";
import assistantRouter from "./routes/assistant.ts";
import voiceRouter from "./routes/voice.ts";

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Behind Prisma's HTTPS proxy: take the client IP and https from X-Forwarded-*,
// for the login rate limit and the cookie's secure flag. Only the one proxy
// hop is trusted, so a client can't fake its IP with its own X-Forwarded-For.
app.set("trust proxy", 1);
// Before express.json(): it checks Retell's signature against the raw body
app.use("/api", voiceRouter); // /api/voice/ask (Retell only, signed requests)
app.use(express.json());

app.use("/api", authRouter); // /api/login, /api/logout, /api/me
app.use("/api", assistantRouter); // /api/chat, /api/search (logged-in users only)

// The React frontend, built by `npm run build` into dist/public next to the
// compiled server. Any other URL gets the app's index.html, so the page loads
// whatever path the browser asks for. Locally with `npm run dev` there's no
// build: the frontend runs on Vite's dev server (npm run dev:web) instead.
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "public");
if (existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(join(publicDir, "index.html")));
}

const jsonErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    res.status(400).json({ error: "Request body must be valid JSON" });
    return;
  }
  next(err);
};

app.use(jsonErrorHandler);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
