import { env } from "./lib/env.js";
import { buildServer } from "./server.js";

const server = buildServer();

server.listen({ host: "0.0.0.0", port: env.port }).catch((error) => {
  server.log.error(error);
  process.exit(1);
});
