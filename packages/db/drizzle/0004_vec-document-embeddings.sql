-- Custom SQL migration file, put your code below! --
-- Dense-vector store for document embeddings (voyage-finance-2, 1024 dims).
-- Hand-written: vec0 DDL cannot go through drizzle-kit generate.
-- The sqlite-vec extension must be loaded (see vec-loader.ts) before running
-- this migration, otherwise SQLite reports "no such module: vec0".
-- tenant_id is the PARTITION KEY so KNN queries pre-filter per tenant.
CREATE VIRTUAL TABLE document_embeddings_vec USING vec0(
  embedding float[1024],
  tenant_id TEXT PARTITION KEY,
  document_id TEXT,
  model TEXT
);
