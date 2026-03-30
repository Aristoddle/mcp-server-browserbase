import { Stagehand } from "@browserbasehq/stagehand";
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";

const OUT = path.join(process.env.HOME!, "Documents", "Expenses");

async function getStagehand(): Promise<Stagehand> {
  const { webSocketDebuggerUrl } = await (await fetch("http://127.0.0.1:9222/json/version")).json();
  const sh = new Stagehand({
    env: "LOCAL",
    localBrowserLaunchOptions: { cdpUrl: webSocketDebuggerUrl },
    model: { modelName: "openai/gpt-4.1", apiKey: process.env.AZURE_API_KEY!, baseURL: process.env.AZURE_BASE_URL! },
  });
  await sh.init();
  return sh;
}

async function printPDF(page: any, filePath: string): Promise<boolean> {
  try {
    const { data } = await (page as any).mainSession.send("Page.printToPDF", {
      printBackground: true, scale: 0.8, paperWidth: 8.5, paperHeight: 11,
    });
    fs.writeFileSync(filePath, Buffer.from(data, "base64"));
    console.log(`  PDF: ${path.basename(filePath)} (${(Buffer.from(data, "base64").length / 1024).toFixed(0)}KB)`);
    return true;
  } catch (e: any) {
    console.log(`  PDF failed: ${e.message.substring(0, 80)}`);
    return false;
  }
}

async function scrapeRaw(page: any): Promise<any> {
  return page.evaluate(() => {
    const text = document.body.innerText;
    return {
      amounts: (text.match(/\$[\d,]+\.?\d*/g) || []).slice(0, 30),
      lines: text.split('\n').filter((l: string) =>
        l.match(/\$/) || l.match(/plan/i) || l.match(/invoice/i) || l.match(/billing/i) || l.match(/subscription/i)
      ).slice(0, 50),
      url: window.location.href,
    };
  });
}

async function scrapePortalSimple(name: string, urls: string[], note?: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`${name.toUpperCase()} ${note ? `— ${note}` : ""}`);
  console.log("=".repeat(60));

  const dir = path.join(OUT, "Invoices", name);
  fs.mkdirSync(dir, { recursive: true });

  let stagehand: Stagehand | null = null;
  try {
    stagehand = await getStagehand();
    const page = await stagehand.context.newPage();
    const result: any = { source: name, scrapedAt: new Date().toISOString(), note, pages: [] };

    for (let i = 0; i < urls.length; i++) {
      console.log(`  Loading: ${urls[i]}`);
      await page.goto(urls[i], { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(5000);
      const rawData = await scrapeRaw(page);
      if (rawData.amounts.length) console.log(`  Amounts: ${rawData.amounts.slice(0, 8).join(', ')}`);
      rawData.lines.slice(0, 5).forEach((l: string) => console.log(`    ${l.substring(0, 120)}`));
      const pdfName = `${name.toLowerCase()}-${i === 0 ? 'billing' : `page-${i + 1}`}.pdf`;
      await printPDF(page, path.join(dir, pdfName));
      result.pages.push({ url: rawData.url, rawData });
    }

    await page.close();
    fs.writeFileSync(path.join(OUT, `chunk_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}.json`), JSON.stringify(result, null, 2));
    console.log(`  Saved chunk_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}.json`);
    return result;
  } catch (e: any) {
    console.log(`  ERROR: ${e.message.substring(0, 100)}`);
    return null;
  } finally {
    try { await stagehand?.close(); } catch {}
  }
}

async function main() {
  // ==========================================
  // 1. APPLE — subscription billing / purchase history
  // ==========================================
  await scrapePortalSimple("Apple", [
    "https://reportaproblem.apple.com",
    "https://finance-app.itunes.apple.com/purchases",
  ], "Apple subscriptions — check for work-related app purchases");
  await new Promise(r => setTimeout(r, 2000));

  // ==========================================
  // 2. FEDEX — $39 shipping receipt
  // ==========================================
  await scrapePortalSimple("FedEx", [
    "https://www.fedex.com/fedexbillingonline/pages/accountsummary/accountSummaryController.html",
    "https://www.fedex.com/billing/order-history",
  ], "$39 shipping/printing charges");
  await new Promise(r => setTimeout(r, 2000));

  // ==========================================
  // 3. CURSOR — AI code editor (check if user has paid plan)
  // ==========================================
  await scrapePortalSimple("Cursor", [
    "https://www.cursor.com/settings",
  ], "AI code editor — check for paid subscription");
  await new Promise(r => setTimeout(r, 2000));

  // ==========================================
  // 4. REPLIT — check for any paid usage
  // ==========================================
  await scrapePortalSimple("Replit", [
    "https://replit.com/account#billing",
  ], "Check for paid plan");
  await new Promise(r => setTimeout(r, 2000));

  // ==========================================
  // 5. NAMECHEAP — domain registrations
  // ==========================================
  await scrapePortalSimple("Namecheap", [
    "https://ap.www.namecheap.com/Billing/DashboardBilling",
    "https://ap.www.namecheap.com/Domains/DomainList",
  ], "Domain registrations for work projects");
  await new Promise(r => setTimeout(r, 2000));

  // ==========================================
  // 6. STRIPE DASHBOARD — direct access to receipts
  // ==========================================
  await scrapePortalSimple("Stripe", [
    "https://dashboard.stripe.com/settings/billing",
    "https://dashboard.stripe.com/invoices",
  ], "Check if user has Stripe account with own charges");
  await new Promise(r => setTimeout(r, 2000));

  // ==========================================
  // 7. POSTMAN — API testing tool
  // ==========================================
  await scrapePortalSimple("Postman", [
    "https://go.postman.co/billing/overview",
  ], "API testing tool — check for paid plan");
  await new Promise(r => setTimeout(r, 2000));

  // ==========================================
  // 8. DEEPGRAM — speech-to-text API
  // ==========================================
  await scrapePortalSimple("Deepgram", [
    "https://console.deepgram.com/billing",
  ], "Speech-to-text API — check for usage/billing");
  await new Promise(r => setTimeout(r, 2000));

  // ==========================================
  // 9. REPLICATE — AI model hosting
  // ==========================================
  await scrapePortalSimple("Replicate", [
    "https://replicate.com/account/billing",
  ], "AI model hosting — check for usage");
  await new Promise(r => setTimeout(r, 2000));

  // ==========================================
  // SUMMARY
  // ==========================================
  console.log(`\n${"=".repeat(60)}`);
  console.log("WAVE 3 COMPLETE");
  console.log("=".repeat(60));

  const totalPDFs = fs.readdirSync(path.join(OUT, "Invoices"), { recursive: true })
    .filter((f: any) => f.toString().endsWith('.pdf')).length;
  console.log(`Total PDFs now: ${totalPDFs}`);

  const chunks = fs.readdirSync(OUT).filter(f => f.startsWith('chunk_') && f.endsWith('.json'));
  console.log(`Total chunks: ${chunks.length}`);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
