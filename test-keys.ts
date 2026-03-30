import { Stagehand } from "@browserbasehq/stagehand";
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
  console.log("Has waitForLoadState?:", typeof (page as any).waitForLoadState);
  console.log("Has waitForNavigation?:", typeof (page as any).waitForNavigation);
  console.log("Has waitForTimeout?:", typeof (page as any).waitForTimeout);
  console.log("Keys in page constructor:", Object.getOwnPropertyNames(Object.getPrototypeOf(page)));
  await stagehand.close();
}
main().catch(console.error);