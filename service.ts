// The deployed API service. The deploy copies dist/ (the `npm run build`
// output) and stages the node_modules packages it imports.
//
// On Prisma, the app gets its settings from here instead of .env: the
// database from `deps` (service.load()) and the OpenAI settings from `input`
// (service.input()), bound to platform environment variables in module.ts.
import { secretString } from "@prisma/composer/arktype";
import node from "@prisma/composer/node";
import { compute } from "@prisma/composer-prisma-cloud";
import { dataContract, postgres } from "@prisma/composer-prisma-cloud/orm";
import { type } from "arktype";
import type { Contract } from "./src/prisma/contract.d.ts";
import contractJson from "./src/prisma/contract.json" with { type: "json" };

export const contract = dataContract<Contract>(contractJson);

export default compute({
  name: "api",
  deps: { database: postgres(contract) },
  input: type({
    openaiApiKey: secretString(),
    // Optional: without it the OpenAI SDK calls api.openai.com directly
    "openaiBaseUrl?": "string",
    // Login accounts (username:role:scrypt hash, see lib/auth.ts) and the key that signs session cookies
    appUsers: secretString(),
    sessionSecret: secretString(),
    // Checks that /api/voice/ask requests come from Retell (the key with the webhook badge)
    retellApiKey: secretString(),
  }),
  build: node({
    module: import.meta.url,
    dir: "./dist",
    entry: "server.js",
    dependencies: "external",
  }),
});
