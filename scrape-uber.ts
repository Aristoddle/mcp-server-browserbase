import { Stagehand } from "@browserbasehq/stagehand";
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";

const OUT = path.join(process.env.HOME!, "Documents", "Expenses");
const PDF_DIR = path.join(OUT, "Invoices", "Uber");
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

  console.log("=== UBER TRIP HISTORY ===");
  await page.goto("https://riders.uber.com/trips", {
    waitUntil: "domcontentloaded", timeout: 30000,
  });
  await page.waitForTimeout(5000);

  // Extract trip list
  let allTrips: any[] = [];
  let scrollAttempts = 0;
  const maxScrolls = 10;

  while (scrollAttempts < maxScrolls) {
    const trips = await page.evaluate(() => {
      const results: any[] = [];
      // Uber trips page has cards for each trip
      document.querySelectorAll('[class*="trip"], [data-testid*="trip"], li, [class*="card"]').forEach((el: any) => {
        const text = el.textContent?.trim();
        if (!text) return;
        // Look for trip patterns: date, price, route
        const hasPrice = text.match(/\$[\d,]+\.?\d*/);
        const hasDate = text.match(/\w+\s+\d{1,2},?\s+\d{4}/) || text.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/);
        if (hasPrice || hasDate) {
          const price = text.match(/\$[\d,]+\.?\d*/)?.[0] || null;
          const date = (text.match(/\w+\s+\d{1,2},?\s+\d{4}/) || text.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/))?.[0] || null;
          // Try to extract route (from → to)
          const routeMatch = text.match(/(.+?)\s*(?:→|to|➜)\s*(.+)/i);
          const detailLink = el.querySelector('a')?.href;
          results.push({
            date,
            amount: price,
            text: text.replace(/\s+/g, ' ').substring(0, 300),
            route: routeMatch ? { from: routeMatch[1].trim(), to: routeMatch[2].trim() } : null,
            detailUrl: detailLink || null,
          });
        }
      });
      return results;
    });

    const newTrips = trips.filter((t: any) => !allTrips.some((e: any) => e.text === t.text));
    if (newTrips.length === 0 && scrollAttempts > 0) break;
    allTrips.push(...newTrips);
    console.log(`Scroll ${scrollAttempts + 1}: ${newTrips.length} new trips (total: ${allTrips.length})`);

    // Scroll down to load more
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(3000);
    scrollAttempts++;
  }

  // If we didn't get structured trips, try the full page text
  if (allTrips.length === 0) {
    console.log("Trying full page text extraction...");
    const pageData = await page.evaluate(() => {
      const text = document.body.innerText;
      const amounts = text.match(/\$[\d,]+\.?\d*/g) || [];
      const dates = text.match(/\w+\s+\d{1,2},?\s+\d{4}/g) || [];
      const lines = text.split('\n').filter((l: string) => l.match(/\$/) || l.match(/trip/i) || l.match(/ride/i));
      return { amounts, dates, lines: lines.slice(0, 50) };
    });
    allTrips = [{ type: "raw_extraction", ...pageData }];
  }

  // Classify trips: weekday AM trips are likely work commutes
  const classifiedTrips = allTrips.map((trip: any) => {
    if (!trip.date) return { ...trip, isWorkCommute: false, commuteReason: "no date" };
    try {
      const d = new Date(trip.date);
      const dayOfWeek = d.getDay(); // 0=Sun, 6=Sat
      const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
      // Check if time info suggests AM (we may not have time, so flag weekday trips)
      const isWorkCommute = isWeekday;
      return { ...trip, isWorkCommute, commuteReason: isWeekday ? "weekday trip" : "weekend trip" };
    } catch {
      return { ...trip, isWorkCommute: false, commuteReason: "date parse error" };
    }
  });

  console.log(`\nTotal trips: ${classifiedTrips.length}`);
  const workTrips = classifiedTrips.filter((t: any) => t.isWorkCommute);
  console.log(`Potential work commutes: ${workTrips.length}`);

  // Print trips page as PDF
  try {
    
    const { data } = await (page as any).mainSession.send("Page.printToPDF", { printBackground: true, landscape: true });
    fs.writeFileSync(path.join(PDF_DIR, "uber-trips.pdf"), Buffer.from(data, "base64"));
    console.log("Saved uber-trips.pdf");
  } catch (e: any) {
    console.log(`PDF: ${e.message}`);
  }

  // Try to get individual trip receipts (first 10 work commutes)
  let downloadedCount = 0;
  for (const trip of workTrips.slice(0, 10)) {
    if (trip.detailUrl) {
      try {
        const tripPage = await stagehand.context.newPage();
        await tripPage.goto(trip.detailUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
        await tripPage.waitForTimeout(2000);
        
        const { data } = await (invPage as any).mainSession.send("Page.printToPDF", { printBackground: true });
        const dateSlug = (trip.date || "unknown").replace(/[^a-zA-Z0-9]/g, '-');
        fs.writeFileSync(path.join(PDF_DIR, `uber-receipt-${dateSlug}.pdf`), Buffer.from(data, "base64"));
        downloadedCount++;
        await tripPage.close();
        await new Promise(r => setTimeout(r, 2000));
      } catch (e: any) {
        console.log(`  Receipt failed: ${e.message}`);
      }
    }
  }

  const chunk = {
    source: "uber",
    scrapedAt: new Date().toISOString(),
    trips: classifiedTrips,
    totalTrips: classifiedTrips.length,
    workCommutes: workTrips.length,
    downloadedReceipts: downloadedCount,
  };

  fs.writeFileSync(path.join(OUT, "chunk_uber.json"), JSON.stringify(chunk, null, 2));
  console.log(`\nSaved chunk_uber.json`);

  await page.close();
  await stagehand.close();
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
