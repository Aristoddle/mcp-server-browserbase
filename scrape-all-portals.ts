import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";

const OUT = path.join(process.env.HOME!, "Documents", "Expenses");

interface PortalConfig {
  name: string;
  urls: string[];
  extractSchema: z.ZodType<any>;
  extractInstruction: string;
  pdfName: string;
  /** Extra pages to print as PDF (e.g. invoice list pages) */
  extraPdfUrls?: { url: string; name: string }[];
  /** How long to wait for SPA to load */
  waitMs?: number;
}

async function printPDF(page: any, filePath: string): Promise<boolean> {
  try {
    const { data } = await (page as any).mainSession.send("Page.printToPDF", {
      printBackground: true,
      landscape: false,
      scale: 0.8,
      paperWidth: 8.5,
      paperHeight: 11,
    });
    fs.writeFileSync(filePath, Buffer.from(data, "base64"));
    console.log(`  PDF saved: ${path.basename(filePath)} (${(Buffer.from(data, "base64").length / 1024).toFixed(0)}KB)`);
    return true;
  } catch (e: any) {
    console.log(`  PDF failed: ${e.message}`);
    return false;
  }
}

async function scrapePage(stagehand: Stagehand, page: any, url: string, waitMs: number): Promise<any> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(waitMs);

  // Get full page text for fallback extraction
  const pageText = await page.evaluate(() => {
    const text = document.body.innerText;
    const amounts = text.match(/\$[\d,]+\.?\d*/g) || [];
    const dates = text.match(/\w+\s+\d{1,2},?\s+\d{4}/g) || [];
    const lines = text.split('\n').filter((l: string) => l.trim().length > 0);
    const invoiceLinks: string[] = [];
    document.querySelectorAll('a').forEach((a: any) => {
      const href = a.href || "";
      if (href.match(/invoice|receipt|billing|payment/i) && !invoiceLinks.includes(href)) {
        invoiceLinks.push(href);
      }
    });
    return { amounts, dates, lines: lines.slice(0, 100), invoiceLinks: invoiceLinks.slice(0, 20), url: window.location.href };
  });

  return pageText;
}

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
  nextBillingDate: z.string().optional().describe("Next billing date"),
});

const UberTripSchema = z.object({
  trips: z.array(z.object({
    date: z.string().describe("Trip date and time"),
    amount: z.string().describe("Trip cost with $ sign"),
    pickupLocation: z.string().describe("Pickup address or location name"),
    dropoffLocation: z.string().describe("Dropoff address or location name"),
    rideType: z.string().optional().describe("UberX, Uber Eats, etc"),
    distance: z.string().optional().describe("Trip distance if shown"),
    duration: z.string().optional().describe("Trip duration if shown"),
  })).describe("All visible trips on the page"),
});

const MongoDBSchema = z.object({
  organizations: z.array(z.object({
    name: z.string().describe("Organization name"),
    clusters: z.array(z.object({
      name: z.string().describe("Cluster name"),
      tier: z.string().describe("Cluster tier (M0, M2, M10, etc)"),
      provider: z.string().optional().describe("Cloud provider (AWS, Azure, GCP)"),
      region: z.string().optional().describe("Region"),
      status: z.string().optional().describe("Running, paused, etc"),
    })).optional(),
  })).optional(),
  totalMonthlyEstimate: z.string().optional().describe("Total monthly cost estimate"),
  invoices: z.array(z.object({
    date: z.string(),
    amount: z.string(),
    status: z.string().optional(),
  })).optional(),
  currentBill: z.string().optional().describe("Current month charges so far"),
});

async function main() {
  const { webSocketDebuggerUrl } = await (await fetch("http://127.0.0.1:9222/json/version")).json();
  const stagehand = new Stagehand({
    env: "LOCAL",
    localBrowserLaunchOptions: { cdpUrl: webSocketDebuggerUrl },
    model: { modelName: "openai/gpt-4.1", apiKey: process.env.AZURE_API_KEY!, baseURL: process.env.AZURE_BASE_URL! },
  });
  await stagehand.init();

  const allResults: Record<string, any> = {};

  // ============================================================
  // PORTAL 1: MongoDB Atlas — URGENT INVESTIGATION ($507 unknown)
  // ============================================================
  console.log("\n" + "=".repeat(60));
  console.log("MONGODB ATLAS — INVESTIGATING $507 SUSPICIOUS CHARGES");
  console.log("=".repeat(60));
  {
    const dir = path.join(OUT, "Invoices", "MongoDB");
    fs.mkdirSync(dir, { recursive: true });
    const page = await stagehand.context.newPage();

    // First check what organizations/projects exist
    await page.goto("https://cloud.mongodb.com", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(6000);

    let mongoData: any = {};
    try {
      mongoData = await stagehand.extract({
        instruction: "Extract ALL information about MongoDB Atlas organizations, projects, and clusters. I need to know: what organizations exist, what clusters are running, what tier they are (M0 free, M2, M10, etc), what cloud provider and region, and any billing/cost information visible. Also extract any billing amounts, invoices, or payment information.",
        schema: MongoDBSchema,
      });
      console.log("MongoDB extract:", JSON.stringify(mongoData, null, 2));
    } catch (e: any) {
      console.log(`MongoDB AI extract failed: ${e.message}`);
    }

    // Also get raw page data
    const rawData = await scrapePage(stagehand, page, "https://cloud.mongodb.com", 5000);
    await printPDF(page, path.join(dir, "mongodb-dashboard.pdf"));

    // Try billing page
    console.log("  Checking billing...");
    const billingData = await scrapePage(stagehand, page, "https://cloud.mongodb.com/v2#/org/billing/overview", 6000);
    await printPDF(page, path.join(dir, "mongodb-billing.pdf"));

    let billingExtract: any = {};
    try {
      billingExtract = await stagehand.extract({
        instruction: "Extract all billing information: current charges, past invoices with dates and amounts, payment methods, and any active subscriptions or running clusters that are costing money.",
        schema: BillingSchema,
      });
    } catch (e: any) {
      console.log(`MongoDB billing extract: ${e.message}`);
    }

    // Try invoices specifically
    const invoiceData = await scrapePage(stagehand, page, "https://cloud.mongodb.com/v2#/org/billing/invoices", 6000);
    await printPDF(page, path.join(dir, "mongodb-invoices.pdf"));

    allResults.mongodb = {
      source: "mongodb-atlas",
      scrapedAt: new Date().toISOString(),
      INVESTIGATION: "User does NOT recognize $507 in MongoDB charges — could be forgotten cluster",
      aiExtract: mongoData,
      billingExtract,
      rawDashboard: rawData,
      rawBilling: billingData,
      rawInvoices: invoiceData,
    };
    fs.writeFileSync(path.join(OUT, "chunk_mongodb.json"), JSON.stringify(allResults.mongodb, null, 2));
    console.log("  Saved chunk_mongodb.json");
    await page.close();
  }

  // ============================================================
  // PORTAL 2: Uber — Need ROUTES and TIMES for expense classification
  // ============================================================
  console.log("\n" + "=".repeat(60));
  console.log("UBER — TRIP HISTORY WITH ROUTES AND TIMES");
  console.log("=".repeat(60));
  {
    const dir = path.join(OUT, "Invoices", "Uber");
    fs.mkdirSync(dir, { recursive: true });
    const page = await stagehand.context.newPage();
    await page.goto("https://riders.uber.com/trips", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(6000);

    let allTrips: any[] = [];

    // Use AI extraction for trip data with routes
    try {
      const tripData = await stagehand.extract({
        instruction: "Extract ALL visible trips. For each trip, I need: the exact date and time, the dollar amount, the pickup location/address, the dropoff location/address, and the ride type (UberX, Uber Eats, etc). Include every trip visible on the page.",
        schema: UberTripSchema,
      });
      allTrips = tripData.trips || [];
      console.log(`  AI extracted ${allTrips.length} trips`);
    } catch (e: any) {
      console.log(`  AI extract failed: ${e.message}`);
    }

    // Scroll to load more and extract again
    for (let scroll = 0; scroll < 5; scroll++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(3000);
      try {
        const moreTripData = await stagehand.extract({
          instruction: "Extract ALL visible trips that I haven't seen before (focus on trips further down the page). For each: date/time, amount, pickup location, dropoff location, ride type.",
          schema: UberTripSchema,
        });
        const newTrips = (moreTripData.trips || []).filter((t: any) =>
          !allTrips.some((e: any) => e.date === t.date && e.amount === t.amount)
        );
        if (newTrips.length === 0) break;
        allTrips.push(...newTrips);
        console.log(`  Scroll ${scroll + 1}: ${newTrips.length} new (total: ${allTrips.length})`);
      } catch {
        break;
      }
    }

    await printPDF(page, path.join(dir, "uber-trips-overview.pdf"));

    // Get raw data as fallback
    const rawData = await scrapePage(stagehand, page, page.url(), 2000);

    // Classify trips
    const classifiedTrips = allTrips.map((trip: any) => {
      const isUberEats = /eats|delivery|food/i.test(trip.rideType || "");
      let isWorkExpense = false;
      let reason = "";
      if (isUberEats) {
        isWorkExpense = true;
        reason = "Uber Eats — check if delivered to office";
      } else {
        // Not a regular commute if going somewhere unusual
        isWorkExpense = true; // Flag all for user review
        reason = "Ride — user to classify (commute = not expensable, other business travel = expensable)";
      }
      return { ...trip, isUberEats, isWorkExpense, classificationReason: reason };
    });

    allResults.uber = {
      source: "uber",
      scrapedAt: new Date().toISOString(),
      trips: classifiedTrips,
      totalTrips: classifiedTrips.length,
      uberEatsOrders: classifiedTrips.filter((t: any) => t.isUberEats).length,
      rawFallback: rawData,
    };
    fs.writeFileSync(path.join(OUT, "chunk_uber.json"), JSON.stringify(allResults.uber, null, 2));
    console.log(`  Saved chunk_uber.json (${classifiedTrips.length} trips)`);

    // Download individual trip receipts
    let receiptCount = 0;
    for (const trip of allTrips.slice(0, 15)) {
      try {
        // Try clicking into trip details
        const tripPage = await stagehand.context.newPage();
        // Uber trip detail URL pattern
        await tripPage.goto(`https://riders.uber.com/trips`, { waitUntil: "domcontentloaded", timeout: 15000 });
        await tripPage.waitForTimeout(2000);
        break; // Just get the overview PDF for now
      } catch {
        break;
      }
    }

    await page.close();
  }

  // ============================================================
  // PORTAL 3: ClickHouse Cloud ($150/mo cluster)
  // ============================================================
  console.log("\n" + "=".repeat(60));
  console.log("CLICKHOUSE CLOUD BILLING");
  console.log("=".repeat(60));
  {
    const dir = path.join(OUT, "Invoices", "ClickHouse");
    fs.mkdirSync(dir, { recursive: true });
    const page = await stagehand.context.newPage();

    // Try the billing page
    await page.goto("https://clickhouse.cloud/billing", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(6000);

    let billingExtract: any = {};
    try {
      billingExtract = await stagehand.extract({
        instruction: "Extract all billing information: current plan, monthly spend, billing history, invoices with dates and amounts, services/clusters being billed, and payment method.",
        schema: BillingSchema,
      });
      console.log(`  Plan: ${billingExtract.planName}, Monthly: ${billingExtract.monthlyAmount}`);
    } catch (e: any) {
      console.log(`  AI extract: ${e.message}`);
    }

    const rawData = await scrapePage(stagehand, page, page.url(), 2000);
    await printPDF(page, path.join(dir, "clickhouse-billing.pdf"));

    // Try invoices page
    const invoiceRaw = await scrapePage(stagehand, page, "https://clickhouse.cloud/billing/invoices", 5000);
    await printPDF(page, path.join(dir, "clickhouse-invoices.pdf"));

    allResults.clickhouse = {
      source: "clickhouse-cloud",
      scrapedAt: new Date().toISOString(),
      billingExtract,
      rawBilling: rawData,
      rawInvoices: invoiceRaw,
    };
    fs.writeFileSync(path.join(OUT, "chunk_clickhouse.json"), JSON.stringify(allResults.clickhouse, null, 2));
    console.log("  Saved chunk_clickhouse.json");
    await page.close();
  }

  // ============================================================
  // PORTAL 4: Cloudflare (domains, Workers, R2)
  // ============================================================
  console.log("\n" + "=".repeat(60));
  console.log("CLOUDFLARE BILLING");
  console.log("=".repeat(60));
  {
    const dir = path.join(OUT, "Invoices", "Cloudflare");
    fs.mkdirSync(dir, { recursive: true });
    const page = await stagehand.context.newPage();

    await page.goto("https://dash.cloudflare.com/?to=/:account/billing", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(6000);

    let billingExtract: any = {};
    try {
      billingExtract = await stagehand.extract({
        instruction: "Extract all billing information: subscriptions, billing history, invoices, domain registrations, Workers usage, R2 storage charges, and payment method. Include all amounts and dates.",
        schema: BillingSchema,
      });
      console.log(`  Plan: ${billingExtract.planName}, Monthly: ${billingExtract.monthlyAmount}`);
    } catch (e: any) {
      console.log(`  AI extract: ${e.message}`);
    }

    const rawData = await scrapePage(stagehand, page, page.url(), 2000);
    await printPDF(page, path.join(dir, "cloudflare-billing.pdf"));

    // Try subscriptions page
    const subsRaw = await scrapePage(stagehand, page, "https://dash.cloudflare.com/?to=/:account/billing/subscriptions", 5000);
    await printPDF(page, path.join(dir, "cloudflare-subscriptions.pdf"));

    // Try billing history for invoices
    const historyRaw = await scrapePage(stagehand, page, "https://dash.cloudflare.com/?to=/:account/billing/billing-history", 5000);
    await printPDF(page, path.join(dir, "cloudflare-history.pdf"));

    allResults.cloudflare = {
      source: "cloudflare",
      scrapedAt: new Date().toISOString(),
      billingExtract,
      rawBilling: rawData,
      rawSubscriptions: subsRaw,
      rawHistory: historyRaw,
    };
    fs.writeFileSync(path.join(OUT, "chunk_cloudflare.json"), JSON.stringify(allResults.cloudflare, null, 2));
    console.log("  Saved chunk_cloudflare.json");
    await page.close();
  }

  // ============================================================
  // PORTAL 5: Tailscale
  // ============================================================
  console.log("\n" + "=".repeat(60));
  console.log("TAILSCALE BILLING");
  console.log("=".repeat(60));
  {
    const dir = path.join(OUT, "Invoices", "Tailscale");
    fs.mkdirSync(dir, { recursive: true });
    const page = await stagehand.context.newPage();

    await page.goto("https://login.tailscale.com/admin/billing", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(5000);

    let billingExtract: any = {};
    try {
      billingExtract = await stagehand.extract({
        instruction: "Extract billing information: plan name, monthly cost, billing history, invoices, and payment method.",
        schema: BillingSchema,
      });
      console.log(`  Plan: ${billingExtract.planName}, Monthly: ${billingExtract.monthlyAmount}`);
    } catch (e: any) {
      console.log(`  AI extract: ${e.message}`);
    }

    const rawData = await scrapePage(stagehand, page, page.url(), 2000);
    await printPDF(page, path.join(dir, "tailscale-billing.pdf"));

    allResults.tailscale = {
      source: "tailscale",
      scrapedAt: new Date().toISOString(),
      billingExtract,
      rawBilling: rawData,
    };
    fs.writeFileSync(path.join(OUT, "chunk_tailscale.json"), JSON.stringify(allResults.tailscale, null, 2));
    console.log("  Saved chunk_tailscale.json");
    await page.close();
  }

  // ============================================================
  // PORTAL 6: ngrok ($40 found in email)
  // ============================================================
  console.log("\n" + "=".repeat(60));
  console.log("NGROK BILLING");
  console.log("=".repeat(60));
  {
    const dir = path.join(OUT, "Invoices", "ngrok");
    fs.mkdirSync(dir, { recursive: true });
    const page = await stagehand.context.newPage();

    await page.goto("https://dashboard.ngrok.com/billing", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(5000);

    let billingExtract: any = {};
    try {
      billingExtract = await stagehand.extract({
        instruction: "Extract billing information: plan name, monthly cost, billing history with invoice dates and amounts, and payment method.",
        schema: BillingSchema,
      });
      console.log(`  Plan: ${billingExtract.planName}, Monthly: ${billingExtract.monthlyAmount}`);
    } catch (e: any) {
      console.log(`  AI extract: ${e.message}`);
    }

    const rawData = await scrapePage(stagehand, page, page.url(), 2000);
    await printPDF(page, path.join(dir, "ngrok-billing.pdf"));

    // Try invoices
    const invoiceRaw = await scrapePage(stagehand, page, "https://dashboard.ngrok.com/billing/invoices", 4000);
    await printPDF(page, path.join(dir, "ngrok-invoices.pdf"));

    allResults.ngrok = {
      source: "ngrok",
      scrapedAt: new Date().toISOString(),
      billingExtract,
      rawBilling: rawData,
      rawInvoices: invoiceRaw,
    };
    fs.writeFileSync(path.join(OUT, "chunk_ngrok.json"), JSON.stringify(allResults.ngrok, null, 2));
    console.log("  Saved chunk_ngrok.json");
    await page.close();
  }

  // ============================================================
  // PORTAL 7: LiveKit Cloud
  // ============================================================
  console.log("\n" + "=".repeat(60));
  console.log("LIVEKIT CLOUD BILLING");
  console.log("=".repeat(60));
  {
    const dir = path.join(OUT, "Invoices", "LiveKit");
    fs.mkdirSync(dir, { recursive: true });
    const page = await stagehand.context.newPage();

    await page.goto("https://cloud.livekit.io/settings/billing", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(5000);

    let billingExtract: any = {};
    try {
      billingExtract = await stagehand.extract({
        instruction: "Extract billing information: plan name, monthly cost, usage charges, billing history with invoice dates and amounts, and payment method.",
        schema: BillingSchema,
      });
      console.log(`  Plan: ${billingExtract.planName}, Monthly: ${billingExtract.monthlyAmount}`);
    } catch (e: any) {
      console.log(`  AI extract: ${e.message}`);
    }

    const rawData = await scrapePage(stagehand, page, page.url(), 2000);
    await printPDF(page, path.join(dir, "livekit-billing.pdf"));

    allResults.livekit = {
      source: "livekit-cloud",
      scrapedAt: new Date().toISOString(),
      billingExtract,
      rawBilling: rawData,
    };
    fs.writeFileSync(path.join(OUT, "chunk_livekit.json"), JSON.stringify(allResults.livekit, null, 2));
    console.log("  Saved chunk_livekit.json");
    await page.close();
  }

  // ============================================================
  // PORTAL 8: Microsoft (mystery $20 charges)
  // ============================================================
  console.log("\n" + "=".repeat(60));
  console.log("MICROSOFT BILLING — INVESTIGATING $20 CHARGES");
  console.log("=".repeat(60));
  {
    const dir = path.join(OUT, "Invoices", "Microsoft");
    fs.mkdirSync(dir, { recursive: true });
    const page = await stagehand.context.newPage();

    await page.goto("https://account.microsoft.com/billing/orders", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(5000);

    let billingExtract: any = {};
    try {
      billingExtract = await stagehand.extract({
        instruction: "Extract all billing information: subscriptions, order history with dates and amounts, what products/services are being billed (Office 365, Xbox, Azure, etc), and payment method.",
        schema: BillingSchema,
      });
      console.log(`  Plan: ${billingExtract.planName}, Monthly: ${billingExtract.monthlyAmount}`);
    } catch (e: any) {
      console.log(`  AI extract: ${e.message}`);
    }

    const rawData = await scrapePage(stagehand, page, page.url(), 2000);
    await printPDF(page, path.join(dir, "microsoft-billing.pdf"));

    // Check subscriptions
    const subsRaw = await scrapePage(stagehand, page, "https://account.microsoft.com/services", 5000);
    await printPDF(page, path.join(dir, "microsoft-subscriptions.pdf"));

    allResults.microsoft = {
      source: "microsoft",
      scrapedAt: new Date().toISOString(),
      INVESTIGATION: "Mystery $20 charges in bank data — need to identify which Microsoft product",
      billingExtract,
      rawBilling: rawData,
      rawSubscriptions: subsRaw,
    };
    fs.writeFileSync(path.join(OUT, "chunk_microsoft.json"), JSON.stringify(allResults.microsoft, null, 2));
    console.log("  Saved chunk_microsoft.json");
    await page.close();
  }

  // ============================================================
  // PORTAL 9: Squarespace ($50 domain)
  // ============================================================
  console.log("\n" + "=".repeat(60));
  console.log("SQUARESPACE BILLING");
  console.log("=".repeat(60));
  {
    const dir = path.join(OUT, "Invoices", "Squarespace");
    fs.mkdirSync(dir, { recursive: true });
    const page = await stagehand.context.newPage();

    await page.goto("https://account.squarespace.com/settings/billing", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(5000);

    let billingExtract: any = {};
    try {
      billingExtract = await stagehand.extract({
        instruction: "Extract billing info: domains registered, subscription plans, billing history with dates and amounts, invoices.",
        schema: BillingSchema,
      });
      console.log(`  Plan: ${billingExtract.planName}, Monthly: ${billingExtract.monthlyAmount}`);
    } catch (e: any) {
      console.log(`  AI extract: ${e.message}`);
    }

    const rawData = await scrapePage(stagehand, page, page.url(), 2000);
    await printPDF(page, path.join(dir, "squarespace-billing.pdf"));

    allResults.squarespace = {
      source: "squarespace",
      scrapedAt: new Date().toISOString(),
      billingExtract,
      rawBilling: rawData,
    };
    fs.writeFileSync(path.join(OUT, "chunk_squarespace.json"), JSON.stringify(allResults.squarespace, null, 2));
    console.log("  Saved chunk_squarespace.json");
    await page.close();
  }

  // ============================================================
  // PORTAL 10: GitHub billing (NOT expensable — for completeness)
  // ============================================================
  console.log("\n" + "=".repeat(60));
  console.log("GITHUB BILLING (personal — not expensable)");
  console.log("=".repeat(60));
  {
    const dir = path.join(OUT, "Invoices", "GitHub");
    fs.mkdirSync(dir, { recursive: true });
    const page = await stagehand.context.newPage();

    await page.goto("https://github.com/settings/billing/summary", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(5000);

    let billingExtract: any = {};
    try {
      billingExtract = await stagehand.extract({
        instruction: "Extract billing information: plan name, Copilot subscription details, Actions usage, monthly cost, payment history.",
        schema: BillingSchema,
      });
      console.log(`  Plan: ${billingExtract.planName}`);
    } catch (e: any) {
      console.log(`  AI extract: ${e.message}`);
    }

    const rawData = await scrapePage(stagehand, page, page.url(), 2000);
    await printPDF(page, path.join(dir, "github-billing.pdf"));

    // Payment history
    const historyRaw = await scrapePage(stagehand, page, "https://github.com/account/billing/history", 4000);
    await printPDF(page, path.join(dir, "github-payment-history.pdf"));

    allResults.github = {
      source: "github",
      scrapedAt: new Date().toISOString(),
      NOTE: "NOT EXPENSABLE — personal subscription per user classification",
      billingExtract,
      rawBilling: rawData,
      rawHistory: historyRaw,
    };
    fs.writeFileSync(path.join(OUT, "chunk_github.json"), JSON.stringify(allResults.github, null, 2));
    console.log("  Saved chunk_github.json");
    await page.close();
  }

  // ============================================================
  // PORTAL 11: Google AI / GCP
  // ============================================================
  console.log("\n" + "=".repeat(60));
  console.log("GOOGLE AI / GCP BILLING");
  console.log("=".repeat(60));
  {
    const dir = path.join(OUT, "Invoices", "GoogleAI");
    fs.mkdirSync(dir, { recursive: true });
    const page = await stagehand.context.newPage();

    // Check Google One (AI Ultra subscription is here)
    await page.goto("https://one.google.com/about/plans", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(4000);

    let googleOneExtract: any = {};
    try {
      googleOneExtract = await stagehand.extract({
        instruction: "Extract Google One plan info: current plan (look for AI Premium or AI Ultra), monthly cost, storage included, and any billing details.",
        schema: BillingSchema,
      });
      console.log(`  Google One Plan: ${googleOneExtract.planName}`);
    } catch (e: any) {
      console.log(`  AI extract: ${e.message}`);
    }

    await printPDF(page, path.join(dir, "google-one-plans.pdf"));

    // Check GCP billing
    await page.goto("https://console.cloud.google.com/billing", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(6000);

    let gcpExtract: any = {};
    try {
      gcpExtract = await stagehand.extract({
        instruction: "Extract GCP billing: billing accounts, current charges, project costs, invoices.",
        schema: BillingSchema,
      });
    } catch (e: any) {
      console.log(`  GCP extract: ${e.message}`);
    }

    await printPDF(page, path.join(dir, "gcp-billing.pdf"));

    // AI Studio
    const aiStudioRaw = await scrapePage(stagehand, page, "https://aistudio.google.com/apikey", 5000);
    await printPDF(page, path.join(dir, "ai-studio.pdf"));

    allResults.googleAI = {
      source: "google-ai",
      scrapedAt: new Date().toISOString(),
      googleOneExtract,
      gcpExtract,
      aiStudioRaw,
    };
    fs.writeFileSync(path.join(OUT, "chunk_google_ai.json"), JSON.stringify(allResults.googleAI, null, 2));
    console.log("  Saved chunk_google_ai.json");
    await page.close();
  }

  // ============================================================
  // PORTAL 12: Browserbase
  // ============================================================
  console.log("\n" + "=".repeat(60));
  console.log("BROWSERBASE BILLING");
  console.log("=".repeat(60));
  {
    const dir = path.join(OUT, "Invoices", "Browserbase");
    fs.mkdirSync(dir, { recursive: true });
    const page = await stagehand.context.newPage();

    await page.goto("https://www.browserbase.com/settings/billing", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(5000);

    let billingExtract: any = {};
    try {
      billingExtract = await stagehand.extract({
        instruction: "Extract billing info: plan, monthly cost, usage, invoices.",
        schema: BillingSchema,
      });
      console.log(`  Plan: ${billingExtract.planName}`);
    } catch (e: any) {
      console.log(`  AI extract: ${e.message}`);
    }

    const rawData = await scrapePage(stagehand, page, page.url(), 2000);
    await printPDF(page, path.join(dir, "browserbase-billing.pdf"));

    allResults.browserbase = {
      source: "browserbase",
      scrapedAt: new Date().toISOString(),
      billingExtract,
      rawBilling: rawData,
    };
    fs.writeFileSync(path.join(OUT, "chunk_browserbase.json"), JSON.stringify(allResults.browserbase, null, 2));
    console.log("  Saved chunk_browserbase.json");
    await page.close();
  }

  // ============================================================
  // PORTAL 13: Notion (NOT expensable — personal, capture for records)
  // ============================================================
  console.log("\n" + "=".repeat(60));
  console.log("NOTION BILLING (personal — not expensable)");
  console.log("=".repeat(60));
  {
    const dir = path.join(OUT, "Invoices", "Notion");
    fs.mkdirSync(dir, { recursive: true });
    const page = await stagehand.context.newPage();

    await page.goto("https://www.notion.so/settings/billing", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(5000);

    let billingExtract: any = {};
    try {
      billingExtract = await stagehand.extract({
        instruction: "Extract billing info: plan name, monthly cost, billing history, invoices.",
        schema: BillingSchema,
      });
      console.log(`  Plan: ${billingExtract.planName}`);
    } catch (e: any) {
      console.log(`  AI extract: ${e.message}`);
    }

    const rawData = await scrapePage(stagehand, page, page.url(), 2000);
    await printPDF(page, path.join(dir, "notion-billing.pdf"));

    allResults.notion = {
      source: "notion",
      scrapedAt: new Date().toISOString(),
      NOTE: "NOT EXPENSABLE — personal subscription per user classification",
      billingExtract,
      rawBilling: rawData,
    };
    fs.writeFileSync(path.join(OUT, "chunk_notion.json"), JSON.stringify(allResults.notion, null, 2));
    console.log("  Saved chunk_notion.json");
    await page.close();
  }

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log("\n" + "=".repeat(60));
  console.log("ALL PORTALS COMPLETE — SUMMARY");
  console.log("=".repeat(60));

  const portalNames = Object.keys(allResults);
  console.log(`Scraped ${portalNames.length} portals: ${portalNames.join(', ')}`);

  // Count PDFs
  const pdfCount = fs.readdirSync(path.join(OUT, "Invoices"), { recursive: true })
    .filter((f: any) => f.toString().endsWith('.pdf')).length;
  console.log(`Total PDFs saved: ${pdfCount}`);

  // Write master portal results
  fs.writeFileSync(path.join(OUT, "portal_scrape_results.json"), JSON.stringify(allResults, null, 2));
  console.log(`\nMaster results: ${path.join(OUT, "portal_scrape_results.json")}`);

  await stagehand.close();
}

main().catch(e => { console.error("FATAL:", e.message, e.stack); process.exit(1); });
