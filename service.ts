// The deployed API service. The deploy copies dist/ (the `npm run build`
// output) and stages the node_modules packages it imports.
import node from "@prisma/composer/node";
import { compute } from "@prisma/composer-prisma-cloud";
import { dataContract, postgres } from "@prisma/composer-prisma-cloud/orm";
import type { Contract } from "./src/prisma/contract.d.ts";
import contractJson from "./src/prisma/contract.json" with { type: "json" };

export const contract = dataContract<Contract>(contractJson);

export default compute({
  name: "api",
  deps: { database: postgres(contract) },
  build: node({
    module: import.meta.url,
    dir: "./dist",
    entry: "server.js",
    dependencies: "external",
  }),
});
