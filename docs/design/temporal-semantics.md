# Financial Temporal Semantics

**Status:** Accepted, 2026-09-13
**Scope:** AIS transaction ingestion, receipt reconciliation, and search freshness

## Decision

Finch keeps financial/effective time separate from Finch system time and search
index time. Reconciliation uses only financial dates; it does not reduce a
historical match's score merely because Finch learned about it long ago.

| Clock | Meaning | Current source | Allowed use |
| --- | --- | --- | --- |
| Transaction booking date | Date the bank posted the entry | `TransactionObserved.bookingDate` -> `transactions.postedDate` | Primary transaction date for receipt matching and reporting |
| Transaction value date | When funds become available/unavailable | `TransactionObserved.valueDate` -> `transactions.valueDate` | Cash-availability reporting; never an implicit replacement for booking date |
| Receipt date | Date printed on the receipt/document | `ReceiptCaptured.receiptDate` -> `receipts.receiptDate` | Receipt-side matching evidence |
| Event occurrence time | When the domain event happened, if the caller supplies it | `events.occurredAt` / event metadata | Event-history analysis only unless a future contract defines a source-time meaning |
| Event record time | When Finch durably accepted the event | `events.recordedAt` / event metadata | Audit, ingestion latency, and replay provenance |
| Transaction observed time | First time Finch recorded the observed transaction projection | `transactions.observedAt = TransactionObserved.recordedAt` | Projection provenance; it is not a transaction date |
| Search document update time | Last projection/index write | `search_documents.updatedAt` | Search-maintenance and explicitly opt-in retrieval freshness only |

`ReceiptCaptured.recordedAt` records when Finch accepted the receipt
capture/import event. It is not the receipt's business date, and the current
receipts projection intentionally does not duplicate it.

## Reconciliation Rules

1. Keep amount and currency as hard gates.
2. Compare `receiptDate` to `postedDate` only when both are present. The
   existing three-calendar-day bonus is matching evidence, not an expiry rule.
3. Do not score against `now`, `recordedAt`, `observedAt`, or
   `search_documents.updatedAt`.
4. A missing date removes only date evidence. It must not invent a date from
   ingestion or index time.
5. A correction, reversal, or deletion remains visible through the event log;
   only currently booked transactions are eligible for automatic matching.

This avoids treating delayed bank feeds, delayed receipt uploads, replays, and
old-but-valid expense evidence as lower quality solely due to processing delay.

## Why

The Open Banking transaction model defines booking date as the date an entry is
posted and says booked entries use the actual booking date; its value date has
a separate funds-availability meaning. It also distinguishes mutable pending
entries from generally immutable booked entries. Finch's Enable Banking adapter
therefore admits only booked entries and maps its `booking_date` and optional
`value_date` without conflating them.

Finch's event store already has the required system-time provenance:
`recordedAt` is generated on append, while `occurredAt` can be supplied by the
caller. Search-document `updatedAt` is written during projection and cannot
state when a financial event occurred.

## Explicit Non-Decision

Do not add age decay, a freshness threshold, or a new temporal schema now.
There is no labelled Finch corpus or product policy that can justify a numeric
weight, horizon, or auto-match threshold. Cerebras' published age-decay
description concerns stale Slack-answer retrieval before rank fusion and does
not establish a financial reconciliation rule.

If product later requires a time-based restriction, define it as a named policy
(for example, an expense-report filing window), evaluate it before matching,
and record the policy version and reason. Do not hide it in a generic ranking
decay.

## Adoption Gates

Add a new source timestamp only when an upstream provider supplies a distinct,
stable transaction-execution time or a receipt capture/import timestamp must be
queried without reading the event log. Preserve it separately from the existing
business dates and `recordedAt`.

Add retrieval freshness only after a measured search evaluation demonstrates a
benefit. It must remain a documented retrieval feature, be based on source
provenance rather than index-write time where possible, and never affect
financial matching or audit history.

Before changing the three-day matching bonus or auto-match threshold, collect
reviewed match outcomes and evaluate precision, recall, false auto-matches, and
unmatched valid receipts by provider and merchant/date-delay cohort.

## Sources

- Open Banking UK, [Transactions v3.1.10](https://openbankinguk.github.io/read-write-api-site3/v3.1.10/resources-and-data-models/aisp/Transactions.html): booking/value-date semantics and transaction mutability.
- Enable Banking, [API reference](https://www.enablebanking.com/docs/api/reference/): transaction responses expose `booking_date`, `value_date`, and `transaction_date`; Finch currently maps the first two.
- Apache Beam, [event time and processing time](https://beam.apache.org/documentation/programming-guide/#event-time): distinct event and processing-time clocks for delayed data.
- Cerebras, [How we built our Knowledge Base](https://www.cerebras.ai/blog/how-we-built-our-knowledge-base): retrieval-age context only; not a financial temporal-policy source.
