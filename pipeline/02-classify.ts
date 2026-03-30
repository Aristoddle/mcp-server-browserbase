import { generateObject } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const EXPENSES_DIR = path.join(process.env.HOME!, 'Documents', 'Expenses', 'Amazon-2026');
const INPUT_FILE = path.join(EXPENSES_DIR, '01-raw-orders.json');
const OUTPUT_FILE = path.join(EXPENSES_DIR, '02-classified-orders.json');

const google = createGoogleGenerativeAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const ClassificationSchema = z.object({
  isExpensable: z.boolean().describe("Whether this item is likely a work-related expense"),
  category: z.enum(["electronics", "office-supplies", "software", "reference-materials", "needs-review", "personal"])
    .describe("The category of the expense. Use 'personal' if it's not work related. Use 'needs-review' if you are unsure."),
  confidence: z.number().min(1).max(10).describe("Confidence score from 1 to 10"),
  reason: z.string().describe("Brief explanation for this classification based on the item names and total price")
});

async function main() {
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`Input file not found: ${INPUT_FILE}`);
    process.exit(1);
  }

  const rawOrders = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf-8'));
  console.log(`Loaded ${rawOrders.length} raw orders. Classifying with Gemini...`);

  const classifiedOrders = [];
  
  for (const order of rawOrders) {
    const itemText = order.items.join(" | ");
    console.log(`Evaluating Order ${order.orderId} (${order.total}): ${itemText.substring(0, 100)}...`);
    
    try {
      const { object } = await generateObject({
        model: google('gemini-2.0-flash'),
        schema: ClassificationSchema,
        prompt: `You are an AI financial auditor. Evaluate this Amazon order to determine if it is a business expense or personal.

Items: ${itemText}
Total: ${order.total}

Work categories include electronics, office supplies, software, and reference materials. Examples of personal items: food, home goods, clothes, groceries, personal care. If an item is clearly personal, mark isExpensable: false and category: personal. If it's ambiguous, mark needs-review.`,
      });

      classifiedOrders.push({
        ...order,
        ...object
      });
      
      console.log(`  -> ${object.isExpensable ? '✅ EXPENSE' : '❌ PERSONAL'} [${object.category}] (Conf: ${object.confidence}) - ${object.reason}`);
    } catch (e) {
      console.error(`  -> ⚠️ Failed to classify:`, e);
      classifiedOrders.push({
        ...order,
        isExpensable: false,
        category: "needs-review",
        confidence: 1,
        reason: "LLM Classification Failed"
      });
    }
    
    // Brief pause for rate limits
    await new Promise(r => setTimeout(r, 500));
  }
  
  const expensable = classifiedOrders.filter((o: any) => o.isExpensable).length;
  const review = classifiedOrders.filter((o: any) => o.category === 'needs-review').length;
  
  console.log(`\nClassification complete:`);
  console.log(`  Expensable:   ${expensable}`);
  console.log(`  Needs Review: ${review}`);
  console.log(`  Personal:     ${classifiedOrders.length - expensable - review}`);

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(classifiedOrders, null, 2));
  console.log(`Saved to ${OUTPUT_FILE}`);
}

main().catch(console.error);