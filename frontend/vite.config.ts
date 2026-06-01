import { defineConfig, loadEnv } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [solid()],
    server: {
      port: Number(env.VITE_FRONTEND_PORT ?? 5173),
      proxy: {
        "/hub-api": {
          target: env.VITE_HUB_PROXY_TARGET ?? "http://127.0.0.1:8080",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/hub-api/, "")
        },
        "/match-api": {
          target: env.VITE_MATCH_PROXY_TARGET ?? "http://127.0.0.1:8000",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/match-api/, "")
        }
      }
    }
  };
});
