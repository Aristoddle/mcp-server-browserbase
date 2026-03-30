import { Stagehand } from "@browserbasehq/stagehand";
async function main() {
  const stagehand = new Stagehand({ env: "LOCAL", localBrowserLaunchOptions: { cdpUrl: "ws://127.0.0.1:9222" } });
  await stagehand.init();
  const page = await stagehand.context.newPage();
  console.log("Keys in page:", Object.keys(page));
  console.log("Has pdf?:", typeof page.pdf);
  console.log("Has page.pdf?:", page.page ? typeof page.page.pdf : "no page.page");
  await stagehand.close();
}
main().catch(console.error);
