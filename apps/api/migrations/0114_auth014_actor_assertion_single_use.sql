-- AUTH-014 §2.11 gap 1: the actor assertion becomes single use, and is bound to the one request
-- it was spent on. docs/domain/sq-core-administrator-layers.md.
--
-- The gap, as the independent review stated it: the assertion is a bearer tied to nothing. Anyone
-- who captures one `X-SQ-Actor-Assertion` header together with a machine token can issue *new*
-- grants in that person's name until it ages out — a fresh requestId is a fresh grant, so the
-- (hub_request_id, action) index does not help. Owner decision 2026-10-30: close it before the
-- channel is switched on.
--
-- This table makes an assertion spendable exactly once. After the legitimate request spends it, a
-- captured copy is worthless. What remains is a race: an attacker who captures the assertion and
-- gets in before the real request. That residue is named in §2.11 and is why the row records what
-- the assertion was spent on — a grant nobody recognises becomes visible rather than invisible.
--
-- Rows are short-lived by construction: assertions are refused above 60 seconds old by default
-- (300 at most), so a row is only useful until its own expiry. Expired rows are deleted on each
-- insert, which keeps the table at roughly the number of grants made in one minute.
--
-- Idempotent: rerunning changes nothing further.
--
-- Rollback/recovery:
--   DROP TABLE IF EXISTS auth_actor_assertions;
--   The channel then accepts an assertion more than once again, so roll the code back with it.

CREATE TABLE IF NOT EXISTS auth_actor_assertions (
  -- The issuer is part of the key, not decoration: a jti is unique per issuer, and HCIS may one day
  -- see more than one realm.
  issuer text NOT NULL,
  jti text NOT NULL,
  -- The assertion's own exp. Rows are purged once past it; keeping them longer would protect
  -- nothing, since the assertion is refused on age anyway.
  expires_at timestamptz NOT NULL,
  spent_at timestamptz NOT NULL DEFAULT now(),
  -- What this assertion was spent on. Recorded so that an unrecognised grant can be traced back to
  -- a specific presentation, and so a race can be told apart from ordinary use.
  request_method text NOT NULL,
  request_path text NOT NULL,
  hub_request_id uuid NULL,
  actor_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  PRIMARY KEY (issuer, jti)
);

CREATE INDEX IF NOT EXISTS auth_actor_assertions_expiry_idx
  ON auth_actor_assertions (expires_at);
