import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Relative base so the static build works at the domain root and under a
  // project path (GitHub Pages /wfm/) alike.
  base: './',
  plugins: [react()],
})
