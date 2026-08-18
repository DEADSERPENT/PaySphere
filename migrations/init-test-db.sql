-- Runs once when the Postgres container initializes its data directory.
-- Creates the separate database used by the integration/failure-injection test suite
-- so tests never run against the development database.
CREATE DATABASE paysphere_test OWNER paysphere;
