// Root Prisma Composer module: what `prisma deploy` provisions. The database
// applies the committed migrations/ before the api service starts.
import { module } from "@prisma/composer";
import { postgres } from "@prisma/composer-prisma-cloud/orm";
import api, { contract } from "./service.ts";

export default module("capstone-project", ({ provision }) => {
  const database = provision(
    postgres({ name: "database", contract, config: "./prisma.config.ts" }),
  );
  provision(api, { deps: { database } });
});
