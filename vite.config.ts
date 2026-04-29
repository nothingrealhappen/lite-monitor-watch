import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 35001,
    host: "0.0.0.0"
  },
  plugins: [remix()]
});
