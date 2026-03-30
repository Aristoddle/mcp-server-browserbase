import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import * as os from "os";

async function main() {
  const res = await fetch("http://127.0.0.1:9222/json/version").catch(() => null);
  let webSocketDebuggerUrl;
  if (res && res.ok) {
    const data = await res.json();
    webSocketDebuggerUrl = data.webSocketDebuggerUrl;
  }

  if (!webSocketDebuggerUrl) {
    console.error("No webSocketDebuggerUrl found. Is the fallback Chrome running?");
    process.exit(1);
  }
  
  console.log("Using CDP URL:", webSocketDebuggerUrl);

  const stagehand = new Stagehand({
    env: "LOCAL",
    localBrowserLaunchOptions: { cdpUrl: webSocketDebuggerUrl },
    model: {
        modelName: "google/gemini-2.0-flash",
        apiKey: process.env.GEMINI_API_KEY
    },
    logger: () => {} // Silence verbose logs
  });

  await stagehand.init();
  const page = await stagehand.context.newPage();
  
  console.log("Navigating to Amazon Orders...");
  await page.goto("https://www.amazon.com/gp/your-account/order-history", {
    waitUntil: "networkidle",
    timeout: 30000,
  });

  // Give the page a moment to fully render dynamic React content
  await page.waitForTimeout(3000); 

  console.log(`Page title: ${await page.title()}`);

  console.log("Starting targeted AI extraction...");
  // Scoping the extraction to just the main content area or order cards prevents 
  // the LLM from getting confused by the 21,000+ line full page accessibility tree.
  const orders = await stagehand.extract({
    instruction: "Extract the last 4 orders. For each order, get ALL item names (every single item, not just the first), the order date, and the total price.",
    schema: z.object({
      orders: z.array(
        z.object({
          orderDate: z.string().describe("Date the order was placed"),
          totalPrice: z.string().describe("Total order price"),
          items: z.array(
            z.object({
              name: z.string().describe("Full product name"),
            })
          ).describe("ALL items in this order"),
        })
      ),
    }),
    selector: "#yourOrdersContent" // Target the main orders container
  });

  console.log("\n--- EXTRACTION RESULTS ---");
  console.log(JSON.stringify(orders, null, 2));
  await stagehand.close();
}

main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });