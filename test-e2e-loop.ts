import { Stagehand } from "@browserbasehq/stagehand";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from the project directory
dotenv.config({ path: path.join(__dirname, ".env") });

const TEST_OUTPUT_DIR = path.join(process.env.HOME!, "Documents", "Expenses", "E2E-Test");

async function main() {
  const res = await fetch("http://127.0.0.1:9222/json/version").catch(() => null);
  let webSocketDebuggerUrl;
  if (res && res.ok) {
    const data = await res.json();
    webSocketDebuggerUrl = data.webSocketDebuggerUrl;
  }

  if (!webSocketDebuggerUrl) {
    console.error("No webSocketDebuggerUrl found. Is fallback Chrome running on 9222?");
    process.exit(1);
  }
  
  if (!fs.existsSync(TEST_OUTPUT_DIR)) {
    fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
  }

  console.log(`[E2E] Connecting to CDP: ${webSocketDebuggerUrl}`);

  const stagehand = new Stagehand({
    env: "LOCAL",
    localBrowserLaunchOptions: { cdpUrl: webSocketDebuggerUrl },
    model: {
        modelName: "openai/gpt-4.1",
        apiKey: process.env.AZURE_API_KEY,
        baseURL: process.env.AZURE_BASE_URL
    }
  });

  await stagehand.init();
  const page = await stagehand.context.newPage();

  console.log("[E2E] STEP 1: Harvesting orders via Hybrid Eval...");
  
  await page.goto("https://www.amazon.com/gp/your-account/order-history", { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);

  const orders = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.a-box-group.a-spacing-base')).slice(0, 2);
    return cards.map(el => {
      const orderIdMatch = el.textContent?.match(/\d{3}-\d{7}-\d{7}/);
      const invoiceLink = el.querySelector('a[href*="print.html"]') as HTMLAnchorElement;
      return {
        orderId: orderIdMatch ? orderIdMatch[0] : "unknown",
        invoiceUrl: invoiceLink ? window.location.origin + invoiceLink.getAttribute('href') : null
      };
    }).filter(o => o.invoiceUrl);
  });

  console.log(`[E2E] Harvested ${orders.length} orders.`);

  console.log("[E2E] STEP 2: Archiving invoices...");
  
  for (const order of orders) {
    console.log(`[E2E] Processing Invoice for ${order.orderId}...`);
    const invoicePage = await stagehand.context.newPage();
    
    try {
        await invoicePage.goto(order.invoiceUrl!, { waitUntil: "networkidle" });
        await invoicePage.waitForTimeout(2000);
        
        const filename = `Amazon_Invoice_${order.orderId}.pdf`;
        const filepath = path.join(TEST_OUTPUT_DIR, filename);
        
        const { data } = await (invoicePage as any).mainSession.send("Page.printToPDF", { 
            printBackground: true,
            preferCSSPageSize: true 
        });
        
        fs.writeFileSync(filepath, Buffer.from(data, "base64"));
        console.log(`[E2E]   -> Saved: ${filename}`);
    } catch (e) {
        console.error(`[E2E]   -> Failed to download invoice for ${order.orderId}:`, e);
    } finally {
        await invoicePage.close();
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`\n[E2E] Test Complete. Files in: ${TEST_OUTPUT_DIR}`);
  await stagehand.close();
}

main().catch(err => { console.error("E2E Fatal:", err); process.exit(1); });