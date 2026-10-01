import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// base "./" works on any GitHub Pages path (https://<user>.github.io/<repo>/) with hash routing
export default defineConfig({
  base: "./",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["logo.svg", "icons/apple-touch-icon.png"],
      manifest: {
        name: "Groovy Fragrances Kiosk",
        short_name: "Groovy Kiosk",
        description: "Billing, stock and reports for Groovy Fragrances",
        theme_color: "#654321",
        background_color: "#FAF7F2",
        display: "standalone",
        orientation: "portrait",
        start_url: "./",
        scope: "./",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // the scanner engine (~900 KB) is left out on purpose: only phones without a built-in
        // barcode reader need it, and it is cached the first time the camera is used
        globPatterns: ["**/*.{js,css,html,svg,png}"],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: "index.html",
        runtimeCaching: [
          {
            // fetched the first time the camera scanner runs on a phone that needs it, then kept
            urlPattern: /\.wasm$/,
            handler: "CacheFirst",
            options: { cacheName: "scanner-engine", expiration: { maxEntries: 4, maxAgeSeconds: 31536000 } },
          },
          {
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/,
            handler: "CacheFirst",
            options: { cacheName: "fonts", expiration: { maxEntries: 20, maxAgeSeconds: 31536000 } },
          },
          {
            // every product image, wherever it is hosted — Drive, the website's CDN, or Google storage.
            // Matching by host missed storage.googleapis.com, so a shop with thousands of products
            // re-downloaded every thumbnail on every visit.
            urlPattern: ({ request, url }) => request.destination === "image" && url.protocol === "https:",
            handler: "CacheFirst",
            options: {
              cacheName: "product-images",
              expiration: { maxEntries: 3000, maxAgeSeconds: 2592000, purgeOnQuotaError: true },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  server: { host: true, port: 5173 },
});
