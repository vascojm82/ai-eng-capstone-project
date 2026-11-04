// LangSmith tracing: every chat or phone question becomes one trace in
// LangSmith, with the agent's model calls, its tool calls and the manual
// passages they returned (see runAgent() in agents/manual-assistant.ts).
//
// The langsmith SDK reads its settings from LANGSMITH_* variables when it
// sends the first trace, not at import:
// - Locally: from .env (LANGSMITH_TRACING, LANGSMITH_API_KEY, ...).
// - On Prisma: the server gets them from service.input() instead, and
//   lib/config.ts copies them into process.env with configureTracing()
//   before the first request is answered.
// With LANGSMITH_TRACING unset or not "true", nothing is sent.

import { RunTree } from "langsmith/run_trees";

type TracingSettings = {
  tracing?: string;
  apiKey?: string;
  endpoint?: string;
  agentId?: string;
  agentEnvironment?: string;
};

export function configureTracing(settings: TracingSettings) {
  const env: Record<string, string | undefined> = {
    LANGSMITH_TRACING: settings.tracing,
    LANGSMITH_API_KEY: settings.apiKey,
    LANGSMITH_ENDPOINT: settings.endpoint,
    LANGSMITH_AGENT_ID: settings.agentId,
    LANGSMITH_AGENT_ENVIRONMENT: settings.agentEnvironment,
  };
  for (const [name, value] of Object.entries(env)) {
    if (value) process.env[name] = value;
  }
}

/** Waits until the traces still queued have been sent, e.g. before the process exits */
export async function flushTraces() {
  await RunTree.getSharedClient().awaitPendingTraceBatches();
}
