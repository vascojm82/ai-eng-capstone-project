// Loads .env from the project root into process.env. Import this FIRST in any
// file that reads process.env at load time, so the values exist before use.
// Variables already set in the shell win over the ones in .env.
// Resolved from the working directory (not this file) so it also works from
// the compiled copy in dist/.
import { existsSync } from "fs";
import { resolve } from "path";

const envPath = resolve(".env");

if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
