import "./env.ts";
import OpenAI from "openai";

// One client for every OpenAI call. Locally the settings come from .env
// (OPENAI_API_KEY, and OPENAI_BASE_URL for a proxy); on Prisma the server
// passes them in with configureOpenAI() (see lib/config.ts). The client is
// created on first use, not at import: the OpenAI SDK throws when the key is
// missing, and the server must still start (and answer 503) without one.
type OpenAISettings = { apiKey?: string; baseURL?: string };

let settings: OpenAISettings | null = null;
let client: OpenAI | null = null;

export function configureOpenAI(next: OpenAISettings) {
  settings = next;
  client = null;
}

export function openai(): OpenAI {
  const { apiKey, baseURL } = settings ?? {
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
  };
  client ??= new OpenAI({ apiKey, baseURL });
  return client;
}

export const EMBEDDING_MODEL = "text-embedding-3-small";

// The embedding size. A one-way door: it must match the chunks.embedding
// column, vector(1536), so changing it means a migration and re-embedding everything.
export const EMBEDDING_DIMENSIONS = 1536;

export async function createEmbedding(text: string): Promise<number[]> {
  const [embedding] = await createEmbeddings([text]);
  return embedding;
}

export async function createEmbeddings(texts: string[]): Promise<number[][]> {
  const response = await openai().embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return response.data.map((d) => d.embedding);
}
