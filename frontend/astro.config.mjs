import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";
import react from "@astrojs/react";
import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  site: "https://cloud-press.co.kr",
  output: "server",
  integrations: [tailwind(), react(), cloudflare()],
  adapter: cloudflare(),
  image: {
    service: {
      entrypoint: "@astrojs/image-service-noop"
    }
  },
  vite: {
    resolve: { alias: { "@": "/src" } },
    ssr: { noExternal: ["lucide-react"] },
    build: {
      rollupOptions: {
        external: ["virtual:image-service"]
      }
    }
  }
});
