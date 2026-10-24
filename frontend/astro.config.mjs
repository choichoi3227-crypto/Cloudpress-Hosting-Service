import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";
import react from "@astrojs/react";

// 정적 빌드: frontend/dist 를 루트 Worker(src/worker.ts)가 ASSETS 바인딩으로 서빙한다.
// SSR 어댑터(@astrojs/cloudflare)를 쓰면 dist/_worker.js 가 생성되어 wrangler 배포가 실패한다.
export default defineConfig({
  site: "https://cloud-press.co.kr",
  output: "static",
  integrations: [tailwind(), react()],
  vite: {
    resolve: { alias: { "@": "/src" } },
    ssr: { noExternal: ["lucide-react"] }
  }
});
