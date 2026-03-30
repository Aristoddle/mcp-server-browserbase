import { Stagehand } from "@browserbasehq/stagehand";
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";

const OUT = path.join(process.env.HOME!, "Documents", "Expenses");

async function main() {
  const { webSocketDebuggerUrl } = await (await fetch("http://127.0.0.1:9222/json/version")).json();
  const stagehand = new Stagehand({
    env: "LOCAL",
    localBrowserLaunchOptions: { cdpUrl: webSocketDebuggerUrl },
    model: { modelName: "openai/gpt-4.1", apiKey: process.env.AZURE_API_KEY!, baseURL: process.env.AZURE_BASE_URL! },
  });
  await stagehand.init();
  const page = await stagehand.context.newPage();

  console.log("=== UBER DEEP SCRAPE — ALL TRIPS WITH ROUTES ===");

  // Navigate to trips page
  await page.goto("https://riders.uber.com/trips", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(6000);

  let allTrips: any[] = [];
  let scrolls = 0;

  while (scrolls < 20) {
    // Extract all visible trip data using raw DOM
    const trips = await page.evaluate(() => {
      const results: any[] = [];
      const text = document.body.innerText;
      const lines = text.split('\n').map((l: string) => l.trim()).filter(Boolean);

      // Parse trip blocks: address, date+time, amount, repeated
      for (let i = 0; i < lines.length; i++) {
        // Look for dollar amounts as trip markers
        const amtMatch = lines[i].match(/^\$[\d,]+\.?\d*$/);
        if (amtMatch) {
          // Backtrack to find the trip info
          const amount = lines[i];
          let address = "";
          let dateTime = "";
          let tripType = "";

          // Search backwards for date/time and address
          for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
            const line = lines[j];
            if (line.match(/\d{1,2}:\d{2}\s*(AM|PM)/i) || line.match(/\w+\s+\d{1,2}\s*[•·]\s*\d{1,2}:\d{2}/)) {
              dateTime = line;
            } else if (line.match(/\d+\s+\w+/) && !line.match(/^(Help|Details|More|Ride|Courier|Past|Upcoming|Personal|All)/)) {
              if (!address) address = line;
            } else if (line.match(/^(UberX|Uber\s*Eats|UberXL|Uber\s*Black|Comfort|Green|Pool|Reserve)/i)) {
              tripType = line;
            }
          }

          results.push({ amount, address, dateTime, tripType });
        }
      }

      // Also capture the full text for parsing
      const relevantLines = lines.filter((l: string) =>
        l.match(/\$/) || l.match(/\d{1,2}:\d{2}/) || l.match(/\d+\s+\w+\s+(Pkwy|St|Ave|Blvd|Dr|Rd|Ln|Hwy|Way)/) ||
        l.match(/^(Mar|Feb|Jan|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/) || l.match(/Uber/)
      );

      return { trips: results, allRelevantLines: relevantLines.slice(0, 200) };
    });

    const newTrips = trips.trips.filter((t: any) =>
      !allTrips.some((e: any) => e.amount === t.amount && e.dateTime === t.dateTime)
    );

    if (newTrips.length === 0 && scrolls > 2) break;
    allTrips.push(...newTrips);
    console.log(`Scroll ${scrolls + 1}: ${newTrips.length} new (total: ${allTrips.length})`);

    // Also log raw lines for first scroll
    if (scrolls === 0) {
      console.log("\n  Raw trip lines:");
      trips.allRelevantLines.slice(0, 30).forEach((l: string) => console.log(`    ${l}`));
    }

    // Scroll to load more
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(3000);

    // Check for "Show more" button and click it
    try {
      const showMore = await page.$('button:has-text("Show more"), button:has-text("Load more"), [data-testid*="more"]');
      if (showMore) {
        await showMore.click();
        await page.waitForTimeout(3000);
        console.log("  Clicked 'Show more'");
      }
    } catch {}

    scrolls++;
  }

  // Now click into individual trips to get pickup → dropoff routes
  console.log("\n=== GETTING TRIP DETAILS (routes) ===");
  const detailedTrips: any[] = [];

  // Get all trip links
  const tripLinks = await page.evaluate(() => {
    const links: string[] = [];
    document.querySelectorAll('a[href*="trip"]').forEach((a: any) => {
      if (a.href && !links.includes(a.href)) links.push(a.href);
    });
    return links;
  });
  console.log(`Found ${tripLinks.length} trip detail links`);

  for (const link of tripLinks.slice(0, 30)) {
    try {
      const detailPage = await stagehand.context.newPage();
      await detailPage.goto(link, { waitUntil: "domcontentloaded", timeout: 15000 });
      await detailPage.waitForTimeout(3000);

      const detail = await detailPage.evaluate(() => {
        const text = document.body.innerText;
        const lines = text.split('\n').map((l: string) => l.trim()).filter(Boolean);
        const amount = text.match(/\$[\d,]+\.?\d*/)?.[0] || null;
        const dateMatch = text.match(/\w+\s+\d{1,2},?\s+\d{4}/)?.[0] || null;
        const timeMatch = text.match(/\d{1,2}:\d{2}\s*(AM|PM)/i)?.[0] || null;

        // Look for pickup/dropoff
        let pickup = "", dropoff = "";
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].match(/pick\s*up|from/i) && lines[i + 1]) {
            pickup = lines[i + 1];
          }
          if (lines[i].match(/drop\s*off|to|destination/i) && lines[i + 1]) {
            dropoff = lines[i + 1];
          }
        }

        // Fallback: look for address patterns
        const addresses = lines.filter((l: string) =>
          l.match(/\d+\s+\w+\s+(Pkwy|St|Ave|Blvd|Dr|Rd|Ln|Hwy|Way|Ct|Cir|Loop)/i) ||
          l.match(/\d{5}/) // ZIP codes
        );

        const rideType = text.match(/(UberX|Uber\s*Eats|UberXL|Uber\s*Black|Comfort|Green|Pool|Reserve)/i)?.[0] || null;

        return {
          amount, date: dateMatch, time: timeMatch,
          pickup: pickup || addresses[0] || null,
          dropoff: dropoff || addresses[1] || null,
          rideType,
          url: window.location.href,
          allAddresses: addresses.slice(0, 5),
          relevantLines: lines.filter((l: string) =>
            l.match(/\$/) || l.match(/\d{1,2}:\d{2}/) || l.match(/\d+\s+\w+/) || l.match(/pickup|dropoff|from|to/i)
          ).slice(0, 20),
        };
      });

      detailedTrips.push(detail);
      console.log(`  ${detail.date || '?'} ${detail.time || ''} | ${detail.amount || '?'} | ${detail.pickup || '?'} → ${detail.dropoff || '?'} | ${detail.rideType || ''}`);

      await detailPage.close();
      await new Promise(r => setTimeout(r, 1500));
    } catch (e: any) {
      console.log(`  Trip detail failed: ${e.message.substring(0, 60)}`);
    }
  }

  // Classify trips for expense reporting
  const classified = detailedTrips.map((trip: any) => {
    const isUberEats = /eats|delivery|food|courier/i.test(trip.rideType || "");
    const isTo7500DallasPkwy = /7500\s*Dallas/i.test(trip.dropoff || "") || /7500\s*Dallas/i.test(trip.pickup || "");
    let expenseClass = "needs_review";
    let reason = "";

    if (isUberEats) {
      expenseClass = "expensable";
      reason = "Uber Eats — check if delivered to office";
    } else if (isTo7500DallasPkwy) {
      expenseClass = "not_expensable";
      reason = "Regular commute to 7500 Dallas Pkwy (office)";
    } else {
      expenseClass = "needs_review";
      reason = "Non-office destination — potentially business travel";
    }

    return { ...trip, expenseClass, reason };
  });

  const chunk = {
    source: "uber-deep",
    scrapedAt: new Date().toISOString(),
    summaryTrips: allTrips,
    detailedTrips: classified,
    totalTrips: allTrips.length,
    detailedCount: classified.length,
    expensable: classified.filter((t: any) => t.expenseClass === "expensable").length,
    notExpensable: classified.filter((t: any) => t.expenseClass === "not_expensable").length,
    needsReview: classified.filter((t: any) => t.expenseClass === "needs_review").length,
  };

  fs.writeFileSync(path.join(OUT, "chunk_uber.json"), JSON.stringify(chunk, null, 2));
  console.log(`\n=== UBER SUMMARY ===`);
  console.log(`Total trips: ${chunk.totalTrips}`);
  console.log(`Detailed: ${chunk.detailedCount}`);
  console.log(`Expensable (Uber Eats): ${chunk.expensable}`);
  console.log(`Not expensable (commute): ${chunk.notExpensable}`);
  console.log(`Needs review: ${chunk.needsReview}`);

  await page.close();
  await stagehand.close();
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
