import type { CapacitorConfig } from "@capacitor/cli";
const config: CapacitorConfig = {
  appId: "app.liuying.personal",
  appName: "留影",
  webDir: "dist",
  // Bundled UI only. There is deliberately no server.url or remote navigation.
  server: { androidScheme: "https", hostname: "localhost", cleartext: false },
  android: { allowMixedContent: false },
  ios: { contentInset: "automatic", limitsNavigationsToAppBoundDomains: true },
  loggingBehavior: "none",
};
export default config;
