-- Architect exterior color (P1-E6): an exterior color the facade material is finished in, chosen apart from the material,
-- beside the facade, roof, windows, lighting, entrance and landscaping of 0015 to 0017. LOCAL DATABASES ONLY, LOCAL TEST
-- CONTROL ONLY, FREE.
--
-- What changes. A fourth design catalog, mirrored from `src/world/design.ts`: `architect-design-v4` offers 0017's facades,
-- roofs, windows, lighting, entrances and landscaping, and thirteen exterior colors: `natural` (the facade material's own
-- color, as every building has been drawn) and twelve named colors (ivory, sand, terracotta, rose, crimson,
-- copper-orange, forest-green, sage, ocean-blue, navy, lavender, charcoal). Every new design is chosen from it.
--
-- What an exterior color is. A NAME the catalog lists, and nothing else: never a color value, a hex string, CSS or anything
-- a browser made up. The page draws it through the city's own art (a named palette the facade material is finished in,
-- with the material's surface drawn over it).
--
-- What does not. Every design 0015 to 0017 recorded keeps exactly its meaning, and is not touched: its row is not
-- rewritten, its catalog stays what it was, and it names no exterior color (the new column is NULL for it, by rule,
-- forever). The page draws such a design in its facade material's own color, which is also v4's default (`natural`), so no
-- building looks different until its controller saves another color. The 0015 rules stand as they were (who saves,
-- append-only revisions 1, 2, 3 ..., one action id per world, the live play session, the city's current sequence, no
-- update or delete); a design still advances no city sequence, writes no city event, spends no test credit, builds
-- nothing and earns no tier, rank, Crown, Capital or monument.
--
-- Schema decisions, and why:
--   * One NULLABLE column, with no default: adding it rewrites no row (a missing value reads as NULL), so the rows of 0015
--     to 0017 stay byte for byte as written and fire no trigger. A shape CHECK holds that a row names a color only beside
--     0017's four treatments (a v4 design is a whole design), and only as an identifier.
--   * Which catalog names which treatments is policy, in a function a later migration can replace (as 0017's
--     `world_design_known`): v1, v2 and v3 rows name no color and are judged by 0017's function, v4 rows one of each of
--     v4's seven.
--   * v1, v2 and v3 are READ ONLY from here: the guard refuses a new row of any of them. A save chosen from one that was
--     already recorded is still answered by the service from its row; one that never was is refused, so a page left open
--     on an earlier editor can never become a different design than the one it showed (it would drop the color unseen).
--
-- Additive. One column, one constraint and one function are added and the guard is replaced; nothing is dropped, and no
-- row of any table is touched.

-- Adding a column and a constraint to world_property_designs takes a brief exclusive lock on it. If it cannot be had
-- quickly, fail and roll back rather than queue readers behind this migration; the deploy can be run again.
SET LOCAL lock_timeout = '10s';

-- ---------------------------------------------------------------------------------------
-- world_property_designs: an exterior color, NULL for every 0015 to 0017 row
-- ---------------------------------------------------------------------------------------

ALTER TABLE world_property_designs
  ADD COLUMN color text,
  ADD CONSTRAINT wpd_color_shape CHECK (
    color IS NULL
    -- IS NOT NULL is spelled out (a NULL test passes a CHECK), and so are 0017's four: a v4 design names all seven.
    OR (color IS NOT NULL AND entrance IS NOT NULL AND landscaping IS NOT NULL AND windows IS NOT NULL AND lighting IS NOT NULL
        AND color ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND char_length(color) <= 32)
  );

COMMENT ON COLUMN world_property_designs.color IS 'The exterior color (a name from its catalog, never a color value) a design of a catalog that has one (architect-design-v4) finishes its facade material in; NULL for an architect-design-v1, v2 or v3 design, which is drawn in its material''s own color.';

-- ---------------------------------------------------------------------------------------
-- The catalogs, as the engine lists them (src/world/design.ts)
-- ---------------------------------------------------------------------------------------

-- Whether a whole design is a choice of a catalog this database knows: v1, v2 and v3 as 0017 says and naming no color, v4
-- one of each of its own seven. False for anything else. (Not STRICT: a NULL treatment is part of what v1 to v3 mean.)
CREATE FUNCTION world_design_color_known(catalog text, facade text, roof text, windows text, lighting text, entrance text, landscaping text, color text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(CASE catalog
    WHEN 'architect-design-v1' THEN color IS NULL AND world_design_known(catalog, facade, roof, windows, lighting, entrance, landscaping)
    WHEN 'architect-design-v2' THEN color IS NULL AND world_design_known(catalog, facade, roof, windows, lighting, entrance, landscaping)
    WHEN 'architect-design-v3' THEN color IS NULL AND world_design_known(catalog, facade, roof, windows, lighting, entrance, landscaping)
    WHEN 'architect-design-v4' THEN facade IN ('slate', 'limestone', 'brick', 'copper', 'jade') AND roof IN ('flat', 'terrace', 'dome', 'spire')
                                    AND windows IN ('grid', 'arched', 'ribbon', 'lattice') AND lighting IN ('standard', 'warm', 'cool')
                                    AND entrance IN ('standard', 'canopy', 'arched', 'portico') AND landscaping IN ('standard', 'garden', 'courtyard')
                                    AND color IN ('natural', 'ivory', 'sand', 'terracotta', 'rose', 'crimson', 'copper-orange', 'forest-green', 'sage',
                                                  'ocean-blue', 'navy', 'lavender', 'charcoal')
    ELSE false
  END, false)
$$;

-- ---------------------------------------------------------------------------------------
-- Guard: 0017's, with the catalog rule replaced
-- ---------------------------------------------------------------------------------------

-- As 0017, and:
--   * a new design is chosen from the current catalog, architect-design-v4 (v1 to v3 designs are read, never saved again);
--   * the whole design (facade, roof, windows, lighting, entrance, landscaping, color) is a choice of that catalog.
CREATE OR REPLACE FUNCTION world_property_designs_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  previous record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'a saved design is permanent: it cannot be changed (save a new revision)';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a saved design is permanent: it cannot be removed';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM app_meta m WHERE m.key = 'environment' AND m.value = 'local') THEN
    RAISE EXCEPTION 'property design is not enabled in this database: only a local database may record it until live player mutations are authorized';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'a design is recorded only in a READ COMMITTED transaction';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM worlds w WHERE w.id = NEW.world_id AND w.city_id = NEW.city_id AND w.city_instance_id = NEW.city_instance_id) THEN
    RAISE EXCEPTION 'a design belongs to its world''s own city (foreign key world_property_designs -> worlds)' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM world_properties p WHERE p.id = NEW.property_id AND p.world_id = NEW.world_id AND p.city_id = NEW.city_id AND p.activated_sequence <= NEW.at_city_sequence) THEN
    RAISE EXCEPTION 'a design is on a property of its world (foreign key world_property_designs -> world_properties)' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM city c WHERE c.id = NEW.city_id AND c.instance_id = NEW.city_instance_id AND c.sequence = NEW.at_city_sequence) THEN
    RAISE EXCEPTION 'a design records the sequence its city is at when it is saved';
  END IF;

  SELECT d.revision, d.at_city_sequence INTO previous FROM world_property_designs d WHERE d.property_id = NEW.property_id ORDER BY d.revision DESC LIMIT 1;
  IF NEW.revision <> COALESCE(previous.revision, 0) + 1 THEN
    RAISE EXCEPTION 'designs are numbered consecutively from 1 for each property';
  END IF;
  IF previous.at_city_sequence IS NOT NULL AND NEW.at_city_sequence < previous.at_city_sequence THEN
    RAISE EXCEPTION 'a design is never saved at an earlier city sequence than the revision before it';
  END IF;

  IF NEW.catalog <> 'architect-design-v4' THEN
    RAISE EXCEPTION 'a new design is chosen from the current catalog, architect-design-v4: % is read only', NEW.catalog;
  END IF;
  IF NOT world_design_color_known(NEW.catalog, NEW.facade, NEW.roof, NEW.windows, NEW.lighting, NEW.entrance, NEW.landscaping, NEW.color) THEN
    RAISE EXCEPTION 'a design is a facade, roof, windows, lighting, entrance, landscaping and color of a catalog this database knows: % / % / % / % / % / % / % / % is not',
      NEW.catalog, NEW.facade, NEW.roof, NEW.windows, NEW.lighting, NEW.entrance, NEW.landscaping, NEW.color;
  END IF;

  PERFORM 1 FROM play_sessions s
    WHERE s.id = NEW.designed_in_play_session AND s.world_id = NEW.world_id AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a design is saved only in a live play session of its world';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM play_sessions s
     WHERE s.id = NEW.designed_in_play_session AND s.core_user_id = NEW.designer_core_user_id AND s.discord_user_id = NEW.designer_discord_user_id
  ) THEN
    RAISE EXCEPTION 'a design''s designer is the player of the play session that saves it';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------------------
-- The guards read real tables, never a session's temporary ones (as in 0004 to 0017)
-- ---------------------------------------------------------------------------------------

-- CREATE OR REPLACE resets a function's settings, so the replaced guard is pinned again with the new function.
DO $$
DECLARE
  guard text;
BEGIN
  FOREACH guard IN ARRAY ARRAY['world_design_color_known(text, text, text, text, text, text, text, text)', 'world_property_designs_guard()'] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path = %I, pg_temp', current_schema(), guard, current_schema());
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------------------
-- Privileges, and what is deliberately not here
-- ---------------------------------------------------------------------------------------

-- No privilege changes: a runtime role needs exactly what 0015 lists. Never grant UPDATE or DELETE on world_property_designs.
--
-- Not here, on purpose: arbitrary or per-face colors, color values of any kind, paid, earned, ranked or unlockable colors,
-- uploaded media or textures, official civic awards, verified NFT control, and any change to a property's tier,
-- construction, founder, district, plot or the city's geography.
