-- AUTH-012: carry the page the user wanted through Akun SQ sign-in.
-- /auth/oidc/start stores a validated same-origin path next to the one-time OIDC transaction, and
-- /auth/callback redirects there after a successful sign-in. The path is never read from the
-- callback query string.
--
-- Additive and nullable: the running release keeps inserting rows without return_to and its
-- callback keeps redirecting to "/". Idempotent: rerunning changes nothing further.
--
-- Rollback/recovery:
--   ALTER TABLE auth_oidc_transactions DROP COLUMN IF EXISTS return_to;
--   Rows are short-lived (10 minutes); an in-flight sign-in then lands on "/" instead.

ALTER TABLE auth_oidc_transactions
  ADD COLUMN IF NOT EXISTS return_to text NULL
    CONSTRAINT auth_oidc_transactions_return_to_check CHECK (
      return_to IS NULL
      OR (
        length(return_to) BETWEEN 1 AND 512
        AND left(return_to, 1) = '/'
        AND left(return_to, 2) <> '//'
        AND position(chr(92) IN return_to) = 0 -- no backslash
      )
    );
