import { env } from "./lib/env.ts";
import { buildServer } from "./server.ts";

const server = buildServer();

server.listen({ host: "0.0.0.0", port: env.port }).catch((error) => {
  server.log.error(error);
  process.exit(1);
});
