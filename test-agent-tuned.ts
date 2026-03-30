import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";

async function main() {
  const res = await fetch("http://127.0.0.1:9222/json/version");
  const { webSocketDebuggerUrl } = await res.json();

  const stagehand = new Stagehand({
    env: "LOCAL",
    localBrowserLaunchOptions: { cdpUrl: webSocketDebuggerUrl },
    model: {
      modelName: "openai/gpt-4.1",
      apiKey: process.env.AZURE_API_KEY!,
      baseURL: process.env.AZURE_BASE_URL!,
    },
    verbose: 2,           // Full debug logging
    selfHeal: true,       // Auto-retry failed actions
    experimental: true,   // Enable hybrid mode
    cacheDir: "stagehand-cache", // Cache actions for reuse
  });

  await stagehand.init();

  // Use a FRESH page (avoid the 100+ tab problem)
  const page = await stagehand.context.newPage();
  await page.goto("https://www.amazon.com/your-orders/orders?timeFilter=year-2026", {
    waitUntil: "networkidle", timeout: 20000,
  });
  console.log(`Page: ${await page.title()}`);

  // APPROACH 1: observe() → scoped extract() (the pattern Context7 recommends)
  console.log("\n=== APPROACH 1: observe → scoped extract ===");
  const observed = await stagehand.observe("find the first 3 order cards on this page", { page });
  console.log(`Observed ${observed.length} elements`);
  
  if (observed.length > 0) {
    for (const card of observed.slice(0, 3)) {
      console.log(`  Extracting from selector: ${card.selector?.substring(0, 60)}...`);
      try {
        const order = await stagehand.extract(
          "Extract: order date, total price, all item names, and the View Invoice link URL",
          z.object({
            date: z.string(),
            total: z.string(),
            items: z.array(z.string()),
            invoiceUrl: z.string().optional(),
          }),
          { selector: card.selector, page }
        );
        console.log(`  → ${JSON.stringify(order)}`);
      } catch (e: any) {
        console.log(`  → extract failed: ${e.message}`);
      }
    }
  }

  // APPROACH 2: agent() with dual-model (reasoning + execution)
  console.log("\n=== APPROACH 2: agent() with dual model ===");
  try {
    const agent = stagehand.agent({
      mode: "dom",
      model: "openai/gpt-4.1",
      systemPrompt: "You are extracting Amazon order data. Navigate carefully. Use the ariaTree tool to understand the page before acting.",
    });

    const result = await agent.execute({
      instruction: "You are on the Amazon order history page for 2026. Extract the first 2 orders visible. For each, get the order ID (format: XXX-XXXXXXX-XXXXXXX), total price, and all item names.",
      maxSteps: 15,
      output: z.object({
        orders: z.array(z.object({
          orderId: z.string(),
          total: z.string(),
          items: z.array(z.string()),
        }))
      }),
    });
    console.log(`Agent success: ${result.success}, steps: ${result.actions?.length}`);
    console.log(`Output: ${JSON.stringify(result.output, null, 2)}`);
  } catch (e: any) {
    console.log(`Agent failed: ${e.message}`);
  }

  await page.close();
  await stagehand.close();
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
