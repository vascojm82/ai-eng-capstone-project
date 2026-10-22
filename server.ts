import "./lib/env.ts";
import express, { type ErrorRequestHandler } from "express";
import indexRouter from "./routes/index.ts";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use(indexRouter);

const jsonErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    res.status(400).json({ error: "Request body must be valid JSON" });
    return;
  }
  next(err);
};

app.use(jsonErrorHandler);

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
