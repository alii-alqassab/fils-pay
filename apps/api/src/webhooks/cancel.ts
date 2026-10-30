import type { Pool } from "pg";

/** Endpoint registrations are retained as disabled tombstones so delivery and archive FKs stay valid. */
export type DeleteWebhookEndpointResult = "deleted" | "not_found";

/**
 * `DELETE /v1/merchants/:merchantId/webhook-endpoints/:id` business logic.
 * The statement carries the merchant-scoped predicate, never `id` alone.
 * Endpoint rows are retained as disabled tombstones because delivery and
 * archive records reference them as an audit trail. `deleted_at` prevents a
 * later PATCH from accidentally reactivating a deleted endpoint.
 */
export async function deleteWebhookEndpoint(
  pool: Pool,
  input: { merchantId: string; id: string },
): Promise<DeleteWebhookEndpointResult> {
  const result = await pool.query<{ id: string }>(
    `UPDATE webhook_endpoints
        SET status = 'disabled', deleted_at = now(), updated_at = now()
      WHERE id = $1 AND merchant_id = $2 AND deleted_at IS NULL
      RETURNING id`,
    [input.id, input.merchantId],
  );
  return result.rows[0] ? "deleted" : "not_found";
}
