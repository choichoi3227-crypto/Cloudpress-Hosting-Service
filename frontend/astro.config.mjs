import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import react from '@astrojs/react';
import cloudflare from '@astrojs/cloudflare';

exportdefaultdefineConfig({
  site: 'https://cloud-press.co.kr',
  output: 'server',
  integrations: [tailwind(), react(), cloudflare()],
  vite: {
    resolve: {
      alias: {
        '@': '/src',
      },
    },
    ssr: {
      noExternal: ['lucide-react']
    }
  }
});
