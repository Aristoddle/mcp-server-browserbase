import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { extractOrdersFromPage } from "../pipeline/parser.js";

describe("Amazon Order Parser", () => {
  it("should parse an empty page", async () => {
    const dom = new JSDOM(`<html><body></body></html>`);
    const results = await extractOrdersFromPage(dom.window.document as any);
    expect(results).toEqual([]);
  });

  it("should extract basic order details correctly", async () => {
    const html = `
      <html>
        <body>
          <div class="order-card">
            <a href="/gp/your-account/order-details?orderID=111-2222222-3333333">Order details</a>
            <div>Order Placed: January 15, 2026</div>
            <div class="yohtmlc-order-total"><span class="value">$123.45</span></div>
            <a href="/dp/B012345678" class="yohtmlc-product-title">Wireless Mouse</a>
            <a href="/dp/B087654321" class="yohtmlc-product-title">Mechanical Keyboard</a>
            <a href="/invoice?orderId=111-2222222-3333333">Invoice</a>
          </div>
        </body>
      </html>
    `;
    const dom = new JSDOM(html);
    const results = await extractOrdersFromPage(dom.window.document as any);
    
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      orderId: "111-2222222-3333333",
      date: "January 15, 2026",
      total: "$123.45",
      items: ["Wireless Mouse", "Mechanical Keyboard"],
      invoiceUrl: "/invoice?orderId=111-2222222-3333333",
      orderUrl: "https://www.amazon.com/gp/your-account/order-details?orderID=111-2222222-3333333"
    });
  });
});
