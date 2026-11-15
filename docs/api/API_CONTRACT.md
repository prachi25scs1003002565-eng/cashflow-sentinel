# Cashflow Sentinel — API Contract (v1)

**Status:** Logical HTTP contract for the MVP; not an implementation or OpenAPI file  
**Public API:** HTTPS REST/JSON at `/api/v1`  
**Private analytics API:** Versioned HTTP/JSON at `/internal/v1`, reachable only by Express  
**Canonical store:** PostgreSQL, accessed only by the Express backend
**Frontend client:** React + Vite + TypeScript

This contract follows the product blueprint, system architecture, and database schema at:

- `docs/planning/PRODUCT_BLUEPRINT.md`
- `docs/architecture/SYSTEM_ARCHITECTURE.md`
- `docs/database/DATABASE_SCHEMA.md`

The API exposes domain resources and derived views, not raw database rows. Derived fields are identified as such below. No endpoint creates a prediction-shaped `transactions` record, executes a recommendation, sends a collection message, initiates a payment, or applies for credit.

## 1. Architecture and trust boundaries

```text
React + Vite + TypeScript
    │ HTTPS /api/v1
    ▼
Node.js + Express ◄──────────────► PostgreSQL
    │                 canonical reads/writes
    │ private /internal/v1
    ▼
Python + FastAPI (analytics only)
    no database access
```

- **React + Vite + TypeScript → Express:** The browser calls only `/api/v1`. It never calls FastAPI or PostgreSQL.
- **Express → PostgreSQL:** Express authenticates and authorizes requests, derives tenant scope from current membership, validates inputs, performs transactional workflows, and is the only service that reads or writes PostgreSQL.
- **Express → FastAPI:** Express sends bounded, normalized, authorized input over a private network. FastAPI computes forecasts, risk candidates, scenario outputs, and health factors; it neither authorizes users nor reads/writes the database.
- **Persistence boundary:** Express validates analytics output and persists forecast points, evidence, alerts, recommendations, health assessments, and simulations. Successful forecast runs and their analytical results are immutable.
- **V1 analytics scope:** The private API also supports customer payment-delay signals and constrained recommendation candidates. Express remains the authorization, validation, final rule-approval, and persistence boundary for both.
- **Financial facts:** Actual cash movements are represented by posted transactions. Forecast movements and scenario outputs remain in forecast/simulation records. A prediction must never be returned or stored as an actual transaction.

## 2. Contract conventions and explicit decisions

### 2.1 Paths, names, IDs, money, and time

- Paths use lowercase plural resource names and `{business_id}`/`{resource_id}` UUID path parameters.
- JSON fields use `snake_case`, matching the schema's concepts.
- UUIDs are canonical strings. `business_id` in a path identifies the requested tenant context; it is **not** proof of access.
- Monetary fields ending in `_paise` are JSON **strings** containing canonical base-10 integer paise (for example `"4800000"`). They map to PostgreSQL `BIGINT`; no floating-point amount is accepted. This exact wire representation avoids JavaScript integer precision loss. The database and services perform integer-paise arithmetic.
- A magnitude such as `amount_paise` is positive. Signed balances, deltas, and contribution effects may be negative. `null` means absent/unknown, not zero.
- Dates are ISO `YYYY-MM-DD` in the business's configured time zone. Instants are ISO 8601 UTC strings ending in `Z`. The server chooses forecast cutoffs; clients cannot choose a future or ambiguous cutoff.
- The MVP currency is `INR`. Rupee display formatting is a frontend concern; APIs do not accept rupee decimals.
- `created_at`, `updated_at`, `requested_at`, `completed_at`, `assessed_at`, and `allocated_at` are server-generated unless the schema explicitly allows a source event time.

### 2.2 Authentication decision

V1 uses a short-lived signed JWT access token (15-minute maximum lifetime) returned by login and held in client memory. Send it as `Authorization: Bearer <access_token>`. Claims identify the user only; authorization always checks current membership in PostgreSQL. There is no refresh-token or session table in the schema.

`POST /auth/logout` tells the client to discard its token; it does not revoke a copied, already-issued stateless JWT. It remains usable until expiry. Immediate server-side revocation is an open follow-up requiring a persisted session/revocation design; this contract does not invent a session table.

### 2.3 Response envelopes

Successful object response:

```json
{
  "data": {
    "id": "00000000-0000-4000-8000-000000000001"
  },
  "meta": {
    "request_id": "req_01JCSENTINEL00000000000001"
  }
}
```

Successful list response:

```json
{
  "data": [],
  "meta": {
    "request_id": "req_01JCSENTINEL00000000000002",
    "pagination": {
      "next_cursor": null,
      "page_size": 50
    }
  }
}
```

No-content success is `204` with an empty body. List responses use a stable opaque `cursor`, not offset pagination. Default `page_size` is 50; maximum is 100. Sort order is deterministic and documented per resource; clients cannot supply arbitrary SQL sort expressions.

### 2.4 Error envelope and common status codes

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "One or more fields are invalid.",
    "details": [
      {
        "field": "amount_paise",
        "issue": "must_be_a_positive_integer_string"
      }
    ]
  },
  "request_id": "req_01JCSENTINEL00000000000003"
}
```

Never return SQL, stack traces, tokens, credentials, raw uploaded rows, or another tenant's resource existence.

| Status | Meaning |
|---|---|
| `400` | Malformed JSON, invalid UUID/path/query syntax, or malformed multipart request. |
| `401` | Missing, invalid, expired, or disabled-user authentication. |
| `403` | Authenticated user lacks the required role for a visible operation. |
| `404` | Resource is absent or not visible in the selected business; do not disclose cross-tenant existence. |
| `409` | Lifecycle conflict, uniqueness conflict, stale idempotency key, or invalid state transition. |
| `413` | Upload or request exceeds configured size limit. |
| `422` | Well-formed request fails field/domain validation. |
| `429` | Rate limit exceeded; include `Retry-After`. |
| `502` / `503` / `504` | Analytics dependency failure, overload, or timeout; never return an empty success-shaped forecast. |
| `500` | Unexpected server failure with only a safe code and request ID. |

Common codes include `AUTHENTICATION_REQUIRED`, `TOKEN_EXPIRED`, `BUSINESS_NOT_FOUND`, `RESOURCE_NOT_FOUND`, `ROLE_REQUIRED`, `VALIDATION_ERROR`, `IDEMPOTENCY_CONFLICT`, `STATE_CONFLICT`, `TRANSACTION_NOT_EDITABLE`, `ALLOCATION_LIMIT_EXCEEDED`, `RUN_NOT_SUCCEEDED`, `ASSESSMENT_NOT_FOUND`, `ANALYTICS_UNAVAILABLE`, `ANALYTICS_TIMEOUT`, and `IMPORT_VALIDATION_FAILED`.

### 2.5 Tenant scope, audit, idempotency, and limits

- Every business-scoped route includes `{business_id}`. Express resolves the authenticated user’s active `business_memberships` row before executing the operation. All queries, joins, writes, and internal-service payloads are scoped to that business. A client-supplied business ID is only a selector and never an authorization claim.
- Writes that change financial records create an `audit_events` record in the same database transaction. Audit records include actor, business, action, entity, timestamp, and correlation ID; credentials and raw statements are excluded.
- Supply `X-Request-ID` for correlation or let Express create one. It is returned in `meta.request_id` and logged in audit events where applicable.
- `Idempotency-Key` is required on retryable financial POSTs (transaction creation/reversal, atomic receivable/payable payment creation, invoice/bill issue and allocation, import upload/confirmation, forecast creation, and simulation creation). Reuse it only with an identical request. **Schema gap:** no idempotency-key/response table exists. V1 can use existing unique source/import/allocation keys to prevent duplicate effects where applicable, but cannot promise durable replay of the exact prior HTTP response for every command. This is an implementation decision to resolve before claiming full production-grade idempotency; do not add an undocumented table or silently claim exactly-once behavior.
- CSV import is limited to UTF-8 CSV in V1; maximum 10 MiB and 25,000 data rows. Raw files are not retained by default. Supported statement-specific parsers are added only when explicitly listed.
- Initial rate-limit defaults (deployment configuration, not schema fields): registration/login 5 attempts per minute per IP; import 5 uploads per hour per business; forecast 10 requests per minute per business; other authenticated reads/writes 120 requests per minute per user. Analytics concurrency is separately bounded.
- Business and resource list endpoints support `page_size` (1–100) and `cursor`. Date-filtered lists use inclusive `from_date`/`to_date` and reject `from_date > to_date`.

## 3. Public React-to-Express API

Unless stated otherwise, public endpoints require a valid bearer JWT. Every endpoint under `/businesses/{business_id}` also requires active membership in that business. A GET request has no body. Examples below show the normal envelope; `...` is avoided in the canonical object definitions but may be used for unrelated list entries.

### 3.1 Authentication

#### `POST /api/v1/auth/register`

- **Purpose/auth/context:** Create a global user; public, no business context.
- **Path/query:** None.
- **Request:**

```json
{
  "email": "kavita@example.test",
  "password": "Example-Only-Password-42",
  "display_name": "Kavita"
}
```

- **Validation:** Normalize email; enforce unique case-insensitive email and password policy; hash with Argon2id. Never return or log the password/hash. Registration creates only `users`; create the business separately.
- **V1 decision:** Registration activates the account without email verification; `email_verified_at` remains null. Email verification is not part of this contract.
- **Response `201`:**

```json
{
  "data": {
    "user": {
      "id": "20000000-0000-4000-8000-000000000001",
      "email": "kavita@example.test",
      "display_name": "Kavita",
      "account_status": "ACTIVE"
    },
    "access_token": "<short-lived-jwt>",
    "token_type": "Bearer",
    "expires_in": 900
  },
  "meta": {
    "request_id": "req_01JCSENTINEL00000000000004"
  }
}
```

- **Statuses/errors:** `201`, `400`, `409` (`ACCOUNT_UNAVAILABLE` without disclosing whether an email is registered), `422`, `429`, `500`.

#### `POST /api/v1/auth/login`

- **Purpose/auth/context:** Authenticate a user; public, no business context.
- **Path/query:** None.
- **Request:**

```json
{
  "email": "kavita@example.test",
  "password": "Example-Only-Password-42"
}
```

- **Validation:** Same email normalization as registration; generic failure for unknown email, invalid password, disabled account, or pending-verification policy.
- **Response `200`:**

```json
{
  "data": {
    "user": {
      "id": "20000000-0000-4000-8000-000000000001",
      "email": "kavita@example.test",
      "display_name": "Kavita",
      "account_status": "ACTIVE"
    },
    "access_token": "<short-lived-jwt>",
    "token_type": "Bearer",
    "expires_in": 900
  },
  "meta": {
    "request_id": "req_01JCSENTINEL00000000000005"
  }
}
```

- **Statuses/errors:** `200`, `400`, `401` (`INVALID_CREDENTIALS`), `429`, `500`.

#### `GET /api/v1/auth/me`

- **Purpose/auth/context:** Return the authenticated user's safe profile.
- **Path/query/body:** None.
- **Response `200`:**

```json
{
  "data": {
    "id": "20000000-0000-4000-8000-000000000001",
    "email": "kavita@example.test",
    "display_name": "Kavita",
    "account_status": "ACTIVE",
    "email_verified_at": null
  },
  "meta": {
    "request_id": "req_01JCSENTINEL00000000000006"
  }
}
```

- **Statuses/errors:** `200`, `401`, `429`, `500`. `password_hash` and login secrets are never included.

#### `POST /api/v1/auth/logout`

- **Purpose/auth/context:** End the client session; authenticated, no business context.
- **Path/query/body:** None.
- **Response:** `204 No Content`; client discards the bearer token.
- **Statuses/errors:** `204`, `401`. As noted above, a stateless JWT is not revoked server-side before expiry.

### 3.2 Businesses and memberships

#### `POST /api/v1/businesses`

- **Purpose/auth/context:** Create a business and its `OWNER` membership atomically.
- **Path/query:** None.
- **Request:**

```json
{
  "name": "Shree Laxmi Kirana",
  "business_type": "KIRANA",
  "city": "Pune",
  "currency_code": "INR",
  "timezone": "Asia/Kolkata",
  "minimum_cash_buffer_paise": "1500000"
}
```

- **Validation:** `currency_code` must be `INR` in MVP; timezone must be a supported IANA name; buffer must be a non-negative paise string. The authenticated user becomes the owner. The business workflow provisions the necessary `MANUAL` and `CSV` `data_sources`; it does not create financial transactions.
- **Response `201`:**

```json
{
  "data": {
    "id": "10000000-0000-4000-8000-000000000001",
    "name": "Shree Laxmi Kirana",
    "business_type": "KIRANA",
    "city": "Pune",
    "currency_code": "INR",
    "timezone": "Asia/Kolkata",
    "minimum_cash_buffer_paise": "1500000",
    "business_status": "ACTIVE",
    "created_at": "2026-11-13T09:30:00Z"
  },
  "meta": {
    "request_id": "req_01JCSENTINEL00000000000007"
  }
}
```

- **Statuses/errors:** `201`, `400`, `401`, `422`, `429`, `500`.

#### `GET /api/v1/businesses`

- **Purpose/auth/context:** List businesses with an active membership for the authenticated user.
- **Path/query/body:** Optional pagination; no body.
- **Response `200`:**

```json
{
  "data": [
    {
      "id": "10000000-0000-4000-8000-000000000001",
      "name": "Shree Laxmi Kirana",
      "business_type": "KIRANA",
      "city": "Pune",
      "currency_code": "INR",
      "timezone": "Asia/Kolkata",
      "minimum_cash_buffer_paise": "1500000",
      "role": "OWNER",
      "membership_status": "ACTIVE"
    }
  ],
  "meta": {
    "request_id": "req_01JCSENTINEL00000000000008",
    "pagination": {
      "next_cursor": null,
      "page_size": 50
    }
  }
}
```

- **Statuses/errors:** `200`, `401`, `400` (bad cursor/page size), `429`, `500`.

#### `GET /api/v1/businesses/{business_id}`

- **Purpose/auth/context:** Retrieve authorized business settings.
- **Path/query/body:** `business_id` UUID; no query/body.
- **Response `200`:** Same business representation as create, with `business_status`, `created_at`, and `updated_at`.
- **Statuses/errors:** `200`, `401`, `404` (`BUSINESS_NOT_FOUND` for absent or inaccessible business), `429`, `500`.

#### `PATCH /api/v1/businesses/{business_id}`

- **Purpose/auth/context:** Update editable business profile/settings. Owner or admin only.
- **Path/query:** `business_id` UUID.
- **Request:**

```json
{
  "name": "Shree Laxmi Kirana",
  "city": "Pune",
  "timezone": "Asia/Kolkata",
  "minimum_cash_buffer_paise": "1750000"
}
```

- **Validation:** At least one allowed field; `currency_code` remains `INR`; no update to membership/role through this route. Update is audited.
- **Response `200`:** Updated business object as above.
- **Statuses/errors:** `200`, `400`, `401`, `403`, `404`, `409`, `422`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/memberships`

- **Purpose/auth/context:** Read memberships for a business; membership required. V1 does not invite users or change roles because MVP scope is a single owner.
- **Path/query:** `business_id`; optional pagination.
- **Response `200`:**

```json
{
  "data": [
    {
      "id": "21000000-0000-4000-8000-000000000001",
      "user_id": "20000000-0000-4000-8000-000000000001",
      "role": "OWNER",
      "membership_status": "ACTIVE",
      "invited_by_user_id": null,
      "created_at": "2026-11-13T09:30:00Z"
    }
  ],
  "meta": {
    "request_id": "req_01JCSENTINEL00000000000009",
    "pagination": {
      "next_cursor": null,
      "page_size": 50
    }
  }
}
```

- **Statuses/errors:** `200`, `401`, `404`, `429`, `500`.

### 3.3 Categories, sources, accounts, and balances

#### `GET /api/v1/businesses/{business_id}/transaction-categories`

- **Purpose/auth/context:** List category IDs and allowed directions for entry/import mapping.
- **Path/query:** `business_id`; optional `is_active` and pagination.
- **Response `200`:**

```json
{
  "data": [
    {
      "id": "41000000-0000-4000-8000-000000000001",
      "category_code": "RENT",
      "display_name": "Rent",
      "allowed_direction": "OUTFLOW",
      "is_active": true
    }
  ],
  "meta": {
    "request_id": "req_01JCSENTINEL00000000000010",
    "pagination": {
      "next_cursor": null,
      "page_size": 50
    }
  }
}
```

- **Statuses/errors:** `200`, `401`, `404`, `400`, `429`, `500`.

#### `POST /api/v1/businesses/{business_id}/transaction-categories`

- **Purpose/auth/context:** Create a business-local category; owner/admin only.
- **Request:**

```json
{
  "category_code": "PACKAGING",
  "display_name": "Packaging",
  "allowed_direction": "OUTFLOW"
}
```

- **Validation:** Unique `category_code` per business; `allowed_direction` is `INFLOW`, `OUTFLOW`, or `BOTH`.
- **Response `201`:** Category projection matching the GET example.
- **Statuses/errors:** `201`, `401`, `403`, `404`, `409` (`CATEGORY_CODE_EXISTS`), `422`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/data-sources`

- **Purpose/auth/context:** List business-local provenance sources. Sources are provisioned by business setup; no source credentials are exposed.
- **Path/query:** `business_id`; optional `source_status`.
- **Response `200`:**

```json
{
  "data": [
    {
      "id": "42000000-0000-4000-8000-000000000001",
      "source_type": "MANUAL",
      "display_name": "Owner entry",
      "provider_name": null,
      "source_status": "ACTIVE"
    }
  ],
  "meta": {
    "request_id": "req_01JCSENTINEL00000000000011",
    "pagination": {
      "next_cursor": null,
      "page_size": 50
    }
  }
}
```

- **Statuses/errors:** `200`, `401`, `404`, `400`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/accounts`

- **Purpose/auth/context:** List business accounts.
- **Path/query/body:** Optional `is_active`, pagination.
- **Response `200`:**

```json
{
  "data": [
    {
      "id": "50000000-0000-4000-8000-000000000001",
      "account_type": "BANK",
      "display_name": "Current account",
      "institution_name": null,
      "currency_code": "INR",
      "is_active": true,
      "created_at": "2026-11-01T04:30:00Z"
    }
  ],
  "meta": {
    "request_id": "req_01JCSENTINEL00000000000012",
    "pagination": {
      "next_cursor": null,
      "page_size": 50
    }
  }
}
```

- **Statuses/errors:** `200`, `401`, `404`, `400`, `429`, `500`.

#### `POST /api/v1/businesses/{business_id}/accounts`

- **Purpose/auth/context:** Create a bank, cash-on-hand, or other account.
- **Request:**

```json
{
  "account_type": "CASH",
  "display_name": "Shop cash",
  "institution_name": null,
  "currency_code": "INR"
}
```

- **Validation:** `account_type` in `BANK`, `CASH`, `OTHER`; currency must match the business (`INR` in MVP). `is_active` starts `true`; client cannot set ownership IDs.
- **Response `201`:** Account projection matching the GET example.
- **Statuses/errors:** `201`, `401`, `403`, `404`, `422`, `429`, `500`.

#### `POST /api/v1/businesses/{business_id}/accounts/{account_id}/balance-snapshots`

- **Purpose/auth/context:** Append an opening/reconciliation balance snapshot; this endpoint never edits an earlier snapshot.
- **Path:** `business_id`, `account_id`; account must belong to this business.
- **Request:**

```json
{
  "snapshot_type": "OPENING",
  "balance_paise": "6200000",
  "as_of_at": "2026-11-13T18:29:59Z",
  "certainty": "CONFIRMED",
  "source_data_source_id": "42000000-0000-4000-8000-000000000001"
}
```

- **Validation:** `snapshot_type` is `OPENING`, `RECONCILIATION`, or `IMPORTED_BALANCE`; `certainty` is `CONFIRMED` or `ESTIMATED`; `as_of_at` is an explicit UTC instant. Source, if supplied, must belong to the same business. `entered_by_user_id` is set by Express.
- **Response `201`:**

```json
{
  "data": {
    "id": "51000000-0000-4000-8000-000000000001",
    "account_id": "50000000-0000-4000-8000-000000000001",
    "snapshot_type": "OPENING",
    "balance_paise": "6200000",
    "as_of_at": "2026-11-13T18:29:59Z",
    "certainty": "CONFIRMED",
    "source_data_source_id": "42000000-0000-4000-8000-000000000001",
    "created_at": "2026-11-13T18:35:00Z"
  },
  "meta": {
    "request_id": "req_01JCSENTINEL00000000000013"
  }
}
```

- **Statuses/errors:** `201`, `401`, `403`, `404`, `409`, `422`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/balances`

- **Purpose/auth/context:** Return the latest eligible balance view per account, rolled forward from its selected snapshot using posted transactions through the server-selected cutoff.
- **Path/query:** Optional `as_of_at` not later than now; default is current server time. Snapshot/transaction inclusions follow the database cutoff rule.
- **Response `200`:**

```json
{
  "data": {
    "as_of_at": "2026-11-13T18:29:59Z",
    "currency_code": "INR",
    "accounts": [
      {
        "account_id": "50000000-0000-4000-8000-000000000001",
        "display_name": "Current account",
        "snapshot_id": "51000000-0000-4000-8000-000000000001",
        "certainty": "CONFIRMED",
        "balance_paise": "6200000"
      }
    ],
    "total_balance_paise": "7000000",
    "data_quality": "SUFFICIENT"
  },
  "meta": {
    "request_id": "req_01JCSENTINEL00000000000014"
  }
}
```

`balance_paise` and `total_balance_paise` are calculated views, not additional writable database columns. If a usable snapshot is absent, report an insufficient-data condition; do not substitute a confirmed zero.

- **Statuses/errors:** `200`, `401`, `404`, `400`, `422`, `429`, `500`.

### 3.4 Transactions

#### `POST /api/v1/businesses/{business_id}/transactions`

- **Purpose/auth/context:** Record one posted actual transaction; requires `Idempotency-Key`.
- **Request:**

```json
{
  "account_id": "50000000-0000-4000-8000-000000000001",
  "category_id": "41000000-0000-4000-8000-000000000002",
  "data_source_id": "42000000-0000-4000-8000-000000000001",
  "source_reference": null,
  "transaction_date": "2026-11-13",
  "occurred_at": "2026-11-13T10:15:00Z",
  "transaction_type": "INFLOW",
  "cash_direction": "INFLOW",
  "amount_paise": "1000000",
  "description": "UPI customer payment",
  "counterparty_name": "Mehta Stores"
}
```

- **Validation:** Account, category, and data source must be in the path business. `amount_paise > 0`; type/direction pair and category direction must agree. `ADJUSTMENT` requires a non-empty audit description and an audit event. Express sets `record_status = POSTED`, `created_by_user_id`, and timestamps. Do not send `reversal_of_transaction_id` on this route. `TRANSFER_IN` and `TRANSFER_OUT` are rejected here; use the paired transfer endpoint. Owner contributions/draws are not invoice-allocation eligible.
- **Response `201`:**

```json
{
  "data": {
    "id": "60000000-0000-4000-8000-000000000001",
    "account_id": "50000000-0000-4000-8000-000000000001",
    "category_id": "41000000-0000-4000-8000-000000000002",
    "data_source_id": "42000000-0000-4000-8000-000000000001",
    "import_row_id": null,
    "source_reference": null,
    "transaction_date": "2026-11-13",
    "occurred_at": "2026-11-13T10:15:00Z",
    "transaction_type": "INFLOW",
    "cash_direction": "INFLOW",
    "amount_paise": "1000000",
    "description": "UPI customer payment",
    "counterparty_name": "Mehta Stores",
    "record_status": "POSTED",
    "reversal_of_transaction_id": null,
    "created_by_user_id": "20000000-0000-4000-8000-000000000001",
    "created_at": "2026-11-13T10:16:00Z",
    "updated_at": "2026-11-13T10:16:00Z"
  },
  "meta": {
    "request_id": "req_01JCSENTINEL00000000000015"
  }
}
```

- **Statuses/errors:** `201`, `400`, `401`, `403`, `404`, `409` (duplicate source reference/idempotency conflict), `422`, `429`, `500`.

#### `POST /api/v1/businesses/{business_id}/transfers`

- **Purpose/auth/context:** Record an internal movement between two of the business's accounts as a matched pair; requires bearer JWT, active business membership, and `Idempotency-Key`.
- **Path/query:** `business_id` UUID; no query parameters.
- **Request:**

```json
{
  "outgoing_account_id": "50000000-0000-4000-8000-000000000001",
  "incoming_account_id": "50000000-0000-4000-8000-000000000002",
  "data_source_id": "42000000-0000-4000-8000-000000000001",
  "amount_paise": "500000",
  "transaction_date": "2026-11-13",
  "occurred_at": "2026-11-13T16:30:00Z",
  "description": "Move shop cash to current account"
}
```

- **Validation/atomic behavior:** Accounts must be distinct, active, and owned by the path business. The amount must be positive. Express creates one `TRANSFER_OUT`/`OUTFLOW` transaction and one `TRANSFER_IN`/`INFLOW` transaction, each for the same amount, and a `transaction_transfers` row in one database transaction. Neither leg is eligible for invoice or bill allocation. A failure at any step rolls back the entire pair. Transfer reversals use the paired transaction-reversal workflow and cannot reverse one leg alone.
- **Response `201`:**

```json
{
  "data": {
    "id": "61000000-0000-4000-8000-000000000001",
    "outgoing_transaction_id": "60000000-0000-4000-8000-000000000010",
    "incoming_transaction_id": "60000000-0000-4000-8000-000000000011",
    "outgoing_account_id": "50000000-0000-4000-8000-000000000001",
    "incoming_account_id": "50000000-0000-4000-8000-000000000002",
    "amount_paise": "500000",
    "transaction_date": "2026-11-13"
  },
  "meta": {
    "request_id": "req_01JCSENTINEL00000000000031"
  }
}
```

The account IDs and transaction date in this response are joined from the paired transaction rows; they are not columns of `transaction_transfers`.

- **Statuses/errors:** `201`, `400`, `401`, `403`, `404`, `409` (idempotency conflict or invalid account/transfer state), `422`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/transactions`

- **Purpose/auth/context:** List actual transactions only; forecasts and expected movements are not returned as transactions.
- **Query:** `from_date`, `to_date`, `account_id`, `category_id`, `cash_direction`, `record_status` (defaults to `POSTED`), `page_size`, `cursor`.
- **Response `200`:** List of the transaction projection in the POST response, with pagination metadata.
- **Statuses/errors:** `200`, `400`, `401`, `404`, `422`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/transactions/{transaction_id}`

- **Purpose/auth/context:** Retrieve one tenant-scoped transaction.
- **Path/query/body:** UUIDs; no body.
- **Response `200`:** One transaction projection matching the POST response.
- **Statuses/errors:** `200`, `401`, `404`, `429`, `500`.

#### `PATCH /api/v1/businesses/{business_id}/transactions/{transaction_id}`

- **Purpose/auth/context:** Correct editable classification or display metadata for an existing actual transaction; requires active business membership.
- **Path/query:** `business_id` and `transaction_id` UUIDs; no query parameters.
- **Request:** Any non-empty subset of the fields below:

```json
{
  "category_id": "41000000-0000-4000-8000-000000000004",
  "description": "UPI customer payment - corrected category",
  "counterparty_name": "Mehta Stores"
}
```

- **Validation:** Only a `POSTED` original transaction that is not a transfer leg may be edited. The only writable fields are `category_id`, `description`, and `counterparty_name`; `category_id` must be null or active, same-business, and compatible with the immutable cash direction. Amount, date, account, source, type, direction, status, and reversal links cannot be changed here; use reversal and replacement to correct financial facts. Write an audit event in the same transaction. This endpoint does not change balance arithmetic.
- **V1 design decision:** The schema protects financial movement fields but does not define metadata editability. V1 permits only the three non-monetary fields above and audits every edit; all listed immutable fields remain protected by the database lifecycle rules.
- **Response `200`:** Updated transaction projection, matching the transaction GET response.
- **Statuses/errors:** `200`, `400`, `401`, `403`, `404`, `409` (`TRANSACTION_NOT_EDITABLE` or stale state), `422`, `429`, `500`.

#### `POST /api/v1/businesses/{business_id}/transactions/{transaction_id}/reverse`

- **Purpose/auth/context:** Reverse a posted transaction under the database lifecycle; requires `Idempotency-Key`.
- **Request:**

```json
{
  "reason": "Imported transaction amount was incorrect",
  "replacement": {
    "account_id": "50000000-0000-4000-8000-000000000001",
    "category_id": "41000000-0000-4000-8000-000000000002",
    "data_source_id": "42000000-0000-4000-8000-000000000001",
    "source_reference": null,
    "transaction_date": "2026-11-13",
    "occurred_at": "2026-11-13T10:15:00Z",
    "transaction_type": "INFLOW",
    "cash_direction": "INFLOW",
    "amount_paise": "950000",
    "description": "Corrected UPI customer payment",
    "counterparty_name": "Mehta Stores"
  }
}
```

- **Validation/atomic behavior:** `reason` is required. Express creates an equal-amount, opposite-direction reversal row and changes the original to `REVERSED` in one transaction. If supplied, `replacement` is a new posted transaction created in that same transaction; it is not the reversal row and follows the transaction-create validation, including rejection of transfer types. Existing allocation rows are audited then removed only by this workflow; they are not silently copied to the replacement. Reallocations, if valid, are explicitly requested through the allocation endpoint after this workflow. A transfer reversal reverses both original legs and creates the matched inverse pair atomically; the service rejects one-leg transfer reversal. Occurrence linkage is cleared and its status restored according to certainty. Original invoice/bill status stays `ISSUED`/`RECEIVED`; outstanding is recomputed from remaining allocations.
- **Response `200`:**

```json
{
  "data": {
    "reversed_transaction_ids": [
      "60000000-0000-4000-8000-000000000001"
    ],
    "reversal_transaction_ids": [
      "60000000-0000-4000-8000-000000000002"
    ],
    "replacement_transaction_ids": [
      "60000000-0000-4000-8000-000000000003"
    ],
    "removed_allocation_count": 1,
    "reopened_receivable_ids": [
      "70000000-0000-4000-8000-000000000001"
    ],
    "restored_occurrence_ids": [],
    "record_status": "REVERSED"
  },
  "meta": {
    "request_id": "req_01JCSENTINEL00000000000016"
  }
}
```

- **Statuses/errors:** `200`, `400`, `401`, `403`, `404`, `409` (`ALREADY_REVERSED`, second reversal, transfer pair mismatch, or allocation/lifecycle conflict), `422`, `429`, `500`.

### 3.5 CSV imports

#### `POST /api/v1/businesses/{business_id}/imports`

- **Purpose/auth/context:** Upload and parse one CSV into an import batch; requires `Idempotency-Key`.
- **Content type:** `multipart/form-data`; fields: `file` (CSV), `data_source_id` (same-business `CSV` source), optional `mapping` JSON.
- **Example form fields:**

```text
data_source_id=42000000-0000-4000-8000-000000000002
mapping={"date_column":"Date","amount_column":"Amount","description_column":"Narration"}
file=<CSV bytes>
```

- **Validation:** V1 upload limits in section 2.5. Treat all cells as untrusted; normalize amounts to integer paise, dates to business-local dates, and signs to direction. Raw upload is not retained by default. Parsing produces `import_batches` and `import_rows`; it does not create transactions.
- **Response `201`:**

```json
{
  "data": {
    "id": "80000000-0000-4000-8000-000000000001",
    "data_source_id": "42000000-0000-4000-8000-000000000002",
    "status": "REVIEW_REQUIRED",
    "row_count": 14,
    "accepted_count": 0,
    "rejected_count": 0,
    "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "error_summary": null,
    "created_at": "2026-11-13T11:00:00Z"
  },
  "meta": {
    "request_id": "req_01JCSENTINEL00000000000017"
  }
}
```

- **Statuses/errors:** `201`, `400`, `401`, `403`, `404`, `409`, `413`, `422`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/imports/{import_batch_id}`

- **Purpose/auth/context:** Retrieve batch status and aggregate errors.
- **Response `200`:** `id`, `data_source_id`, sanitized filename if present, `content_sha256`, `status`, row counts, mapping snapshot where safe, error summary, and timestamps.
- **Statuses/errors:** `200`, `401`, `404`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/imports/{import_batch_id}/rows`

- **Purpose/auth/context:** Preview parsed rows and row-level validation errors.
- **Query:** `review_status`, pagination. Raw file bytes are never returned.
- **Response `200`:**

```json
{
  "data": [
    {
      "id": "81000000-0000-4000-8000-000000000014",
      "source_row_number": 14,
      "row_fingerprint": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "parsed_transaction_date": "2026-11-13",
      "parsed_amount_paise": "1000000",
      "parsed_direction": "INFLOW",
      "parsed_description": "UPI customer payment",
      "source_reference": "BANK-ROW-14",
      "review_status": "PENDING",
      "validation_errors": []
    }
  ],
  "meta": {
    "request_id": "req_01JCSENTINEL00000000000018",
    "pagination": {
      "next_cursor": null,
      "page_size": 50
    }
  }
}
```

- **Statuses/errors:** `200`, `400`, `401`, `404`, `429`, `500`.

#### `POST /api/v1/businesses/{business_id}/imports/{import_batch_id}/confirm`

- **Purpose/auth/context:** Finalize owner-reviewed rows and create actual transactions for accepted rows; requires `Idempotency-Key`.
- **Request:**

```json
{
  "accepted_row_ids": [
    "81000000-0000-4000-8000-000000000014"
  ],
  "duplicate_override_row_ids": [],
  "rejected_row_ids": [],
  "mapping_snapshot": {
    "date_column": "Date",
    "amount_column": "Amount",
    "description_column": "Narration"
  }
}
```

- **Validation:** Row IDs must belong to this batch and business; sets must not overlap. Duplicate candidates need explicit override. Accepted rows create at most one transaction each; `(business_id, import_row_id)` uniqueness prevents duplicate accepted transactions. Persist transactions and row/batch status changes atomically. Keep import provenance; do not treat confirmation as a forecast or prediction.
- **Response `200`:**

```json
{
  "data": {
    "import_batch_id": "80000000-0000-4000-8000-000000000001",
    "status": "COMPLETED",
    "accepted_count": 1,
    "rejected_count": 0,
    "created_transaction_ids": [
      "60000000-0000-4000-8000-000000000014"
    ]
  },
  "meta": {
    "request_id": "req_01JCSENTINEL00000000000019"
  }
}
```

- **Statuses/errors:** `200`, `400`, `401`, `403`, `404`, `409` (already completed or row state changed), `422`, `429`, `500`.

### 3.6 Customers, invoices, receivables, suppliers, and payables

All document amounts are integer paise strings. Issue/receive operations create their receivable/payable in the same database transaction. Draft or void documents cannot have active receivables/payables. Issued invoice and received bill totals cannot be edited in place. Allocation deletion is not exposed here; it occurs only in the transaction reversal endpoint.

#### `POST /api/v1/businesses/{business_id}/customers`

- **Auth/context:** Owner/admin/member; business context required.
- **Request:** `{"display_name":"Mehta Stores","external_reference":"C-104","contact_hint":null}`.
- **Validation:** `display_name` required; external reference unique per business when supplied.
- **Response `201`:** `{"data":{"id":"30000000-0000-4000-8000-000000000001","display_name":"Mehta Stores","external_reference":"C-104","contact_hint":null,"record_status":"ACTIVE","created_at":"2026-11-13T11:10:00Z"},"meta":{"request_id":"req_01JCSENTINEL00000000000020"}}`
- **Statuses/errors:** `201`, `401`, `403`, `404`, `409`, `422`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/customers`

- **Purpose/query:** List tenant-scoped customers; optional `record_status`, `page_size`, `cursor`.
- **Request body:** None.
- **Response `200`:** List of customer projections from POST; paginated.
- **Statuses/errors:** `200`, `400`, `401`, `404`, `429`, `500`.

#### `POST /api/v1/businesses/{business_id}/sales-invoices`

- **Purpose:** Create a draft invoice. Requires `Idempotency-Key`.
- **Request:**

```json
{
  "customer_id": "30000000-0000-4000-8000-000000000001",
  "invoice_number": "SLK-2026-104",
  "issued_date": "2026-11-05",
  "due_date": "2026-11-20",
  "total_paise": "3000000",
  "external_reference": null
}
```

- **Validation:** Customer same-business; `due_date >= issued_date`; amount positive; invoice number unique per business. New invoice status is `DRAFT`; no receivable yet.
- **Response `201`:** Invoice fields `id`, `customer_id`, `invoice_number`, dates, `total_paise`, `invoice_status:"DRAFT"`, `external_reference`, `created_at`, `updated_at`.
- **Statuses/errors:** `201`, `401`, `403`, `404`, `409`, `422`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/sales-invoices`

- **Query:** `customer_id`, `invoice_status`, `from_date`, `to_date`, pagination.
- **Request body:** None.
- **Response `200`:** Paginated invoice projections; an issued invoice may include its associated receivable and derived `outstanding_paise`.
- **Statuses/errors:** `200`, `400`, `401`, `404`, `422`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/sales-invoices/{invoice_id}`

- **Response `200`:** One invoice projection plus its receivable, if created, and derived outstanding amount. The outstanding field is computed from valid allocations, not stored.
- **Statuses/errors:** `200`, `401`, `404`, `429`, `500`.

#### `POST /api/v1/businesses/{business_id}/sales-invoices/{invoice_id}/issue`

- **Purpose:** Issue a draft invoice and create its one receivable atomically; requires `Idempotency-Key`.
- **Request:**

```json
{
  "expected_collection_date": "2026-11-24",
  "expected_date_source": "OWNER_ESTIMATE",
  "expected_certainty": "ESTIMATED"
}
```

- **Validation:** Invoice must be `DRAFT`; values match the receivable schema; invoice/customer must be same-business. API does not allow total changes in this action.
- **Response `200`:** `{"data":{"invoice_id":"70000000-0000-4000-8000-000000000001","invoice_status":"ISSUED","receivable":{"id":"70000000-0000-4000-8000-000000000002","expected_collection_date":"2026-11-24","expected_date_source":"OWNER_ESTIMATE","expected_certainty":"ESTIMATED","collection_state":"OPEN","outstanding_paise":"3000000"}},"meta":{"request_id":"req_01JCSENTINEL00000000000021"}}`
- **Statuses/errors:** `200`, `401`, `403`, `404`, `409` (already issued/void), `422`, `429`, `500`.

#### `POST /api/v1/businesses/{business_id}/sales-invoices/{invoice_id}/void`

- **Purpose:** Void an unallocated invoice; cancel its unallocated receivable in the same transaction when present.
- **Request:** `{"reason":"Duplicate draft entered in error"}`.
- **Validation:** Reject if allocations remain. An issued total is never edited. Reversal of allocated transactions must occur before voiding.
- **Response `200`:** `{"data":{"invoice_id":"70000000-0000-4000-8000-000000000001","invoice_status":"VOID","receivable_state":"CANCELLED"},"meta":{"request_id":"req_01JCSENTINEL00000000000022"}}`
- **Statuses/errors:** `200`, `401`, `403`, `404`, `409` (`HAS_ALLOCATIONS` or invalid state), `422`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/receivables`

- **Query:** `collection_state`, `customer_id`, `due_from`, `due_to`, `expected_from`, `expected_to`, `overdue` (boolean), pagination.
- **Response `200`:** Paginated records with `id`, `invoice_id`, expected date/source/certainty, `collection_state`, and derived `outstanding_paise`.
- **Statuses/errors:** `200`, `400`, `401`, `404`, `422`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/receivables/{receivable_id}`

- **Response `200`:** Same receivable projection plus invoice number/due date and valid allocation summaries. `outstanding_paise = invoice.total_paise - sum(valid receivable allocations)`.
- **Statuses/errors:** `200`, `401`, `404`, `429`, `500`.

#### `PATCH /api/v1/businesses/{business_id}/receivables/{receivable_id}`

- **Purpose:** Correct expected collection metadata or lifecycle state, not payment history.
- **Request:** Any non-empty subset of `expected_collection_date`, `expected_date_source`, `expected_certainty`, `collection_state`.
- **Validation:** `collection_state` must follow lifecycle rules; cannot cancel with allocations. Do not send `invoice_id`, `business_id`, an outstanding amount, or payment status.
- **Response `200`:** Updated receivable projection and computed outstanding amount.
- **Statuses/errors:** `200`, `401`, `403`, `404`, `409`, `422`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/receivables/{receivable_id}/allocations`

- **Response `200`:** List allocation rows with `id`, `transaction_id`, `amount_paise`, `allocated_at`, and `created_at`.
- **Statuses/errors:** `200`, `401`, `404`, `429`, `500`.

#### `POST /api/v1/businesses/{business_id}/receivables/{receivable_id}/allocations`

- **Purpose:** Allocate a posted actual receipt, including partial payments; requires `Idempotency-Key`.
- **Request:** `{"transaction_id":"60000000-0000-4000-8000-000000000001","amount_paise":"1000000"}`.
- **Validation:** Transaction is same-business, posted `INFLOW`, eligible for allocation; invoice is `ISSUED`; allocation is positive; aggregate allocations do not exceed transaction or invoice totals. Allocation writes are atomic.
- **Response `201`:** `{"data":{"id":"71000000-0000-4000-8000-000000000001","receivable_id":"70000000-0000-4000-8000-000000000002","transaction_id":"60000000-0000-4000-8000-000000000001","amount_paise":"1000000","allocated_at":"2026-11-13T11:20:00Z","outstanding_paise":"2000000"},"meta":{"request_id":"req_01JCSENTINEL00000000000023"}}`
- **Statuses/errors:** `201`, `401`, `403`, `404`, `409` (`ALLOCATION_LIMIT_EXCEEDED`, duplicate allocation, or document state conflict), `422`, `429`, `500`.

#### `POST /api/v1/businesses/{business_id}/receivables/{receivable_id}/payments`

- **Purpose/auth/context:** Record an actual customer receipt and allocate it to this receivable atomically; requires active business membership and `Idempotency-Key`.
- **Path/query:** Business and receivable UUIDs; no query parameters.
- **Request:**

```json
{
  "account_id": "50000000-0000-4000-8000-000000000001",
  "category_id": "41000000-0000-4000-8000-000000000002",
  "data_source_id": "42000000-0000-4000-8000-000000000001",
  "source_reference": "UPI-SETTLEMENT-8842",
  "amount_paise": "1000000",
  "transaction_date": "2026-11-13",
  "occurred_at": "2026-11-13T11:20:00Z",
  "description": "Part payment from Mehta Stores"
}
```

- **Validation/atomic behavior:** The receivable and account must belong to the path business; the parent invoice must be `ISSUED`. Amount must be positive and no greater than the receivable's current outstanding amount. The source must be active and same-business; optional category must be compatible with `INFLOW`. In one database transaction Express creates a `POSTED` `INFLOW` transaction, creates its receivable allocation for the same amount, and writes audit events. If either insert or an aggregate allocation cap fails, neither record is committed. For a payment split across invoices, record the transaction once and allocate it through the allocation endpoint.
- **Response `201`:**

```json
{
  "data": {
    "transaction": {
      "id": "60000000-0000-4000-8000-000000000021",
      "transaction_type": "INFLOW",
      "cash_direction": "INFLOW",
      "amount_paise": "1000000",
      "record_status": "POSTED"
    },
    "allocation": {
      "id": "71000000-0000-4000-8000-000000000021",
      "receivable_id": "70000000-0000-4000-8000-000000000002",
      "amount_paise": "1000000",
      "outstanding_paise": "1000000"
    }
  },
  "meta": {
    "request_id": "req_01JCSENTINEL00000000000032"
  }
}
```

- **Statuses/errors:** `201`, `400`, `401`, `403`, `404`, `409` (`ALLOCATION_LIMIT_EXCEEDED`, duplicate source/idempotency key, or document state conflict), `422`, `429`, `500`.

#### `POST /api/v1/businesses/{business_id}/suppliers`

- **Request:** `{"display_name":"Deccan Wholesale","external_reference":"SUP-01","record_status":"ACTIVE"}`. `record_status` is server-defaulted to `ACTIVE`; clients may omit it.
- **Validation:** `display_name` required; external reference unique per business when supplied.
- **Response `201`:** Supplier projection with `id`, `display_name`, `external_reference`, `record_status`, `created_at`, and `updated_at`.
- **Statuses/errors:** `201`, `401`, `403`, `404`, `409`, `422`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/suppliers`

- **Query/body:** Optional `record_status`, pagination; no body.
- **Response `200`:** Paginated supplier projections.
- **Statuses/errors:** `200`, `400`, `401`, `404`, `429`, `500`.

#### `POST /api/v1/businesses/{business_id}/supplier-bills`

- **Purpose:** Create a draft bill; requires `Idempotency-Key`.
- **Request:**

```json
{
  "supplier_id": "31000000-0000-4000-8000-000000000001",
  "bill_number": "DW-884",
  "bill_date": "2026-11-10",
  "due_date": "2026-11-18",
  "total_paise": "4800000",
  "external_reference": null
}
```

- **Validation:** Supplier same-business; `due_date >= bill_date`; positive paise; bill number unique per business. New bill is `DRAFT`, with no payable yet.
- **Response `201`:** Bill projection with `bill_status:"DRAFT"` and the submitted fields plus IDs/timestamps.
- **Statuses/errors:** `201`, `401`, `403`, `404`, `409`, `422`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/supplier-bills`

- **Query:** `supplier_id`, `bill_status`, date range, pagination.
- **Response `200`:** Paginated bill projections; received bills may include associated payable and derived `outstanding_paise`.
- **Statuses/errors:** `200`, `400`, `401`, `404`, `422`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/supplier-bills/{bill_id}`

- **Response `200`:** One bill projection plus payable, if created, and derived outstanding amount.
- **Statuses/errors:** `200`, `401`, `404`, `429`, `500`.

#### `POST /api/v1/businesses/{business_id}/supplier-bills/{bill_id}/receive`

- **Purpose:** Mark a draft bill `RECEIVED` and create its payable atomically; requires `Idempotency-Key`.
- **Request:** `{"expected_payment_date":"2026-11-18","expected_date_source":"CONTRACT_DUE","expected_certainty":"CONFIRMED"}`.
- **Validation:** Bill must be `DRAFT`; schema enums enforced; same-business supplier; total is not editable here.
- **Response `200`:** Bill `RECEIVED` with its payable ID, expected payment date/source/certainty, `payment_state:"OPEN"`, and `outstanding_paise` equal to bill total.
- **Statuses/errors:** `200`, `401`, `403`, `404`, `409` (already received/void), `422`, `429`, `500`.

#### `POST /api/v1/businesses/{business_id}/supplier-bills/{bill_id}/void`

- **Purpose/request:** Void an unallocated bill with `{"reason":"Duplicate supplier bill"}`; cancel an unallocated payable in the same transaction.
- **Validation:** Reject while allocations remain; never edit a received bill total.
- **Response `200`:** Bill `VOID`; payable `CANCELLED` when one exists.
- **Statuses/errors:** `200`, `401`, `403`, `404`, `409`, `422`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/payables`

- **Query:** `payment_state`, `supplier_id`, `due_from`, `due_to`, expected-date range, `overdue`, pagination.
- **Response `200`:** Paginated payable projection with `id`, `bill_id`, expected payment metadata, `payment_state`, and derived `outstanding_paise`.
- **Statuses/errors:** `200`, `400`, `401`, `404`, `422`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/payables/{payable_id}`

- **Response `200`:** Payable projection plus bill number/due date, valid allocation summaries, and derived outstanding amount.
- **Statuses/errors:** `200`, `401`, `404`, `429`, `500`.

#### `PATCH /api/v1/businesses/{business_id}/payables/{payable_id}`

- **Request:** Any non-empty subset of `expected_payment_date`, `expected_date_source`, `expected_certainty`, `payment_state`.
- **Validation:** Lifecycle rules apply; cannot cancel with allocations. No client-supplied outstanding amount or bill ID.
- **Response `200`:** Updated payable projection and derived outstanding amount.
- **Statuses/errors:** `200`, `401`, `403`, `404`, `409`, `422`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/payables/{payable_id}/allocations`

- **Response `200`:** List allocation rows with `id`, `transaction_id`, `amount_paise`, `allocated_at`, `created_at`.
- **Statuses/errors:** `200`, `401`, `404`, `429`, `500`.

#### `POST /api/v1/businesses/{business_id}/payables/{payable_id}/allocations`

- **Purpose:** Apply a posted actual supplier payment, including partial payments; requires `Idempotency-Key`.
- **Request:** `{"transaction_id":"60000000-0000-4000-8000-000000000002","amount_paise":"2000000"}`.
- **Validation:** Same-business posted `OUTFLOW`; bill `RECEIVED`; eligible payable; positive amount; combined allocation caps enforced across both allocation tables. Ordinary API cannot delete or update an allocation.
- **Response `201`:** Payable allocation projection and computed remaining `outstanding_paise`.
- **Statuses/errors:** `201`, `401`, `403`, `404`, `409` (`ALLOCATION_LIMIT_EXCEEDED` or state conflict), `422`, `429`, `500`.

#### `POST /api/v1/businesses/{business_id}/payables/{payable_id}/payments`

- **Purpose/auth/context:** Record an actual supplier payment and allocate it to this payable atomically; requires active business membership and `Idempotency-Key`.
- **Path/query:** Business and payable UUIDs; no query parameters.
- **Request:**

```json
{
  "account_id": "50000000-0000-4000-8000-000000000001",
  "category_id": "41000000-0000-4000-8000-000000000003",
  "data_source_id": "42000000-0000-4000-8000-000000000001",
  "source_reference": "BANK-UTR-90371",
  "amount_paise": "2000000",
  "transaction_date": "2026-11-17",
  "occurred_at": "2026-11-17T09:30:00Z",
  "description": "Part payment to Deccan Wholesale"
}
```

- **Validation/atomic behavior:** The payable and account must belong to the path business; the parent bill must be `RECEIVED`. Amount must be positive and no greater than the payable's current outstanding amount. The source must be active and same-business; optional category must be compatible with `OUTFLOW`. In one database transaction Express creates a `POSTED` `OUTFLOW` transaction, creates its payable allocation for the same amount, and writes audit events. Aggregate allocation caps apply across both allocation tables. If any validation or insert fails, neither record is committed. For a payment split across bills, record the transaction once and allocate it through the allocation endpoint.
- **Response `201`:**

```json
{
  "data": {
    "transaction": {
      "id": "60000000-0000-4000-8000-000000000022",
      "transaction_type": "OUTFLOW",
      "cash_direction": "OUTFLOW",
      "amount_paise": "2000000",
      "record_status": "POSTED"
    },
    "allocation": {
      "id": "72000000-0000-4000-8000-000000000021",
      "payable_id": "73000000-0000-4000-8000-000000000001",
      "amount_paise": "2000000",
      "outstanding_paise": "800000"
    }
  },
  "meta": {
    "request_id": "req_01JCSENTINEL00000000000039"
  }
}
```

- **Statuses/errors:** `201`, `400`, `401`, `403`, `404`, `409` (`ALLOCATION_LIMIT_EXCEEDED`, duplicate source/idempotency key, or document state conflict), `422`, `429`, `500`.

### 3.7 Recurring cash flows

#### `POST /api/v1/businesses/{business_id}/recurring-items`

- **Purpose:** Create a recurring expected movement; requires `Idempotency-Key`.
- **Request:**

```json
{
  "category_id": "41000000-0000-4000-8000-000000000003",
  "counterparty_type": "OTHER",
  "customer_id": null,
  "supplier_id": null,
  "direction": "OUTFLOW",
  "description": "Shop rent",
  "amount_paise": "1800000",
  "recurrence": "MONTHLY",
  "interval_count": 1,
  "day_of_month": 21,
  "start_date": "2026-11-21",
  "end_date": null,
  "next_due_date": "2026-11-21"
}
```

- **Validation:** Customer requires `INFLOW` and matching `customer_id`; supplier requires `OUTFLOW` and matching `supplier_id`; `OTHER` requires both IDs null and allows either direction. Category and counterparty IDs must be same-business. Amount/interval positive; date consistency and recurrence rules enforced.
- **Response `201`:** Recurring item projection with `schedule_status:"ACTIVE"` and timestamps.
- **Statuses/errors:** `201`, `401`, `403`, `404`, `409`, `422`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/recurring-items`

- **Query/body:** `schedule_status`, `direction`, pagination; no body.
- **Response `200`:** Paginated recurring item projections.
- **Statuses/errors:** `200`, `400`, `401`, `404`, `429`, `500`.

#### `PATCH /api/v1/businesses/{business_id}/recurring-items/{recurring_item_id}`

- **Purpose:** Manage future schedule settings; existing occurrences remain historical snapshots.
- **Request:** Non-empty allowed subset of `category_id`, `counterparty_type`, `customer_id`, `supplier_id`, `direction`, `description`, `amount_paise`, `recurrence`, `interval_count`, `day_of_month`, `start_date`, `end_date`, `next_due_date`, `schedule_status`.
- **Validation:** Reapply mapping and date rules; no business reassignment. Changes do not rewrite settled occurrences.
- **Response `200`:** Updated recurring item projection.
- **Statuses/errors:** `200`, `401`, `403`, `404`, `409`, `422`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/recurring-occurrences`

- **Query:** `recurring_item_id`, `from_date`, `to_date`, `occurrence_status`, pagination.
- **Response `200`:**

```json
{
  "data": [
    {
      "id": "90000000-0000-4000-8000-000000000001",
      "recurring_item_id": "91000000-0000-4000-8000-000000000001",
      "period_key": "2026-11-21",
      "expected_date": "2026-11-21",
      "expected_amount_paise": "1800000",
      "certainty": "ESTIMATED",
      "occurrence_status": "PLANNED",
      "actual_transaction_id": null
    }
  ],
  "meta": {
    "request_id": "req_01JCSENTINEL00000000000024",
    "pagination": {
      "next_cursor": null,
      "page_size": 50
    }
  }
}
```

- **Statuses/errors:** `200`, `400`, `401`, `404`, `422`, `429`, `500`.

#### `PATCH /api/v1/businesses/{business_id}/recurring-occurrences/{occurrence_id}`

- **Purpose:** Correct or skip an unlinked occurrence.
- **Request:** Non-empty subset of `expected_date`, `expected_amount_paise`, `certainty`, or `occurrence_status` (`PLANNED`, `CONFIRMED`, `SKIPPED`, `CANCELLED` only).
- **Validation:** `SETTLED` and `actual_transaction_id` cannot be set here; only the reconcile endpoint may set both. This row's CHECK requires a null transaction link for non-settled states.
- **Response `200`:** Updated occurrence projection.
- **Statuses/errors:** `200`, `401`, `403`, `404`, `409`, `422`, `429`, `500`.

#### `POST /api/v1/businesses/{business_id}/recurring-occurrences/{occurrence_id}/reconcile`

- **Purpose:** Link one occurrence to an existing actual transaction and settle it atomically; requires `Idempotency-Key`.
- **Request:** `{"actual_transaction_id":"60000000-0000-4000-8000-000000000002"}`.
- **Validation:** Same-business posted transaction, correct direction, no reversal/transfer, no other occurrence link, and compatible allocations/counterparty. Express sets the transaction link and `occurrence_status:"SETTLED"` in one statement/transaction. The event is no longer projected as expected movement.
- **Response `200`:** Occurrence projection with `occurrence_status:"SETTLED"` and the transaction ID.
- **Statuses/errors:** `200`, `401`, `403`, `404`, `409`, `422`, `429`, `500`.

### 3.8 Forecasting, alerts, and evidence

#### `POST /api/v1/businesses/{business_id}/forecasts`

- **Purpose/auth/context:** Request a synchronous forecast for a member; requires `Idempotency-Key`.
- **Request:**

```json
{
  "horizon_days": 30
}
```

- **Validation:** MVP accepts `1..30`; longer horizons are deferred despite future schema capacity. Express selects the latest eligible snapshot per account and server cutoff; clients cannot submit opening balances or mark predictions confirmed.
- **Response `201`:**

```json
{
  "data": {
    "id": "a0000000-0000-4000-8000-000000000001",
    "run_status": "SUCCEEDED",
    "requested_at": "2026-11-13T12:00:00Z",
    "completed_at": "2026-11-13T12:00:02Z",
    "as_of_at": "2026-11-13T18:29:59Z",
    "business_as_of_date": "2026-11-13",
    "opening_confirmed_paise": "7000000",
    "opening_estimated_paise": "0",
    "horizon_days": 30,
    "method_name": "DETERMINISTIC_ROLL_FORWARD",
    "method_version": "1.0",
    "service_version": "1.0.0",
    "data_quality": "SUFFICIENT",
    "failure_code": null,
    "point_count": 30
  },
  "meta": {
    "request_id": "req_01JCSENTINEL00000000000025"
  }
}
```

- **Failure behavior:** Express creates a run and moves it to `RUNNING`, then sends analytics input. Any analytics, validation, or persistence failure marks it `FAILED` with a safe `failure_code`; no partial successful result is exposed. Timeout returns `504`, service unavailable returns `503`, includes the failed run ID where available, and never returns an empty forecast as success.
- **Statuses/errors:** `201`, `400`, `401`, `403`, `404`, `409`, `422`, `429`, `503`, `504`, `500`.

#### `GET /api/v1/businesses/{business_id}/forecasts`

- **Query:** `run_status`, `from_requested_at`, `to_requested_at`, `page_size`, `cursor`.
- **Response `200`:** Paginated forecast-run metadata projections (same fields as above; no `input_snapshot` or digest payload).
- **Statuses/errors:** `200`, `400`, `401`, `404`, `422`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/forecasts/{forecast_run_id}`

- **Response `200`:** One run metadata projection. A non-successful run returns status and safe failure code; results are available only for `SUCCEEDED`.
- **Statuses/errors:** `200`, `401`, `404`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/forecasts/{forecast_run_id}/points`

- **Query:** Optional `from_date`, `to_date`, `page_size`, `cursor`; default all points for this run.
- **Response `200`:**

```json
{
  "data": [
    {
      "forecast_date": "2026-11-21",
      "confirmed_inflow_paise": "0",
      "confirmed_outflow_paise": "0",
      "estimated_inflow_paise": "0",
      "estimated_outflow_paise": "1800000",
      "predicted_inflow_paise": "0",
      "predicted_outflow_paise": "0",
      "closing_confirmed_paise": "2200000",
      "closing_with_estimates_paise": "400000",
      "closing_predicted_paise": "400000",
      "predicted_low_paise": null,
      "predicted_high_paise": null,
      "uncertainty_band": "MEDIUM"
    }
  ],
  "meta": {
    "request_id": "req_01JCSENTINEL00000000000026",
    "pagination": {
      "next_cursor": null,
      "page_size": 50
    }
  }
}
```

- **Validation:** Only successful runs return points; a successful run contains exactly `horizon_days` consecutive dates beginning the day after `business_as_of_date`. Confirmed, estimated, and predicted residual amounts remain separate. Predicted columns are residual adjustments, not duplicated estimates.
- **Statuses/errors:** `200`, `400`, `401`, `404`, `409` (`RUN_NOT_SUCCEEDED`), `422`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/alerts`

- **Query:** `forecast_run_id`, `status`, `alert_type`, `severity`, `projected_from`, `projected_to`, pagination.
- **Response `200`:**

```json
{
  "data": [
    {
      "id": "a1000000-0000-4000-8000-000000000001",
      "forecast_run_id": "a0000000-0000-4000-8000-000000000001",
      "alert_type": "CASH_BUFFER_BREACH",
      "severity": "WARNING",
      "status": "OPEN",
      "projected_date": "2026-11-21",
      "threshold_paise": "1500000",
      "projected_balance_paise": "400000",
      "deduplication_key": "BUFFER:2026-11-21",
      "title": "Cash may fall below your operating buffer",
      "explanation": "The expected rent and supplier payment leave projected cash below the configured buffer.",
      "created_at": "2026-11-13T12:00:02Z"
    }
  ],
  "meta": {
    "request_id": "req_01JCSENTINEL00000000000027",
    "pagination": {
      "next_cursor": null,
      "page_size": 50
    }
  }
}
```

- **Statuses/errors:** `200`, `400`, `401`, `404`, `422`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/alerts/{alert_id}`

- **Purpose/auth/context:** Retrieve one tenant-scoped alert and its forecast-run metadata.
- **Path/query:** Business and alert UUIDs; no query parameters or request body.
- **Response `200`:** One alert projection with the same fields as the alert list example, plus `acknowledged_at` and `resolved_at`.
- **Statuses/errors:** `200`, `401`, `404`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/alerts/{alert_id}/evidence`

- **Purpose:** Retrieve same-run evidence for a warning.
- **Response `200`:** Evidence rows with `id`, `analysis_evidence_id`, `contribution_paise`, and `contribution_role`, plus a safe evidence projection containing `evidence_kind`, `certainty`, `movement_date`, `direction`, `amount_paise`, and `label_snapshot`. Evidence links must match the alert's `forecast_run_id`; no unrelated source fields are returned.
- **Statuses/errors:** `200`, `401`, `404`, `429`, `500`.

#### `PATCH /api/v1/businesses/{business_id}/alerts/{alert_id}/disposition`

- **Purpose:** Update only the owner workflow disposition; analytical fields/evidence are immutable after forecast success.
- **Request:** `{"action":"ACKNOWLEDGE"}`; actions are `ACKNOWLEDGE`, `RESOLVE`, or `DISMISS`.
- **Validation:** Update status and corresponding `acknowledged_at`/`resolved_at` as allowed; record an audit event. Does not edit alert explanation, threshold, date, or evidence.
- **Response `200`:** Alert projection with updated `status`, timestamps, and unchanged analytical fields.
- **Statuses/errors:** `200`, `401`, `403`, `404`, `409`, `422`, `429`, `500`.

### 3.9 What-If simulations

#### `POST /api/v1/businesses/{business_id}/simulations`

- **Purpose:** Calculate and optionally persist a scenario against a successful baseline; requires `Idempotency-Key`.
- **Request:**

```json
{
  "baseline_forecast_run_id": "a0000000-0000-4000-8000-000000000001",
  "name": "Collect Mehta Stores before rent",
  "assumptions": [
    {
      "assumption_type": "EARLIER_RECEIPT",
      "target_receivable_id": "70000000-0000-4000-8000-000000000002",
      "target_payable_id": null,
      "target_recurring_occurrence_id": null,
      "amount_delta_paise": null,
      "date_override": "2026-11-19",
      "assumption_label": "Receipt arrives before rent",
      "assumption_snapshot": {}
    }
  ]
}
```

- **Validation:** Baseline is `SUCCEEDED` and same-business. At most one target ID per assumption; target must belong to business. A targetless `MANUAL_CASH_MOVEMENT` must specify direction and amount in `assumption_snapshot` (an explicit v1 payload decision because the schema has no dedicated direction column). Scenario is hypothetical; it must not write ledger entities. FastAPI receives only baseline points and assumptions from Express.
- **Response `201`:**

```json
{
  "data": {
    "id": "a2000000-0000-4000-8000-000000000001",
    "baseline_forecast_run_id": "a0000000-0000-4000-8000-000000000001",
    "name": "Collect Mehta Stores before rent",
    "status": "CALCULATED",
    "input_snapshot_sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "assumptions": [
      {
        "id": "a2100000-0000-4000-8000-000000000001",
        "assumption_type": "EARLIER_RECEIPT",
        "target_receivable_id": "70000000-0000-4000-8000-000000000002",
        "target_payable_id": null,
        "target_recurring_occurrence_id": null,
        "amount_delta_paise": null,
        "date_override": "2026-11-19",
        "assumption_label": "Receipt arrives before rent"
      }
    ],
    "points": [
      {
        "forecast_date": "2026-11-21",
        "baseline_closing_paise": "400000",
        "scenario_closing_paise": "2400000",
        "difference_paise": "2000000",
        "buffer_breached": false
      }
    ],
    "hypothetical": true
  },
  "meta": {
    "request_id": "req_01JCSENTINEL00000000000028"
  }
}
```

- **Statuses/errors:** `201`, `400`, `401`, `403`, `404`, `409`, `422`, `429`, `503`, `504`, `500`.

#### `GET /api/v1/businesses/{business_id}/simulations`

- **Query:** `baseline_forecast_run_id`, `status`, pagination. Archived simulations are excluded unless `status=ARCHIVED` is requested.
- **Response `200`:** Paginated simulation summaries with `id`, baseline run, name, `status`, `input_snapshot_sha256`, `created_at`, and `updated_at`.
- **Statuses/errors:** `200`, `400`, `401`, `404`, `422`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/simulations/{simulation_id}`

- **Response `200`:** Simulation summary, its `scenario_assumptions`, and `simulation_points`; all outputs are marked `hypothetical:true`.
- **Statuses/errors:** `200`, `401`, `404`, `429`, `500`.

#### `DELETE /api/v1/businesses/{business_id}/simulations/{simulation_id}`

- **Purpose/auth/context:** Remove a saved simulation from the default active list; requires the simulation creator or a business owner/admin.
- **Path/query:** Business and simulation UUIDs; no query parameters or request body.
- **Behavior/design decision:** V1 uses a logical delete: eligible `DRAFT` or `CALCULATED` simulations transition to the schema's `ARCHIVED` status. The simulation, assumptions, and hypothetical points are retained for audit/reproducibility; no transaction, forecast, invoice, or balance is deleted or modified. The transition and actor are audited. Repeating DELETE for an already archived simulation returns the same `200` archived representation without another state change or audit event.
- **Response `200`:** `{"data":{"id":"a2000000-0000-4000-8000-000000000001","status":"ARCHIVED"},"meta":{"request_id":"req_01JCSENTINEL00000000000035"}}`
- **Statuses/errors:** `200`, `401`, `403`, `404`, `409` (concurrent lifecycle conflict), `429`, `500`.

### 3.10 Recommendations and financial health

#### `GET /api/v1/businesses/{business_id}/recommendations`

- **Query:** `forecast_run_id`, `status`, `page_size`, `cursor`.
- **Response `200`:** Paginated recommendation projections with `id`, `forecast_run_id`, `alert_id`, `rule_id`, `rule_version`, `rank`, `title`, `explanation`, `expected_effect_paise`, `suggested_by_date`, `uncertainty_band`, and `status`.
- **Statuses/errors:** `200`, `400`, `401`, `404`, `422`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/recommendations/{recommendation_id}`

- **Response `200`:** One recommendation projection plus same-run supporting evidence references and safe labels. Numerical effects are derived from persisted evidence, not generated text.
- **Statuses/errors:** `200`, `401`, `404`, `429`, `500`.

#### `PATCH /api/v1/businesses/{business_id}/recommendations/{recommendation_id}/disposition`

- **Request:** `{"status":"USEFUL"}`; permitted values `DISMISSED` or `USEFUL` (returning to `ACTIVE` is not allowed).
- **Validation:** Workflow disposition only; rule, explanation, effect, rank, forecast, and evidence are immutable. Changes are audited.
- **Response `200`:** Updated recommendation projection.
- **Statuses/errors:** `200`, `401`, `403`, `404`, `409`, `422`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/financial-health`

- **Purpose/auth/context:** Retrieve the latest persisted cash-flow health assessment for the authorized business; never a credit score.
- **Path/query:** `business_id` UUID; no query parameters or request body.
- **Selection:** Latest assessment by `assessed_at DESC`, with `id` as a stable tie-breaker. It is returned only after its associated forecast run succeeded.
- **Response `200`:** Same assessment and factor representation as the forecast-specific financial-health response below.
- **Statuses/errors:** `200`, `401`, `404` (`ASSESSMENT_NOT_FOUND`), `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/financial-health/history`

- **Purpose/auth/context:** List prior persisted assessments for the authorized business.
- **Path/query:** `business_id` UUID; optional `page_size`, `cursor`, `from_assessed_at`, and `to_assessed_at`.
- **Response `200`:**

```json
{
  "data": [
    {
      "id": "a3000000-0000-4000-8000-000000000001",
      "forecast_run_id": "a0000000-0000-4000-8000-000000000001",
      "indicator_version": "1.0",
      "score": 62,
      "health_band": "WATCH",
      "input_completeness": "78.50",
      "assessed_at": "2026-11-13T12:00:02Z"
    }
  ],
  "meta": {
    "request_id": "req_01JCSENTINEL00000000000036",
    "pagination": {
      "next_cursor": null,
      "page_size": 50
    }
  }
}
```

- **Validation:** Date/time bounds are UTC instants and inclusive; reject `from_assessed_at > to_assessed_at`. Sort by `assessed_at DESC, id DESC`.
- **Statuses/errors:** `200`, `400`, `401`, `404`, `422`, `429`, `500`.

#### `GET /api/v1/businesses/{business_id}/forecasts/{forecast_run_id}/financial-health`

- **Purpose:** Retrieve the run's operational cash-flow health indicator and factors.
- **Response `200`:**

```json
{
  "data": {
    "id": "a3000000-0000-4000-8000-000000000001",
    "forecast_run_id": "a0000000-0000-4000-8000-000000000001",
    "indicator_version": "1.0",
    "score": 62,
    "health_band": "WATCH",
    "input_completeness": "78.50",
    "explanation": "Near-term buffer coverage is limited by an expected supplier payment.",
    "assessed_at": "2026-11-13T12:00:02Z",
    "factors": [
      {
        "id": "a3100000-0000-4000-8000-000000000001",
        "factor_code": "BUFFER_COVERAGE",
        "measured_value": "0.27",
        "measured_amount_paise": "400000",
        "effect_points": -12,
        "explanation": "The projected low point is below the operating buffer.",
        "evidence_ids": [
          "a1100000-0000-4000-8000-000000000001"
        ]
      }
    ],
    "is_credit_score": false
  },
  "meta": {
    "request_id": "req_01JCSENTINEL00000000000029"
  }
}
```

`is_credit_score` is a response label, not a stored database field. A score may be null with `health_band:"INSUFFICIENT_DATA"` when source data is inadequate. The indicator is never a credit/lending score.

- **Statuses/errors:** `200`, `401`, `404`, `409` (`RUN_NOT_SUCCEEDED` or assessment unavailable), `429`, `500`.

## 4. Private Express-to-FastAPI contract

### 4.1 Internal transport and shared rules

- Only Express can reach FastAPI through a private network and service authentication (`Authorization: Bearer <service-token>`); use TLS unless private transport provides equivalent protection. Rotate service credentials outside source control.
- FastAPI does not receive user JWTs, passwords, database credentials, bank credentials, raw CSVs, or unrestricted database access. It receives only authorized, normalized, minimum-necessary data from Express.
- Internal JSON follows the same snake_case and paise-string rules. All requests include `contract_version:"1"` and `request_id`; business and forecast IDs are opaque UUIDs used for scoping/tracing, not authorization.
- FastAPI validates every request and response independently. Express validates response IDs, dates, amounts, counts, certainty, formulas, and evidence references again before persistence.
- Set a 10-second default deadline for forecast, risk, payment-delay, recommendation-candidate, and health calls and 5 seconds for scenario calls; one bounded retry is allowed only for connection failure before computation. No retry after an ambiguous completed write (FastAPI has no writes). On deadline, Express marks the forecast `FAILED`, returns `504`, and exposes no partial result.
- Internal errors use:

```json
{
  "error": {
    "code": "INVALID_ANALYTICS_INPUT",
    "message": "The analytics request is invalid.",
    "details": [
      {
        "field": "horizon_days",
        "issue": "out_of_range"
      }
    ]
  },
  "request_id": "req_01JCSENTINEL00000000000030"
}
```

Internal error codes: `INVALID_ANALYTICS_INPUT`, `INSUFFICIENT_DATA`, `UNSUPPORTED_HORIZON`, `CALCULATION_FAILED`, `SERVICE_BUSY`, `DEADLINE_EXCEEDED`, `INTERNAL_ERROR`. Do not include source rows or stack traces in an error response.

### 4.2 Forecast computation

#### `POST /internal/v1/forecasts`

- **Caller:** Express forecast orchestrator only.
- **Request schema/example:**

```json
{
  "contract_version": "1",
  "request_id": "req_01JCSENTINEL00000000000031",
  "business_id": "10000000-0000-4000-8000-000000000001",
  "forecast_run_id": "a0000000-0000-4000-8000-000000000001",
  "as_of_at": "2026-11-13T18:29:59Z",
  "business_as_of_date": "2026-11-13",
  "timezone": "Asia/Kolkata",
  "horizon_days": 30,
  "opening_confirmed_paise": "7000000",
  "opening_estimated_paise": "0",
  "minimum_cash_buffer_paise": "1500000",
  "history": [
    {
      "date": "2026-11-12",
      "inflow_paise": "250000",
      "outflow_paise": "110000"
    }
  ],
  "confirmed_movements": [
    {
      "event_id": "73000000-0000-4000-8000-000000000001",
      "source_type": "PAYABLE",
      "date": "2026-11-18",
      "direction": "OUTFLOW",
      "amount_paise": "4800000"
    }
  ],
  "estimated_movements": [
    {
      "event_id": "70000000-0000-4000-8000-000000000002",
      "source_type": "RECEIVABLE",
      "date": "2026-11-24",
      "direction": "INFLOW",
      "amount_paise": "2000000"
    }
  ],
  "prediction_features": {
    "historical_daily_totals": [
      {
        "date": "2026-11-12",
        "inflow_paise": "250000",
        "outflow_paise": "110000"
      }
    ]
  }
}
```

- **Input data:** Express selects the latest eligible account snapshot and rolls forward only posted transactions strictly after its cutoff through `as_of_at`. Transactions already reflected in a snapshot are never sent as future movements. Actual history used for pattern analysis is separately supplied and is not added to opening cash again. Send bounded source identifiers, amounts, dates, source types, certainty, and assumptions; omit unnecessary counterparties/personal data.
- **Validation:** `horizon_days` 1–30 for MVP; dates contiguous and after business as-of date; opening and movement amounts exact signed/positive integer paise as applicable; no future movement duplicates; confirmed/estimated/predicted certainty preserved. Predicted output is a residual adjustment to the estimate case, never a second full estimate.
- **Response `200`:**

```json
{
  "contract_version": "1",
  "request_id": "req_01JCSENTINEL00000000000031",
  "forecast_run_id": "a0000000-0000-4000-8000-000000000001",
  "method_name": "DETERMINISTIC_ROLL_FORWARD",
  "method_version": "1.0",
  "service_version": "1.0.0",
  "data_quality": "SUFFICIENT",
  "points": [
    {
      "forecast_date": "2026-11-18",
      "confirmed_inflow_paise": "0",
      "confirmed_outflow_paise": "4800000",
      "estimated_inflow_paise": "0",
      "estimated_outflow_paise": "0",
      "predicted_inflow_paise": "0",
      "predicted_outflow_paise": "0",
      "closing_confirmed_paise": "2200000",
      "closing_with_estimates_paise": "2200000",
      "closing_predicted_paise": "2200000",
      "predicted_low_paise": null,
      "predicted_high_paise": null,
      "uncertainty_band": "MEDIUM"
    }
  ],
  "evidence": [
    {
      "event_id": "73000000-0000-4000-8000-000000000001",
      "source_type": "PAYABLE",
      "certainty": "CONFIRMED",
      "movement_date": "2026-11-18",
      "direction": "OUTFLOW",
      "amount_paise": "4800000",
      "label_snapshot": "Deccan Wholesale supplier bill",
      "forecast_date": "2026-11-18"
    }
  ]
}
```

- **Response constraints:** Service returns exactly one point per requested local date and no persisted DB IDs beyond the input source IDs. Express creates any required `forecast_points`/`analysis_evidence` UUIDs, validates the equations and range, and later commits all results together.
- **Errors/statuses:** `200`; `400` malformed request; `401/403` invalid internal service identity; `413` oversized; `422` invalid/unsupported data; `429/503` overloaded; `500` calculation failure; `504` deadline.

### 4.3 Risk analysis

#### `POST /internal/v1/risk-analysis`

- **Assignment:** FastAPI calculates explainable cash-buffer alert candidates; Express risk-detection module validates, assigns/persists `risk_alerts` and `alert_evidence`. Customer payment-delay analysis is a separate internal operation.
- **Request schema/example:**

```json
{
  "contract_version": "1",
  "request_id": "req_01JCSENTINEL00000000000032",
  "business_id": "10000000-0000-4000-8000-000000000001",
  "forecast_run_id": "a0000000-0000-4000-8000-000000000001",
  "minimum_cash_buffer_paise": "1500000",
  "points": [
    {
      "forecast_date": "2026-11-21",
      "closing_with_estimates_paise": "400000",
      "closing_predicted_paise": "400000",
      "uncertainty_band": "MEDIUM"
    }
  ],
  "evidence": [
    {
      "analysis_evidence_id": "a1100000-0000-4000-8000-000000000001",
      "forecast_date": "2026-11-21",
      "source_type": "RECURRING_OCCURRENCE",
      "certainty": "ESTIMATED",
      "direction": "OUTFLOW",
      "amount_paise": "1800000",
      "label_snapshot": "Shop rent"
    }
  ]
}
```

- **Validation:** Business/run context supplied by Express; every evidence ID was produced for this run. Compare eligible projected balances with configured buffer; return only cause-linked candidates and do not infer credit risk or certainty from insufficient history.
- **Response `200`:**

```json
{
  "contract_version": "1",
  "request_id": "req_01JCSENTINEL00000000000032",
  "candidates": [
    {
      "alert_type": "CASH_BUFFER_BREACH",
      "severity": "WARNING",
      "projected_date": "2026-11-21",
      "threshold_paise": "1500000",
      "projected_balance_paise": "400000",
      "deduplication_key": "BUFFER:2026-11-21",
      "title": "Cash may fall below your operating buffer",
      "explanation": "Expected rent and supplier commitments place cash below the configured buffer.",
      "evidence": [
        {
          "analysis_evidence_id": "a1100000-0000-4000-8000-000000000001",
          "contribution_paise": "-1800000",
          "contribution_role": "OUTFLOW"
        }
      ]
    }
  ]
}
```

- **Errors/statuses:** Same internal error envelope; `200`, `400`, `401/403`, `413`, `422`, `429/503`, `500`, `504`.

### 4.4 Customer payment-delay analysis

#### `POST /internal/v1/payment-delay-analysis`

- **Caller/assignment:** Express receivables/risk orchestration only. Express derives history from same-business invoices, receivables, allocations, and posted transactions; FastAPI receives normalized observations, not customer names, contacts, full invoice documents, or raw ledger rows. Express maps validated assessments to same-run `analysis_evidence` and, where warranted, `RECEIPT_DELAY_RISK`/`RECEIVABLE_OVERDUE` alerts.
- **Request schema/example:**

```json
{
  "contract_version": "1",
  "request_id": "req_01JCSENTINEL00000000000037",
  "business_id": "10000000-0000-4000-8000-000000000001",
  "forecast_run_id": "a0000000-0000-4000-8000-000000000001",
  "as_of_date": "2026-11-13",
  "receivables": [
    {
      "receivable_id": "70000000-0000-4000-8000-000000000002",
      "customer_id": "30000000-0000-4000-8000-000000000001",
      "due_date": "2026-11-20",
      "expected_collection_date": "2026-11-24",
      "outstanding_paise": "2000000",
      "days_overdue": 0,
      "settled_invoice_delays_days": [2, 4, 6, 4]
    }
  ]
}
```

- **Validation:** The forecast run must be `SUCCEEDED`, belong to the supplied business, and have a `business_as_of_date` matching `as_of_date`. IDs are authorized by Express and scoped to that run. Include only issued invoices with a live receivable and prior invoices fully settled by posted, eligible inflow allocations. `days_overdue` is a non-negative integer as of `as_of_date`; historical delay values are signed whole days from due date to full settlement. Amounts are canonical paise strings. V1 uses at least three prior settled invoices before returning a history-based expected delay; below that threshold return `INSUFFICIENT_HISTORY` without inventing a prediction. This threshold is an explicit MVP assumption, not a database field.
- **Response `200`:**

```json
{
  "contract_version": "1",
  "request_id": "req_01JCSENTINEL00000000000037",
  "forecast_run_id": "a0000000-0000-4000-8000-000000000001",
  "assessments": [
    {
      "receivable_id": "70000000-0000-4000-8000-000000000002",
      "delay_status": "DELAY_RISK",
      "expected_delay_days": 4,
      "estimated_collection_date": "2026-11-24",
      "confidence": "MEDIUM",
      "explanation": "Prior fully settled invoices were paid a median of four days after due date.",
      "evidence": {
        "settled_invoice_count": 4,
        "historical_median_days_late": 4,
        "days_overdue": 0
      }
    }
  ]
}
```

- **Response handling:** Output is an estimate, not a customer credit/risk score or a guarantee. Express validates receivable/run ownership, dates, range, and evidence, maps the result to `PREDICTED` evidence and an allowed uncertainty band, then persists only supported evidence and alert candidates. FastAPI does not persist customer assessments.
- **Errors/statuses:** Same internal error envelope; `200`, `400`, `401/403`, `413`, `422`, `429/503`, `500`, `504`. Insufficient per-customer history is a successful `200` assessment with `delay_status:"INSUFFICIENT_HISTORY"`, not a service error.

### 4.5 Scenario simulation

#### `POST /internal/v1/simulations`

- **Assignment:** FastAPI calculates hypothetical points; Express validates and persists `simulations`, `scenario_assumptions`, and `simulation_points`.
- **Request schema/example:**

```json
{
  "contract_version": "1",
  "request_id": "req_01JCSENTINEL00000000000033",
  "business_id": "10000000-0000-4000-8000-000000000001",
  "baseline_forecast_run_id": "a0000000-0000-4000-8000-000000000001",
  "minimum_cash_buffer_paise": "1500000",
  "baseline_points": [
    {
      "forecast_date": "2026-11-21",
      "closing_paise": "400000"
    }
  ],
  "assumptions": [
    {
      "assumption_type": "EARLIER_RECEIPT",
      "target_id": "70000000-0000-4000-8000-000000000002",
      "target_type": "RECEIVABLE",
      "amount_delta_paise": null,
      "date_override": "2026-11-19",
      "assumption_snapshot": {}
    }
  ]
}
```

- **Validation:** Express verifies the baseline succeeded, target scope, assumption count/range and no duplicate target changes. FastAPI receives only selected baseline points and scenario data; it cannot change the baseline or ledger.
- **Response `200`:**

```json
{
  "contract_version": "1",
  "request_id": "req_01JCSENTINEL00000000000033",
  "baseline_forecast_run_id": "a0000000-0000-4000-8000-000000000001",
  "points": [
    {
      "forecast_date": "2026-11-21",
      "baseline_closing_paise": "400000",
      "scenario_closing_paise": "2400000",
      "difference_paise": "2000000",
      "buffer_breached": false
    }
  ],
  "hypothetical": true
}
```

- **Errors/statuses:** `200`, `400`, `401/403`, `413`, `422`, `429/503`, `500`, `504`.

### 4.6 Financial health computation

#### `POST /internal/v1/financial-health`

- **Assignment:** FastAPI computes deterministic operational health factors from a bounded forecast/evidence summary; Express persists the assessment and factor/evidence join rows. It is not a credit score.
- **Request schema/example:**

```json
{
  "contract_version": "1",
  "request_id": "req_01JCSENTINEL00000000000034",
  "business_id": "10000000-0000-4000-8000-000000000001",
  "forecast_run_id": "a0000000-0000-4000-8000-000000000001",
  "input_completeness": "78.50",
  "minimum_cash_buffer_paise": "1500000",
  "points": [
    {
      "forecast_date": "2026-11-21",
      "closing_with_estimates_paise": "400000",
      "closing_predicted_paise": "400000",
      "uncertainty_band": "MEDIUM"
    }
  ],
  "overdue_receivable_total_paise": "0",
  "near_term_obligations_paise": "6600000",
  "evidence": [
    {
      "analysis_evidence_id": "a1100000-0000-4000-8000-000000000001",
      "forecast_date": "2026-11-21",
      "certainty": "ESTIMATED",
      "amount_paise": "1800000"
    }
  ]
}
```

- **Validation:** Completeness is exact decimal percent in `0..100`; all evidence IDs belong to the specified run. If data is insufficient, score is null and band is `INSUFFICIENT_DATA`. No lending/eligibility inference.
- **Response `200`:**

```json
{
  "contract_version": "1",
  "request_id": "req_01JCSENTINEL00000000000034",
  "indicator_version": "1.0",
  "score": 62,
  "health_band": "WATCH",
  "input_completeness": "78.50",
  "explanation": "Near-term buffer coverage is limited by an expected supplier payment.",
  "factors": [
    {
      "factor_code": "BUFFER_COVERAGE",
      "measured_value": "0.27",
      "measured_amount_paise": "400000",
      "effect_points": -12,
      "explanation": "The projected low point is below the operating buffer.",
      "analysis_evidence_ids": [
        "a1100000-0000-4000-8000-000000000001"
      ]
    }
  ]
}
```

- **Errors/statuses:** `200`, `400`, `401/403`, `413`, `422`, `429/503`, `500`, `504`.

### 4.7 Explainable recommendation candidates

#### `POST /internal/v1/recommendation-candidates`

- **Caller/assignment:** Express recommendation orchestration only. Express supplies a bounded list of allowed rule IDs and same-run analytical signals. FastAPI may rank and explain candidates from those inputs; Express remains authoritative for rule allowlisting, numerical effect validation, persisted recommendation creation, and user disposition.
- **Request schema/example:**

```json
{
  "contract_version": "1",
  "request_id": "req_01JCSENTINEL00000000000038",
  "business_id": "10000000-0000-4000-8000-000000000001",
  "forecast_run_id": "a0000000-0000-4000-8000-000000000001",
  "ruleset_version": "1.0",
  "allowed_rule_ids": [
    "CONFIRM_LARGE_RECEIPT"
  ],
  "signals": [
    {
      "signal_type": "CASH_BUFFER_BREACH",
      "forecast_date": "2026-11-21",
      "shortfall_paise": "1100000",
      "evidence_ids": [
        "a1100000-0000-4000-8000-000000000001"
      ],
      "eligible_actions": [
        {
          "action_type": "CONFIRM_RECEIVABLE",
          "target_id": "70000000-0000-4000-8000-000000000002",
          "potential_effect_paise": "2000000",
          "suggested_by_date": "2026-11-18",
          "analysis_evidence_ids": [
            "a1100000-0000-4000-8000-000000000001"
          ]
        }
      ]
    }
  ]
}
```

- **Validation:** Express verifies all signal/evidence IDs belong to the successful forecast run and filters the supplied rule/action allowlist. FastAPI may return only an allowed `rule_id` tied to a supplied eligible action, same-run evidence IDs, exact integer-paise effects when derivable, and dates within the forecast horizon. Explanations use deterministic templates over supplied facts; no LLM is used in the MVP. It must not invent facts, request personal data, initiate an action, or return credit/borrowing advice.
- **Response `200`:**

```json
{
  "contract_version": "1",
  "request_id": "req_01JCSENTINEL00000000000038",
  "forecast_run_id": "a0000000-0000-4000-8000-000000000001",
  "candidates": [
    {
      "rule_id": "CONFIRM_LARGE_RECEIPT",
      "rule_version": "1.0",
      "rank": 1,
      "title": "Confirm the expected customer receipt",
      "explanation": "Confirming the receipt date could clarify whether cash remains below the operating buffer.",
      "expected_effect_paise": null,
      "suggested_by_date": "2026-11-18",
      "uncertainty_band": "MEDIUM",
      "analysis_evidence_ids": [
        "a1100000-0000-4000-8000-000000000001"
      ]
    }
  ]
}
```

- **Response handling:** Candidates are advisory and not guaranteed outcomes. Express rejects unapproved rules, recalculates or verifies numerical effects deterministically, persists `recommendations` and `recommendation_evidence` only after validation, and never executes the suggested action.
- **Errors/statuses:** Same internal error envelope; `200`, `400`, `401/403`, `413`, `422`, `429/503`, `500`, `504`.

### 4.8 Service health

#### `GET /internal/v1/health`

- **Purpose:** Liveness/readiness only; no financial data.
- **Request:** Service-authenticated GET; no body.
- **Response `200`:** `{"status":"ok","service":"cashflow-analytics","version":"1.0.0"}`.
- **Statuses/errors:** `200`, `401/403`, `503` if not ready.

## 5. Forecast lifecycle and persistence boundary

1. Client submits `POST /businesses/{business_id}/forecasts` with a supported horizon.
2. Express authenticates the JWT and checks active membership. The path business ID is not trusted until authorized.
3. Express loads business-scoped accounts, latest eligible balance snapshots, posted transactions, open receivables/payables, recurring occurrences, categories/provenance needed for evidence, and bounded historical totals.
4. Express chooses one snapshot per account and the exact `as_of_at` / `business_as_of_date`. It excludes movements already represented by the snapshot and adds only later posted transactions through the cutoff once. It creates a `forecast_runs` row in `REQUESTED`, then `RUNNING`, with input snapshot/digest, method metadata, horizon, cutoff, openings, and requester.
5. Express sends the normalized input to FastAPI. No raw file, credentials, unrestricted query, or browser request is forwarded.
6. FastAPI validates and computes the full date series, movement buckets, close balances, uncertainty and evidence source snapshots.
7. Express validates the service version/shape, full contiguous horizon, non-negative movement magnitudes, integer-paise totals, certainty classification, opening and cumulative formulas, and evidence source ownership. It requests cash-crunch, payment-delay, health, and recommendation candidates from FastAPI. The Express recommendation module applies its allowlisted deterministic rules and verifies every candidate and effect before persistence.
8. In one final PostgreSQL transaction, Express inserts all points, analysis evidence, alerts/evidence, recommendations/evidence, health assessment/factors/evidence, and changes the run to `SUCCEEDED` with `completed_at`. A deferred database check verifies exact point count/date coverage. If this transaction fails, it rolls back all analytical result rows.
9. Any failure after run creation marks the run `FAILED`, sets `completed_at` and a safe `failure_code`, and returns a retryable error where appropriate. No partial result is represented as a successful run. Recalculation creates a new run; successful runs and analytical results are immutable.

The API returns only persisted successful results. Confirmed, estimated, and predicted movements remain distinct; predicted amounts are residual adjustments from the estimate case, not duplicate estimated cash movements.

## 6. Simulation isolation

- Public simulation creation requires a successful same-business baseline forecast.
- Each hypothetical assumption is stored in `scenario_assumptions`; calculated daily results are stored in `simulation_points`.
- `simulation_points` are always labeled `hypothetical:true` in responses.
- Scenarios never create/update transactions, allocations, invoices, bills, recurring commitments, or the baseline forecast.
- A scenario failure returns a dependency error and persists no `CALCULATED` result. The public API returns no success-shaped empty scenario.

## 7. Canonical resource projections and validation notes

The public routes intentionally omit private/internal columns unless needed:

| Schema resource | Public projection notes |
|---|---|
| `users` | `id`, `email`, `display_name`, `email_verified_at`, `account_status`, timestamps; never `password_hash`. |
| `businesses` | Business profile, `currency_code`, `timezone`, `minimum_cash_buffer_paise`, status, timestamps. |
| `business_memberships` | Membership ID, user ID, role/status, inviter, timestamps; no invitation-management mutation in MVP. |
| `accounts` | Account type/name/institution/currency/active state; IDs and timestamps. |
| `account_balance_snapshots` | Snapshot ID/type, signed balance, cutoff, certainty, source ID, created time. Snapshot rows are append-only. |
| `transactions` | Schema fields including type/direction, amount, dates, source/category/account, status and reversal reference. Actual transactions only. |
| `sales_invoices` / `supplier_bills` | Document fields and lifecycle state. Totals immutable in place after issue/receipt; corrections use audited void/replace. |
| `receivables` / `payables` | Schema fields plus `outstanding_paise` as a derived response value (`document total - valid allocations`); not stored as a writable column. |
| Payment allocations | Allocation ID, target ID, transaction ID, amount, allocation/creation times. No delete route; reversal details persist in `audit_events`. |
| `recurring_items` / `recurring_occurrences` | Schedule and expected-movement fields; `SETTLED` iff actual transaction ID is present. |
| `forecast_runs` | Public metadata and status; do not expose full input snapshot or hash by default. |
| `forecast_points` | Daily movements, closes, optional interval, uncertainty. Actual history is not republished as future movement. |
| `analysis_evidence` | Safe labels, source kind, certainty, movement and amount fields; same-run links only. Sensitive snapshots are not returned wholesale. |
| `risk_alerts` / `alert_evidence` | Alert analytical fields, owner workflow status, and same-run evidence contribution. |
| `simulations` / `scenario_assumptions` / `simulation_points` | Hypothetical inputs/results only; assumptions do not alter source ledger resources. |
| `recommendations` / evidence | Versioned deterministic rule, explanation, timing/effect/uncertainty, disposition, same-run evidence. |
| Financial health tables | Score/band/completeness and explanatory factors/evidence; never creditworthiness. |
| `audit_events` | Written by Express; no general public read endpoint in V1. Only a scoped owner/admin audit export may be added after a separate access/retention decision. |

## 8. Endpoint-to-implementation mapping

### 8.1 Public endpoint to Express module and database tables

| Endpoint group | Express module | Primary tables |
|---|---|---|
| `/auth/*` | `auth` | `users`; audit events for security actions. |
| `/businesses*`, `/memberships` | `businesses` | `businesses`, `business_memberships`, `data_sources` (business setup). |
| `/transaction-categories`, `/data-sources` | `businesses` / `transactions` | `transaction_categories`, `data_sources`. |
| `/accounts`, `/balances`, `/balance-snapshots` | `cashflow` | `accounts`, `account_balance_snapshots`, `transactions`. |
| `/transactions*`, `/transfers` | `transactions` | `transactions`, `transaction_categories`, `data_sources`, `accounts`, `transaction_transfers`, `audit_events`. |
| `/imports*` | `transactions` / import workflow | `import_batches`, `import_rows`, `transactions`, `data_sources`, `audit_events`. |
| `/customers*`, `/sales-invoices*`, `/receivables*` including `/payments` and `/allocations` | `receivables` | `customers`, `sales_invoices`, `receivables`, `receivable_payment_allocations`, `transactions`, `audit_events`. |
| `/suppliers*`, `/supplier-bills*`, `/payables*` including `/payments` and `/allocations` | `receivables` (payables submodule) | `suppliers`, `supplier_bills`, `payables`, `payable_payment_allocations`, `transactions`, `audit_events`. |
| `/recurring-items*`, `/recurring-occurrences*` | `cashflow` | `recurring_items`, `recurring_occurrences`, `transactions`, relevant allocation tables, `audit_events`. |
| `/forecasts*`, `/points` | `cashflow` / forecast orchestration | `account_balance_snapshots`, `transactions`, `receivables`, `payables`, `recurring_occurrences`, `forecast_runs`, `forecast_points`, `analysis_evidence`. |
| `/alerts*` | `risk-detection` | `risk_alerts`, `alert_evidence`, `analysis_evidence`, `forecast_points`, `audit_events`. |
| `/simulations*` | `simulations` | `simulations`, `scenario_assumptions`, `simulation_points`, baseline `forecast_runs`/`forecast_points`. |
| `/recommendations*` | `recommendations` | `recommendations`, `recommendation_evidence`, `analysis_evidence`, optional `risk_alerts`, `audit_events`. |
| `/financial-health`, `/financial-health/history`, and forecast-specific health | `businesses` / analytics orchestration | `financial_health_assessments`, `health_assessment_factors`, `health_factor_evidence`, `analysis_evidence`, `forecast_runs`. |

### 8.2 Express-to-FastAPI service mapping

| Internal route | Express caller | Purpose |
|---|---|---|
| `POST /internal/v1/forecasts` | Forecast orchestration | Deterministic roll-forward and supported prediction residuals; returns daily points/evidence. |
| `POST /internal/v1/risk-analysis` | Risk detection | Cash-buffer candidates with evidence references; Express persists alerts. |
| `POST /internal/v1/payment-delay-analysis` | Receivables/risk orchestration | Customer-specific expected delay signals derived from scoped settled-invoice history; Express persists evidence/alerts. |
| `POST /internal/v1/simulations` | Simulation module | Hypothetical comparison against supplied baseline points. |
| `POST /internal/v1/financial-health` | Forecast/health orchestration | Deterministic operational score/factors; Express persists them. |
| `POST /internal/v1/recommendation-candidates` | Recommendation module | Ranks constrained, evidence-linked candidates; Express validates and persists final recommendations. |
| `GET /internal/v1/health` | Deployment/readiness probe | No financial or tenant data. |

### 8.3 MVP status and dependency order

| Capability | V1 status | Dependencies |
|---|---|---|
| Registration/login/current user/logout | Essential | `users`, JWT configuration, request/error middleware. |
| Business create/list/details/settings | Essential | Auth, memberships, tenant repository scope. |
| Account and opening balance | Essential | Business, accounts, snapshots, exact-money validation. |
| Manual transactions, paired transfers, and reversals | Essential | Accounts, categories/sources, audit and allocation reversal workflow. |
| Eligible transaction metadata correction | Essential | Transaction lifecycle checks, category-direction validation, and audit event. Amount/date/account/type/direction corrections use reversal and replacement. |
| CSV upload/preview/confirm | Essential | Data source, parser, import rows, transactions, idempotency limitation. |
| Customers/invoices/receivables, supplier bills/payables, and atomic payment recording/allocation | Essential | Tenant scope, document lifecycle, transaction/allocation caps and audit transactions. |
| Recurring items/reconciliation | Essential | Transaction lifecycle and occurrence status/link invariant. |
| 30-day forecast, daily points, cash-crunch and payment-delay alerts/evidence | Essential | Usable snapshots, transaction/obligation data, settled-invoice history, private FastAPI client, immutable persistence. |
| What-If simulation, saved results, and archive/delete action | Essential core feature | A successful baseline forecast and isolated scenario service; DELETE archives eligible results without erasing history. |
| Rule-based recommendations and latest/history health indicator | Essential core feature | Forecast, same-run evidence, rule versioning and insufficient-data path. |
| Membership invitations/role editing | Deferred | Blueprint MVP is single-owner; schema supports membership status/roles but invitation flow is not defined. |
| 60/90-day API horizons | Deferred | Product/architecture describe future horizon; MVP schema/API contract uses 1–30 days. |
| Live bank/UPI connections, autonomous collections/payments, credit actions | Out of scope | Explicit product and architecture boundaries. |
| Durable idempotency response replay | Open before production claim | Current schema has no idempotency registry; unique source/import/allocation constraints only cover specific operations. |
| Immediate JWT revocation/refresh sessions | Open follow-up | Current schema has no session/revocation table; v1 tokens expire within 15 minutes. |

### 8.4 Error-code reference

| Code | Meaning and expected client handling |
|---|---|
| `AUTHENTICATION_REQUIRED`, `TOKEN_EXPIRED` | Obtain a valid login token; do not retry the same request until authenticated. |
| `BUSINESS_NOT_FOUND`, `RESOURCE_NOT_FOUND` | Resource is absent or not visible to the authenticated business membership; do not infer cross-tenant existence. |
| `ROLE_REQUIRED` | The caller lacks the role required for the requested operation. |
| `VALIDATION_ERROR`, `IMPORT_VALIDATION_FAILED` | Correct the named field or CSV rows and submit a new request/import. |
| `IDEMPOTENCY_CONFLICT` | The key was reused with a different payload; use a new key only for a genuinely new operation. |
| `STATE_CONFLICT`, `TRANSACTION_NOT_EDITABLE` | Reload current state; financial facts require the documented reversal/replacement workflow. |
| `ALLOCATION_LIMIT_EXCEEDED` | The allocation would exceed transaction, invoice, or bill capacity; reload outstanding and retry only with a valid amount. |
| `INSUFFICIENT_HISTORY` response state (not an error) | Payment-delay analysis found too few settled invoices; the client sees an insufficient-history state rather than a customer risk score. |
| `RUN_NOT_SUCCEEDED`, `ASSESSMENT_NOT_FOUND` | Requested analytical results are unavailable for a failed/running run or because no health assessment exists yet. |
| `ANALYTICS_UNAVAILABLE`, `ANALYTICS_TIMEOUT` | Analytics did not produce a result; use a bounded retry and never treat an empty response as success. |

Recommended implementation dependency order: authentication and tenant middleware → business setup and required source/category lookup → accounts/snapshots, transactions, and paired transfers → CSV import → receivables/payables, atomic payment recording, and allocations → recurring occurrences → forecast orchestration/persistence → cash-crunch/payment-delay risk and health evidence → simulations → recommendation candidates and persisted recommendations. Never bypass database constraints to unblock a dependent module.

## 9. Final consistency checklist

- Browser routes target Express only; FastAPI is private and database-free.
- Business scope is membership-derived for every business endpoint and internal analytics payload.
- API monetary fields use exact paise strings and map to integer `BIGINT`; no floating-point financial amount is accepted.
- Posted transactions alone represent actual movements. Predictions remain forecast residuals.
- Forecast input cutoff, snapshot inclusion, no-double-counting, complete horizon, immutable success, and failed-run handling follow the database schema.
- Occurrence status and transaction link are updated together; a reversal clears the link and restores an unsettled status atomically.
- Allocation deletion is not an ordinary API operation; the controlled reversal workflow preserves allocation details in append-only audit history and recalculates outstanding balances.
- Invoice/bill totals and issue/receive/void transitions preserve database lifecycle protections.
- Simulations do not write to actual transactions, receivables, payables, recurring commitments, or the baseline run.
- Customer/supplier payment convenience routes create a posted transaction and its allocation atomically; allocations for an existing transaction remain separately available.
- Transaction updates are limited to audited descriptive/classification metadata; corrections to financial facts require reversal and replacement.
- Simulation DELETE archives eligible rows rather than erasing historical assumptions or points.
- Payment-delay assessments require sufficient settled-invoice history and never create customer credit/risk scores; recommendation candidates are allowlisted, evidence-linked, and non-executing.
- Open decisions (idempotency replay and immediate JWT revocation) are visible rather than hidden behind invented schema.
