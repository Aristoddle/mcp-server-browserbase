import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";

const OUT = path.join(process.env.HOME!, "Documents", "Expenses", "Amazon-2026");
fs.mkdirSync(OUT, { recursive: true });

async function main() {
  const { webSocketDebuggerUrl } = await (await fetch("http://127.0.0.1:9222/json/version")).json();
  
  const stagehand = new Stagehand({
    env: "LOCAL",
    localBrowserLaunchOptions: { cdpUrl: webSocketDebuggerUrl },
    model: { modelName: "openai/gpt-4.1", apiKey: process.env.AZURE_API_KEY!, baseURL: process.env.AZURE_BASE_URL! },
  });
  await stagehand.init();

  // STEP 1: Extract all orders
  console.log("=== HARVESTING ALL 2026 ORDERS ===");
  const page = await stagehand.context.newPage();
  let allOrders: any[] = [];
  let pageNum = 1;

  while (true) {
    const url = pageNum === 1 
      ? "https://www.amazon.com/your-orders/orders?timeFilter=year-2026"
      : `https://www.amazon.com/your-orders/orders?timeFilter=year-2026&startIndex=${(pageNum-1)*10}`;
    
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);

    const orders = await page.evaluate(() => {
      const results: any[] = [];
      document.querySelectorAll('.order-card, .js-order-card, .a-box-group.order').forEach((card: any) => {
        const idMatch = card.innerHTML.match(/(\d{3}-\d{7}-\d{7})/);
        if (!idMatch) return;
        const id = idMatch[1];
        const dateMatch = card.textContent?.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/);
        // Find total: look for dollar amount in .a-size-base.a-color-secondary.aok-break-word
        let totalText = "$0";
        card.querySelectorAll('.a-size-base.a-color-secondary.aok-break-word').forEach((span: any) => {
          const t = span.textContent?.trim() || "";
          if (t.match(/^\$[\d,.]+$/) && totalText === "$0") totalText = t;
        });
        // Fallback: scan text after "Total" label
        if (totalText === "$0") {
          const ct = card.textContent || "";
          const ti = ct.indexOf("Total");
          if (ti >= 0) { const m = ct.substring(ti).match(/\$([\d,]+\.\d{2})/); if (m) totalText = "$" + m[1]; }
        }
        const items = Array.from(card.querySelectorAll('.yohtmlc-product-title, a[href*="/dp/"]'))
          .map((el: any) => el.textContent?.trim()).filter((t: any) => t && t.length > 2);
        let invoiceUrl: string | null = null;
        card.querySelectorAll('a').forEach((a: any) => {
          if (a.textContent?.toLowerCase().includes('invoice')) invoiceUrl = a.href;
        });
        results.push({ orderId: id, date: dateMatch?.[0] || "Unknown", total: totalText, items, invoiceUrl });
      });
      return results;
    });

    console.log(`Page ${pageNum}: ${orders.length} orders`);
    allOrders.push(...orders);
    if (orders.length < 10) break;
    pageNum++;
    await page.waitForTimeout(2000);
    if (pageNum > 15) break;
  }

  console.log(`\nTotal: ${allOrders.length} orders`);
  fs.writeFileSync(path.join(OUT, "01-raw-orders.json"), JSON.stringify(allOrders, null, 2));

  // STEP 2: Classify with Azure Foundry
  console.log("\n=== CLASSIFYING WITH AZURE FOUNDRY ===");
  const classified: any[] = [];
  for (let i = 0; i < allOrders.length; i += 5) {
    const batch = allOrders.slice(i, i + 5);
    const prompt = batch.map((o: any, j: number) => `${j+1}. ${o.items.join(", ")} — ${o.total}`).join("\n");
    
    const resp = await fetch(process.env.AZURE_BASE_URL + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": process.env.AZURE_API_KEY! },
      body: JSON.stringify({
        model: "gpt-4.1",
        messages: [{ role: "user", content: `Classify each Amazon order as work-expensable or personal for a Sr. Director of AI at a mortgage tech company. Return JSON array: [{index, isExpensable, category, reason}]\n\n${prompt}` }],
        max_tokens: 1000,
      }),
    });
    const data = await resp.json();
    let classifications: any[] = [];
    try {
      const text = data.choices?.[0]?.message?.content || "[]";
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      classifications = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch { classifications = []; }

    for (const c of classifications) {
      const idx = (c.index || c.idx || 1) - 1;
      if (batch[idx]) {
        classified.push({ ...batch[idx], isExpensable: c.isExpensable, category: c.category, reason: c.reason });
      }
    }
    const unmatched = batch.filter((_: any, j: number) => !classifications.find((c: any) => (c.index || c.idx || 1) - 1 === j));
    for (const u of unmatched) classified.push({ ...u, isExpensable: false, category: "needs-review", reason: "Classification missed" });
    
    console.log(`Batch ${Math.floor(i/5)+1}: ${classifications.length} classified`);
    await new Promise(r => setTimeout(r, 500));
  }

  const expensable = classified.filter(o => o.isExpensable);
  const review = classified.filter(o => o.category === "needs-review");
  console.log(`\nExpensable: ${expensable.length} | Needs review: ${review.length} | Personal: ${classified.length - expensable.length - review.length}`);
  fs.writeFileSync(path.join(OUT, "02-classified.json"), JSON.stringify(classified, null, 2));

  // STEP 3: Download invoices for expensable orders
  console.log("\n=== DOWNLOADING INVOICES ===");
  const toDownload = [...expensable, ...review].filter(o => o.invoiceUrl);
  let downloaded = 0;
  
  for (const order of toDownload) {
    try {
      const invoicePage = await stagehand.context.newPage();
      const url = order.invoiceUrl.startsWith("http") ? order.invoiceUrl : `https://www.amazon.com${order.invoiceUrl}`;
      await invoicePage.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      await invoicePage.waitForTimeout(1500);
      
      const { data } = await (invoicePage as any).mainSession.send("Page.printToPDF", { printBackground: true });
      const filename = `${order.date.replace(/[^a-zA-Z0-9]/g, '-')}_${order.orderId}.pdf`;
      fs.writeFileSync(path.join(OUT, filename), Buffer.from(data, "base64"));
      console.log(`  ✓ ${filename}`);
      downloaded++;
      await invoicePage.close();
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
    } catch (e: any) {
      console.log(`  ✗ ${order.orderId}: ${e.message}`);
    }
  }

  console.log(`\nDownloaded ${downloaded}/${toDownload.length} invoices`);
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify({ total: allOrders.length, expensable: expensable.length, review: review.length, downloaded, orders: classified }, null, 2));
  
  console.log(`\n=== DONE ===`);
  console.log(`Files: ${OUT}/`);
  console.log(`  01-raw-orders.json (${allOrders.length} orders)`);
  console.log(`  02-classified.json (${expensable.length} expensable)`);
  console.log(`  manifest.json`);
  console.log(`  ${downloaded} PDF invoices`);

  await page.close();
  await stagehand.close();
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
