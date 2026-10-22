import { Router } from "express";

const router = Router();

router.post("/search", async (req, res) => {
  const { query } = req.body ?? {};

  if (typeof query !== "string" || query.trim() === "") {
    res.status(400).json({ error: "`query` must be a non-empty string" });
    return;
  }

  // TODO: replace with real retrieval logic.
  res.json({ query, results: [] });
});

export default router;
