import { Stagehand } from "@browserbasehq/stagehand";
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";

const OUT = path.join(process.env.HOME!, "Documents", "Expenses");
const PDF_DIR = path.join(OUT, "Invoices", "GitHub");
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

  console.log("=== GITHUB BILLING ===");
  await page.goto("https://github.com/settings/billing/summary", {
    waitUntil: "domcontentloaded", timeout: 30000,
  });
  await page.waitForTimeout(5000);

  // Extract billing summary
  const billingSummary = await page.evaluate(() => {
    const text = document.body.innerText;
    const amounts = text.match(/\$[\d,]+\.?\d*/g) || [];
    const planMatches = text.match(/(Copilot\s*(Pro\+?|Business|Enterprise|Individual)|GitHub\s*(Pro|Team|Enterprise|Free))/gi) || [];
    const usageLines = text.split('\n').filter((l: string) =>
      l.match(/\$/) || l.match(/usage/i) || l.match(/copilot/i) || l.match(/actions/i) || l.match(/plan/i) || l.match(/subscription/i)
    );

    // Look for specific billing sections
    const sections: any = {};
    ['Copilot', 'Actions', 'Packages', 'Codespaces', 'Storage'].forEach(section => {
      const idx = text.indexOf(section);
      if (idx >= 0) {
        const nearby = text.substring(idx, idx + 300);
        const amt = nearby.match(/\$[\d,]+\.?\d*/);
        sections[section.toLowerCase()] = { found: true, amount: amt?.[0] || null, context: nearby.substring(0, 150) };
      }
    });

    return { amounts, plans: planMatches, usageLines: usageLines.slice(0, 30), sections };
  });
  console.log(`Plans: ${billingSummary.plans.join(', ')}`);
  console.log(`Sections found: ${Object.keys(billingSummary.sections).join(', ')}`);

  // Print billing page as PDF
  try {
    
    const { data } = await (page as any).mainSession.send("Page.printToPDF", { printBackground: true });
    fs.writeFileSync(path.join(PDF_DIR, "github-billing-summary.pdf"), Buffer.from(data, "base64"));
    console.log("Saved github-billing-summary.pdf");
  } catch (e: any) {
    console.log(`PDF: ${e.message}`);
  }

  // Check payment history / receipts
  console.log("\nChecking payment history...");
  await page.goto("https://github.com/account/billing/history", {
    waitUntil: "domcontentloaded", timeout: 30000,
  });
  await page.waitForTimeout(4000);

  const paymentHistory = await page.evaluate(() => {
    const rows: any[] = [];
    document.querySelectorAll('table tr, [class*="payment"], [class*="receipt"], li').forEach((el: any) => {
      const text = el.textContent?.trim();
      if (text && text.match(/\$[\d,]+/)) {
        const link = el.querySelector('a[href*="receipt"]')?.href;
        rows.push({ text: text.replace(/\s+/g, ' ').substring(0, 300), receiptUrl: link || null });
      }
    });

    const allText = document.body.innerText;
    const receiptLines = allText.split('\n').filter((l: string) => l.match(/\$/) || l.match(/receipt/i) || l.match(/payment/i));
    return { rows: rows.slice(0, 30), receiptLines: receiptLines.slice(0, 30) };
  });
  console.log(`Found ${paymentHistory.rows.length} payment entries`);

  // Download receipt PDFs
  let downloadedCount = 0;
  for (const row of paymentHistory.rows) {
    if (row.receiptUrl) {
      try {
        const receiptPage = await stagehand.context.newPage();
        await receiptPage.goto(row.receiptUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
        await receiptPage.waitForTimeout(2000);
        
        const { data } = await (invPage as any).mainSession.send("Page.printToPDF", { printBackground: true });
        fs.writeFileSync(path.join(PDF_DIR, `github-receipt-${downloadedCount + 1}.pdf`), Buffer.from(data, "base64"));
        console.log(`  Saved github-receipt-${downloadedCount + 1}.pdf`);
        downloadedCount++;
        await receiptPage.close();
        if (downloadedCount >= 12) break;
      } catch (e: any) {
        console.log(`  Receipt failed: ${e.message}`);
      }
    }
  }

  const chunk = {
    source: "github",
    scrapedAt: new Date().toISOString(),
    billingSummary,
    paymentHistory,
    downloadedPDFs: downloadedCount,
  };

  fs.writeFileSync(path.join(OUT, "chunk_github.json"), JSON.stringify(chunk, null, 2));
  console.log(`\nSaved chunk_github.json`);

  await page.close();
  await stagehand.close();
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
