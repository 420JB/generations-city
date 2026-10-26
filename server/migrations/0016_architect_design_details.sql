-- Architect design details (P1-C2-E4B): a window treatment and an exterior lighting treatment, beside the facade and roof
-- of 0015. LOCAL DATABASES ONLY, LOCAL TEST CONTROL ONLY, FREE.
--
-- What changes. A second design catalog, mirrored from `src/world/design.ts`: `architect-design-v2` offers 0015's five
-- facades and four roofs, four window treatments (grid, arched, ribbon, lattice) and three exterior lighting treatments
-- (standard, warm, cool), each one the standard city renderer already draws. Every new design is chosen from it.
--
-- What does not. Every design 0015 recorded keeps exactly its meaning, and is not touched: its row is not rewritten, its
-- catalog stays `architect-design-v1`, and it names no window or lighting treatment (the new columns are NULL for it, by
-- rule, forever). The page draws such a design with the treatments every building had when it was saved (grid windows,
-- the standard warm glow, no floodlights), which are also v2's default, so no building looks different until its
-- controller saves a v2 design. The 0015 rules stand as they were (who saves, append-only revisions 1, 2, 3 ..., one
-- action id per world, the live play session, the city's current sequence, no update or delete); a design still advances
-- no city sequence, writes no city event, spends no test credit, builds nothing and earns no tier, rank, Crown, Capital or
-- monument.
--
-- Schema decisions, and why:
--   * Two NULLABLE columns, with no default: adding them rewrites no row (a missing value reads as NULL), so 0015's rows
--     stay byte for byte as written and fire no trigger. A shape CHECK holds that a row names both treatments or neither.
--   * Which catalog names which treatments is policy, in functions a later migration can replace (as 0015's
--     `world_design_choice_known`): v1 rows name none, v2 rows name one of each of v2's.
--   * v1 is READ ONLY from here: the guard refuses a new v1 row. A save chosen from v1 that was already recorded is still
--     answered by the service from its row; one that never was is refused, so a page left open on the earlier editor can
--     never become a different design than the one it showed.
--
-- Additive. Two columns, one constraint and one function are added and the guard is replaced; nothing is dropped, and no
-- row of any table is touched.

-- Adding columns and a constraint to world_property_designs takes a brief exclusive lock on it. If it cannot be had
-- quickly, fail and roll back rather than queue readers behind this migration; the deploy can be run again.
SET LOCAL lock_timeout = '10s';

-- ---------------------------------------------------------------------------------------
-- world_property_designs: a window and a lighting treatment, NULL for every 0015 row
-- ---------------------------------------------------------------------------------------

ALTER TABLE world_property_designs
  ADD COLUMN windows  text,
  ADD COLUMN lighting text,
  ADD CONSTRAINT wpd_detail_shape CHECK (
    (windows IS NULL AND lighting IS NULL)
    -- IS NOT NULL is spelled out: a NULL test passes a CHECK, so the shapes alone would let one treatment be missing.
    OR (windows IS NOT NULL AND lighting IS NOT NULL
        AND windows ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND char_length(windows) <= 32 AND lighting ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND char_length(lighting) <= 32)
  );

COMMENT ON COLUMN world_property_designs.windows IS 'The window treatment of a design of a catalog that has one (architect-design-v2); NULL for an architect-design-v1 design, which is drawn with the standard grid windows.';
COMMENT ON COLUMN world_property_designs.lighting IS 'The exterior lighting treatment of a design of a catalog that has one (architect-design-v2); NULL for an architect-design-v1 design, which is drawn with the standard lighting.';

-- ---------------------------------------------------------------------------------------
-- The catalogs, as the engine lists them (src/world/design.ts)
-- ---------------------------------------------------------------------------------------

-- Whether a whole design is a choice of a catalog this database knows: v1 names a facade and a roof and no treatment, v2
-- one of each of its own. False for anything else. (Not STRICT: a NULL treatment is part of what v1 means.)
CREATE FUNCTION world_design_details_known(catalog text, facade text, roof text, windows text, lighting text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(CASE catalog
    WHEN 'architect-design-v1' THEN windows IS NULL AND lighting IS NULL AND world_design_choice_known(catalog, facade, roof)
    WHEN 'architect-design-v2' THEN facade IN ('slate', 'limestone', 'brick', 'copper', 'jade') AND roof IN ('flat', 'terrace', 'dome', 'spire')
                                    AND windows IN ('grid', 'arched', 'ribbon', 'lattice') AND lighting IN ('standard', 'warm', 'cool')
    ELSE false
  END, false)
$$;

-- ---------------------------------------------------------------------------------------
-- Guard: 0015's, with the catalog rule replaced
-- ---------------------------------------------------------------------------------------

-- As 0015, and:
--   * a new design is chosen from the current catalog, architect-design-v2 (v1 designs are read, never saved again);
--   * the whole design (facade, roof, windows, lighting) is a choice of that catalog.
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

  IF NEW.catalog <> 'architect-design-v2' THEN
    RAISE EXCEPTION 'a new design is chosen from the current catalog, architect-design-v2: % is read only', NEW.catalog;
  END IF;
  IF NOT world_design_details_known(NEW.catalog, NEW.facade, NEW.roof, NEW.windows, NEW.lighting) THEN
    RAISE EXCEPTION 'a design is a facade, roof, windows and lighting of a catalog this database knows: % / % / % / % / % is not', NEW.catalog, NEW.facade, NEW.roof, NEW.windows, NEW.lighting;
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
-- The guards read real tables, never a session's temporary ones (as in 0004 to 0015)
-- ---------------------------------------------------------------------------------------

-- CREATE OR REPLACE resets a function's settings, so the replaced guard is pinned again with the new function.
DO $$
DECLARE
  guard text;
BEGIN
  FOREACH guard IN ARRAY ARRAY['world_design_details_known(text, text, text, text, text)', 'world_property_designs_guard()'] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path = %I, pg_temp', current_schema(), guard, current_schema());
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------------------
-- Privileges, and what is deliberately not here
-- ---------------------------------------------------------------------------------------

-- No privilege changes: a runtime role needs exactly what 0015 lists. Never grant UPDATE or DELETE on world_property_designs.
--
-- Not here, on purpose: landscaping placement, paid, earned, ranked or unlockable designs, uploaded media or textures,
-- arbitrary colors, a day/night cycle, verified NFT control, and any change to a property's tier, construction, founder,
-- district or plot.
