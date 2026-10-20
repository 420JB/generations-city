-- Only the current judge records a new configuration verdict (P1-C2-B2C-H).
--
-- A configuration verdict is permanent (world_config_versions, 0005): recorded once per Play version,
-- never re-judged. Migration 0008 changed the judge, from rare-city/play-config-v1+world-evolution-v2
-- (which also required the founding district geometry) to world-evolution-v3 (collections only; the
-- geometry is a governing rule, frozen by a world's first property). An instance of an older build
-- still serving launches after 0008 is applied, during a rolling deploy or left running, would judge
-- a new version with the v2 rules and record that verdict for good: a valid configuration that only
-- changes an empty city's districts would stay "rejected" forever. (An accepted one cannot be
-- recorded without its geometry since 0008, so it already fails closed.)
--
-- From here the database refuses a NEW verdict recorded by any judge but the current one. The older
-- instance's launch then fails and records nothing; the next launch through a current instance
-- records the verdict this build gives. Deploys must still stop older instances before migrating
-- (server/README.md); this makes a forgotten one harmless to the record rather than relying on it.
--
-- Additive: one guard function and one trigger, on INSERT only. Every verdict already recorded,
-- whatever judged it, is left exactly as it is and stays readable: no row is changed or checked
-- again, and verification keeps re-checking each by its own judge's rules. A later judge replaces
-- the function (CREATE OR REPLACE) in its own migration, as 0008 replaced world_properties_guard.

-- Creating a trigger on world_config_versions takes a brief lock on a live table. If it cannot be
-- had quickly, fail and roll back rather than queue launches behind this migration.
SET LOCAL lock_timeout = '10s';

-- The judge named here is WORLD_CONFIG_JUDGE in src/brand/core/evolution.ts. A judged_by of the wrong
-- shape is left to wcv_judged_by_shape, which reports it as such.
CREATE FUNCTION world_config_versions_current_judge() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF char_length(NEW.judged_by) BETWEEN 1 AND 100 AND NEW.judged_by <> 'rare-city/play-config-v1+world-evolution-v3' THEN
    RAISE EXCEPTION 'a new configuration verdict is recorded only by the current judge (rare-city/play-config-v1+world-evolution-v3), not %', NEW.judged_by
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Reads no table, but is pinned like every guard (0004 to 0008): never a session's temporary objects.
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION %I.world_config_versions_current_judge() SET search_path = %I, pg_temp', current_schema(), current_schema());
END;
$$;

CREATE TRIGGER world_config_versions_current_judge
  BEFORE INSERT ON world_config_versions
  FOR EACH ROW EXECUTE FUNCTION world_config_versions_current_judge();

COMMENT ON FUNCTION world_config_versions_current_judge() IS 'Refuses a new configuration verdict by any judge but the current one (an older build left running after a judge change). Replaced, never dropped, when the judge changes.';
