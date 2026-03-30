import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";

const OUT = path.join(process.env.HOME!, "Documents", "Expenses");

const BillingSchema = z.object({
  planName: z.string().optional().describe("Current subscription plan name"),
  monthlyAmount: z.string().optional().describe("Monthly billing amount with $ sign"),
  totalSpend: z.string().optional().describe("Total spend shown on the page with $ sign"),
  billingPeriod: z.string().optional().describe("Current billing period dates"),
  invoices: z.array(z.object({
    date: z.string().describe("Invoice date"),
    amount: z.string().describe("Invoice amount with $ sign"),
    status: z.string().optional().describe("Paid/pending/etc"),
    invoiceNumber: z.string().optional().describe("Invoice ID or number"),
  })).optional().describe("List of invoices if visible"),
  services: z.array(z.string()).optional().describe("List of services/resources being billed"),
  paymentMethod: z.string().optional().describe("Credit card or payment method shown"),
});

async function getStagehand(): Promise<Stagehand> {
  const { webSocketDebuggerUrl } = await (await fetch("http://127.0.0.1:9222/json/version")).json();
  const stagehand = new Stagehand({
    env: "LOCAL",
    localBrowserLaunchOptions: { cdpUrl: webSocketDebuggerUrl },
    model: { modelName: "openai/gpt-4.1", apiKey: process.env.AZURE_API_KEY!, baseURL: process.env.AZURE_BASE_URL! },
  });
  await stagehand.init();
  return stagehand;
}

async function printPDF(page: any, filePath: string): Promise<boolean> {
  try {
    const { data } = await (page as any).mainSession.send("Page.printToPDF", {
      printBackground: true, scale: 0.8, paperWidth: 8.5, paperHeight: 11,
    });
    fs.writeFileSync(filePath, Buffer.from(data, "base64"));
    const sizeKB = (Buffer.from(data, "base64").length / 1024).toFixed(0);
    console.log(`  PDF: ${path.basename(filePath)} (${sizeKB}KB)`);
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
      dates: (text.match(/\w+\s+\d{1,2},?\s+\d{4}/g) || []).slice(0, 20),
      lines: text.split('\n').filter((l: string) =>
        l.match(/\$/) || l.match(/plan/i) || l.match(/invoice/i) || l.match(/billing/i) || l.match(/subscription/i)
      ).slice(0, 50),
      invoiceLinks: Array.from(document.querySelectorAll('a'))
        .map((a: any) => a.href)
        .filter((h: string) => h.match(/invoice|receipt|billing|payment/i))
        .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i)
        .slice(0, 20),
      url: window.location.href,
    };
  });
}

interface Portal {
  name: string;
  urls: { url: string; pdfName: string; label: string }[];
  expensable: boolean;
  note?: string;
}

const PORTALS: Portal[] = [
  {
    name: "tailscale",
    expensable: true,
    urls: [
      { url: "https://login.tailscale.com/admin/billing", pdfName: "tailscale-billing.pdf", label: "Tailscale billing" },
    ],
  },
  {
    name: "ngrok",
    expensable: true,
    note: "$40 found in email",
    urls: [
      { url: "https://dashboard.ngrok.com/billing", pdfName: "ngrok-billing.pdf", label: "ngrok billing" },
      { url: "https://dashboard.ngrok.com/billing/invoices", pdfName: "ngrok-invoices.pdf", label: "ngrok invoices" },
    ],
  },
  {
    name: "livekit",
    expensable: true,
    urls: [
      { url: "https://cloud.livekit.io/settings/billing", pdfName: "livekit-billing.pdf", label: "LiveKit billing" },
    ],
  },
  {
    name: "microsoft",
    expensable: true,
    note: "INVESTIGATE: $20 mystery charges — what Microsoft product?",
    urls: [
      { url: "https://account.microsoft.com/billing/orders", pdfName: "microsoft-orders.pdf", label: "Microsoft orders" },
      { url: "https://account.microsoft.com/services", pdfName: "microsoft-subscriptions.pdf", label: "Microsoft subscriptions" },
    ],
  },
  {
    name: "squarespace",
    expensable: true,
    note: "$50 domain invoice",
    urls: [
      { url: "https://account.squarespace.com/settings/billing", pdfName: "squarespace-billing.pdf", label: "Squarespace billing" },
    ],
  },
  {
    name: "github",
    expensable: false,
    note: "NOT EXPENSABLE — personal per user",
    urls: [
      { url: "https://github.com/settings/billing/summary", pdfName: "github-billing.pdf", label: "GitHub billing" },
      { url: "https://github.com/account/billing/history", pdfName: "github-history.pdf", label: "GitHub payment history" },
    ],
  },
  {
    name: "google-ai",
    expensable: true,
    urls: [
      { url: "https://one.google.com/about/plans", pdfName: "google-one.pdf", label: "Google One plans" },
      { url: "https://console.cloud.google.com/billing", pdfName: "gcp-billing.pdf", label: "GCP billing" },
    ],
  },
  {
    name: "browserbase",
    expensable: true,
    urls: [
      { url: "https://www.browserbase.com/settings/billing", pdfName: "browserbase-billing.pdf", label: "Browserbase billing" },
    ],
  },
  {
    name: "notion",
    expensable: false,
    note: "NOT EXPENSABLE — personal per user",
    urls: [
      { url: "https://www.notion.so/settings/billing", pdfName: "notion-billing.pdf", label: "Notion billing" },
    ],
  },
  {
    name: "azure",
    expensable: true,
    note: "Re-scrape with longer wait times for SPA",
    urls: [
      { url: "https://portal.azure.com/#view/Microsoft_Azure_CostManagement/Menu/~/invoices", pdfName: "azure-invoices.pdf", label: "Azure invoices" },
      { url: "https://portal.azure.com/#view/Microsoft_Azure_CostManagement/Menu/~/costanalysis", pdfName: "azure-cost-analysis.pdf", label: "Azure cost analysis" },
    ],
  },
];

async function scrapePortal(portal: Portal): Promise<any> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`${portal.name.toUpperCase()} ${portal.note ? `— ${portal.note}` : ""}`);
  console.log(`${"=".repeat(60)}`);

  const dir = path.join(OUT, "Invoices", portal.name.charAt(0).toUpperCase() + portal.name.slice(1).replace(/-./g, m => m[1].toUpperCase()));
  fs.mkdirSync(dir, { recursive: true });

  let stagehand: Stagehand | null = null;
  try {
    stagehand = await getStagehand();
    const page = await stagehand.context.newPage();
    const result: any = {
      source: portal.name,
      scrapedAt: new Date().toISOString(),
      expensable: portal.expensable,
      note: portal.note || null,
      pages: [],
    };

    for (const urlConfig of portal.urls) {
      console.log(`  ${urlConfig.label}...`);
      try {
        const isAzure = urlConfig.url.includes("portal.azure.com");
        const waitMs = isAzure ? 12000 : 5000;

        await page.goto(urlConfig.url, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForTimeout(waitMs);

        const rawData = await scrapeRaw(page);
        await printPDF(page, path.join(dir, urlConfig.pdfName));

        // Try AI extraction only on the first URL of each portal to avoid session issues
        let aiExtract: any = null;
        if (portal.urls.indexOf(urlConfig) === 0) {
          try {
            aiExtract = await stagehand.extract({
              instruction: `Extract all billing information from this ${portal.name} page: plan name, monthly cost, billing history, invoices with dates and amounts, services being billed, payment method.`,
              schema: BillingSchema,
            });
            if (aiExtract.planName) console.log(`  Plan: ${aiExtract.planName}`);
            if (aiExtract.monthlyAmount) console.log(`  Monthly: ${aiExtract.monthlyAmount}`);
            if (aiExtract.invoices?.length) console.log(`  Invoices: ${aiExtract.invoices.length}`);
          } catch (e: any) {
            console.log(`  AI extract: ${e.message.substring(0, 60)}`);
          }
        }

        result.pages.push({
          url: rawData.url,
          label: urlConfig.label,
          pdfName: urlConfig.pdfName,
          rawData,
          aiExtract,
        });
      } catch (e: any) {
        console.log(`  ERROR on ${urlConfig.label}: ${e.message.substring(0, 80)}`);
        result.pages.push({ url: urlConfig.url, label: urlConfig.label, error: e.message });
      }
    }

    await page.close();
    const chunkPath = path.join(OUT, `chunk_${portal.name.replace(/-/g, '_')}.json`);
    fs.writeFileSync(chunkPath, JSON.stringify(result, null, 2));
    console.log(`  Saved ${path.basename(chunkPath)}`);
    return result;
  } catch (e: any) {
    console.log(`  PORTAL FAILED: ${e.message.substring(0, 100)}`);
    return { source: portal.name, error: e.message };
  } finally {
    try { await stagehand?.close(); } catch {}
  }
}

async function main() {
  const allResults: Record<string, any> = {};

  for (const portal of PORTALS) {
    allResults[portal.name] = await scrapePortal(portal);
    // Brief pause between portals to let Chrome clean up
    await new Promise(r => setTimeout(r, 2000));
  }

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log("ALL REMAINING PORTALS COMPLETE");
  console.log(`${"=".repeat(60)}`);

  const pdfs = fs.readdirSync(path.join(OUT, "Invoices"), { recursive: true })
    .filter((f: any) => f.toString().endsWith('.pdf'));
  console.log(`Total PDFs: ${pdfs.length}`);

  for (const [name, result] of Object.entries(allResults)) {
    const status = (result as any).error ? "FAILED" : "OK";
    const pages = (result as any).pages?.length || 0;
    console.log(`  ${name}: ${status} (${pages} pages)`);
  }

  fs.writeFileSync(path.join(OUT, "portal_remaining_results.json"), JSON.stringify(allResults, null, 2));
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
