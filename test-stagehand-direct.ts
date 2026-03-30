import { Stagehand } from "@browserbasehq/stagehand";
import "dotenv/config";

(async () => {
  try {
    const httpRes = await fetch("http://127.0.0.1:9222/json/version");
    const data = await httpRes.json();
    const wsUrl = data.webSocketDebuggerUrl;
    console.log("Using WebSocket URL:", wsUrl);

    const stagehand = new Stagehand({
      env: "LOCAL",
      localBrowserLaunchOptions: { cdpUrl: wsUrl },
      model: {
        modelName: "azure/claude-sonnet-4-6",
        apiKey: process.env.AZURE_API_KEY,
        baseURL: process.env.AZURE_BASE_URL,
      },
    });
    
    console.log("Initializing Stagehand...");
    await stagehand.init();
    
    console.log("Navigating to example.com...");
    await stagehand.page.goto("https://example.com");
    
    console.log("Extracting...");
    const extractRes = await stagehand.extract({ instruction: "extract the main heading text" });
    console.log("Extract Result:", extractRes);
    
    console.log("Observing...");
    const obsRes = await stagehand.observe();
    console.log("Observe Result:", obsRes);

    await stagehand.close();
  } catch (e) {
    console.error("Caught error:", e);
  }
})();