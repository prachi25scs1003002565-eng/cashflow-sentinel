# Cashflow Sentinel

**Intelligent Cash Flow Monitoring and Forecasting Platform**

Cashflow Sentinel is a financial management platform designed to help businesses monitor cash flow, manage financial activities, and gain insights into their financial position through analytics and forecasting.

## Overview

Cashflow Sentinel combines a web-based application, a backend API, a PostgreSQL database, and a Python-based analytics engine.

The project is designed with a modular architecture, separating frontend functionality, backend business logic, database operations, and analytical processing.

## Technology Stack

| Layer | Technologies |
|---|---|
| Frontend | React, Vite, TypeScript |
| Backend | Node.js, Express.js, TypeScript |
| Database | PostgreSQL 18 |
| Analytics Engine | Python, FastAPI |
| API Communication | REST APIs |

## Project Structure

```text
cashflow-sentinel/
│
├── ai-engine/          # Python analytics engine
├── backend/            # Express backend API
├── frontend/           # React frontend
├── database/
│   ├── migrations/     # Database schema migrations
│   └── seeds/          # Demo data
├── docs/
│   ├── api/            # API documentation
│   ├── architecture/   # System architecture
│   ├── database/       # Database documentation
│   └── planning/       # Product blueprint
│
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

## Core Modules

The repository includes modules for:

- User authentication
- Business and account management
- Transactions
- Payables and receivables
- Recurring financial activities
- Data imports
- Cash flow forecasting
- Financial risk analysis
- Payment delay analysis
- Financial recommendations

## Architecture

The application follows a modular architecture:

1. **Frontend:** Provides the user-facing application.
2. **Backend:** Handles API requests, authentication, business logic and database operations.
3. **Database:** PostgreSQL stores application data.
4. **Analytics Engine:** Python services handle analytical and forecasting operations.

## Getting Started

### Prerequisites

Install the following before running the project:

- Node.js and npm
- Python 3
- PostgreSQL 18
- Git

### 1. Clone the repository

```bash
git clone https://github.com/prachi25scs1003002565-eng/cashflow-sentinel.git
cd cashflow-sentinel
```

### 2. Configure environment variables

Copy the example environment file:

```bash
copy .env.example .env
```

Update the local environment variables with your own database credentials and generated secrets.

**Important:** Never commit your actual `.env` file or expose private credentials.

### 3. Install dependencies

Install the dependencies for the root project, backend, frontend and Python analytics engine according to their respective configuration files.

### 4. Configure PostgreSQL

Create and configure your local development database according to the database documentation.

Review the migration instructions before running migrations. Never run development migrations against a database containing data you need to preserve.

### 5. Start the application

Follow the development scripts and startup instructions defined in the root, backend, frontend and AI engine configuration files.

*Exact commands and deployment instructions will be added after local setup verification.*

## Local Demo Data & What-If Simulation Setup

To evaluate real AI cash flow forecasting and interactive What-If simulations immediately without waiting for 14 days of real-time transactions:

1. Ensure services are running (`npm run dev:backend`, `npm run dev:frontend`, `npm run dev:ai`).
2. Seed the isolated demo account with 35 days of compliant history:
   ```bash
   npm run seed:demo
   ```
3. Log in with the dedicated demo credentials:
   - **Email:** `demo.merchant@cashflowsentinel.local`
   - **Password:** `DemoPassword123!`
4. Open `http://localhost:3000` to generate a real 30-day forecast and run What-If simulations.
5. To safely reset the demo account at any time:
   ```bash
   npm run reset:demo
   ```

For detailed specifications, safety assertions, and automated test coverage, see [docs/DEMO_DATA_SETUP.md](file:///c:/Users/prach/Desktop/automation%20works/knockit/cashflow-senitel/cashflow-sentinel/docs/DEMO_DATA_SETUP.md).

## Documentation

Additional project documentation is available in the `docs/` directory:

- System Architecture
- API Contract
- Database Schema
- Product Blueprint

## Security

- Environment variables are excluded from version control.
- Authentication and authorization are handled by the backend.
- Private service credentials should remain server-side.
- Database migrations are maintained separately from application logic.

## Project Status

Under development.

## License

No open-source license has been added yet. All rights reserved unless a license is subsequently specified.
