import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

// Using the same parser logic since page.evaluate runs in the browser context
import { OrderData } from "./parser.js";

const OUTPUT_DIR = path.join(os.homedir(), "Documents", "Expenses", "Amazon-2026");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "01-raw-orders.json");

// Zod schema for order validation
const orderSchema = z.object({
  orderId: z.string().min(1),
  date: z.string(),
  total: z.string(),
  items: z.array(z.string()),
  invoiceUrl: z.string().nullable(),
  orderUrl: z.string()
});

async function extractOrdersFromPage(page: any): Promise<OrderData[]> {
  return page.evaluate(() => {
    const results: any[] = [];
    const cards = document.querySelectorAll('.order-card, .js-order-card, .a-box-group.order');
    cards.forEach((card: any) => {
      const idMatch = card.innerHTML.match(/orderID[=:][\s"']*(\d{3}-\d{7}-\d{7})/);
      if (!idMatch) return;
      const orderId = idMatch[1];
      
      const dateMatch = card.textContent?.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/);
      const date = dateMatch ? dateMatch[0] : "Unknown";
      
      const totalEl = card.querySelector('.yohtmlc-order-total .value, .a-color-price');
      const total = totalEl?.textContent?.trim() || "$0.00";
      
      const itemEls = card.querySelectorAll('.yohtmlc-product-title, a[href*="/dp/"]');
      const items = Array.from(itemEls).map((el: any) => el.textContent?.trim()).filter((t: any) => t && t.length > 2);
      
      let invoiceUrl: string | null = null;
      card.querySelectorAll('a').forEach((a: any) => {
        if (a.textContent?.toLowerCase().includes('invoice') || a.href?.toLowerCase().includes('invoice')) {
          invoiceUrl = a.getAttribute('href'); 
        }
      });
      
      results.push({ orderId, date, total, items, invoiceUrl, orderUrl: \`https://www.amazon.com/gp/your-account/order-details?orderID=\${orderId}\` });
    });
    return results;
  });
}

async function getAllOrders(page: any): Promise<OrderData[]> {
  const allOrders: OrderData[] = [];
  let pageNum = 1;
  while (true) {
    console.log(\`Scraping page \${pageNum}...\`);
    const pageOrders = await extractOrdersFromPage(page);
    
    // Validate with Zod
    const validatedOrders = pageOrders.filter((order) => {
      const parsed = orderSchema.safeParse(order);
      if (!parsed.success) {
        console.warn(\`Validation failed for order \${order.orderId}:\`, parsed.error);
        return false;
      }
      return true;
    });
    
    allOrders.push(...validatedOrders);
    console.log(\`  Found \${validatedOrders.length} valid orders (\${allOrders.length} total)\`);
    
    const hasNext = await page.evaluate(() => {
      const next = document.querySelector('.a-pagination .a-last:not(.a-disabled) a');
      if (next) { (next as HTMLAnchorElement).click(); return true; }
      return false;
    });
    
    if (!hasNext || pageNum >= 20) break;
    
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
    pageNum++;
  }
  return allOrders;
}

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
  await page.goto("https://www.amazon.com/your-orders/orders?timeFilter=year-2026", {
    waitUntil: "networkidle",
    timeout: 30000,
  });

  await page.waitForTimeout(3000); 

  const isLoggedIn = await page.evaluate(() => !window.location.href.includes("ap/signin"));
  if (!isLoggedIn) { 
    console.error("Not logged in to Amazon!"); 
    await stagehand.close();
    process.exit(1); 
  }

  const allOrders = await getAllOrders(page);
  console.log(\`\\nTotal raw orders extracted: \${allOrders.length}\`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allOrders, null, 2));
  console.log(\`Saved to \${OUTPUT_FILE}\`);

  await stagehand.close();
}

main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
