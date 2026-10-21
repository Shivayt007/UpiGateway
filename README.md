# UPI Link Gateway

A standalone, single-domain payment-link dashboard **based on the design and UPI checkout concepts of [YouPI-PG](https://github.com/Shivayt007/YouPI-PG)**. This project is separate from the original YouPI-PG services. It does not require the original multiport supervisor, merchant-admin proxy, WhatsApp OTP, or Android observer APK.

## What's included

- **Merchant dashboard**: password-protected, mobile-first UI at `/admin` (and `/`), with overview and paid history.
- **Multiple receiving UPI IDs**: add labels and payee names, activate/deactivate, select default, select account per link.
- **Appearance**: gateway title, business name, company logo upload (PNG/JPEG/WebP, 250 KB max) or HTTPS URL, and 3 checkout themes.
- **Payment links**: fixed-amount links (`FIXED`) and customer-entered-amount links (`OPEN`); customer name/phone metadata.
- **Static/no-amount UPI QR** for each active receiving account, and **amount-specific QR** for a fixed-amount link and for each payment attempt (local SVG via `qrcode`).
- **Tap-to-pay mobile checkout**: Google Pay, PhonePe, Paytm, generic UPI. On Android Chrome, app-specific `intent://` anchors attempt to launch the selected installed app; on desktop a QR is shown. Browser/app support differs and the QR always remains available.
- **Customer payment history**: `PENDING`, `CUSTOMER_REPORTED`, `PAID`, `REJECTED`. Customer checkout is public and never asks for merchant credentials.
- **Server-side REST API**: create/list links, read payments. Authenticated with a secret Bearer API key.
- **Payment reconciliation**: manual bank-statement confirmation with real UTR, or a signed settlement callback from a trusted bank/PSP integration.
- **Data persistence**: SQLite WAL under `/app/data`, with Docker/EasyPanel deployment and no paid external database service.

## IMPORTANT: payment verification and banking

This is **NOT an accredited payment aggregator or a bank verification service**. The QR/app handoff moves the payer to their bank/UPI app; it does not prove money was received. A customer clicking “I've paid”, or an app opening, **does not** set status to `PAID`. The admin should independently match the receiving bank account, exact amount, and bank reference/UTR before confirming, and that is recorded as `MANUAL_BANK_CHECK`.

For automatic confirmed status, you must connect a **trusted** bank/PSP settlement feed and configure `SETTLEMENT_SECRET` to receive signed events. The server authenticates those events but **cannot validate that an arbitrary third-party sender truly checked a bank**; only grant this secret to a truly authoritative verifier. Do not expose secrets to checkout clients or use unverified bank SMS and payment screenshots as final proof. Static QR payments may need separate manual reconciliation and are not automatically tied to payment links.

UPI app deep links are not guaranteed in every browser/app, and ordinary VPA transfers may have merchant/P2P restrictions. Test your own UPI ID with a small genuine transaction and follow applicable PSP/bank rules.

## EasyPanel Docker deployment

1. Create a new GitHub repository from this project. Connect it in EasyPanel as a **Dockerfile** service. Choose a public HTTPS domain (e.g. `https://pay.example.com`) and container port `3000`.
2. Configure these **environment variables** (generate secure random values):

   ```env
   PORT=3000
   PUBLIC_BASE_URL=https://pay.example.com
   ADMIN_PASSWORD=choose-a-long-admin-password
   SESSION_SECRET=your-random-32-or-more-character-value
   API_KEY=another-random-32-or-more-character-value
   DB_PATH=/app/data/gateway.sqlite
   ```

   Optional `SETTLEMENT_SECRET` is only needed for an actual trusted bank/PSP feed.
3. **Attach a persistent storage volume mounted at `/app/data`**. Otherwise redeployment can lose payment history and UPI settings.
4. Deploy. Navigate to `https://pay.example.com/admin`, sign in with `ADMIN_PASSWORD`, then add a receiving UPI ID.
5. Create a fixed or open payment link, then open it **without logging in** on a separate device to test the checkout flow.

**Security**: Never commit `.env`, your bank details, password or API key to GitHub. Do not share the admin password with customers. Protect your account with HTTPS. Limit who can access payment history (it can contain customer contact information).

### Local run

Requires Node.js **22.13+** and npm (built-in `node:sqlite` is experimental on Node 22). Copy `.env.example` to `.env`, edit secrets and the localhost base URL, then:

```bash
npm install
npm test
npm start
```

Open `http://localhost:3000/admin`. The Docker build automatically installs dependencies.

## HTTP API quick reference

All `/api/v1/links`, `/api/v1/accounts`, and `/api/v1/payments*` routes require:

```http
Authorization: Bearer YOUR_API_KEY
```

**Create fixed-amount link**:

```http
POST /api/v1/links
Content-Type: application/json
Authorization: Bearer YOUR_API_KEY

{"type":"FIXED","accountId":"ACCOUNT_UUID","title":"Order #1001","amount":"499.00","customerName":"Customer"}
```

**Create open-amount link**:

```http
POST /api/v1/links
Content-Type: application/json
Authorization: Bearer YOUR_API_KEY

{"type":"OPEN","accountId":"ACCOUNT_UUID","title":"Pay any amount"}
```

Responses include a public `url` such as `https://pay.example.com/pay/<link_uuid>`.

- `GET /api/v1/accounts` — list receiving account UUIDs.
- `GET /api/v1/links` — list the newest 150 links.
- `GET /api/v1/payments` — list the newest 200 payment attempts; optional `?status=PAID`.
- `GET /api/v1/payments/:id` — authoritative backend status, amount, UTR and confirmation source.
- `GET /api/public/links/:id` — public payment-link summary (no authentication).
- `POST /api/public/links/:id/attempts` — create an actual payer attempt. For open links, send `{ "amount": "100.00" }`; for fixed links the amount comes from server state.
- `GET /api/public/attempts/:id` — public payment-attempt status and UPI deep link.
- `POST /api/public/attempts/:id/report` — customer-reported state only, **never** confirmed PAID.
- `GET /qr/static/:accountId.svg` — normal/static/no-amount QR.
- `GET /qr/links/:linkId.svg` — direct amount-specific QR for a fixed link (not tied to a unique payer attempt; reconcile manually).
- `GET /qr/payments/:paymentId.svg` — QR for an individual payment attempt.
- `GET /health` — public service health check.

All payment amounts are validated and persisted as integer paise. Link IDs, payment IDs and UPI account IDs are UUIDs. `externalId` is optional and unique when creating links, to reduce duplicate invoice link generation. API key requests must originate from your backend, not the customer-facing browser.

### Settlement verification (advanced)

**POST** `/api/v1/settlements/confirm` is disabled unless `SETTLEMENT_SECRET` is configured. It is intended **only** for a trusted bank/PSP settlement verifier. On each event, send:

```json
{"eventId":"settlement-unique-0001","paymentId":"payment-uuid","amount":"499.00","upiId":"merchant@bank","utr":"BANK123456789","bankVerified":true}
```

`X-Settlement-Timestamp`: Unix milliseconds (maximum ±5 minutes). `X-Settlement-Signature`: `sha256=` followed by the hex `HMAC-SHA256(secret, timestamp + '.' + raw_JSON_body)`.

The gateway enforces a matching payment amount, UPI ID, unique bank reference on that receiver, timestamp, and event idempotency. Your integrated verifier **must** have already independently confirmed the bank-side credit before it sends the event. Do not call this endpoint from customer browsers, payment screenshots, or self-reported UTRs.

## Scope compared with the original YouPI-PG

This single-container project intentionally excludes the original WhatsApp Berry OTP, SMS listener, Gmail observer, queuing engine, and multi-service checkout so it can be deployed on one EasyPanel domain. These services should not be presented as working in this new version. You can migrate verified bank/PSP integrations into the gateway after security review.

## License and provenance

This is a newly implemented standalone application inspired by the YouPI-PG checkout and merchant-management concepts. Review the original upstream project's license/terms before redistributing any original files or trademarks.
