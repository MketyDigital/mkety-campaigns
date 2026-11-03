-- OCI sender support is included in 0006 for new D1 databases. This marker
-- keeps D1's migration sequence aligned with PostgreSQL without rebuilding a
-- table that is referenced by existing campaigns.
SELECT 1;
