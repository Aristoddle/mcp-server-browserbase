import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from the project directory
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const OUTPUT_DIR = path.join(process.env.HOME!, "Documents", "Expenses", "Amazon-2026");
const RAW_FILE = path.join(OUTPUT_DIR, "01-raw-orders.json");

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
  
  console.log(`[Harvester] Connecting to CDP: ${webSocketDebuggerUrl}`);

  const stagehand = new Stagehand({
    env: "LOCAL",
    localBrowserLaunchOptions: { cdpUrl: webSocketDebuggerUrl },
    model: {
        modelName: "openai/gpt-4.1",
        apiKey: process.env.AZURE_API_KEY,
        baseURL: process.env.AZURE_BASE_URL
    },
    experimental: true,
    disableAPI: true,
    logger: (logLine) => {
        if (logLine.level > 1) {
            console.log(`[Stagehand] ${logLine.message}`);
        }
    }
  });

  await stagehand.init();
  const agent = stagehand.agent({ mode: "dom" });

  console.log("[Harvester] Navigating to Amazon and harvesting orders...");
  
  // We'll let the agent handle pagination autonomously
  const result = await agent.execute({
    instruction: "Go to amazon.com/your-orders, find all orders placed in 2026. For each order, extract the orderId, date, total amount, ALL item names, and the link to the invoice (usually 'View invoice'). Paginate through all pages for 2026.",
    maxSteps: 80,
    output: z.object({
      orders: z.array(z.object({
        orderId: z.string(),
        date: z.string(),
        total: z.string(),
        items: z.array(z.string()),
        invoiceUrl: z.string().optional()
      }))
    })
  });

  console.log("[Harvester] Agent execution finished.");
  console.log(JSON.stringify(result, null, 2));

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const orders = (result as any).orders || (result as any).output?.orders || [];
  fs.writeFileSync(RAW_FILE, JSON.stringify(orders, null, 2));
  console.log(`[Harvester] Done! Harvested ${orders.length} orders to ${RAW_FILE}`);
  
  await stagehand.close();
}

main().catch(err => { console.error("Fatal Error:", err); process.exit(1); });