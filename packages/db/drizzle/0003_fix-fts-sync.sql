-- Custom SQL migration file, put your code below! --
-- bun:sqlite rejects the FTS5 `delete` command used by the 0001 triggers
-- ("SQL logic error" on any UPDATE/DELETE of search_documents, which breaks
-- the repository upsert conflict path and projection replay). Plain DELETE
-- statements keep the FTS index in sync on this build.
DROP TRIGGER IF EXISTS `search_documents_au`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `search_documents_ad`;--> statement-breakpoint
CREATE TRIGGER `search_documents_ad` AFTER DELETE ON `search_documents` BEGIN
  DELETE FROM `search_documents_fts` WHERE `rowid` = old.`rowid`;
END;--> statement-breakpoint
CREATE TRIGGER `search_documents_au` AFTER UPDATE ON `search_documents` BEGIN
  DELETE FROM `search_documents_fts` WHERE `rowid` = old.`rowid`;
  INSERT INTO `search_documents_fts` (`rowid`, `content`) VALUES (new.`rowid`, new.`content`);
END;
