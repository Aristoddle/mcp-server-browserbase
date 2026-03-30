import { Stagehand } from "@browserbasehq/stagehand";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

interface ClassifiedOrder {
  orderId: string;
  date: string;
  total: string;
  items: string[];
  invoiceUrl: string | null;
  orderUrl: string;
  isExpensable: boolean;
  category?: string;
}

const EXPENSES_DIR = path.join(os.homedir(), "Documents", "Expenses", "Amazon-2026");
const INPUT_FILE = path.join(EXPENSES_DIR, "02-classified-orders.json");
const INVOICES_DIR = path.join(EXPENSES_DIR, "invoices");

function parseDate(dateStr: string): string {
  const months: Record<string, string> = {
    january:"01",february:"02",march:"03",april:"04",may:"05",june:"06",
    july:"07",august:"08",september:"09",october:"10",november:"11",december:"12"
  };
  const match = dateStr.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (!match) return "unknown-date";
  const [, month, day, year] = match;
  return \`\${year}-\${months[month.toLowerCase()] || "00"}-\${day.padStart(2, "0")}\`;
}

async function downloadInvoice(context: any, order: ClassifiedOrder): Promise<string | null> {
  if (!order.invoiceUrl) {
    console.log(\`  Skipping \${order.orderId}: No invoice URL\`);
    return null;
  }
  
  const invoicePage = await context.newPage();
  try {
    const url = order.invoiceUrl.startsWith("http") ? order.invoiceUrl : \`https://www.amazon.com\${order.invoiceUrl}\`;
    console.log(\`  Downloading \${order.orderId} from \${url}...\`);
    
    await invoicePage.goto(url, { waitUntil: "networkidle", timeout: 20000 });
    await invoicePage.waitForSelector("table, .invoice", { timeout: 10000 }).catch(() => {});
    
    // Give it an extra moment to render images
    await invoicePage.waitForTimeout(2000);
    
    const isoDate = parseDate(order.date);
    const filename = \`\${isoDate}_\${order.orderId}.pdf\`;
    const filepath = path.join(INVOICES_DIR, filename);
    
    // Use CDP to generate PDF
    const { data } = await (invoicePage as any).mainSession.send("Page.printToPDF", { 
        printBackground: true
    });
    
    fs.mkdirSync(INVOICES_DIR, { recursive: true });
    fs.writeFileSync(filepath, Buffer.from(data, "base64"));
    
    console.log(\`  Saved: \${filename} (\${order.total})\`);
    return filepath;
  } catch (err: any) {
    console.error(\`  Failed to download \${order.orderId}: \${err.message}\`);
    return null;
  } finally {
    await invoicePage.close();
  }
}

async function main() {
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(\`Input file not found: \${INPUT_FILE}\`);
    console.error("Please ensure 02-classified-orders.json exists before running this step.");
    process.exit(1);
  }

  const classifiedOrders: ClassifiedOrder[] = JSON.parse(fs.readFileSync(INPUT_FILE, "utf-8"));
  const expensableOrders = classifiedOrders.filter(o => o.isExpensable);

  console.log(\`Found \${classifiedOrders.length} total orders, \${expensableOrders.length} to download.\`);

  if (expensableOrders.length === 0) {
    console.log("No expensable orders to download. Exiting.");
    process.exit(0);
  }

  const res = await fetch("http://127.0.0.1:9222/json/version").catch(() => null);
  let webSocketDebuggerUrl;
  if (res && res.ok) {
    const data = await res.json();
    webSocketDebuggerUrl = data.webSocketDebuggerUrl;
  }

  if (!webSocketDebuggerUrl) {
    console.error("No webSocketDebuggerUrl found. Is the fallback Chrome running?");
    process.exit(1);
  }

  console.log("Using CDP URL:", webSocketDebuggerUrl);

  const stagehand = new Stagehand({
    env: "LOCAL",
    localBrowserLaunchOptions: { cdpUrl: webSocketDebuggerUrl },
    model: {
        modelName: "google/gemini-2.0-flash",
        apiKey: process.env.GEMINI_API_KEY
    },
    logger: () => {} // Silence verbose logs
  });

  await stagehand.init();

  fs.mkdirSync(INVOICES_DIR, { recursive: true });
  
  for (const order of expensableOrders) {
    await downloadInvoice(stagehand.context, order);
    
    // 3-5 second delay to avoid rate limiting
    const delay = Math.floor(Math.random() * 2000) + 3000;
    console.log(\`  Waiting \${delay}ms...\`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  console.log(\`\\nFinished downloading invoices to \${INVOICES_DIR}\`);
  await stagehand.close();
}

main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
