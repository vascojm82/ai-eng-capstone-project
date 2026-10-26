import "./lib/env.ts";
import express, { type ErrorRequestHandler } from "express";
import authRouter from "./routes/auth.ts";
import indexRouter from "./routes/index.ts";

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Behind Prisma's HTTPS proxy: take the client IP and https from X-Forwarded-*,
// for the login rate limit and the cookie's secure flag. Only the one proxy
// hop is trusted, so a client can't fake its IP with its own X-Forwarded-For.
app.set("trust proxy", 1);
app.use(express.json());

app.use("/api", authRouter); // /api/login, /api/logout, /api/me
app.use("/api", indexRouter); // /api/chat, /api/search (logged-in users only)

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
