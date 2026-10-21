import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import react from '@astrojs/react';

export default defineConfig({
  site: 'https://cloud-press.co.kr',
  output: 'static',
  integrations: [tailwind(), react()],
  vite: {
    ssr: {
      noExternal: ['lucide-react']
    }
  }
});
