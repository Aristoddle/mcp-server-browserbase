import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";

const OUT = path.join(process.env.HOME!, "Documents", "Expenses");

const BillingSchema = z.object({
  planName: z.string().optional().describe("Current plan name"),
  monthlyAmount: z.string().optional().describe("Monthly billing amount with $"),
  totalSpend: z.string().optional().describe("Total spend with $"),
  invoices: z.array(z.object({
    date: z.string().describe("Invoice date"),
    amount: z.string().describe("Amount with $"),
    status: z.string().optional(),
    invoiceNumber: z.string().optional(),
    downloadUrl: z.string().optional().describe("URL to download invoice PDF if visible"),
  })).optional(),
  services: z.array(z.string()).optional(),
});

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
        l.match(/\$/) || l.match(/plan/i) || l.match(/invoice/i) || l.match(/billing/i) || l.match(/subscription/i) || l.match(/receipt/i)
      ).slice(0, 50),
      allLinks: Array.from(document.querySelectorAll('a'))
        .map((a: any) => ({ href: a.href, text: (a.textContent || "").trim().substring(0, 100) }))
        .filter((l: any) => l.href.match(/invoice|receipt|billing|payment|download|pdf/i) || l.text.match(/invoice|receipt|download|pdf/i))
        .slice(0, 30),
      url: window.location.href,
    };
  });
}

interface PortalResult {
  source: string;
  scrapedAt: string;
  expensable: boolean;
  note?: string;
  billingExtract?: any;
  rawData?: any;
  pdfsSaved: string[];
  invoiceLinks?: any[];
}

async function scrapePortal(name: string, urls: string[], dir: string, note?: string): Promise<PortalResult> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`${name.toUpperCase()} ${note ? `— ${note}` : ""}`);
  console.log("=".repeat(60));

  fs.mkdirSync(dir, { recursive: true });
  const result: PortalResult = {
    source: name, scrapedAt: new Date().toISOString(), expensable: true,
    note, pdfsSaved: [], invoiceLinks: [],
  };

  let stagehand: Stagehand | null = null;
  try {
    stagehand = await getStagehand();
    const page = await stagehand.context.newPage();

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      console.log(`  Loading: ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(5000);

      const rawData = await scrapeRaw(page);
      if (i === 0) result.rawData = rawData;
      if (rawData.allLinks.length) {
        result.invoiceLinks!.push(...rawData.allLinks);
        console.log(`  Found ${rawData.allLinks.length} invoice/receipt links`);
      }
      if (rawData.amounts.length) {
        console.log(`  Amounts: ${rawData.amounts.slice(0, 5).join(', ')}`);
      }

      // Try AI extraction on first URL
      if (i === 0) {
        try {
          result.billingExtract = await stagehand.extract({
            instruction: `Extract ALL billing information from this ${name} page: plan name, monthly cost, total spend, all invoices with dates/amounts/invoice numbers, any download links for invoice PDFs.`,
            schema: BillingSchema,
          });
          if (result.billingExtract?.planName) console.log(`  Plan: ${result.billingExtract.planName}`);
          if (result.billingExtract?.monthlyAmount) console.log(`  Monthly: ${result.billingExtract.monthlyAmount}`);
          if (result.billingExtract?.invoices?.length) console.log(`  Invoices: ${result.billingExtract.invoices.length}`);
        } catch (e: any) {
          console.log(`  AI extract: ${e.message.substring(0, 60)}`);
        }
      }

      const pdfName = `${name}-${i === 0 ? 'billing' : `page-${i + 1}`}.pdf`;
      if (await printPDF(page, path.join(dir, pdfName))) {
        result.pdfsSaved.push(pdfName);
      }
    }

    // Try to download individual invoice PDFs from links found
    for (const link of (result.invoiceLinks || []).slice(0, 10)) {
      if (link.href && (link.href.includes('invoice') || link.href.includes('receipt') || link.href.includes('pdf') || link.href.includes('download'))) {
        try {
          const invPage = await stagehand.context.newPage();
          await invPage.goto(link.href, { waitUntil: "domcontentloaded", timeout: 15000 });
          await invPage.waitForTimeout(2000);
          const pdfName = `${name}-invoice-${result.pdfsSaved.length + 1}.pdf`;
          if (await printPDF(invPage, path.join(dir, pdfName))) {
            result.pdfsSaved.push(pdfName);
          }
          await invPage.close();
        } catch (e: any) {
          console.log(`  Invoice download: ${e.message.substring(0, 60)}`);
        }
      }
    }

    await page.close();
  } catch (e: any) {
    console.log(`  PORTAL ERROR: ${e.message.substring(0, 100)}`);
  } finally {
    try { await stagehand?.close(); } catch {}
  }

  return result;
}

async function main() {
  const allResults: Record<string, PortalResult> = {};

  // ==========================================
  // 1. ELEVENLABS ($44 in email, TTS service)
  // ==========================================
  allResults.elevenlabs = await scrapePortal(
    "elevenlabs",
    [
      "https://elevenlabs.io/app/billing",
      "https://elevenlabs.io/app/billing/invoices",
    ],
    path.join(OUT, "Invoices", "ElevenLabs"),
    "$44 found in email — TTS service, work expense",
  );
  fs.writeFileSync(path.join(OUT, "chunk_elevenlabs.json"), JSON.stringify(allResults.elevenlabs, null, 2));
  await new Promise(r => setTimeout(r, 2000));

  // ==========================================
  // 2. HUME AI ($3/mo TTS Starter)
  // ==========================================
  allResults.humeai = await scrapePortal(
    "humeai",
    [
      "https://platform.hume.ai/settings/billing",
      "https://platform.hume.ai/settings/billing/invoices",
    ],
    path.join(OUT, "Invoices", "HumeAI"),
    "$3/mo TTS Starter plan — work expense",
  );
  fs.writeFileSync(path.join(OUT, "chunk_humeai.json"), JSON.stringify(allResults.humeai, null, 2));
  await new Promise(r => setTimeout(r, 2000));

  // ==========================================
  // 3. MOTION SOFTWARE ($228/yr annual)
  // ==========================================
  allResults.motion = await scrapePortal(
    "motion",
    [
      "https://app.usemotion.com/settings/billing",
      "https://app.usemotion.com/web/settings/billing",
    ],
    path.join(OUT, "Invoices", "Motion"),
    "$228/yr annual — productivity tool, work expense",
  );
  fs.writeFileSync(path.join(OUT, "chunk_motion.json"), JSON.stringify(allResults.motion, null, 2));
  await new Promise(r => setTimeout(r, 2000));

  // ==========================================
  // 4. OPENAI (API usage)
  // ==========================================
  allResults.openai = await scrapePortal(
    "openai",
    [
      "https://platform.openai.com/settings/organization/billing/overview",
      "https://platform.openai.com/settings/organization/billing/history",
    ],
    path.join(OUT, "Invoices", "OpenAI"),
    "API usage — check for work-related credits",
  );
  fs.writeFileSync(path.join(OUT, "chunk_openai.json"), JSON.stringify(allResults.openai, null, 2));
  await new Promise(r => setTimeout(r, 2000));

  // ==========================================
  // 5. AIRBNB (main stay receipt $3,738)
  // ==========================================
  allResults.airbnb = await scrapePortal(
    "airbnb",
    [
      "https://www.airbnb.com/account-settings/payments/receipt-index",
      "https://www.airbnb.com/trips/v1",
    ],
    path.join(OUT, "Invoices", "Airbnb"),
    "31-night Plano stay $3,738 — work relocation expense",
  );
  fs.writeFileSync(path.join(OUT, "chunk_airbnb_portal.json"), JSON.stringify(allResults.airbnb, null, 2));
  await new Promise(r => setTimeout(r, 2000));

  // ==========================================
  // 6. ANTHROPIC CONSOLE — formal invoice PDFs
  // ==========================================
  console.log(`\n${"=".repeat(60)}`);
  console.log("ANTHROPIC — FORMAL STRIPE INVOICE PDFs");
  console.log("=".repeat(60));
  {
    const dir = path.join(OUT, "Invoices", "Anthropic");
    let stagehand: Stagehand | null = null;
    try {
      stagehand = await getStagehand();
      const page = await stagehand.context.newPage();

      // Try the billing invoices page
      await page.goto("https://console.anthropic.com/settings/billing", { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(5000);

      // Look for invoice download links
      const invoiceLinks = await page.evaluate(() => {
        const links: any[] = [];
        document.querySelectorAll('a').forEach((a: any) => {
          const href = a.href || "";
          const text = (a.textContent || "").trim();
          if (href.match(/invoice|receipt|stripe|pay\.stripe/i) || text.match(/invoice|receipt|download|pdf/i)) {
            links.push({ href, text: text.substring(0, 100) });
          }
        });
        // Also check for buttons
        document.querySelectorAll('button').forEach((b: any) => {
          const text = (b.textContent || "").trim();
          if (text.match(/invoice|receipt|download|pdf/i)) {
            links.push({ text, isButton: true });
          }
        });
        return links;
      });

      console.log(`  Found ${invoiceLinks.length} invoice links/buttons`);
      for (const link of invoiceLinks) {
        console.log(`    ${link.text} ${link.href ? `→ ${link.href.substring(0, 80)}` : '(button)'}`);
      }

      // Try to use Stagehand to find and click download buttons
      try {
        const obs = await stagehand.observe({ instruction: "Find any buttons or links to download invoices, view receipts, or access billing history. Look for invoice numbers matching 2430C5FC-0023, 2430C5FC-0025." });
        console.log("  Observe results:", JSON.stringify(obs).substring(0, 500));
      } catch (e: any) {
        console.log(`  Observe: ${e.message.substring(0, 60)}`);
      }

      // Download any invoice PDFs from Stripe links
      for (const link of invoiceLinks) {
        if (link.href && link.href.match(/stripe|invoice|receipt/i)) {
          try {
            const invPage = await stagehand.context.newPage();
            await invPage.goto(link.href, { waitUntil: "domcontentloaded", timeout: 15000 });
            await invPage.waitForTimeout(2000);
            const idx = invoiceLinks.indexOf(link) + 1;
            await printPDF(invPage, path.join(dir, `anthropic-formal-invoice-${idx}.pdf`));
            await invPage.close();
          } catch (e: any) {
            console.log(`  Invoice download: ${e.message.substring(0, 60)}`);
          }
        }
      }

      // Also try claude.ai billing page for Max plan receipts
      console.log("\n  Checking claude.ai billing...");
      await page.goto("https://claude.ai/settings/billing", { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(4000);

      const claudeLinks = await page.evaluate(() => {
        const links: any[] = [];
        document.querySelectorAll('a, button').forEach((el: any) => {
          const text = (el.textContent || "").trim();
          const href = el.href || "";
          if (text.match(/invoice|receipt|manage|stripe|billing/i) || href.match(/stripe|invoice|receipt/i)) {
            links.push({ text: text.substring(0, 100), href: href || null, tag: el.tagName });
          }
        });
        return links;
      });
      console.log(`  Claude.ai billing links: ${claudeLinks.length}`);
      for (const link of claudeLinks.slice(0, 10)) {
        console.log(`    [${link.tag}] ${link.text} ${link.href ? `→ ${link.href.substring(0, 80)}` : ''}`);
      }

      // Try Stripe-hosted invoice page
      // Known Anthropic receipt numbers from email: 2313-2009-1655, 2259-5306-0773, 2014-4102-1808
      console.log("\n  Trying Stripe customer portal...");
      await page.goto("https://billing.stripe.com/p/login/00gdQU1rg3yQf1m000", { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(4000);
      await printPDF(page, path.join(dir, "anthropic-stripe-portal.pdf"));

      const stripeData = await scrapeRaw(page);
      console.log(`  Stripe portal amounts: ${stripeData.amounts.slice(0, 5).join(', ')}`);

      allResults.anthropicFormal = {
        source: "anthropic-formal", scrapedAt: new Date().toISOString(), expensable: true,
        note: "Formal Stripe invoice PDFs for $200/mo Claude Max plan",
        pdfsSaved: [], invoiceLinks, claudeLinks,
      };
      fs.writeFileSync(path.join(OUT, "chunk_anthropic_formal.json"), JSON.stringify(allResults.anthropicFormal, null, 2));

      await page.close();
    } catch (e: any) {
      console.log(`  ERROR: ${e.message.substring(0, 100)}`);
    } finally {
      try { await stagehand?.close(); } catch {}
    }
  }
  await new Promise(r => setTimeout(r, 2000));

  // ==========================================
  // 7. VERCEL — formal invoice PDFs
  // ==========================================
  console.log(`\n${"=".repeat(60)}`);
  console.log("VERCEL — FORMAL INVOICE PDFs");
  console.log("=".repeat(60));
  {
    const dir = path.join(OUT, "Invoices", "Vercel");
    let stagehand: Stagehand | null = null;
    try {
      stagehand = await getStagehand();
      const page = await stagehand.context.newPage();

      // Go to Vercel billing with invoices
      await page.goto("https://vercel.com/~/account/billing", { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(5000);

      // Extract billing data with AI
      try {
        const extract = await stagehand.extract({
          instruction: "Extract all billing information: plan name, monthly cost, all invoices with dates and amounts, and any download links for invoice PDFs. Look for Stripe receipt links.",
          schema: BillingSchema,
        });
        console.log(`  Plan: ${extract.planName}, Monthly: ${extract.monthlyAmount}`);
        if (extract.invoices?.length) {
          console.log(`  Invoices: ${extract.invoices.length}`);
          extract.invoices.forEach((inv: any) => console.log(`    ${inv.date} — ${inv.amount} ${inv.invoiceNumber || ''}`));
        }
        allResults.vercelFormal = { source: "vercel-formal", scrapedAt: new Date().toISOString(), expensable: true, billingExtract: extract, pdfsSaved: [] };
      } catch (e: any) {
        console.log(`  AI extract: ${e.message.substring(0, 60)}`);
      }

      // Look for invoice links
      const invoiceLinks = await page.evaluate(() => {
        const links: any[] = [];
        document.querySelectorAll('a').forEach((a: any) => {
          const href = a.href || "";
          const text = (a.textContent || "").trim();
          if (href.match(/invoice|receipt|stripe/i) || text.match(/invoice|receipt|download/i)) {
            links.push({ href, text: text.substring(0, 100) });
          }
        });
        return links;
      });
      console.log(`  Invoice links: ${invoiceLinks.length}`);
      for (const link of invoiceLinks.slice(0, 5)) {
        console.log(`    ${link.text} → ${link.href.substring(0, 80)}`);
      }

      await printPDF(page, path.join(dir, "vercel-billing-v2.pdf"));

      // Try clicking "Invoices" tab or section
      try {
        await stagehand.act({ action: "Click on the Invoices tab or section to see invoice history" });
        await page.waitForTimeout(3000);
        await printPDF(page, path.join(dir, "vercel-invoices-tab.pdf"));
      } catch (e: any) {
        console.log(`  Invoices tab: ${e.message.substring(0, 60)}`);
      }

      fs.writeFileSync(path.join(OUT, "chunk_vercel_formal.json"), JSON.stringify(allResults.vercelFormal || { source: "vercel-formal", invoiceLinks }, null, 2));

      await page.close();
    } catch (e: any) {
      console.log(`  ERROR: ${e.message.substring(0, 100)}`);
    } finally {
      try { await stagehand?.close(); } catch {}
    }
  }
  await new Promise(r => setTimeout(r, 2000));

  // ==========================================
  // 8. GOOGLE PLAY ORDER HISTORY (formal receipts)
  // ==========================================
  allResults.googlePlay = await scrapePortal(
    "googleplay",
    [
      "https://play.google.com/store/account/orderhistory",
      "https://play.google.com/store/account/subscriptions",
    ],
    path.join(OUT, "Invoices", "GooglePlay"),
    "Google AI Ultra ($124.99/mo) receipts — formal Google Play order receipts",
  );
  fs.writeFileSync(path.join(OUT, "chunk_googleplay.json"), JSON.stringify(allResults.googlePlay, null, 2));

  // ==========================================
  // SUMMARY
  // ==========================================
  console.log(`\n${"=".repeat(60)}`);
  console.log("WAVE 2 COMPLETE — SUMMARY");
  console.log("=".repeat(60));

  const totalNewPDFs = fs.readdirSync(path.join(OUT, "Invoices"), { recursive: true })
    .filter((f: any) => f.toString().endsWith('.pdf')).length;
  console.log(`Total PDFs now: ${totalNewPDFs}`);

  for (const [name, result] of Object.entries(allResults)) {
    if (result) {
      console.log(`  ${name}: ${result.pdfsSaved?.length || 0} PDFs | ${result.billingExtract?.planName || 'no plan extracted'}`);
    }
  }
}

main().catch(e => { console.error("FATAL:", e.message, e.stack?.substring(0, 200)); process.exit(1); });
