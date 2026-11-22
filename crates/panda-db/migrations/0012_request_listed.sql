-- Once a request's title is in the library it joins the requester's My List, once: this marks
-- that it has (so removing it from My List later sticks).
ALTER TABLE requests ADD COLUMN listed INTEGER NOT NULL DEFAULT 0;
