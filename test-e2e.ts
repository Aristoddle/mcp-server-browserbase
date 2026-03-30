import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import * as dotenv from "dotenv";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from the project directory
dotenv.config({ path: path.join(__dirname, ".env") });

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
        modelName: "openai/gpt-4.1",
        apiKey: process.env.AZURE_API_KEY,
        baseURL: process.env.AZURE_BASE_URL
    },
    experimental: true,
    disableAPI: true
  });

  await stagehand.init();
  console.log("Stagehand initialized.");

  const agent = stagehand.agent({
    mode: "dom"
  });

  console.log("Executing E2E agent for Amazon (via Azure GPT-4o)...");
  
  const result = await agent.execute({
    instruction: "Navigate to amazon.com/your-orders, find orders from 2026, and extract orderId, date, total amount, and items for the first 2 orders.",
    maxSteps: 30,
    output: z.object({
      orders: z.array(z.object({
        orderId: z.string(),
        date: z.string(),
        total: z.string(),
        items: z.array(z.string())
      }))
    })
  });

  console.log("\n--- E2E RESULTS ---");
  console.log(JSON.stringify(result, null, 2));
  
  await stagehand.close();
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });