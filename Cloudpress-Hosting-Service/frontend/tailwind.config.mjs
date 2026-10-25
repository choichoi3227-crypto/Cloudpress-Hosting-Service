/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        primary: '#0052CC',
        secondary: '#172B4D',
        accent: '#FFAB00',
        background: '#F4F5F7',
        'background-dark': '#1A202C',
        text: '#212B36',
        'text-dark': '#E2E8F0',
      },
    },
  },
  plugins: [],
};
