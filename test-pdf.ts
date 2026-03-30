import { Stagehand } from "@browserbasehq/stagehand";
import fs from "fs";

async function main() {
  const res = await fetch("http://127.0.0.1:9222/json/version").catch(() => null);
  let cdpUrl;
  if (res && res.ok) {
    const data = await res.json();
    cdpUrl = data.webSocketDebuggerUrl;
  }
  const stagehand = new Stagehand({ env: "LOCAL", localBrowserLaunchOptions: { cdpUrl }, model: { modelName: "google/gemini-2.0-flash", apiKey: process.env.GEMINI_API_KEY } });
  await stagehand.init();
  const page = await stagehand.context.newPage();
  await page.goto("https://example.com");
  
  try {
    console.log("Trying page.mainSession.send...");
    const { data } = await (page as any).mainSession.send("Page.printToPDF", { printBackground: true });
    fs.writeFileSync("test.pdf", Buffer.from(data, "base64"));
    console.log("PDF saved!");
  } catch (e) {
    console.error("mainSession.send failed", e);
  }
  await stagehand.close();
}
main().catch(console.error);
