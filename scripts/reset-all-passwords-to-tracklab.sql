-- ==========================================================================
-- Reset every user's password to the default "tracklab" and force a change
-- on next login. Run this in the Neon SQL Editor (or psql) against the
-- production database AFTER the app has deployed the migration that adds
-- the must_change_password column (server.ts:842 — will run automatically
-- on the next server boot; you can verify with:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'users' AND column_name = 'must_change_password';
-- and it should return one row before you continue).
--
-- Hash generated locally: bcrypt('tracklab', cost=10). Same $2b prefix +
-- 10-round work factor the app uses for real user passwords.
-- ==========================================================================

BEGIN;

-- 1. Preview who will be affected — always look before you leap.
--    Comment out the SELECT and run the UPDATE once you're satisfied.
SELECT id, email, role, status, must_change_password
  FROM users
  ORDER BY id;

-- 2. Reset every user. Uncomment to run.
-- UPDATE users
--    SET password = '$2b$10$W2h6G3HqAnehJ5AkJpGwT.OvrMOIMCqwA8kBUkQMKu.JwgYSlVHBO',
--        must_change_password = TRUE,
--        updated_at = CURRENT_TIMESTAMP;

-- 3. If you want to keep the seed-admin (dedw13@gmail.com) able to log in
--    with their own current password rather than resetting them too, use
--    the WHERE-scoped variant instead of step 2:
-- UPDATE users
--    SET password = '$2b$10$W2h6G3HqAnehJ5AkJpGwT.OvrMOIMCqwA8kBUkQMKu.JwgYSlVHBO',
--        must_change_password = TRUE,
--        updated_at = CURRENT_TIMESTAMP
--  WHERE email <> 'dedw13@gmail.com';

-- 4. Kill every active session so nobody stays signed in past the reset.
-- DELETE FROM user_sessions;

-- Uncomment the COMMIT once you've verified the previews. Or ROLLBACK to
-- undo everything in the transaction.
-- COMMIT;
ROLLBACK;

-- ==========================================================================
-- POST-RESET:
-- - Every user (or every non-seed user if you used step 3) will log in
--   with the password: tracklab
-- - The app immediately shows a mandatory "Set a new password" modal;
--   they cannot proceed until they choose one that isn't "tracklab".
-- - The chosen password is stored as a fresh bcrypt hash, and
--   must_change_password is cleared server-side so subsequent logins go
--   straight to the app.
--
-- SAFETY NOTES:
-- - The SEED_ADMIN_PASSWORD (Fly secret) still works as break-glass. If you
--   lock yourself out of your own account by accident, log in as the seed
--   admin (dedw13@gmail.com + the seed password) — that path bypasses the
--   stored hash entirely and doesn't overwrite it.
-- - There is no way to undo this once COMMIT runs, short of a Neon
--   point-in-time restore. If in doubt, screenshot the SELECT output
--   before you commit.
-- ==========================================================================
