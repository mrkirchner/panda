-- A season matched to another show (an anthology's story) shows that story's description.
ALTER TABLE season_matches ADD COLUMN overview TEXT;
ALTER TABLE season_matches ADD COLUMN year INTEGER;
