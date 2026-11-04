-- Counters only. A cell is one text key (src/report.js, cellOf) that holds the
-- closed enums in the clear and the three open values as digests. There is no
-- report body, address, header, country or time here.
CREATE TABLE cells (
  week TEXT NOT NULL,
  cell TEXT NOT NULL,
  n INTEGER NOT NULL CHECK (n BETWEEN 1 AND 500),
  PRIMARY KEY (week, cell)
) WITHOUT ROWID;

-- The public read touches only rows above the threshold, so a read of a full
-- week costs what it returns, not 50,000 rows of the free daily budget.
CREATE INDEX cells_public ON cells (week, cell) WHERE n >= 3;

-- One row per week: the ceiling is checked by reading one row, not by counting.
CREATE TABLE weeks (
  week TEXT PRIMARY KEY,
  cells INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TRIGGER cells_counted AFTER INSERT ON cells
BEGIN
  UPDATE weeks SET cells = cells + 1 WHERE week = NEW.week;
END;
