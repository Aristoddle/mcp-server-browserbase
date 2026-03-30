import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";

async function run() {
  const httpRes = await fetch("http://127.0.0.1:9222/json/version").catch(() => null);
  let cdpUrl;
  if (httpRes && httpRes.ok) {
    const data = await httpRes.json();
    cdpUrl = data.webSocketDebuggerUrl;
  }
  
  if (!cdpUrl) {
    console.log("No cdpUrl found via HTTP. Make sure the fallback Chrome is running.");
    process.exit(1);
  }
  
  console.log("Using CDP URL:", cdpUrl);

  const stagehand = new Stagehand({
    env: "LOCAL",
    localBrowserLaunchOptions: { cdpUrl },
    model: {
        modelName: "gemini-1.5-flash", // Using a widely supported model name
    },
    logger: () => {} // Silence verbose logs for cleaner output
  });

  await stagehand.init();
  console.log("Stagehand initialized.");
  
  // Navigate using the underlying page object
  await stagehand.page.goto("https://www.amazon.com/gp/your-account/order-history");
  console.log("Navigated to Amazon order history.");
  
  const OrderSchema = z.object({
      orders: z.array(z.object({
          date: z.string(),
          totalPrice: z.string(),
          items: z.array(z.string()).describe("List of ALL items in this specific order. Do not miss any."),
          orderNumber: z.string().optional()
      })).length(4).describe("The last 4 recent orders")
  });

  try {
      console.log("Starting extraction...");
      const result = await stagehand.page.extract({ 
          instruction: "Extract the last 4 orders from this page. For each order, ensure you capture ALL items in that order.",
          schema: OrderSchema
      });
      console.log("\n--- EXTRACTION RESULTS ---");
      console.dir(result, { depth: null });
  } catch (e) {
      console.error("Extract failed:", e);
  } finally {
      await stagehand.close();
  }
}

run().catch(console.error);