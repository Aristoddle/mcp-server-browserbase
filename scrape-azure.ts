import { Stagehand } from "@browserbasehq/stagehand";
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";

const OUT = path.join(process.env.HOME!, "Documents", "Expenses");
const PDF_DIR = path.join(OUT, "Invoices", "Azure");
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

  console.log("=== AZURE PORTAL: Cost Management + Invoices ===");

  // Navigate to Azure Cost Management - Invoices
  await page.goto("https://portal.azure.com/#view/Microsoft_Azure_CostManagement/Menu/~/invoices", {
    waitUntil: "domcontentloaded", timeout: 45000,
  });
  await page.waitForTimeout(8000); // Azure portal is slow to load

  // Try to extract invoice data from the page
  let invoices: any[] = [];
  try {
    invoices = await page.evaluate(() => {
      const results: any[] = [];
      // Azure invoices table - look for rows in the invoices grid
      const rows = document.querySelectorAll('div[role="row"], tr[class*="fxs-blade"], .azc-grid-row, .fxs-grid-row');
      rows.forEach((row: any) => {
        const cells = row.querySelectorAll('div[role="gridcell"], td, .azc-grid-cell');
        if (cells.length >= 3) {
          const text = Array.from(cells).map((c: any) => c.textContent?.trim()).filter(Boolean);
          if (text.some((t: any) => t.match(/\$/))) {
            results.push({ cells: text });
          }
        }
      });
      // Also grab any visible text about invoices
      const allText = document.body.innerText;
      const invoiceMatches = allText.match(/Invoice\s*#?\s*[\w-]+/gi) || [];
      const amountMatches = allText.match(/\$[\d,]+\.\d{2}/g) || [];
      return results.length > 0 ? results : [{ invoiceRefs: invoiceMatches.slice(0, 20), amounts: amountMatches.slice(0, 20), note: "Extracted from page text" }];
    });
    console.log(`Found ${invoices.length} invoice entries`);
  } catch (e: any) {
    console.log(`Invoice extraction attempt: ${e.message}`);
  }

  // Try Cost Analysis for subscription-level spending
  console.log("\nNavigating to Cost Analysis...");
  await page.goto("https://portal.azure.com/#view/Microsoft_Azure_CostManagement/Menu/~/costanalysis", {
    waitUntil: "domcontentloaded", timeout: 45000,
  });
  await page.waitForTimeout(8000);

  let costData: any = {};
  try {
    costData = await page.evaluate(() => {
      const text = document.body.innerText;
      const costs = text.match(/\$[\d,]+\.?\d*/g) || [];
      const dateRanges = text.match(/\w+\s+\d{1,2},\s+\d{4}\s*[-–]\s*\w+\s+\d{1,2},\s+\d{4}/g) || [];
      // Look for resource group / service names
      const services = text.match(/(Microsoft\.\w+|AI Foundry|OpenAI|Cognitive Services|Azure AI)/gi) || [];
      return { costs: costs.slice(0, 30), dateRanges: dateRanges.slice(0, 5), services: [...new Set(services)].slice(0, 20) };
    });
    console.log(`Cost data: ${costData.costs?.length || 0} amounts, ${costData.services?.length || 0} services`);
  } catch (e: any) {
    console.log(`Cost analysis: ${e.message}`);
  }

  // Navigate to the specific AI Foundry resource cost
  console.log("\nChecking AI Foundry resource...");
  await page.goto("https://portal.azure.com/#view/Microsoft_Azure_CostManagement/Menu/~/costanalysis/scope/subscriptions", {
    waitUntil: "domcontentloaded", timeout: 45000,
  });
  await page.waitForTimeout(6000);

  // Try to get subscription-level overview
  let subscriptionData: any = {};
  try {
    subscriptionData = await page.evaluate(() => {
      const text = document.body.innerText;
      // Look for subscription names and their costs
      const lines = text.split('\n').filter((l: string) => l.match(/\$[\d,]+/) || l.match(/subscription/i));
      return { relevantLines: lines.slice(0, 30) };
    });
  } catch (e: any) {
    console.log(`Subscription data: ${e.message}`);
  }

  // Print the invoices page as PDF
  console.log("\nCapturing invoice page as PDF...");
  await page.goto("https://portal.azure.com/#view/Microsoft_Azure_CostManagement/Menu/~/invoices", {
    waitUntil: "domcontentloaded", timeout: 45000,
  });
  await page.waitForTimeout(8000);

  try {
    
    const { data } = await (page as any).mainSession.send("Page.printToPDF", { printBackground: true, landscape: true });
    fs.writeFileSync(path.join(PDF_DIR, "azure-invoices-page.pdf"), Buffer.from(data, "base64"));
    console.log("Saved azure-invoices-page.pdf");
  } catch (e: any) {
    console.log(`PDF capture: ${e.message}`);
  }

  // Build chunk
  const chunk = {
    source: "azure-portal",
    scrapedAt: new Date().toISOString(),
    invoices,
    costAnalysis: costData,
    subscriptionData,
  };

  fs.writeFileSync(path.join(OUT, "chunk_azure.json"), JSON.stringify(chunk, null, 2));
  console.log(`\nSaved chunk_azure.json`);

  await page.close();
  await stagehand.close();
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
