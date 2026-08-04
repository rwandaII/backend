# Target Traders — checkout API

Express + TypeScript backend that takes a cart, prices it from the catalog,
and collects payment through Flutterwave (MTN MoMo, Airtel Money, Visa/Mastercard).

---

## Setup

```bash
cd server
npm install
cp .env.example .env     # then fill it in
npm run dev              # http://localhost:4000
```

In a second terminal, run the React app as usual:

```bash
npm run dev              # from the project root, http://localhost:5173
```

### Getting your Flutterwave keys

1. Create an account at https://app.flutterwave.com
2. **Settings → API Keys** — copy the **Secret Key**. Use the `FLWSECK_TEST-…`
   one while developing.
3. **Settings → Webhooks** — set the URL to
   `https://YOUR-PUBLIC-URL/api/webhook/flutterwave`, invent a **Secret hash**,
   and put that same string in `FLW_SECRET_HASH`.

The secret key must never reach the browser. That is the whole reason this
server exists.

### Receiving webhooks on localhost

Flutterwave can't reach `localhost`. Open a tunnel:

```bash
npx cloudflared tunnel --url http://localhost:4000
# or: ngrok http 4000
```

Put the public URL in `SERVER_URL` **and** in the Flutterwave dashboard webhook
setting. Without this the webhook never arrives and orders sit in `pending`
until the browser redirect settles them.

---

## Testing a payment

With test keys, Flutterwave gives you test instruments — Rwandan mobile money
payments in test mode auto-authorise after a few seconds. Their current test
cards are listed at https://developer.flutterwave.com under *Testing*.

Watch orders land:

```bash
curl http://localhost:4000/api/admin/orders
```

---

## How it fits together

```
Cart page  →  /checkout  →  POST /api/checkout/session
                               ↓ (server re-prices the cart)
                           Flutterwave hosted page
                               ↓  customer pays
        ┌──────────────────────┴──────────────────────┐
   browser redirect                              webhook
   GET /api/checkout/callback          POST /api/webhook/flutterwave
        └──────────────────────┬──────────────────────┘
                          settleOrder()
                   verify with Flutterwave API
                    check amount + currency
                       mark order paid
                               ↓
                    /payment/success in React
```

Both paths call the same idempotent `settleOrder()`. Whichever arrives first
wins; the second is a no-op. This matters — customers close the tab, and
webhooks get retried.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/checkout/quote` | Re-price a cart. No order created. |
| POST | `/api/checkout/session` | Create order, return Flutterwave payment link. |
| GET | `/api/checkout/callback` | Where Flutterwave returns the customer. |
| GET | `/api/checkout/order/:txRef` | Order status for the result page. |
| POST | `/api/webhook/flutterwave` | Authoritative payment notification. |
| GET | `/api/admin/orders` | **No auth yet.** Temporary. |
| GET | `/api/health` | Catalog stats. |

### Order statuses

- `pending` — customer sent to Flutterwave, no result yet
- `paid` — verified successful, amount and currency matched
- `failed` — cancelled or declined
- `mismatch` — paid, but the amount didn't match. Needs a human. Check the logs.

---

## Security properties worth keeping

**Prices come from the catalog, never the request body.** The client sends only
product ids and quantities. Anyone can edit what their browser posts, so if the
server trusted a `price` field, they could buy medicine for 1 RWF.

**Every payment is verified server-to-server.** The redirect query params and
the webhook body are both attacker-reachable. `verifyTransaction()` asking
Flutterwave directly is the only answer we trust.

**Webhooks are authenticated** by comparing `verif-hash` against
`FLW_SECRET_HASH` with a timing-safe compare.

**Settlement is idempotent** so a retried webhook can't double-process an order.

---

## Before you go live

- [ ] Put authentication in front of `/api/admin/orders`
- [ ] Swap `orders.ts` for a real database — the JSON file has no concurrency
      control and won't survive a serverless deploy
- [ ] Decrement stock on payment, in the same transaction as the status update
- [ ] Send order confirmation (SMS is more reliable than email in Rwanda)
- [ ] Switch to live Flutterwave keys and re-test with a real small payment
- [ ] Decide the VAT question below
- [ ] Rate-limit `/api/checkout/session`

---

## Two things that need your decision

### 1. VAT is probably being double-counted

The cart page labels the subtotal **"Subtotal (inc. VAT)"** and then adds 18%
VAT on top of it. Both can't be true. Either:

- catalog prices already include VAT → set `VAT_RATE=0` and fix the cart label, or
- catalog prices exclude VAT → keep `VAT_RATE=0.18` and change the label to
  "Subtotal (excl. VAT)"

Right now the server matches the existing frontend behaviour so the totals agree,
but one of the two labels is wrong and customers may be overcharged by 18%.

### 2. Almost nothing in the catalog is actually sellable

Of 1,148 products in `categories-menu.json`:

- **148** have a price
- **152** have stock
- **51** have both — these are the only items a customer can buy

Everything else is rejected at checkout with a clear message, which is correct
behaviour but a poor experience. Either fill in the missing prices and stock,
or hide unsellable products from the catalog pages.

Separately, **20 products collapse onto an id already used by another product**,
because ids are generated by slugifying the product name. Two different products
with similar names become the same id, so the wrong one can end up in the cart.
Real unique ids (a `sku` field) would fix this properly.
