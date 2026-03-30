import { Stagehand } from "@browserbasehq/stagehand";
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";

const OUT = path.join(process.env.HOME!, "Documents", "Expenses");
const PDF_DIR = path.join(OUT, "Invoices", "Notion");
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

  console.log("=== NOTION BILLING ===");
  await page.goto("https://www.notion.so/settings/billing", {
    waitUntil: "domcontentloaded", timeout: 30000,
  });
  await page.waitForTimeout(5000);

  // Notion might redirect to a workspace-specific URL
  const currentUrl = page.url();
  console.log(`Current URL: ${currentUrl}`);

  const billingData = await page.evaluate(() => {
    const text = document.body.innerText;
    const amounts = text.match(/\$[\d,]+\.?\d*/g) || [];
    const planMatch = text.match(/(Plus|Team|Business|Enterprise|Free|Personal)\s*(Plan|plan)?/gi) || [];
    const lines = text.split('\n').filter((l: string) =>
      l.match(/\$/) || l.match(/plan/i) || l.match(/billing/i) || l.match(/invoice/i) || l.match(/subscription/i) || l.match(/member/i)
    );

    // Look for invoice table or list
    const invoiceElements: any[] = [];
    document.querySelectorAll('a[href*="invoice"], [class*="invoice"], tr, [class*="receipt"]').forEach((el: any) => {
      const t = el.textContent?.trim();
      const href = el.href || el.querySelector('a')?.href;
      if (t && (t.match(/\$/) || t.match(/invoice/i))) {
        invoiceElements.push({ text: t.replace(/\s+/g, ' ').substring(0, 300), href: href || null });
      }
    });

    return {
      amounts: amounts.slice(0, 15),
      plans: planMatch,
      lines: lines.slice(0, 30),
      invoiceElements: invoiceElements.slice(0, 20),
    };
  });
  console.log(`Plan: ${billingData.plans.join(', ')}`);
  console.log(`Amounts: ${billingData.amounts.slice(0, 5).join(', ')}`);

  // Print billing page as PDF
  try {
    
    const { data } = await (page as any).mainSession.send("Page.printToPDF", { printBackground: true });
    fs.writeFileSync(path.join(PDF_DIR, "notion-billing.pdf"), Buffer.from(data, "base64"));
    console.log("Saved notion-billing.pdf");
  } catch (e: any) {
    console.log(`PDF: ${e.message}`);
  }

  // Try to download individual invoices
  let downloadedCount = 0;
  for (const inv of billingData.invoiceElements) {
    if (inv.href && (inv.href.includes("invoice") || inv.href.includes("receipt") || inv.href.includes("stripe"))) {
      try {
        const invPage = await stagehand.context.newPage();
        await invPage.goto(inv.href, { waitUntil: "domcontentloaded", timeout: 15000 });
        await invPage.waitForTimeout(2000);
        
        const { data } = await (invPage as any).mainSession.send("Page.printToPDF", { printBackground: true });
        fs.writeFileSync(path.join(PDF_DIR, `notion-invoice-${downloadedCount + 1}.pdf`), Buffer.from(data, "base64"));
        console.log(`  Saved notion-invoice-${downloadedCount + 1}.pdf`);
        downloadedCount++;
        await invPage.close();
        if (downloadedCount >= 12) break;
      } catch (e: any) {
        console.log(`  Invoice failed: ${e.message}`);
      }
    }
  }

  const chunk = {
    source: "notion",
    scrapedAt: new Date().toISOString(),
    billingData,
    downloadedPDFs: downloadedCount,
  };

  fs.writeFileSync(path.join(OUT, "chunk_notion.json"), JSON.stringify(chunk, null, 2));
  console.log(`\nSaved chunk_notion.json`);

  await page.close();
  await stagehand.close();
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
