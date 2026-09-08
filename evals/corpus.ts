export const EVAL_DIMS = 1024
export const EVAL_MODEL = "voyage-finance-2"
export const EVAL_TENANT = "t-eval"

export interface FixtureDoc {
  readonly documentId: string
  readonly content: string
}

// Separable fixture: exact tokens are unique per doc, "groceries" hits only
// the 3 grocery docs (first tripled so BM25 + dense agree on top-1),
// "utilities monthly" hits only the 2 utility docs (first tripled), and the
// semantic queries use paraphrases absent from every doc so the lexical
// channel returns [] unless Voyage dense retrieval surfaces them.
export const EVAL_CORPUS: readonly FixtureDoc[] = [
  {
    documentId: "transaction:tx-continente-weekly",
    content: "Continente groceries groceries groceries EUR 42.80 weekly shop debit card receipt",
  },
  {
    documentId: "transaction:tx-pingo-fresh",
    content: "Pingo Doce groceries EUR 31.15 fresh produce debit receipt",
  },
  {
    documentId: "transaction:tx-aucham-bulk",
    content: "Auchan bulk groceries EUR 88.40 household essentials credit receipt",
  },
  { documentId: "transaction:tx-bp-fuel", content: "BP fuel station petrol EUR 60.00 diesel receipt" },
  {
    documentId: "transaction:tx-galp-charge",
    content: "Galp electric charging EUR 18.75 EV station receipt",
  },
  {
    documentId: "transaction:tx-cp-rail",
    content: "CP train Lisboa Porto EUR 24.50 railway ticket transport",
  },
  {
    documentId: "transaction:tx-uber-airport",
    content: "Uber ride Lisboa airport EUR 14.20 transport receipt",
  },
  {
    documentId: "receipt:rc-starbucks-lisboa",
    content: "Starbucks Lisboa coffee EUR 4.80 cafe latte receipt",
  },
  {
    documentId: "receipt:rc-mcdonalds",
    content: "McDonalds burger fries EUR 9.90 fast food restaurant receipt",
  },
  {
    documentId: "transaction:tx-farmacia-health",
    content: "Farmacia Central pharmacy EUR 12.30 medicine health receipt",
  },
  {
    documentId: "receipt:rc-nos-telecom",
    content: "NOS telecom internet bill EUR 35.99 monthly subscription utilities utilities utilities",
  },
  {
    documentId: "receipt:rc-edp-energy",
    content: "EDP electricity bill EUR 62.10 energy utilities monthly receipt",
  },
]
