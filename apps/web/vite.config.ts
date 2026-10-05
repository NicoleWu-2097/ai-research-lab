import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "API_DEV_");

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/api": env.API_DEV_PROXY_TARGET || "http://localhost:3001",
      },
    },
  };
});
