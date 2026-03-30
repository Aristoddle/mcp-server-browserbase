import { Stagehand } from "@browserbasehq/stagehand";
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";

const OUT = path.join(process.env.HOME!, "Documents", "Expenses");
const PDF_DIR = path.join(OUT, "Invoices", "GoogleAI");
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

  console.log("=== GOOGLE AI BILLING ===");

  // Try AI Studio first
  await page.goto("https://aistudio.google.com/billing", {
    waitUntil: "domcontentloaded", timeout: 30000,
  });
  await page.waitForTimeout(5000);

  let aiStudioBilling: any = {};
  try {
    aiStudioBilling = await page.evaluate(() => {
      const text = document.body.innerText;
      const amounts = text.match(/\$[\d,]+\.?\d*/g) || [];
      const planMatch = text.match(/(AI Ultra|AI Premium|Free|Paid)/gi) || [];
      const lines = text.split('\n').filter((l: string) =>
        l.match(/\$/) || l.match(/plan/i) || l.match(/usage/i) || l.match(/billing/i) || l.match(/subscription/i)
      );
      return { amounts: amounts.slice(0, 20), plans: planMatch, lines: lines.slice(0, 30) };
    });
    console.log(`AI Studio: ${aiStudioBilling.plans.join(', ')}, ${aiStudioBilling.amounts.length} amounts`);
  } catch (e: any) {
    console.log(`AI Studio: ${e.message}`);
  }

  // Try Google One / Subscriptions (AI Ultra is often under Google One)
  console.log("\nChecking Google One...");
  await page.goto("https://one.google.com/about/plans", {
    waitUntil: "domcontentloaded", timeout: 30000,
  });
  await page.waitForTimeout(4000);

  let googleOnePlans: any = {};
  try {
    googleOnePlans = await page.evaluate(() => {
      const text = document.body.innerText;
      const amounts = text.match(/\$[\d,]+\.?\d*/g) || [];
      const planMatch = text.match(/(AI Premium|AI Ultra|2\s*TB|100\s*GB|Basic|Premium|Standard)/gi) || [];
      const lines = text.split('\n').filter((l: string) => l.match(/\$/) || l.match(/plan/i) || l.match(/AI/));
      return { amounts: amounts.slice(0, 15), plans: planMatch, lines: lines.slice(0, 20) };
    });
  } catch (e: any) {
    console.log(`Google One: ${e.message}`);
  }

  // Try Google Play subscriptions
  console.log("Checking Google Play subscriptions...");
  await page.goto("https://play.google.com/store/account/subscriptions", {
    waitUntil: "domcontentloaded", timeout: 30000,
  });
  await page.waitForTimeout(4000);

  let playSubscriptions: any = {};
  try {
    playSubscriptions = await page.evaluate(() => {
      const text = document.body.innerText;
      const amounts = text.match(/\$[\d,]+\.?\d*/g) || [];
      const subs = text.split('\n').filter((l: string) => l.match(/\$/) || l.match(/subscription/i) || l.match(/renew/i));
      return { amounts: amounts.slice(0, 15), subscriptions: subs.slice(0, 20) };
    });
  } catch (e: any) {
    console.log(`Play subscriptions: ${e.message}`);
  }

  // Try GCP billing (if they have a GCP project)
  console.log("Checking GCP billing...");
  await page.goto("https://console.cloud.google.com/billing", {
    waitUntil: "domcontentloaded", timeout: 30000,
  });
  await page.waitForTimeout(6000);

  let gcpBilling: any = {};
  try {
    gcpBilling = await page.evaluate(() => {
      const text = document.body.innerText;
      const amounts = text.match(/\$[\d,]+\.?\d*/g) || [];
      const lines = text.split('\n').filter((l: string) =>
        l.match(/\$/) || l.match(/billing/i) || l.match(/invoice/i) || l.match(/project/i)
      );
      return { amounts: amounts.slice(0, 20), lines: lines.slice(0, 30) };
    });
    console.log(`GCP: ${gcpBilling.amounts.length} amounts found`);
  } catch (e: any) {
    console.log(`GCP billing: ${e.message}`);
  }

  // Print billing pages as PDF
  try {
    
    const { data } = await (page as any).mainSession.send("Page.printToPDF", { printBackground: true });
    fs.writeFileSync(path.join(PDF_DIR, "google-billing.pdf"), Buffer.from(data, "base64"));
    console.log("Saved google-billing.pdf");
  } catch (e: any) {
    console.log(`PDF: ${e.message}`);
  }

  const chunk = {
    source: "google-ai",
    scrapedAt: new Date().toISOString(),
    aiStudioBilling,
    googleOnePlans,
    playSubscriptions,
    gcpBilling,
  };

  fs.writeFileSync(path.join(OUT, "chunk_google_ai.json"), JSON.stringify(chunk, null, 2));
  console.log(`\nSaved chunk_google_ai.json`);

  await page.close();
  await stagehand.close();
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
