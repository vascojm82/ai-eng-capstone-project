// Root Prisma Composer module: what `prisma deploy` provisions. The database
// applies the committed migrations/ before the api service starts. The OpenAI,
// login, Retell and LangSmith settings come from the project's environment variables
// on Prisma (`npx prisma project env add ...`), never from .env.
import { module } from "@prisma/composer";
import { envParam, envSecret } from "@prisma/composer-prisma-cloud";
import { postgres } from "@prisma/composer-prisma-cloud/orm";
import api, { contract } from "./service.ts";

export default module("capstone-project", ({ provision }) => {
  const database = provision(
    postgres({ name: "database", contract, config: "./prisma.config.ts" }),
  );
  provision(api, {
    deps: { database },
    input: {
      openaiApiKey: envSecret("OPENAI_API_KEY"),
      openaiBaseUrl: envParam("OPENAI_BASE_URL"),
      appUsers: envSecret("APP_USERS"),
      sessionSecret: envSecret("SESSION_SECRET"),
      retellApiKey: envSecret("RETELL_API_KEY"),
      langsmithTracing: envParam("LANGSMITH_TRACING"),
      langsmithApiKey: envSecret("LANGSMITH_API_KEY"),
      langsmithEndpoint: envParam("LANGSMITH_ENDPOINT"),
      langsmithAgentId: envParam("LANGSMITH_AGENT_ID"),
      langsmithAgentEnvironment: envParam("LANGSMITH_AGENT_ENVIRONMENT"),
    },
  });
});
