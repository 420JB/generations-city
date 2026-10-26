-- Architect entrances and landscaping (P1-C2-E4C): an entrance treatment and a landscaping treatment, beside the facade,
-- roof, windows and lighting of 0015 and 0016. LOCAL DATABASES ONLY, LOCAL TEST CONTROL ONLY, FREE.
--
-- What changes. A third design catalog, mirrored from `src/world/design.ts`: `architect-design-v3` offers 0016's facades,
-- roofs, windows and lighting, four entrance treatments (standard, canopy, arched, portico) and three landscaping
-- treatments (standard, garden, courtyard), each one the standard city renderer already draws. Every new design is chosen
-- from it.
--
-- What a landscaping treatment is. An identifier, and nothing else: the page draws it as a FIXED arrangement of the city's
-- own landscape pieces inside the property's own paved lot. No position, size, count or piece is stored or chosen, so a
-- design can never place anything on a road, a neighbour's plot, a district gate or the civic centre, reserve land, move
-- the property or change its plot, its ward or the city's geography.
--
-- What does not. Every design 0015 and 0016 recorded keeps exactly its meaning, and is not touched: its row is not
-- rewritten, its catalog stays what it was, and it names no entrance or landscaping treatment (the new columns are NULL
-- for it, by rule, forever). The page draws such a design with the standard door and bare paving every building had when
-- it was saved, which are also v3's default, so no building looks different until its controller saves a v3 design. The
-- 0015 rules stand as they were (who saves, append-only revisions 1, 2, 3 ..., one action id per world, the live play
-- session, the city's current sequence, no update or delete); a design still advances no city sequence, writes no city
-- event, spends no test credit, builds nothing and earns no tier, rank, Crown, Capital or monument.
--
-- Schema decisions, and why:
--   * Two NULLABLE columns, with no default: adding them rewrites no row (a missing value reads as NULL), so the rows of
--     0015 and 0016 stay byte for byte as written and fire no trigger. A shape CHECK holds that a row names both new
--     treatments or neither, and names them only beside 0016's two (a v3 design is a whole design).
--   * Which catalog names which treatments is policy, in a function a later migration can replace (as 0016's
--     `world_design_details_known`): v1 rows name none of the four, v2 rows only windows and lighting, v3 rows one of each
--     of v3's six.
--   * v1 and v2 are READ ONLY from here: the guard refuses a new row of either. A save chosen from either that was already
--     recorded is still answered by the service from its row; one that never was is refused, so a page left open on an
--     earlier editor can never become a different design than the one it showed.
--
-- Additive. Two columns, one constraint and one function are added and the guard is replaced; nothing is dropped, and no
-- row of any table is touched.

-- Adding columns and a constraint to world_property_designs takes a brief exclusive lock on it. If it cannot be had
-- quickly, fail and roll back rather than queue readers behind this migration; the deploy can be run again.
SET LOCAL lock_timeout = '10s';

-- ---------------------------------------------------------------------------------------
-- world_property_designs: an entrance and a landscaping treatment, NULL for every 0015 and 0016 row
-- ---------------------------------------------------------------------------------------

ALTER TABLE world_property_designs
  ADD COLUMN entrance    text,
  ADD COLUMN landscaping text,
  ADD CONSTRAINT wpd_street_shape CHECK (
    (entrance IS NULL AND landscaping IS NULL)
    -- IS NOT NULL is spelled out (a NULL test passes a CHECK), and so is 0016's pair: a v3 design names all six.
    OR (entrance IS NOT NULL AND landscaping IS NOT NULL AND windows IS NOT NULL AND lighting IS NOT NULL
        AND entrance ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND char_length(entrance) <= 32 AND landscaping ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND char_length(landscaping) <= 32)
  );

COMMENT ON COLUMN world_property_designs.entrance IS 'The entrance treatment of a design of a catalog that has one (architect-design-v3); NULL for an architect-design-v1 or v2 design, which is drawn with the standard door.';
COMMENT ON COLUMN world_property_designs.landscaping IS 'The landscaping treatment (a fixed arrangement drawn inside the property''s own paved lot) of a design of a catalog that has one (architect-design-v3); NULL for an architect-design-v1 or v2 design, which is drawn with bare paving.';

-- ---------------------------------------------------------------------------------------
-- The catalogs, as the engine lists them (src/world/design.ts)
-- ---------------------------------------------------------------------------------------

-- Whether a whole design is a choice of a catalog this database knows: v1 and v2 as 0016 says and naming no entrance or
-- landscaping, v3 one of each of its own six. False for anything else. (Not STRICT: a NULL treatment is part of what v1 and
-- v2 mean.)
CREATE FUNCTION world_design_known(catalog text, facade text, roof text, windows text, lighting text, entrance text, landscaping text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(CASE catalog
    WHEN 'architect-design-v1' THEN entrance IS NULL AND landscaping IS NULL AND world_design_details_known(catalog, facade, roof, windows, lighting)
    WHEN 'architect-design-v2' THEN entrance IS NULL AND landscaping IS NULL AND world_design_details_known(catalog, facade, roof, windows, lighting)
    WHEN 'architect-design-v3' THEN facade IN ('slate', 'limestone', 'brick', 'copper', 'jade') AND roof IN ('flat', 'terrace', 'dome', 'spire')
                                    AND windows IN ('grid', 'arched', 'ribbon', 'lattice') AND lighting IN ('standard', 'warm', 'cool')
                                    AND entrance IN ('standard', 'canopy', 'arched', 'portico') AND landscaping IN ('standard', 'garden', 'courtyard')
    ELSE false
  END, false)
$$;

-- ---------------------------------------------------------------------------------------
-- Guard: 0016's, with the catalog rule replaced
-- ---------------------------------------------------------------------------------------

-- As 0016, and:
--   * a new design is chosen from the current catalog, architect-design-v3 (v1 and v2 designs are read, never saved again);
--   * the whole design (facade, roof, windows, lighting, entrance, landscaping) is a choice of that catalog.
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

  IF NEW.catalog <> 'architect-design-v3' THEN
    RAISE EXCEPTION 'a new design is chosen from the current catalog, architect-design-v3: % is read only', NEW.catalog;
  END IF;
  IF NOT world_design_known(NEW.catalog, NEW.facade, NEW.roof, NEW.windows, NEW.lighting, NEW.entrance, NEW.landscaping) THEN
    RAISE EXCEPTION 'a design is a facade, roof, windows, lighting, entrance and landscaping of a catalog this database knows: % / % / % / % / % / % / % is not',
      NEW.catalog, NEW.facade, NEW.roof, NEW.windows, NEW.lighting, NEW.entrance, NEW.landscaping;
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
-- The guards read real tables, never a session's temporary ones (as in 0004 to 0016)
-- ---------------------------------------------------------------------------------------

-- CREATE OR REPLACE resets a function's settings, so the replaced guard is pinned again with the new function.
DO $$
DECLARE
  guard text;
BEGIN
  FOREACH guard IN ARRAY ARRAY['world_design_known(text, text, text, text, text, text, text)', 'world_property_designs_guard()'] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path = %I, pg_temp', current_schema(), guard, current_schema());
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------------------
-- Privileges, and what is deliberately not here
-- ---------------------------------------------------------------------------------------

-- No privilege changes: a runtime role needs exactly what 0015 lists. Never grant UPDATE or DELETE on world_property_designs.
--
-- Not here, on purpose: freeform or per-piece landscaping placement, inventories, costs or collection, paid, earned,
-- ranked or unlockable designs, uploaded media or textures, arbitrary colors or geometry, official civic awards, verified
-- NFT control, and any change to a property's tier, construction, founder, district, plot or the city's geography.
