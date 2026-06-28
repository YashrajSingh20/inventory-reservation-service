# Location-Based Inventory Reservation Service

> **Live API URL:** `https://inventory-reservation-service.onrender.com`

## 📖 Project Overview
This repository contains a production-quality backend service built with **NestJS, TypeScript, TypeORM, and PostgreSQL**. It is designed to handle multi-location inventory reservations with a strict focus on data integrity, concurrency, and idempotency.

The system ensures that an item is securely reserved from the best possible warehouse before payment, and handles all subsequent state transitions (Success, Failure, Abandonment, and Expiry) without ever overselling or drifting stock numbers.

---

## 🏗 Architecture & Key Decisions

### 1. Concurrency Approach (Row-Level Locking)
To prevent overselling during high-traffic events (e.g., flash sales), this service implements **pessimistic row-level locking** using PostgreSQL's `SELECT ... FOR UPDATE` (`pessimistic_write`).

*   **How it works:** The entire checkout creation occurs within a single `READ COMMITTED` database transaction. Once the system selects an eligible warehouse, it requests an exclusive lock on that specific `Inventory` row. 
*   **Why this was chosen:** While Optimistic Locking (versioning) is common, it forces the application to manually catch `OptimisticLockException` and implement complex retry loops under high contention. Pessimistic locking pushes the queuing mechanism down to the database engine. If two users try to buy the exact same item from the exact same warehouse at the exact same millisecond, the database neatly forces one to wait microseconds for the other to finish, ensuring perfect data integrity without application-level retry loops.
*   **Safety Check:** Because we use `READ COMMITTED` isolation, the stock is re-evaluated *after* the lock is acquired to ensure another transaction didn't steal the stock while this transaction was waiting in the queue.

### 2. Location Selection Logic
When a checkout is initiated, the system must choose a single warehouse capable of fulfilling the entire quantity. It uses a cascading fallback algorithm:

1.  **Service Zone Match (Primary):** The system searches for active locations where the requested delivery pincode exists in the `servicePincodes` array. It uses PostgreSQL's native text array operator (`@>`) for lightning-fast matching. If multiple locations qualify and have stock, it sorts them by the lowest `priority` integer.
2.  **Fallback Chain:** If the primary service zone is out of stock, the system attempts to find the physically closest alternative:
    *   *Preference 1:* Another active location in the **Same City** with stock.
    *   *Preference 2:* Another active location in the **Same State** with stock.
    *   *Preference 3:* **Any** active location with stock.

### 3. Data Model & Invariants
*   **Product:** The catalog item.
*   **Location:** Represents a physical warehouse, holding a `servicePincodes` array and a `priority` tie-breaker.
*   **Inventory:** The join table tracking physical `stock` and active `reserved` quantities.
    *   *Invariant:* Available stock is dynamically computed (`available = stock - reserved`). 
    *   *Backstop:* A database-level `CHECK ("stock" >= "reserved")` constraint guarantees reservations can never mathematically exceed physical stock.
*   **Checkout:** Tracks the state machine (`STARTED`, `RESERVED`, `SUCCEEDED`, `FAILED`, `ABANDONED`, `EXPIRED`).

### 4. Idempotency & Cart Recovery
*   **Idempotency:** Every checkout requires an `Idempotency-Key` header. The system creates a SHA-256 hash of the request payload. If the key is replayed with the same payload, it safely returns the existing checkout. If the payload differs, it rejects the request with a `409 Conflict`.
*   **Cart Recovery (Abandoned Checkouts):** If a payment is marked as `ABANDONED`, the stock is *not* released immediately. Instead, a 15-minute `retryDeadlineAt` is set, acting as a cart-recovery window. A separate cron endpoint (`/checkouts/expire`) must be called to sweep these expired checkouts and officially release the stock back to the shelf.

---

## 🚀 Getting Started

### Prerequisites
*   Node.js v20+
*   Docker and Docker Compose

### Running Locally

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Start the database:**
   ```bash
   docker-compose up -d db
   ```

3. **Start the NestJS application:**
   ```bash
   npm run start:dev
   ```
   The API will be available at `http://localhost:3000`.

---

## 🧪 Testing

The repository includes a comprehensive End-to-End (e2e) test suite that rigorously verifies all invariants, including a stress test firing 10 concurrent checkouts at the exact same millisecond to prove the row-level locking prevents overselling.

Ensure the local Docker database is running, then execute:
```bash
npm run test:e2e
```

---

## 🎮 Bonus: Frontend Playground

A plain HTML/JS frontend is included to easily visualize and test the backend logic (creating products/locations, adding inventory, testing concurrent checkouts, sweeping abandoned carts, and viewing the availability dashboard).

To use it:
1. Ensure the NestJS server is running.
2. Open `playground/index.html` directly in your web browser. *(CORS is enabled on the API to allow this).*