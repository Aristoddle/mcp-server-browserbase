import { Stagehand } from "@browserbasehq/stagehand";

(async () => {
  try {
    const stagehand = new Stagehand({
      env: "LOCAL",
      model: {
        modelName: "azure/claude-sonnet-4-6",
        apiKey: process.env.AZURE_API_KEY,
        baseURL: process.env.AZURE_BASE_URL,
      },
    });
    await stagehand.init();
    await stagehand.page.goto("https://example.com");
    await stagehand.observe();
    await stagehand.close();
  } catch (e) {
    console.error(e);
  }
})();
