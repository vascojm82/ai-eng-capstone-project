import "./env.ts";
import OpenAI from "openai";

// One client for every OpenAI call, honoring OPENAI_BASE_URL (the bootcamp's
// LiteLLM proxy) as well as OPENAI_API_KEY.
export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

export const EMBEDDING_MODEL = "text-embedding-3-small";

// The embedding size. A one-way door: it must match the chunks.embedding
// column, vector(1536), so changing it means a migration and re-embedding everything.
export const EMBEDDING_DIMENSIONS = 1536;

export async function createEmbedding(text: string): Promise<number[]> {
  const [embedding] = await createEmbeddings([text]);
  return embedding;
}

export async function createEmbeddings(texts: string[]): Promise<number[][]> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return response.data.map((d) => d.embedding);
}
