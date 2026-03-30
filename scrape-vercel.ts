import { Stagehand } from "@browserbasehq/stagehand";
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";

const OUT = path.join(process.env.HOME!, "Documents", "Expenses");
const PDF_DIR = path.join(OUT, "Invoices", "Vercel");
fs.mkdirSync(PDF_DIR, { recursive: true });

async function main() {
  const { webSocketDebuggerUrl } = await (await fetch("http://127.0.0.1:9222/json/version")).json();
  const stagehand = new Stagehand({
    env: "LOCAL",
    localBrowserLaunchOptions: { cdpUrl: webSocketDebuggerUrl },
    model: { modelName: "openai/gpt-4.1", apiKey: process.env.AZURE_API_KEY!, baseURL: process.env.AZURE_BASE_URL! },
  });
  await stagehand.init();
  const page = await stagehand.context.newPage();

  console.log("=== VERCEL BILLING ===");
  await page.goto("https://vercel.com/~/account/billing", {
    waitUntil: "domcontentloaded", timeout: 30000,
  });
  await page.waitForTimeout(5000);

  // Extract billing overview
  const billingOverview = await page.evaluate(() => {
    const text = document.body.innerText;
    const amounts = text.match(/\$[\d,]+\.?\d*/g) || [];
    const planMatch = text.match(/(Pro|Hobby|Enterprise|Team)\s*(Plan|plan)?/i);
    const periodMatch = text.match(/\w+\s+\d{1,2},?\s+\d{4}/g) || [];

    // Look for invoice rows
    const rows: any[] = [];
    document.querySelectorAll('table tr, [class*="invoice"], [class*="billing"]').forEach((el: any) => {
      const t = el.textContent?.trim();
      if (t && t.match(/\$[\d,]+/)) {
        rows.push(t.replace(/\s+/g, ' ').substring(0, 200));
      }
    });

    return {
      plan: planMatch?.[0] || "Unknown",
      amounts: amounts.slice(0, 20),
      dates: periodMatch.slice(0, 10),
      invoiceRows: rows.slice(0, 20),
    };
  });
  console.log(`Plan: ${billingOverview.plan}, ${billingOverview.amounts.length} amounts found`);

  // Navigate to invoices section
  console.log("\nChecking invoices...");
  await page.goto("https://vercel.com/~/account/billing/invoices", {
    waitUntil: "domcontentloaded", timeout: 30000,
  });
  await page.waitForTimeout(4000);

  const invoiceData = await page.evaluate(() => {
    const invoices: any[] = [];
    // Look for invoice links and rows
    document.querySelectorAll('a[href*="invoice"], tr, [class*="row"]').forEach((el: any) => {
      const text = el.textContent?.trim();
      const href = el.href || el.querySelector('a')?.href;
      if (text && (text.match(/\$/) || text.match(/invoice/i) || text.match(/\d{4}/))) {
        invoices.push({ text: text.replace(/\s+/g, ' ').substring(0, 300), href: href || null });
      }
    });

    // Fallback: grab all visible text with dollar amounts
    const allText = document.body.innerText;
    const lines = allText.split('\n').filter((l: string) => l.match(/\$[\d,]+/) || l.match(/invoice/i));

    return { invoices: invoices.slice(0, 30), relevantLines: lines.slice(0, 30) };
  });
  console.log(`Found ${invoiceData.invoices.length} invoice entries`);

  // Print billing page as PDF
  try {
    
    const { data } = await (page as any).mainSession.send("Page.printToPDF", { printBackground: true });
    fs.writeFileSync(path.join(PDF_DIR, "vercel-billing.pdf"), Buffer.from(data, "base64"));
    console.log("Saved vercel-billing.pdf");
  } catch (e: any) {
    console.log(`PDF: ${e.message}`);
  }

  // Try to download individual invoices
  let downloadedCount = 0;
  for (const inv of invoiceData.invoices) {
    if (inv.href && inv.href.includes("invoice")) {
      try {
        const invPage = await stagehand.context.newPage();
        await invPage.goto(inv.href, { waitUntil: "domcontentloaded", timeout: 15000 });
        await invPage.waitForTimeout(2000);
        
        const { data } = await (invPage as any).mainSession.send("Page.printToPDF", { printBackground: true });
        const filename = `vercel-invoice-${downloadedCount + 1}.pdf`;
        fs.writeFileSync(path.join(PDF_DIR, filename), Buffer.from(data, "base64"));
        console.log(`  Saved ${filename}`);
        downloadedCount++;
        await invPage.close();
        if (downloadedCount >= 12) break;
      } catch (e: any) {
        console.log(`  Failed: ${e.message}`);
      }
    }
  }

  const chunk = {
    source: "vercel",
    scrapedAt: new Date().toISOString(),
    billingOverview,
    invoiceData,
    downloadedPDFs: downloadedCount,
  };

  fs.writeFileSync(path.join(OUT, "chunk_vercel.json"), JSON.stringify(chunk, null, 2));
  console.log(`\nSaved chunk_vercel.json`);

  await page.close();
  await stagehand.close();
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
