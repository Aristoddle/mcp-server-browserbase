// amazon-invoice-crawler.ts
// Run from: cd projects/mcp-server-browserbase && npx tsx ~/Documents/Expenses/amazon-invoice-crawler.ts
//
// Prerequisites:
// 1. chrome-debug start (fallback Chrome on port 9222)
// 2. Log into Amazon in the debug Chrome
// 3. AZURE_API_KEY + AZURE_BASE_URL in .env

import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import fs from "fs";
import path from "path";

const OUTPUT_DIR = path.join(process.env.HOME!, "Documents", "Expenses", "Amazon-2026");

interface OrderData {
  orderId: string;
  date: string;
  total: string;
  items: string[];
  invoiceUrl: string | null;
  orderUrl: string;
}

interface ClassifiedOrder extends OrderData {
  isExpensable: boolean;
  category: string;
  confidence: number;
  reason: string;
}

const WORK_CATEGORIES: Record<string, RegExp[]> = {
  "electronics": [
    /monitor|display|screen/i, /keyboard|mouse|trackpad/i,
    /usb[-\s]?c|hub|dock|adapter|dongle/i, /hdmi|displayport|cable/i,
    /headset|headphone|microphone|webcam/i, /charger|power\s?supply/i,
    /ssd|hard\s?drive|storage|flash\s?drive/i, /laptop\s?stand|mount|arm/i,
  ],
  "office-supplies": [
    /desk|chair|mat|cushion|lumbar/i, /lamp|light|lighting/i,
    /organizer|shelf|filing|folder/i, /sweater\s?dryer|coat\s?rack/i,
  ],
  "software": [
    /subscription|license/i, /software|app|digital/i,
    /cloud|hosting|domain/i, /vpn|security/i,
  ],
  "reference-materials": [
    /technical\s?book|programming|o'reilly/i,
  ],
};

function classifyOrder(order: OrderData): ClassifiedOrder {
  const itemText = order.items.join(" ");
  for (const [category, patterns] of Object.entries(WORK_CATEGORIES)) {
    for (const pattern of patterns) {
      if (pattern.test(itemText)) {
        return { ...order, isExpensable: true, category, confidence: 8, reason: `Matched "${pattern.source}"` };
      }
    }
  }
  const amount = parseFloat(order.total.replace(/[$,]/g, ""));
  if (amount > 50) {
    return { ...order, isExpensable: false, category: "needs-review", confidence: 3, reason: `High value ($${amount})` };
  }
  return { ...order, isExpensable: false, category: "personal", confidence: 9, reason: "No match" };
}

function parseDate(dateStr: string): string {
  const months: Record<string, string> = {
    january:"01",february:"02",march:"03",april:"04",may:"05",june:"06",
    july:"07",august:"08",september:"09",october:"10",november:"11",december:"12"
  };
  const match = dateStr.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (!match) return "unknown-date";
  const [, month, day, year] = match;
  return `${year}-${months[month.toLowerCase()] || "00"}-${day.padStart(2, "0")}`;
}

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
        if (a.textContent?.toLowerCase().includes('invoice')) invoiceUrl = a.href;
      });
      results.push({ orderId, date, total, items, invoiceUrl, orderUrl: `https://www.amazon.com/gp/your-account/order-details?orderID=${orderId}` });
    });
    return results;
  });
}

async function getAllOrders(page: any): Promise<OrderData[]> {
  const allOrders: OrderData[] = [];
  let pageNum = 1;
  while (true) {
    console.log(`Scraping page ${pageNum}...`);
    const pageOrders = await extractOrdersFromPage(page);
    allOrders.push(...pageOrders);
    console.log(`  Found ${pageOrders.length} orders (${allOrders.length} total)`);
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

async function downloadInvoice(context: any, order: ClassifiedOrder): Promise<string | null> {
  if (!order.invoiceUrl) return null;
  const invoicePage = await context.newPage();
  try {
    const url = order.invoiceUrl.startsWith("http") ? order.invoiceUrl : `https://www.amazon.com${order.invoiceUrl}`;
    await invoicePage.goto(url, { waitUntil: "networkidle", timeout: 20000 });
    await invoicePage.waitForSelector("table, .invoice", { timeout: 10000 }).catch(() => {});
    const isoDate = parseDate(order.date);
    const filename = `${isoDate}_${order.orderId}.pdf`;
    const filepath = path.join(OUTPUT_DIR, filename);
    const { data } = await invoicePage.sendCDP("Page.printToPDF", { printBackground: true, preferCSSPageSize: true });
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(filepath, Buffer.from(data, "base64"));
    console.log(`  Saved: ${filename} (${order.total})`);
    return filepath;
  } catch (err: any) {
    console.error(`  Failed: ${order.orderId}: ${err.message}`);
    return null;
  } finally {
    await invoicePage.close();
  }
}

async function main() {
  const res = await fetch("http://127.0.0.1:9222/json/version");
  const { webSocketDebuggerUrl } = await res.json();
  console.log(`CDP: ${webSocketDebuggerUrl}`);

  const stagehand = new Stagehand({
    env: "LOCAL",
    localBrowserLaunchOptions: { cdpUrl: webSocketDebuggerUrl },
    model: "google/gemini-2.5-flash",
  });
  await stagehand.init();

  const page = await stagehand.context.newPage();
  await page.goto("https://www.amazon.com/your-orders/orders?timeFilter=year-2026", { waitUntil: "networkidle", timeout: 30000 });

  const isLoggedIn = await page.evaluate(() => !window.location.href.includes("ap/signin"));
  if (!isLoggedIn) { console.error("Not logged in!"); process.exit(1); }

  const allOrders = await getAllOrders(page);
  console.log(`\nTotal orders: ${allOrders.length}`);

  const classified = allOrders.map(classifyOrder);
  const expensable = classified.filter(o => o.isExpensable);
  const needsReview = classified.filter(o => o.category === "needs-review");
  console.log(`Expensable: ${expensable.length} | Needs review: ${needsReview.length} | Personal: ${classified.length - expensable.length - needsReview.length}`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const manifest: any[] = [];
  for (const order of [...expensable, ...needsReview]) {
    const pdfPath = await downloadInvoice(stagehand.context, order);
    manifest.push({ ...order, pdfPath });
    await new Promise(r => setTimeout(r, 3000 + Math.random() * 5000));
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`\nManifest: ${OUTPUT_DIR}/manifest.json`);
  console.log(`PDFs: ${OUTPUT_DIR}/`);

  await page.close();
  await stagehand.close();
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
