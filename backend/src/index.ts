import { env } from "./lib/env.js";
import { buildServer } from "./server.js";

const server = buildServer();

server
  .listen({ host: "0.0.0.0", port: env.port })
  .then(() => {
    console.log(`ctf-agent backend listening on http://0.0.0.0:${env.port}`);
  })
  .catch((error) => {
    server.log.error(error);
    process.exit(1);
  });
