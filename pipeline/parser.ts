export interface OrderData {
  orderId: string;
  date: string;
  total: string;
  items: string[];
  invoiceUrl: string | null;
  orderUrl: string;
}

export async function extractOrdersFromPage(document: any): Promise<OrderData[]> {
  const results: OrderData[] = [];
  const cards = document.querySelectorAll('.order-card, .js-order-card, .a-box-group.order');
  
  cards.forEach((card: any) => {
    // Wait, since we are doing this inside Node (JSDOM) or Browser, `document` works.
    const idMatch = card.innerHTML.match(/orderID[=:][\s"']*(\d{3}-\d{7}-\d{7})/);
    if (!idMatch) return;
    const orderId = idMatch[1];
    
    const dateMatch = card.textContent?.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/);
    const date = dateMatch ? dateMatch[0] : "Unknown";
    
    const totalEl = card.querySelector('.yohtmlc-order-total .value, .a-color-price');
    const total = totalEl?.textContent?.trim() || "$0.00";
    
    const itemEls = card.querySelectorAll('.yohtmlc-product-title, a[href*="/dp/"]');
    const items = Array.from(itemEls).map((el: any) => el.textContent?.trim()).filter((t: any) => t && t.length > 2);
    
    let invoiceUrl: string | null = null;
    card.querySelectorAll('a').forEach((a: any) => {
      if (a.textContent?.toLowerCase().includes('invoice') || a.href?.toLowerCase().includes('invoice')) {
        invoiceUrl = a.getAttribute('href'); // Use getAttribute to get raw href, or .href. In JSDOM .href is absolute.
      }
    });
    
    results.push({ 
      orderId, 
      date, 
      total, 
      items: items as string[], 
      invoiceUrl, 
      orderUrl: `https://www.amazon.com/gp/your-account/order-details?orderID=${orderId}` 
    });
  });
  
  return results;
}
