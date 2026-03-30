import { Stagehand } from "@browserbasehq/stagehand";
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";

const OUT = path.join(process.env.HOME!, "Documents", "Expenses");
const PDF_DIR = path.join(OUT, "Invoices", "Anthropic");
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

  console.log("=== ANTHROPIC BILLING ===");
  await page.goto("https://console.anthropic.com/settings/billing", {
    waitUntil: "domcontentloaded", timeout: 30000,
  });
  await page.waitForTimeout(5000);

  // Extract billing overview
  const billingOverview = await page.evaluate(() => {
    const text = document.body.innerText;
    const amounts = text.match(/\$[\d,]+\.?\d*/g) || [];
    const planMatch = text.match(/(Max|Pro|Build|Scale|Free|Enterprise)\s*(plan|tier)?/gi) || [];
    const usageLines = text.split('\n').filter((l: string) =>
      l.match(/\$/) || l.match(/usage/i) || l.match(/credit/i) || l.match(/plan/i) || l.match(/invoice/i) || l.match(/balance/i)
    );
    return { amounts: amounts.slice(0, 20), plans: planMatch, usageLines: usageLines.slice(0, 30) };
  });
  console.log(`Plans: ${billingOverview.plans.join(', ')}`);
  console.log(`Amounts: ${billingOverview.amounts.slice(0, 5).join(', ')}`);

  // Print billing page as PDF
  try {
    
    const { data } = await (page as any).mainSession.send("Page.printToPDF", { printBackground: true });
    fs.writeFileSync(path.join(PDF_DIR, "anthropic-billing.pdf"), Buffer.from(data, "base64"));
    console.log("Saved anthropic-billing.pdf");
  } catch (e: any) {
    console.log(`PDF: ${e.message}`);
  }

  // Check for invoices/usage page
  console.log("\nChecking usage...");
  await page.goto("https://console.anthropic.com/settings/usage", {
    waitUntil: "domcontentloaded", timeout: 30000,
  });
  await page.waitForTimeout(4000);

  const usageData = await page.evaluate(() => {
    const text = document.body.innerText;
    const amounts = text.match(/\$[\d,]+\.?\d*/g) || [];
    const usageLines = text.split('\n').filter((l: string) => l.match(/\$/) || l.match(/token/i) || l.match(/usage/i) || l.match(/model/i));
    return { amounts: amounts.slice(0, 20), lines: usageLines.slice(0, 40) };
  });

  // Try invoices page
  console.log("Checking invoices...");
  await page.goto("https://console.anthropic.com/settings/invoices", {
    waitUntil: "domcontentloaded", timeout: 30000,
  });
  await page.waitForTimeout(4000);

  const invoiceData = await page.evaluate(() => {
    const invoices: any[] = [];
    document.querySelectorAll('a[href*="invoice"], tr, [class*="row"], li').forEach((el: any) => {
      const text = el.textContent?.trim();
      const href = el.href || el.querySelector('a')?.href;
      if (text && (text.match(/\$/) || text.match(/invoice/i) || text.match(/\d{4}/))) {
        invoices.push({ text: text.replace(/\s+/g, ' ').substring(0, 300), href: href || null });
      }
    });

    const allText = document.body.innerText;
    const lines = allText.split('\n').filter((l: string) => l.match(/\$[\d,]+/) || l.match(/invoice/i) || l.match(/paid/i));
    return { invoices: invoices.slice(0, 30), lines: lines.slice(0, 30) };
  });
  console.log(`Found ${invoiceData.invoices.length} invoice entries`);

  // Try to download invoice PDFs
  let downloadedCount = 0;
  for (const inv of invoiceData.invoices) {
    if (inv.href && (inv.href.includes("invoice") || inv.href.includes("receipt"))) {
      try {
        const invPage = await stagehand.context.newPage();
        await invPage.goto(inv.href, { waitUntil: "domcontentloaded", timeout: 15000 });
        await invPage.waitForTimeout(2000);
        
        const { data } = await (invPage as any).mainSession.send("Page.printToPDF", { printBackground: true });
        fs.writeFileSync(path.join(PDF_DIR, `anthropic-invoice-${downloadedCount + 1}.pdf`), Buffer.from(data, "base64"));
        console.log(`  Saved anthropic-invoice-${downloadedCount + 1}.pdf`);
        downloadedCount++;
        await invPage.close();
        if (downloadedCount >= 12) break;
      } catch (e: any) {
        console.log(`  Invoice failed: ${e.message}`);
      }
    }
  }

  // Also check claude.ai subscription (Max plan)
  console.log("\nChecking claude.ai subscription...");
  await page.goto("https://claude.ai/settings/billing", {
    waitUntil: "domcontentloaded", timeout: 30000,
  });
  await page.waitForTimeout(4000);

  let claudeSubscription: any = {};
  try {
    claudeSubscription = await page.evaluate(() => {
      const text = document.body.innerText;
      const amounts = text.match(/\$[\d,]+\.?\d*/g) || [];
      const planMatch = text.match(/(Max|Pro|Free|Team)\s*(plan)?/gi) || [];
      const lines = text.split('\n').filter((l: string) => l.match(/\$/) || l.match(/plan/i) || l.match(/subscription/i) || l.match(/billing/i));
      return { amounts, plans: planMatch, lines: lines.slice(0, 20) };
    });
    console.log(`Claude.ai plans: ${claudeSubscription.plans?.join(', ')}`);
  } catch (e: any) {
    console.log(`Claude.ai billing: ${e.message}`);
  }

  const chunk = {
    source: "anthropic",
    scrapedAt: new Date().toISOString(),
    billingOverview,
    usageData,
    invoiceData,
    claudeSubscription,
    downloadedPDFs: downloadedCount,
  };

  fs.writeFileSync(path.join(OUT, "chunk_anthropic.json"), JSON.stringify(chunk, null, 2));
  console.log(`\nSaved chunk_anthropic.json`);

  await page.close();
  await stagehand.close();
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
