import { Router } from 'express';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import * as tools from '../assistant/tools.js';
import { TOOLS } from '../assistant/tool-schemas.js';

export const adminAssistantRouter = Router();

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const MODEL = 'claude-opus-5';
const MAX_TOOL_ITERATIONS = 8;

const SYSTEM_PROMPT = `You are the catalog assistant built into the Target Traders admin dashboard - a pharmacy and baby-care supplier in Rwanda. The person you're talking to is a store admin managing the product catalog: they can ask you to search for products, add new ones, edit names/prices/stock/descriptions, attach photos, or answer questions about what's in the catalog.

Domain facts:
- Currency is RWF. unitPrice is always VAT-exclusive; the database computes the 18%-VAT-inclusive total automatically - never try to set a total yourself.
- Products belong to a subcategory, which belongs to a category. You need a subcategoryId to create a product - look one up with search_products or list_subcategories if the admin doesn't give you an id directly.
- Photos are files already sitting in public/products/ on the server. attach_product_image only points a product at a file that's already there - it does not upload anything. If the admin describes a photo rather than naming the exact file, use list_available_images to find it first.

Working style:
- Use the tools rather than guessing ids or filenames.
- Before delete_product, make sure you're deleting the right thing - if the admin didn't give an exact id, search first and confirm the name in your reply, or ask if more than one plausible match exists.
- Be concise. This is a working tool for a business owner, not a conversation - skip preamble and pleasantries, state what you did or found.`;

const messageContentSchema = z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]);

const chatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: messageContentSchema,
      })
    )
    .min(1)
    .max(60),
});

async function runTool(name: string, input: Record<string, unknown>): Promise<string> {
  try {
    let result: unknown;
    switch (name) {
      case 'search_products':
        result = await tools.searchProducts(input as Parameters<typeof tools.searchProducts>[0]);
        break;
      case 'get_product':
        result = await tools.getProduct(Number(input.id));
        break;
      case 'create_product':
        result = await tools.createProduct(input as unknown as tools.ProductInput);
        break;
      case 'update_product':
        result = await tools.updateProduct(Number(input.id), input as Partial<tools.ProductInput>);
        break;
      case 'delete_product':
        result = await tools.deleteProduct(Number(input.id));
        break;
      case 'list_categories':
        result = await tools.listCategories();
        break;
      case 'list_subcategories':
        result = await tools.listSubcategories(input.categoryId ? Number(input.categoryId) : undefined);
        break;
      case 'list_available_images':
        result = tools.listAvailableImages(typeof input.search === 'string' ? input.search : undefined);
        break;
      case 'attach_product_image':
        result = await tools.attachProductImage(Number(input.id), String(input.image));
        break;
      default:
        return JSON.stringify({ error: `Unknown tool "${name}".` });
    }
    return JSON.stringify(result);
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * POST /api/admin/assistant/chat
 * Stateless: the client stores and resends the full `messages` array it gets
 * back (this includes the assistant's tool_use/tool_result turns, which the
 * API needs to keep the conversation coherent - don't strip them).
 */
adminAssistantRouter.post('/chat', async (req, res) => {
  const parsed = chatSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid request.' });
  }

  let messages = parsed.data.messages as Anthropic.MessageParam[];

  try {
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 8192,
        output_config: { effort: 'medium' },
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      });

      messages = [...messages, { role: 'assistant', content: response.content }];

      if (response.stop_reason === 'refusal') {
        return res.status(422).json({ ok: false, error: 'The assistant declined that request.', messages });
      }

      if (response.stop_reason !== 'tool_use') {
        const reply = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
        return res.json({ ok: true, reply, messages });
      }

      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
      );

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of toolUseBlocks) {
        const content = await runTool(block.name, block.input as Record<string, unknown>);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content });
      }

      messages = [...messages, { role: 'user', content: toolResults }];
    }

    res.status(500).json({
      ok: false,
      error: 'The assistant took too many steps without finishing. Try breaking the request into smaller ones.',
      messages,
    });
  } catch (err) {
    console.error('assistant chat error:', err);
    res.status(500).json({ ok: false, error: 'The assistant is unavailable right now. Try again shortly.' });
  }
});
