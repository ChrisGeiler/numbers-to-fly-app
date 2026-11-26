-- pg_net's default grants allow client roles to read its transport queue.
-- The queue temporarily contains Authorization headers: keep it server-only.
revoke all on net.http_request_queue from public, anon, authenticated;
revoke all on net._http_response from public, anon, authenticated;
revoke all on sequence net.http_request_queue_id_seq from public, anon, authenticated;
