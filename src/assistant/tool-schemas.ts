import type Anthropic from '@anthropic-ai/sdk';

export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'search_products',
    description:
      'Search the product catalog by name or barcode (fuzzy match included, so typos and partial names work), optionally narrowed to a category or subcategory. Use this before editing anything to find the right product id.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to match against product name/barcode. Omit to just list products.' },
        categoryId: { type: 'integer', description: 'Restrict to this category id.' },
        subcategoryId: { type: 'integer', description: 'Restrict to this subcategory id.' },
        limit: { type: 'integer', description: 'Max results (default 20, max 50).' },
      },
    },
  },
  {
    name: 'get_product',
    description: 'Fetch full details for one product by id.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
    },
  },
  {
    name: 'create_product',
    description:
      'Adds a new product. subcategoryId is required - use list_subcategories or search_products first if you do not already know it. unitPrice is VAT-exclusive; the 18% VAT-inclusive total is computed automatically, never set it directly.',
    input_schema: {
      type: 'object',
      properties: {
        subcategoryId: { type: 'integer' },
        name: { type: 'string' },
        brand: { type: 'string' },
        barcode: { type: 'string' },
        unitPrice: { type: 'number', description: 'VAT-exclusive unit price in RWF.' },
        qtyInStock: { type: 'integer' },
        description: { type: 'string' },
        image: { type: 'string', description: 'A filename already present in public/products/ (see list_available_images).' },
      },
      required: ['subcategoryId', 'name'],
    },
  },
  {
    name: 'update_product',
    description: 'Edits an existing product. Only send the fields that should change.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        subcategoryId: { type: 'integer' },
        name: { type: 'string' },
        brand: { type: 'string' },
        barcode: { type: 'string' },
        unitPrice: { type: 'number', description: 'VAT-exclusive unit price in RWF.' },
        qtyInStock: { type: 'integer' },
        discontinued: { type: 'boolean' },
        description: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_product',
    description:
      'Permanently deletes a product. This cannot be undone - confirm you have the right product (by name, from a prior search_products/get_product call) before calling this, unless the admin gave an exact id explicitly.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
    },
  },
  {
    name: 'list_categories',
    description: 'Lists every top-level category with subcategory/product counts.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_subcategories',
    description: 'Lists subcategories, optionally filtered to one category.',
    input_schema: {
      type: 'object',
      properties: { categoryId: { type: 'integer' } },
    },
  },
  {
    name: 'list_available_images',
    description:
      'Lists image filenames already uploaded to the server (public/products/), optionally filtered by a search term. Use this to find a photo to attach when the admin describes it loosely rather than giving an exact filename.',
    input_schema: {
      type: 'object',
      properties: { search: { type: 'string' } },
    },
  },
  {
    name: 'attach_product_image',
    description: "Sets a product's photo to an image file that already exists in public/products/ (from list_available_images). Does not upload a new file.",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        image: { type: 'string', description: 'Exact filename, e.g. "baby-nail-clipper.jpg".' },
      },
      required: ['id', 'image'],
    },
  },
];
