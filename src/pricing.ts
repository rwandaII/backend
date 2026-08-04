import { config } from './config.js';
import { findProduct } from './catalog.js';

export interface CartLineInput {
  id: string;
  quantity: number;
}

export interface PricedLine {
  id: string;
  name: string;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
}

export interface PricedCart {
  lines: PricedLine[];
  subtotal: number;
  vat: number;
  deliveryFee: number;
  total: number;
  currency: string;
}

export class CheckoutError extends Error {
  constructor(message: string, readonly code: string, readonly status = 400) {
    super(message);
  }
}

/**
 * Rebuilds the cart from the catalog. Anything the client sent about price is
 * discarded; only product ids and quantities are trusted, and even those are
 * validated against stock.
 *
 * RWF has no minor unit (no cents), so every money value is a whole number.
 */
export function priceCart(input: CartLineInput[]): PricedCart {
  if (!Array.isArray(input) || input.length === 0) {
    throw new CheckoutError('Your cart is empty.', 'EMPTY_CART');
  }
  if (input.length > 100) {
    throw new CheckoutError('Too many different items in one order.', 'CART_TOO_LARGE');
  }

  const lines: PricedLine[] = [];

  for (const item of input) {
    if (typeof item?.id !== 'string' || item.id.length === 0) {
      throw new CheckoutError('Cart contains an item with no id.', 'BAD_ITEM');
    }

    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
      throw new CheckoutError(
        `Invalid quantity for "${item.id}".`,
        'BAD_QUANTITY'
      );
    }

    const product = findProduct(item.id);
    if (!product) {
      throw new CheckoutError(
        `We no longer carry one of the items in your cart.`,
        'PRODUCT_NOT_FOUND'
      );
    }

    if (product.price === null) {
      throw new CheckoutError(
        `"${product.name}" is not available for online purchase yet.`,
        'PRODUCT_NOT_PRICED'
      );
    }

    if (product.qtyInStock < quantity) {
      throw new CheckoutError(
        product.qtyInStock === 0
          ? `"${product.name}" is out of stock.`
          : `Only ${product.qtyInStock} of "${product.name}" left in stock.`,
        'INSUFFICIENT_STOCK'
      );
    }

    lines.push({
      id: product.id,
      name: product.name,
      unitPrice: product.price,
      quantity,
      lineTotal: product.price * quantity,
    });
  }

  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const vat = Math.round(subtotal * config.vatRate);
  const deliveryFee = subtotal >= config.freeShippingThreshold ? 0 : config.deliveryFee;
  const total = subtotal + vat + deliveryFee;

  return {
    lines,
    subtotal,
    vat,
    deliveryFee,
    total,
    currency: config.currency,
  };
}
