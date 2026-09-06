-- Custom SQL migration file, put your code below! --
CREATE VIRTUAL TABLE `search_documents_fts` USING fts5(`content`, tokenize = 'porter');
--> statement-breakpoint
CREATE TRIGGER `search_documents_ai` AFTER INSERT ON `search_documents` BEGIN
  INSERT INTO `search_documents_fts` (`rowid`, `content`) VALUES (new.`rowid`, new.`content`);
END;
--> statement-breakpoint
CREATE TRIGGER `search_documents_ad` AFTER DELETE ON `search_documents` BEGIN
  INSERT INTO `search_documents_fts` (`search_documents_fts`, `rowid`, `content`) VALUES ('delete', old.`rowid`, old.`content`);
END;
--> statement-breakpoint
CREATE TRIGGER `search_documents_au` AFTER UPDATE ON `search_documents` BEGIN
  INSERT INTO `search_documents_fts` (`search_documents_fts`, `rowid`, `content`) VALUES ('delete', old.`rowid`, old.`content`);
  INSERT INTO `search_documents_fts` (`rowid`, `content`) VALUES (new.`rowid`, new.`content`);
END;
--> statement-breakpoint
-- SQLite allows only one event per trigger, so event immutability needs two
-- triggers (no BEFORE UPDATE OR DELETE form exists).
CREATE TRIGGER `events_no_update` BEFORE UPDATE ON `events` BEGIN
  SELECT RAISE(ABORT, 'events are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `events_no_delete` BEFORE DELETE ON `events` BEGIN
  SELECT RAISE(ABORT, 'events are immutable');
END;
