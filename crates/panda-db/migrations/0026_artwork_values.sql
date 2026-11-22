-- Artwork joins the provider order (Fanart.tv next to TMDB): what's shown today is TMDB's
-- (an image cache key), kept as its answer.
INSERT OR IGNORE INTO provider_values (metadata_id, provider, field, value)
    SELECT id, 'tmdb', 'poster', poster FROM metadata WHERE poster IS NOT NULL AND poster <> '';
INSERT OR IGNORE INTO provider_values (metadata_id, provider, field, value)
    SELECT id, 'tmdb', 'backdrop', backdrop FROM metadata WHERE backdrop IS NOT NULL AND backdrop <> '';
