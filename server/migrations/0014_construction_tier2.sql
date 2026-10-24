-- Tier 2 local test construction (P1-C2-E3B): a second recipe version, which takes a property on
-- from Tier 1 to Tier 2. LOCAL DATABASES ONLY, VALUELESS TEST CREDITS ONLY, as 0013.
--
-- What changes. 0013 knew one recipe, `local-test-tier1-v1` (50 units an action, Tier 1 at 100
-- lifetime units, nothing above). This migration adds `local-test-tier2-v1`, mirrored from
-- `src/world/construction.ts`: exactly tier1-v1 up to Tier 1 (the same 50-unit step, the same
-- threshold), then Tier 2 at 250 lifetime units, and nothing above Tier 2. Its numbers are
-- PROVISIONAL LOCAL REHEARSAL TUNING: not a price, not an exchange rate and not a decision about
-- final tiers or any tier above 2.
--
-- What does not change. Every construction, era, ledger entry, event and city stays exactly as it
-- is. `local-test-tier1-v1` keeps its meaning, branch for branch: the two recipe functions below
-- are 0013's with one more recipe, and answer every tier1-v1 question exactly as 0013 did. Because
-- tier2-v1 extends tier1-v1, a property built under tier1-v1 (Tier 1 at 100, or 50 on the way) is at
-- the same tier and has the same next step under tier2-v1, so the guard of 0013 lets it continue.
--
-- One new rule: a NEW construction is built by the current recipe only (tier2-v1). tier1-v1 is
-- retired: its records stay valid and are read by it for good, but nothing more is built by it, so
-- a property's records are in the order of the recipes and nothing can be built by an older recipe
-- to stop short of the current one's ladder. This is a policy trigger, replaceable by a later
-- migration, as 0013's guards are.
--
-- Forward only. Replacing two IMMUTABLE functions that nothing indexes, and adding one trigger on
-- world_property_constructions, which has no other writer than the construction service.

SET LOCAL lock_timeout = '10s';

-- ---------------------------------------------------------------------------------------
-- The recipes, as the engine computes them (src/world/construction.ts)
-- ---------------------------------------------------------------------------------------

-- The tier `built` lifetime units reach under a recipe, or NULL for a recipe this database does not know.
CREATE OR REPLACE FUNCTION world_construction_tier(recipe text, built integer) RETURNS integer
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE recipe
    WHEN 'local-test-tier1-v1' THEN CASE WHEN built >= 100 THEN 1 ELSE 0 END
    WHEN 'local-test-tier2-v1' THEN CASE WHEN built >= 250 THEN 2 WHEN built >= 100 THEN 1 ELSE 0 END
  END
$$;

-- The units one action builds into a building that has `built_before`, or NULL: an unknown recipe, or nothing left to build.
-- A step stops exactly at the next tier's threshold, so no tier is passed by one step.
CREATE OR REPLACE FUNCTION world_construction_units(recipe text, built_before integer) RETURNS integer
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE recipe
    WHEN 'local-test-tier1-v1' THEN CASE WHEN built_before >= 0 AND built_before < 100 THEN least(50, 100 - built_before) END
    WHEN 'local-test-tier2-v1' THEN CASE WHEN built_before >= 0 AND built_before < 100 THEN least(50, 100 - built_before) WHEN built_before >= 100 AND built_before < 250 THEN least(50, 250 - built_before) END
  END
$$;

-- ---------------------------------------------------------------------------------------
-- A new construction is built by the current recipe
-- ---------------------------------------------------------------------------------------

-- Runs after 0013's world_property_constructions_guard (triggers of one event fire in name order), which
-- already refuses an update or removal of a construction and anything outside a local database.
CREATE FUNCTION world_property_constructions_recipe_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.recipe IS DISTINCT FROM 'local-test-tier2-v1' THEN
    RAISE EXCEPTION 'a new construction is built by the current recipe, local-test-tier2-v1: % builds nothing more', NEW.recipe;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER world_property_constructions_recipe_guard
  BEFORE INSERT ON world_property_constructions
  FOR EACH ROW EXECUTE FUNCTION world_property_constructions_recipe_guard();

-- ---------------------------------------------------------------------------------------
-- The guards read real tables, never a session's temporary ones (as in 0004 to 0013)
-- ---------------------------------------------------------------------------------------

DO $$
DECLARE
  guard text;
BEGIN
  FOREACH guard IN ARRAY ARRAY['world_construction_tier(text, integer)', 'world_construction_units(text, integer)', 'world_property_constructions_recipe_guard()'] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path = %I, pg_temp', current_schema(), guard, current_schema());
  END LOOP;
END;
$$;

-- Not here, on purpose, because each waits on a decision or a contract that does not exist yet: any tier above 2,
-- final tier balancing, any real currency or price, verified NFT control, patron rewards and Architect levels.
