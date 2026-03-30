import { Stagehand } from "@browserbasehq/stagehand";
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";

const OUT = path.join(process.env.HOME!, "Documents", "Expenses");
const PDF_DIR = path.join(OUT, "Invoices", "ClickHouse");
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

  console.log("=== CLICKHOUSE CLOUD ===");
  await page.goto("https://clickhouse.cloud", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(6000);

  const currentUrl = page.url();
  console.log("Dashboard URL:", currentUrl);

  // Extract org ID from URL
  const orgMatch = currentUrl.match(/organizations\/([^/]+)/);
  const orgId = orgMatch?.[1];
  console.log("Org ID:", orgId || "not found");

  // Navigate to billing
  if (orgId) {
    await page.goto(`https://clickhouse.cloud/organizations/${orgId}/billing`, {
      waitUntil: "domcontentloaded", timeout: 30000,
    });
    await page.waitForTimeout(6000);
  }

  const data = await page.evaluate(() => {
    const text = document.body.innerText;
    return {
      amounts: (text.match(/\$[\d,]+\.?\d*/g) || []).slice(0, 30),
      lines: text.split('\n').filter((l: string) =>
        l.match(/\$/) || l.match(/plan/i) || l.match(/billing/i) || l.match(/invoice/i) || l.match(/service/i) || l.match(/cluster/i) || l.match(/usage/i)
      ).slice(0, 50),
      url: window.location.href,
    };
  });

  console.log("Amounts:", data.amounts.slice(0, 10));
  data.lines.slice(0, 15).forEach((l: string) => console.log("  ", l.substring(0, 120)));

  try {
    const { data: pdfData } = await (page as any).mainSession.send("Page.printToPDF", { printBackground: true, scale: 0.8 });
    fs.writeFileSync(path.join(PDF_DIR, "clickhouse-billing-v2.pdf"), Buffer.from(pdfData, "base64"));
    console.log("Billing PDF saved");
  } catch (e: any) { console.log("PDF:", e.message); }

  // Try usage page
  if (orgId) {
    await page.goto(`https://clickhouse.cloud/organizations/${orgId}/usage`, {
      waitUntil: "domcontentloaded", timeout: 30000,
    });
    await page.waitForTimeout(5000);

    const usageData = await page.evaluate(() => {
      const text = document.body.innerText;
      return {
        amounts: (text.match(/\$[\d,]+\.?\d*/g) || []).slice(0, 20),
        lines: text.split('\n').filter((l: string) =>
          l.match(/\$/) || l.match(/usage/i) || l.match(/compute/i) || l.match(/storage/i)
        ).slice(0, 30),
      };
    });
    console.log("\nUsage amounts:", usageData.amounts);

    try {
      const { data: pdfData } = await (page as any).mainSession.send("Page.printToPDF", { printBackground: true, scale: 0.8 });
      fs.writeFileSync(path.join(PDF_DIR, "clickhouse-usage.pdf"), Buffer.from(pdfData, "base64"));
      console.log("Usage PDF saved");
    } catch {}
  }

  fs.writeFileSync(path.join(OUT, "chunk_clickhouse.json"), JSON.stringify({
    source: "clickhouse-cloud",
    scrapedAt: new Date().toISOString(),
    orgId,
    data,
  }, null, 2));
  console.log("Saved chunk_clickhouse.json");

  await page.close();
  await stagehand.close();
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
