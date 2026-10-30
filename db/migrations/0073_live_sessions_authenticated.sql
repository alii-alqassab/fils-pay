-- Pending sessions belong to the OTP verification flow only. Keep the
-- shared live-session view restricted to sessions that completed OTP.
CREATE OR REPLACE VIEW live_sessions AS
SELECT id,
       merchant_user_id,
       token_hash,
       authenticated,
       created_at,
       expires_at
  FROM sessions
 WHERE authenticated = true
   AND revoked_at IS NULL
   AND expires_at > now();
