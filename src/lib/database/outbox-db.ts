/**
 * Outbox SQLite Storage (PAN-826)
 *
 * Persists user prompts that failed delivery so they can be retried.
 * When sendKeysAsync throws MessageDeliveryFailed, the message is
 * inserted here with status='pending' and retried on a subsequent sweep.
 */

import { getDatabase } from './index.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type OutboxStatus = 'pending' | 'failed' | 'delivered';

export type OutboxErrorPhase = 'paste-not-visible' | 'submit-not-confirmed' | 'busy';

export interface OutboxEntry {
  id: number;
  conversationName: string;
  message: string;
  status: OutboxStatus;
  error: string | null;
  errorPhase: OutboxErrorPhase | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

// ─── Row mapper ──────────────────────────────────────────────────────────────

function rowToOutboxEntry(row: Record<string, unknown>): OutboxEntry {
  return {
    id: row['id'] as number,
    conversationName: row['conversation_name'] as string,
    message: row['message'] as string,
    status: row['status'] as OutboxStatus,
    error: (row['error'] as string | null) ?? null,
    errorPhase: (row['error_phase'] as OutboxErrorPhase | null) ?? null,
    attempts: row['attempts'] as number,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}

// ─── CRUD operations ─────────────────────────────────────────────────────────

/**
 * Insert a new outbox entry for a failed or deferred message.
 * Returns the created entry with its assigned id.
 */
export function insertOutboxEntry(conversationName: string, message: string): OutboxEntry {
  const db = getDatabase();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO outbox (conversation_name, message, status, attempts, created_at, updated_at)
       VALUES (?, ?, 'pending', 0, ?, ?)`,
    )
    .run(conversationName, message, now, now);

  const row = db
    .prepare(
      `SELECT id, conversation_name, message, status, error, error_phase,
              attempts, created_at, updated_at
       FROM outbox WHERE id = ?`,
    )
    .get(result.lastInsertRowid) as Record<string, unknown>;

  return rowToOutboxEntry(row);
}

/**
 * Get all non-delivered outbox entries for a conversation (FIFO order).
 * Returns entries with status 'pending' or 'failed', ordered by creation time.
 */
export function getOutboxEntries(conversationName: string): OutboxEntry[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT id, conversation_name, message, status, error, error_phase,
              attempts, created_at, updated_at
       FROM outbox
       WHERE conversation_name = ? AND status != 'delivered'
       ORDER BY created_at ASC`,
    )
    .all(conversationName) as Record<string, unknown>[];

  return rows.map(rowToOutboxEntry);
}

/**
 * Update the status of an outbox entry.
 * Increments the attempt counter and refreshes updated_at on every call.
 */
export function updateOutboxStatus(
  id: number,
  status: OutboxStatus,
  error?: string,
  errorPhase?: OutboxErrorPhase,
): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE outbox
     SET status = ?, error = ?, error_phase = ?, attempts = attempts + 1, updated_at = ?
     WHERE id = ?`,
  ).run(status, error ?? null, errorPhase ?? null, new Date().toISOString(), id);
}

/**
 * Delete an outbox entry by id.
 */
export function deleteOutboxEntry(id: number): void {
  const db = getDatabase();
  db.prepare(`DELETE FROM outbox WHERE id = ?`).run(id);
}
