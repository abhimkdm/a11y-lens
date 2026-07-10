import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Tauri compiles into src-tauri/target; watching locked .exe files causes EBUSY on Windows.
      ignored: ["**/src-tauri/**"],
    },
  },
});
