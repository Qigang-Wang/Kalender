import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import pg from "pg";

import {
  getDatabaseMigrationStatus as inspectDatabaseMigrationStatus,
  runDatabaseMigrations,
  type DatabaseMigration,
  type DatabaseMigrationStatus,
} from "./database-migrations";

const { Pool, types } = pg;

types.setTypeParser(1082, (value) => value);
types.setTypeParser(1114, (value) => value);
types.setTypeParser(1184, (value) => value);

export interface DatabaseQueryResult<T> {
  readonly rows: T[];
  readonly affectedRows?: number;
}

export interface DatabaseExecutor {
  query<T>(query: string, params?: readonly unknown[]): Promise<DatabaseQueryResult<T>>;
  exec(query: string): Promise<unknown>;
}

export interface KalenderDatabase extends DatabaseExecutor {
  readonly engine: "postgres";
  readonly closed: boolean;
  transaction<T>(callback: (transaction: DatabaseExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

declare global {
  var kalenderDatabase: Promise<KalenderDatabase> | undefined;
  var kalenderDatabaseMigrations: Promise<void> | undefined;
  var kalenderDatabaseExitHandlersRegistered: boolean | undefined;
  var kalenderTestDatabase: { readonly adminUrl: string; readonly databaseName: string } | undefined;
}

export function workspaceRoot(): string {
  const cwd = process.cwd();
  return cwd.endsWith(path.join("apps", "web")) ? path.resolve(cwd, "../..") : cwd;
}

export function dataRoot(): string {
  return process.env.KALENDER_DATA_DIR
    ? path.resolve(process.env.KALENDER_DATA_DIR)
    : path.join(workspaceRoot(), ".data");
}

export async function getDatabase(): Promise<KalenderDatabase> {
  try {
    globalThis.kalenderDatabase ??= initializeDatabase();
    const database = await globalThis.kalenderDatabase;
    globalThis.kalenderDatabaseMigrations ??= ensureLatestSchema(database);
    await globalThis.kalenderDatabaseMigrations;
    return database;
  } catch (error) {
    globalThis.kalenderDatabase = undefined;
    globalThis.kalenderDatabaseMigrations = undefined;
    throw error;
  }
}

export async function closeDatabaseForRestore(): Promise<void> {
  try {
    const pending = globalThis.kalenderDatabase;
    if (pending) {
      const database = await pending;
      if (!database.closed) await database.close();
    }
  } finally {
    globalThis.kalenderDatabase = undefined;
    globalThis.kalenderDatabaseMigrations = undefined;
    await dropTestDatabaseIfNeeded();
  }
}

const FEATURE_SCHEMA_SQL = String.raw`
    CREATE TABLE IF NOT EXISTS exchange_connections (
      id text PRIMARY KEY,
      display_name text NOT NULL,
      server_url text NOT NULL,
      username text NOT NULL,
      email_address text NOT NULL,
      color text NOT NULL DEFAULT '#86bdf5',
      mail_enabled boolean NOT NULL DEFAULT true,
      calendar_enabled boolean NOT NULL DEFAULT true,
      last_tested_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (server_url, username)
    );
    CREATE TABLE IF NOT EXISTS exchange_connection_credentials (
      connection_id text PRIMARY KEY REFERENCES exchange_connections(id) ON DELETE CASCADE,
      encrypted_payload text NOT NULL,
      key_version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS exchange_mail_sync_state (
      account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      provider_folder_id text NOT NULL,
      sync_state text,
      latest_seeded boolean NOT NULL DEFAULT false,
      initial_complete boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (account_id, provider_folder_id)
    );
    ALTER TABLE calendar_accounts ADD COLUMN IF NOT EXISTS exchange_connection_id text REFERENCES exchange_connections(id) ON DELETE SET NULL;
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS exchange_connection_id text REFERENCES exchange_connections(id) ON DELETE SET NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS calendar_accounts_exchange_connection_unique_idx
      ON calendar_accounts (exchange_connection_id) WHERE exchange_connection_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS accounts_exchange_connection_unique_idx
      ON accounts (exchange_connection_id) WHERE exchange_connection_id IS NOT NULL;
    INSERT INTO exchange_connections (
      id, display_name, server_url, username, email_address, color,
      mail_enabled, calendar_enabled, last_tested_at, created_at, updated_at
    )
    SELECT ca.id, ca.display_name, ca.server_url, ca.username, lower(ca.username), ca.color,
           true, true, ca.last_tested_at, ca.created_at, ca.updated_at
      FROM calendar_accounts ca
     WHERE ca.provider_id = 'exchange'
    ON CONFLICT (server_url, username) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      calendar_enabled = true,
      updated_at = now();
    INSERT INTO exchange_connection_credentials (connection_id, encrypted_payload, key_version, created_at, updated_at)
    SELECT ec.id, cec.encrypted_payload, cec.key_version, cec.created_at, cec.updated_at
      FROM exchange_connections ec
      JOIN calendar_accounts ca ON ca.provider_id = 'exchange'
                               AND ca.server_url = ec.server_url
                               AND ca.username = ec.username
      JOIN calendar_encrypted_credentials cec ON cec.account_id = ca.id
     WHERE ec.id = ca.id
    ON CONFLICT (connection_id) DO NOTHING;
    UPDATE calendar_accounts ca
       SET exchange_connection_id = ec.id
      FROM exchange_connections ec
     WHERE ca.provider_id = 'exchange'
       AND ca.server_url = ec.server_url
       AND ca.username = ec.username
       AND ca.exchange_connection_id IS NULL;
    INSERT INTO accounts (
      id, provider_id, display_name, email_address, color, enabled,
      sync_mode, sync_status, sync_error, last_tested_at, exchange_connection_id,
      created_at, updated_at
    )
    SELECT 'exchange-mail:' || ec.id, 'exchange-ews', ec.display_name, lower(ec.email_address), ec.color, true,
           'recommended', 'idle', NULL, ec.last_tested_at, ec.id, ec.created_at, ec.updated_at
      FROM exchange_connections ec
     WHERE ec.mail_enabled = true
    ON CONFLICT (provider_id, email_address) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      exchange_connection_id = EXCLUDED.exchange_connection_id,
      enabled = true,
      updated_at = now();
    CREATE TABLE IF NOT EXISTS ai_providers (
      id text PRIMARY KEY,
      display_name text NOT NULL,
      provider_kind text NOT NULL DEFAULT 'openai-compatible' CHECK (provider_kind IN ('openai-compatible')),
      base_url text NOT NULL,
      auth_scheme text NOT NULL DEFAULT 'bearer' CHECK (auth_scheme IN ('bearer', 'custom-header')),
      auth_header_name text NOT NULL DEFAULT 'Authorization',
      enabled boolean NOT NULL DEFAULT true,
      allow_private_network boolean NOT NULL DEFAULT false,
      request_timeout_ms integer NOT NULL DEFAULT 30000 CHECK (request_timeout_ms BETWEEN 1000 AND 120000),
      last_tested_at timestamptz,
      last_test_status text NOT NULL DEFAULT 'untested' CHECK (last_test_status IN ('untested', 'passed', 'failed')),
      last_test_latency_ms integer CHECK (last_test_latency_ms IS NULL OR last_test_latency_ms >= 0),
      last_error_code text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ai_providers_display_name_unique_idx ON ai_providers (lower(display_name));
    CREATE TABLE IF NOT EXISTS ai_provider_credentials (
      provider_id text PRIMARY KEY REFERENCES ai_providers(id) ON DELETE CASCADE,
      encrypted_payload text NOT NULL,
      key_version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS ai_models (
      id text PRIMARY KEY,
      provider_id text NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
      api_model_id text NOT NULL,
      display_name text NOT NULL,
      model_kind text NOT NULL DEFAULT 'chat' CHECK (model_kind IN ('chat', 'embedding')),
      endpoint_kind text NOT NULL DEFAULT 'chat-completions' CHECK (endpoint_kind IN ('chat-completions', 'responses', 'embeddings')),
      enabled boolean NOT NULL DEFAULT true,
      capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
      context_window integer CHECK (context_window IS NULL OR context_window > 0),
      max_output_tokens integer CHECK (max_output_tokens IS NULL OR max_output_tokens > 0),
      default_parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
      data_region text,
      last_tested_at timestamptz,
      last_test_status text NOT NULL DEFAULT 'untested' CHECK (last_test_status IN ('untested', 'passed', 'failed')),
      last_test_latency_ms integer CHECK (last_test_latency_ms IS NULL OR last_test_latency_ms >= 0),
      last_error_code text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (provider_id, api_model_id, endpoint_kind)
    );
    CREATE INDEX IF NOT EXISTS ai_models_provider_idx ON ai_models (provider_id, enabled, created_at);
    CREATE TABLE IF NOT EXISTS ai_feature_bindings (
      feature_key text PRIMARY KEY,
      primary_model_id text REFERENCES ai_models(id) ON DELETE SET NULL,
      fallback_model_id text REFERENCES ai_models(id) ON DELETE SET NULL,
      context_budget_tokens integer NOT NULL DEFAULT 32000 CHECK (context_budget_tokens BETWEEN 1000 AND 1000000),
      timeout_ms integer NOT NULL DEFAULT 60000 CHECK (timeout_ms BETWEEN 1000 AND 180000),
      tool_mode text NOT NULL DEFAULT 'none' CHECK (tool_mode IN ('none', 'read', 'write-proposals')),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (primary_model_id IS NULL OR primary_model_id IS DISTINCT FROM fallback_model_id)
    );
    CREATE TABLE IF NOT EXISTS ai_conversations (
      id text PRIMARY KEY,
      title text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS ai_messages (
      id text PRIMARY KEY,
      conversation_id text NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
      role text NOT NULL CHECK (role IN ('user', 'assistant')),
      content jsonb NOT NULL,
      model_id text REFERENCES ai_models(id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'complete' CHECK (status IN ('complete', 'partial')),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ai_messages_conversation_idx ON ai_messages (conversation_id, created_at, id);
    CREATE TABLE IF NOT EXISTS ai_runs (
      id text PRIMARY KEY,
      conversation_id text NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
      feature_key text NOT NULL,
      provider_id text REFERENCES ai_providers(id) ON DELETE SET NULL,
      model_id text REFERENCES ai_models(id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
      attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count BETWEEN 1 AND 2),
      used_fallback boolean NOT NULL DEFAULT false,
      prompt_tokens integer CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
      completion_tokens integer CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
      latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
      error_code text,
      created_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS ai_runs_conversation_idx ON ai_runs (conversation_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS projects (
      id text PRIMARY KEY,
      name text NOT NULL,
      description text,
      area_name text,
      color text NOT NULL DEFAULT '#86bdf5',
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS projects_name_unique_idx ON projects (lower(name));
    CREATE TABLE IF NOT EXISTS notes (
      id text PRIMARY KEY,
      project_id text REFERENCES projects(id) ON DELETE SET NULL,
      title text NOT NULL,
      content text NOT NULL DEFAULT '',
      note_type text NOT NULL DEFAULT 'general' CHECK (note_type IN ('general', 'meeting', 'email', 'project', 'daily')),
      pinned boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS notes_project_updated_idx ON notes (project_id, pinned DESC, updated_at DESC);
    CREATE TABLE IF NOT EXISTS entity_links (
      id text PRIMARY KEY,
      source_kind text NOT NULL CHECK (source_kind IN ('mail', 'calendar', 'task', 'note', 'project')),
      source_id text NOT NULL,
      target_kind text NOT NULL CHECK (target_kind IN ('mail', 'calendar', 'task', 'note', 'project')),
      target_id text NOT NULL,
      relation text NOT NULL DEFAULT 'related',
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (source_kind, source_id, target_kind, target_id, relation)
    );
    CREATE TABLE IF NOT EXISTS mail_drafts (
      id text PRIMARY KEY,
      account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      reply_to_message_id text REFERENCES mail_messages(id) ON DELETE SET NULL,
      to_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
      cc_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
      bcc_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
      subject text NOT NULL DEFAULT '',
      text_body text NOT NULL DEFAULT '',
      body_content text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sending', 'sent', 'failed')),
      idempotency_key text,
      provider_message_id text,
      error_message text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      sent_at timestamptz
    );
    ALTER TABLE mail_drafts ADD COLUMN IF NOT EXISTS body_content text NOT NULL DEFAULT '';
    ALTER TABLE calendar_accounts ADD COLUMN IF NOT EXISTS color_override text;
    CREATE INDEX IF NOT EXISTS mail_drafts_status_updated_idx ON mail_drafts (status, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS mail_drafts_idempotency_idx ON mail_drafts (idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS mail_draft_attachments (
      id text PRIMARY KEY,
      draft_id text NOT NULL REFERENCES mail_drafts(id) ON DELETE CASCADE,
      filename text NOT NULL,
      content_type text NOT NULL,
      size_bytes integer NOT NULL CHECK (size_bytes >= 0),
      storage_name text NOT NULL,
      inline boolean NOT NULL DEFAULT false,
      content_id text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE mail_draft_attachments ADD COLUMN IF NOT EXISTS inline boolean NOT NULL DEFAULT false;
    ALTER TABLE mail_draft_attachments ADD COLUMN IF NOT EXISTS content_id text;
    CREATE INDEX IF NOT EXISTS mail_draft_attachments_draft_idx ON mail_draft_attachments (draft_id, created_at);
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_id text REFERENCES projects(id) ON DELETE SET NULL;
    INSERT INTO entity_links (id, source_kind, source_id, target_kind, target_id, relation)
      SELECT 'legacy:source:' || id, source_kind, source_id, 'task', task_id, 'derived-task'
        FROM task_source_references
      ON CONFLICT (source_kind, source_id, target_kind, target_id, relation) DO NOTHING;
    INSERT INTO entity_links (id, source_kind, source_id, target_kind, target_id, relation)
      SELECT 'legacy:schedule:' || task_id || ':' || calendar_event_id,
             'task', task_id, 'calendar', calendar_event_id, 'scheduled'
        FROM task_time_blocks
      ON CONFLICT (source_kind, source_id, target_kind, target_id, relation) DO NOTHING;
`;

const INITIAL_SCHEMA_SQL = String.raw`
    CREATE TABLE IF NOT EXISTS accounts (
      id text PRIMARY KEY,
      provider_id text NOT NULL,
      display_name text NOT NULL,
      email_address text NOT NULL,
      color text NOT NULL DEFAULT '#86bdf5',
      enabled boolean NOT NULL DEFAULT true,
      sync_mode text NOT NULL DEFAULT 'recommended' CHECK (sync_mode IN ('quick', 'recommended', 'full')),
      sync_status text NOT NULL DEFAULT 'idle' CHECK (sync_status IN ('idle', 'syncing', 'ready', 'error', 'paused')),
      sync_error text,
      last_tested_at timestamptz NOT NULL,
      last_sync_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (provider_id, email_address)
    );

    CREATE TABLE IF NOT EXISTS encrypted_credentials (
      account_id text PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      encrypted_payload text NOT NULL,
      key_version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS mail_folders (
      id text PRIMARY KEY,
      account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      provider_folder_id text NOT NULL,
      name text NOT NULL,
      role text NOT NULL,
      parent_id text,
      unread_count integer,
      total_count integer,
      sort_order integer NOT NULL DEFAULT 0,
      manual_sort_order integer,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (account_id, provider_folder_id)
    );

    CREATE TABLE IF NOT EXISTS mail_threads (
      id text PRIMARY KEY,
      account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      provider_thread_id text NOT NULL,
      subject text NOT NULL,
      snippet text NOT NULL DEFAULT '',
      participants jsonb NOT NULL DEFAULT '[]'::jsonb,
      last_message_at timestamptz NOT NULL,
      unread_count integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (account_id, provider_thread_id)
    );

    CREATE TABLE IF NOT EXISTS mail_messages (
      id text PRIMARY KEY,
      account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      thread_id text NOT NULL REFERENCES mail_threads(id) ON DELETE CASCADE,
      provider_message_id text NOT NULL,
      provider_uid integer NOT NULL,
      provider_folder_id text NOT NULL,
      subject text NOT NULL,
      from_address jsonb NOT NULL,
      to_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
      cc_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
      sent_at timestamptz NOT NULL,
      received_at timestamptz NOT NULL,
      snippet text NOT NULL DEFAULT '',
      text_body text,
      html_body text,
      body_loaded_at timestamptz,
      body_cache_version integer NOT NULL DEFAULT 0,
      is_read boolean NOT NULL DEFAULT false,
      is_starred boolean NOT NULL DEFAULT false,
      attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
      size_bytes integer,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (account_id, provider_folder_id, provider_uid)
    );

    CREATE INDEX IF NOT EXISTS mail_messages_received_idx
      ON mail_messages (account_id, received_at DESC);
    CREATE INDEX IF NOT EXISTS mail_messages_unread_idx
      ON mail_messages (account_id, is_read, received_at DESC);

    CREATE TABLE IF NOT EXISTS mail_drafts (
      id text PRIMARY KEY,
      account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      reply_to_message_id text REFERENCES mail_messages(id) ON DELETE SET NULL,
      to_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
      cc_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
      bcc_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
      subject text NOT NULL DEFAULT '',
      text_body text NOT NULL DEFAULT '',
      body_content text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sending', 'sent', 'failed')),
      idempotency_key text,
      provider_message_id text,
      error_message text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      sent_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS mail_drafts_status_updated_idx
      ON mail_drafts (status, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS mail_drafts_idempotency_idx
      ON mail_drafts (idempotency_key) WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS mail_draft_attachments (
      id text PRIMARY KEY,
      draft_id text NOT NULL REFERENCES mail_drafts(id) ON DELETE CASCADE,
      filename text NOT NULL,
      content_type text NOT NULL,
      size_bytes integer NOT NULL CHECK (size_bytes >= 0),
      storage_name text NOT NULL,
      inline boolean NOT NULL DEFAULT false,
      content_id text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS mail_draft_attachments_draft_idx
      ON mail_draft_attachments (draft_id, created_at);

    CREATE TABLE IF NOT EXISTS sync_cursors (
      account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      provider_folder_id text NOT NULL,
      uid_validity text NOT NULL,
      last_uid integer NOT NULL DEFAULT 0,
      backfill_before_uid integer,
      initial_complete boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (account_id, provider_folder_id)
    );

    CREATE TABLE IF NOT EXISTS sync_runs (
      id text PRIMARY KEY,
      account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
      mode text NOT NULL,
      folders_processed integer NOT NULL DEFAULT 0,
      messages_processed integer NOT NULL DEFAULT 0,
      error_message text,
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz
    );

    CREATE TABLE IF NOT EXISTS calendars (
      id text PRIMARY KEY,
      account_id text,
      provider_id text NOT NULL,
      provider_calendar_id text NOT NULL,
      source_url text,
      name text NOT NULL,
      color text NOT NULL DEFAULT '#86bdf5',
      read_only boolean NOT NULL DEFAULT false,
      is_primary boolean NOT NULL DEFAULT false,
      time_zone text NOT NULL DEFAULT 'Europe/Berlin',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (provider_id, provider_calendar_id)
    );

    CREATE TABLE IF NOT EXISTS calendar_events (
      id text PRIMARY KEY,
      calendar_id text NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
      provider_event_id text NOT NULL,
      title text NOT NULL,
      description text,
      location text,
      starts_at timestamptz NOT NULL,
      ends_at timestamptz NOT NULL,
      time_zone text NOT NULL DEFAULT 'Europe/Berlin',
      all_day boolean NOT NULL DEFAULT false,
      attendees jsonb NOT NULL DEFAULT '[]'::jsonb,
      meeting_url text,
      status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'tentative', 'cancelled')),
      etag text,
      provider_item_id text,
      provider_change_key text,
      is_meeting boolean NOT NULL DEFAULT false,
      is_recurring boolean NOT NULL DEFAULT false,
      is_organizer boolean,
      idempotency_key text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (calendar_id, provider_event_id),
      CHECK (ends_at > starts_at)
    );

    CREATE INDEX IF NOT EXISTS calendar_events_range_idx
      ON calendar_events (starts_at, ends_at);
    CREATE UNIQUE INDEX IF NOT EXISTS calendar_events_idempotency_idx
      ON calendar_events (calendar_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS calendar_accounts (
      id text PRIMARY KEY,
      provider_id text NOT NULL DEFAULT 'caldav',
      display_name text NOT NULL,
      server_url text NOT NULL,
      username text NOT NULL,
      color text NOT NULL DEFAULT '#86bdf5',
      enabled boolean NOT NULL DEFAULT true,
      sync_status text NOT NULL DEFAULT 'idle' CHECK (sync_status IN ('idle', 'syncing', 'ready', 'error', 'paused')),
      sync_error text,
      last_tested_at timestamptz NOT NULL,
      last_sync_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (provider_id, server_url, username)
    );

    CREATE TABLE IF NOT EXISTS calendar_encrypted_credentials (
      account_id text PRIMARY KEY REFERENCES calendar_accounts(id) ON DELETE CASCADE,
      encrypted_payload text NOT NULL,
      key_version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS projects (
      id text PRIMARY KEY,
      name text NOT NULL,
      description text,
      area_name text,
      color text NOT NULL DEFAULT '#86bdf5',
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS projects_name_unique_idx
      ON projects (lower(name));

    CREATE TABLE IF NOT EXISTS notes (
      id text PRIMARY KEY,
      project_id text REFERENCES projects(id) ON DELETE SET NULL,
      title text NOT NULL,
      content text NOT NULL DEFAULT '',
      note_type text NOT NULL DEFAULT 'general' CHECK (note_type IN ('general', 'meeting', 'email', 'project', 'daily')),
      pinned boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS notes_project_updated_idx
      ON notes (project_id, pinned DESC, updated_at DESC);

    CREATE TABLE IF NOT EXISTS entity_links (
      id text PRIMARY KEY,
      source_kind text NOT NULL CHECK (source_kind IN ('mail', 'calendar', 'task', 'note', 'project')),
      source_id text NOT NULL,
      target_kind text NOT NULL CHECK (target_kind IN ('mail', 'calendar', 'task', 'note', 'project')),
      target_id text NOT NULL,
      relation text NOT NULL DEFAULT 'related',
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (source_kind, source_id, target_kind, target_id, relation)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id text PRIMARY KEY,
      title text NOT NULL,
      notes text,
      status text NOT NULL DEFAULT 'inbox' CHECK (status IN ('inbox', 'next', 'waiting', 'someday', 'done')),
      important boolean NOT NULL DEFAULT false,
      urgency_mode text NOT NULL DEFAULT 'auto' CHECK (urgency_mode IN ('auto', 'urgent', 'not_urgent')),
      due_at timestamptz,
      estimated_minutes integer CHECK (estimated_minutes IS NULL OR (estimated_minutes >= 5 AND estimated_minutes <= 1440)),
      project_name text,
      area_name text,
      completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS tasks_open_due_idx
      ON tasks (status, due_at, updated_at DESC);

    CREATE TABLE IF NOT EXISTS task_source_references (
      id text PRIMARY KEY,
      task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      source_kind text NOT NULL CHECK (source_kind IN ('mail', 'calendar', 'note')),
      source_id text NOT NULL,
      label text NOT NULL,
      href text,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (task_id, source_kind, source_id)
    );

    CREATE TABLE IF NOT EXISTS task_time_blocks (
      task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      calendar_event_id text NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (task_id, calendar_event_id)
    );

    ALTER TABLE calendars
      ADD COLUMN IF NOT EXISTS account_id text;
    ALTER TABLE calendars
      ADD COLUMN IF NOT EXISTS source_url text;
    ALTER TABLE calendar_events
      ADD COLUMN IF NOT EXISTS etag text;
    ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS provider_item_id text;
    ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS provider_change_key text;
    ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS is_meeting boolean NOT NULL DEFAULT false;
    ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS is_recurring boolean NOT NULL DEFAULT false;
    ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS is_organizer boolean;
    UPDATE calendars SET read_only = false, updated_at = now()
      WHERE provider_id = 'exchange' AND read_only = true;
    ALTER TABLE tasks
      ADD COLUMN IF NOT EXISTS project_id text REFERENCES projects(id) ON DELETE SET NULL;

    INSERT INTO calendars (
      id, provider_id, provider_calendar_id, name, color,
      read_only, is_primary, time_zone
    ) VALUES (
      'local:personal', 'local-calendar', 'personal', '个人日历', '#86bdf5',
      false, true, 'Europe/Berlin'
    ) ON CONFLICT (provider_id, provider_calendar_id) DO NOTHING;

    ALTER TABLE sync_cursors
      ADD COLUMN IF NOT EXISTS backfill_before_uid integer;
    ALTER TABLE sync_cursors
      ADD COLUMN IF NOT EXISTS initial_complete boolean NOT NULL DEFAULT false;
    ALTER TABLE mail_messages
      ADD COLUMN IF NOT EXISTS body_loaded_at timestamptz;
    ALTER TABLE mail_messages
      ADD COLUMN IF NOT EXISTS body_cache_version integer NOT NULL DEFAULT 0;
    ALTER TABLE mail_folders
      ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;
    ALTER TABLE mail_folders
      ADD COLUMN IF NOT EXISTS manual_sort_order integer;
`;

const SYNC_STABILITY_SCHEMA_SQL = String.raw`
  ALTER TABLE sync_cursors
    ADD COLUMN IF NOT EXISTS reconcile_before_uid integer;
  ALTER TABLE sync_cursors
    ADD COLUMN IF NOT EXISTS last_deep_reconcile_at timestamptz;
`;

const PROJECT_TASK_LINKS_SCHEMA_SQL = String.raw`
  CREATE INDEX IF NOT EXISTS tasks_project_status_updated_idx
    ON tasks (project_id, status, updated_at DESC);

  UPDATE tasks t
     SET project_id = p.id,
         project_name = p.name,
         area_name = COALESCE(p.area_name, t.area_name)
    FROM projects p
   WHERE t.project_id IS NULL
     AND t.project_name IS NOT NULL
     AND lower(trim(t.project_name)) = lower(trim(p.name));

  UPDATE tasks t
     SET project_name = p.name,
         area_name = COALESCE(p.area_name, t.area_name)
    FROM projects p
   WHERE t.project_id = p.id;
`;

const PROJECT_MILESTONES_SCHEMA_SQL = String.raw`
  CREATE TABLE IF NOT EXISTS project_milestones (
    id text PRIMARY KEY,
    project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title text NOT NULL,
    due_on date,
    status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'active', 'done')),
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS project_milestones_project_due_idx
    ON project_milestones (project_id, status, due_on, sort_order);
`;

const PROJECT_GANTT_SCHEMA_SQL = String.raw`
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS planned_start date;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS planned_end date;

  CREATE TABLE IF NOT EXISTS task_dependencies (
    project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    predecessor_task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    successor_task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (predecessor_task_id, successor_task_id),
    CHECK (predecessor_task_id <> successor_task_id)
  );

  CREATE INDEX IF NOT EXISTS task_dependencies_project_idx
    ON task_dependencies (project_id, successor_task_id);

  UPDATE tasks
     SET planned_end = due_at::date
   WHERE project_id IS NOT NULL
     AND planned_end IS NULL
     AND due_at IS NOT NULL;
`;

const PROJECT_ENTITY_LINKS_SCHEMA_SQL = String.raw`
  INSERT INTO entity_links (id, source_kind, source_id, target_kind, target_id, relation)
    SELECT 'project-task:' || t.id, 'project', t.project_id, 'task', t.id, 'project-item'
      FROM tasks t
     WHERE t.project_id IS NOT NULL
    ON CONFLICT (source_kind, source_id, target_kind, target_id, relation) DO NOTHING;

  INSERT INTO entity_links (id, source_kind, source_id, target_kind, target_id, relation)
    SELECT 'project-note:' || n.id, 'project', n.project_id, 'note', n.id, 'project-item'
      FROM notes n
     WHERE n.project_id IS NOT NULL
    ON CONFLICT (source_kind, source_id, target_kind, target_id, relation) DO NOTHING;
`;

const PROJECT_PHASES_AND_AUTO_SCHEDULE_SCHEMA_SQL = String.raw`
  CREATE TABLE IF NOT EXISTS project_phases (
    id text PRIMARY KEY,
    project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name text NOT NULL,
    color text NOT NULL DEFAULT '#86bdf5',
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS project_phases_project_order_idx
    ON project_phases (project_id, sort_order, created_at);

  ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS phase_id text REFERENCES project_phases(id) ON DELETE SET NULL;
  ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS duration_workdays integer
      CHECK (duration_workdays IS NULL OR duration_workdays BETWEEN 1 AND 2600);
  ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS auto_schedule boolean NOT NULL DEFAULT false;

  CREATE INDEX IF NOT EXISTS tasks_project_phase_plan_idx
    ON tasks (project_id, phase_id, planned_start, planned_end);
`;

const MAIL_QUERY_PERFORMANCE_SCHEMA_SQL = String.raw`
  CREATE INDEX IF NOT EXISTS mail_messages_thread_received_idx
    ON mail_messages (thread_id, received_at DESC, id DESC);

  CREATE INDEX IF NOT EXISTS mail_messages_thread_read_idx
    ON mail_messages (thread_id, is_read);

  CREATE INDEX IF NOT EXISTS mail_messages_folder_received_idx
    ON mail_messages (account_id, provider_folder_id, received_at DESC, id DESC);

  CREATE INDEX IF NOT EXISTS mail_folders_role_account_provider_idx
    ON mail_folders (role, account_id, provider_folder_id);
`;

const WORKSPACE_QUERY_PERFORMANCE_SCHEMA_SQL = String.raw`
  CREATE INDEX IF NOT EXISTS tasks_active_due_idx
    ON tasks (due_at, important DESC, updated_at DESC)
    WHERE status <> 'done';

  CREATE INDEX IF NOT EXISTS tasks_next_urgency_due_idx
    ON tasks (urgency_mode, due_at, important DESC)
    WHERE status = 'next';

  CREATE INDEX IF NOT EXISTS task_source_references_source_idx
    ON task_source_references (source_kind, source_id, task_id);

  CREATE INDEX IF NOT EXISTS entity_links_target_idx
    ON entity_links (target_kind, target_id, relation);

  CREATE INDEX IF NOT EXISTS mail_messages_account_provider_message_idx
    ON mail_messages (account_id, provider_message_id);
`;

const APP_AUTH_SCHEMA_SQL = String.raw`
  CREATE TABLE IF NOT EXISTS app_users (
    id text PRIMARY KEY,
    display_name text NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    role text NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    disabled_at timestamptz
  );

  CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_unique_idx ON app_users (lower(email));
`;

const USER_DATA_ISOLATION_SCHEMA_SQL = String.raw`
  ALTER TABLE accounts ADD COLUMN IF NOT EXISTS user_id text REFERENCES app_users(id) ON DELETE CASCADE;
  ALTER TABLE calendar_accounts ADD COLUMN IF NOT EXISTS user_id text REFERENCES app_users(id) ON DELETE CASCADE;
  ALTER TABLE exchange_connections ADD COLUMN IF NOT EXISTS user_id text REFERENCES app_users(id) ON DELETE CASCADE;
  ALTER TABLE calendars ADD COLUMN IF NOT EXISTS user_id text REFERENCES app_users(id) ON DELETE CASCADE;
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS user_id text REFERENCES app_users(id) ON DELETE CASCADE;
  ALTER TABLE notes ADD COLUMN IF NOT EXISTS user_id text REFERENCES app_users(id) ON DELETE CASCADE;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS user_id text REFERENCES app_users(id) ON DELETE CASCADE;
  ALTER TABLE entity_links ADD COLUMN IF NOT EXISTS user_id text REFERENCES app_users(id) ON DELETE CASCADE;
  ALTER TABLE mail_drafts ADD COLUMN IF NOT EXISTS user_id text REFERENCES app_users(id) ON DELETE CASCADE;
  ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS user_id text REFERENCES app_users(id) ON DELETE CASCADE;
  ALTER TABLE ai_conversations ADD COLUMN IF NOT EXISTS user_id text REFERENCES app_users(id) ON DELETE CASCADE;
  ALTER TABLE ai_feature_bindings ADD COLUMN IF NOT EXISTS user_id text REFERENCES app_users(id) ON DELETE CASCADE;

  WITH first_admin AS (
    SELECT id FROM app_users ORDER BY (role = 'admin') DESC, created_at, id LIMIT 1
  )
  UPDATE accounts SET user_id = (SELECT id FROM first_admin)
   WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM first_admin);

  WITH first_admin AS (
    SELECT id FROM app_users ORDER BY (role = 'admin') DESC, created_at, id LIMIT 1
  )
  UPDATE calendar_accounts SET user_id = (SELECT id FROM first_admin)
   WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM first_admin);

  UPDATE exchange_connections ec
     SET user_id = COALESCE(ca.user_id, a.user_id)
    FROM calendar_accounts ca
    FULL JOIN accounts a ON a.exchange_connection_id = ca.exchange_connection_id
   WHERE ec.user_id IS NULL AND ec.id = COALESCE(ca.exchange_connection_id, a.exchange_connection_id);

  WITH first_admin AS (
    SELECT id FROM app_users ORDER BY (role = 'admin') DESC, created_at, id LIMIT 1
  )
  UPDATE exchange_connections SET user_id = (SELECT id FROM first_admin)
   WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM first_admin);

  UPDATE calendars c
     SET user_id = ca.user_id
    FROM calendar_accounts ca
   WHERE c.user_id IS NULL AND c.account_id = ca.id AND ca.user_id IS NOT NULL;

  WITH first_admin AS (
    SELECT id FROM app_users ORDER BY (role = 'admin') DESC, created_at, id LIMIT 1
  )
  UPDATE calendars SET user_id = (SELECT id FROM first_admin)
   WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM first_admin);

  WITH first_admin AS (
    SELECT id FROM app_users ORDER BY (role = 'admin') DESC, created_at, id LIMIT 1
  )
  UPDATE projects SET user_id = (SELECT id FROM first_admin)
   WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM first_admin);

  UPDATE notes n SET user_id = p.user_id
    FROM projects p
   WHERE n.user_id IS NULL AND n.project_id = p.id AND p.user_id IS NOT NULL;

  WITH first_admin AS (
    SELECT id FROM app_users ORDER BY (role = 'admin') DESC, created_at, id LIMIT 1
  )
  UPDATE notes SET user_id = (SELECT id FROM first_admin)
   WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM first_admin);

  UPDATE tasks t SET user_id = p.user_id
    FROM projects p
   WHERE t.user_id IS NULL AND t.project_id = p.id AND p.user_id IS NOT NULL;

  WITH first_admin AS (
    SELECT id FROM app_users ORDER BY (role = 'admin') DESC, created_at, id LIMIT 1
  )
  UPDATE tasks SET user_id = (SELECT id FROM first_admin)
   WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM first_admin);

  UPDATE mail_drafts d SET user_id = a.user_id
    FROM accounts a
   WHERE d.user_id IS NULL AND d.account_id = a.id AND a.user_id IS NOT NULL;

  WITH first_admin AS (
    SELECT id FROM app_users ORDER BY (role = 'admin') DESC, created_at, id LIMIT 1
  )
  UPDATE ai_providers SET user_id = (SELECT id FROM first_admin)
   WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM first_admin);

  WITH first_admin AS (
    SELECT id FROM app_users ORDER BY (role = 'admin') DESC, created_at, id LIMIT 1
  )
  UPDATE ai_conversations SET user_id = (SELECT id FROM first_admin)
   WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM first_admin);

  WITH first_admin AS (
    SELECT id FROM app_users ORDER BY (role = 'admin') DESC, created_at, id LIMIT 1
  )
  UPDATE ai_feature_bindings SET user_id = (SELECT id FROM first_admin)
   WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM first_admin);

  UPDATE entity_links l
     SET user_id = COALESCE(t.user_id, n.user_id, p.user_id, c.user_id, m.user_id)
    FROM entity_links source
    LEFT JOIN tasks t ON (source.source_kind = 'task' AND t.id = source.source_id) OR (source.target_kind = 'task' AND t.id = source.target_id)
    LEFT JOIN notes n ON (source.source_kind = 'note' AND n.id = source.source_id) OR (source.target_kind = 'note' AND n.id = source.target_id)
    LEFT JOIN projects p ON (source.source_kind = 'project' AND p.id = source.source_id) OR (source.target_kind = 'project' AND p.id = source.target_id)
    LEFT JOIN calendar_events ce ON (source.source_kind = 'calendar' AND ce.id = source.source_id) OR (source.target_kind = 'calendar' AND ce.id = source.target_id)
    LEFT JOIN calendars c ON c.id = ce.calendar_id
    LEFT JOIN mail_messages mm ON (source.source_kind = 'mail' AND mm.id = source.source_id) OR (source.target_kind = 'mail' AND mm.id = source.target_id)
    LEFT JOIN accounts m ON m.id = mm.account_id
   WHERE l.id = source.id AND l.user_id IS NULL;

  WITH first_admin AS (
    SELECT id FROM app_users ORDER BY (role = 'admin') DESC, created_at, id LIMIT 1
  )
  UPDATE entity_links SET user_id = (SELECT id FROM first_admin)
   WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM first_admin);

  ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_provider_id_email_address_key;
  ALTER TABLE calendar_accounts DROP CONSTRAINT IF EXISTS calendar_accounts_provider_id_server_url_username_key;
  ALTER TABLE exchange_connections DROP CONSTRAINT IF EXISTS exchange_connections_server_url_username_key;
  ALTER TABLE calendars DROP CONSTRAINT IF EXISTS calendars_provider_id_provider_calendar_id_key;
  DROP INDEX IF EXISTS projects_name_unique_idx;
  DROP INDEX IF EXISTS ai_providers_display_name_unique_idx;
  ALTER TABLE ai_feature_bindings DROP CONSTRAINT IF EXISTS ai_feature_bindings_pkey;

  CREATE UNIQUE INDEX IF NOT EXISTS accounts_user_provider_email_unique_idx
    ON accounts (user_id, provider_id, email_address) WHERE user_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS calendar_accounts_user_provider_server_username_unique_idx
    ON calendar_accounts (user_id, provider_id, server_url, username) WHERE user_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS exchange_connections_user_server_username_unique_idx
    ON exchange_connections (user_id, server_url, username) WHERE user_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS calendars_user_provider_calendar_unique_idx
    ON calendars (user_id, provider_id, provider_calendar_id) WHERE user_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS projects_user_name_unique_idx
    ON projects (user_id, lower(name)) WHERE user_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS projects_legacy_name_unique_idx
    ON projects (lower(name)) WHERE user_id IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS ai_providers_user_display_name_unique_idx
    ON ai_providers (user_id, lower(display_name)) WHERE user_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS ai_feature_bindings_user_feature_unique_idx
    ON ai_feature_bindings (user_id, feature_key);

  CREATE INDEX IF NOT EXISTS accounts_user_idx ON accounts (user_id, created_at);
  CREATE INDEX IF NOT EXISTS calendar_accounts_user_idx ON calendar_accounts (user_id, created_at);
  CREATE INDEX IF NOT EXISTS calendars_user_idx ON calendars (user_id, is_primary DESC, created_at);
  CREATE INDEX IF NOT EXISTS projects_user_status_updated_idx ON projects (user_id, status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS notes_user_project_updated_idx ON notes (user_id, project_id, pinned DESC, updated_at DESC);
  CREATE INDEX IF NOT EXISTS tasks_user_status_due_idx ON tasks (user_id, status, due_at, updated_at DESC);
  CREATE INDEX IF NOT EXISTS mail_drafts_user_status_updated_idx ON mail_drafts (user_id, status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS ai_conversations_user_updated_idx ON ai_conversations (user_id, updated_at DESC);
`;

const AUTH_SECURITY_SCHEMA_SQL = String.raw`
  ALTER TABLE app_users ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 1;
  ALTER TABLE app_users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

  CREATE TABLE IF NOT EXISTS app_login_attempts (
    id text PRIMARY KEY,
    email text NOT NULL,
    ip_address text,
    user_agent text,
    succeeded boolean NOT NULL DEFAULT false,
    attempted_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS app_login_attempts_email_time_idx
    ON app_login_attempts (lower(email), attempted_at DESC);
  CREATE INDEX IF NOT EXISTS app_login_attempts_ip_time_idx
    ON app_login_attempts (ip_address, attempted_at DESC)
    WHERE ip_address IS NOT NULL;

  CREATE TABLE IF NOT EXISTS app_audit_events (
    id text PRIMARY KEY,
    actor_user_id text REFERENCES app_users(id) ON DELETE SET NULL,
    target_user_id text REFERENCES app_users(id) ON DELETE SET NULL,
    action text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    ip_address text,
    user_agent text,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS app_audit_events_created_idx
    ON app_audit_events (created_at DESC);
  CREATE INDEX IF NOT EXISTS app_audit_events_actor_created_idx
    ON app_audit_events (actor_user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS app_audit_events_target_created_idx
    ON app_audit_events (target_user_id, created_at DESC);
`;

const COLLABORATION_SCHEMA_SQL = String.raw`
  ALTER TABLE app_users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
  ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_role_check;
  ALTER TABLE app_users ADD CONSTRAINT app_users_role_check CHECK (role IN ('admin', 'user', 'viewer'));

  CREATE TABLE IF NOT EXISTS app_invitations (
    id text PRIMARY KEY,
    email text NOT NULL,
    display_name text,
    role text NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user', 'viewer')),
    token_hash text NOT NULL UNIQUE,
    invited_by_user_id text REFERENCES app_users(id) ON DELETE SET NULL,
    accepted_by_user_id text REFERENCES app_users(id) ON DELETE SET NULL,
    expires_at timestamptz NOT NULL,
    accepted_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS app_invitations_email_created_idx
    ON app_invitations (lower(email), created_at DESC);
  CREATE INDEX IF NOT EXISTS app_invitations_active_idx
    ON app_invitations (expires_at, accepted_at, revoked_at);

  CREATE TABLE IF NOT EXISTS project_members (
    project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    access_level text NOT NULL DEFAULT 'viewer' CHECK (access_level IN ('viewer', 'editor')),
    invited_by_user_id text REFERENCES app_users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS project_members_user_idx
    ON project_members (user_id, access_level, updated_at DESC);
  CREATE INDEX IF NOT EXISTS project_members_project_idx
    ON project_members (project_id, access_level, updated_at DESC);

  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignee_user_id text REFERENCES app_users(id) ON DELETE SET NULL;
  CREATE INDEX IF NOT EXISTS tasks_assignee_status_due_idx
    ON tasks (assignee_user_id, status, due_at, updated_at DESC)
    WHERE assignee_user_id IS NOT NULL;
`;

const OPERATIONS_BACKUP_AI_SEARCH_SCHEMA_SQL = String.raw`
  CREATE TABLE IF NOT EXISTS app_jobs (
    id text PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN (
      'backup.create', 'backup.restore', 'mail.sync', 'calendar.sync', 'ai.action', 'maintenance'
    )),
    status text NOT NULL DEFAULT 'queued' CHECK (status IN (
      'queued', 'running', 'succeeded', 'failed', 'cancelled'
    )),
    user_id text REFERENCES app_users(id) ON DELETE SET NULL,
    title text NOT NULL,
    progress integer NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    result jsonb NOT NULL DEFAULT '{}'::jsonb,
    error_message text,
    log_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
    idempotency_key text,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts integer NOT NULL DEFAULT 1 CHECK (max_attempts > 0),
    run_after timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE UNIQUE INDEX IF NOT EXISTS app_jobs_user_idempotency_unique_idx
    ON app_jobs (user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS app_jobs_status_run_after_idx
    ON app_jobs (status, run_after, created_at);
  CREATE INDEX IF NOT EXISTS app_jobs_user_created_idx
    ON app_jobs (user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS app_jobs_kind_created_idx
    ON app_jobs (kind, created_at DESC);

  CREATE TABLE IF NOT EXISTS backup_artifacts (
    id text PRIMARY KEY,
    job_id text REFERENCES app_jobs(id) ON DELETE SET NULL,
    created_by_user_id text REFERENCES app_users(id) ON DELETE SET NULL,
    filename text NOT NULL,
    file_path text NOT NULL,
    size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
    checksum_sha256 text NOT NULL DEFAULT '',
    encrypted boolean NOT NULL DEFAULT false,
    mail_policy text NOT NULL DEFAULT 'lightweight' CHECK (mail_policy IN ('lightweight', 'full-archive', 'configuration-only')),
    manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
    source text NOT NULL DEFAULT 'server' CHECK (source IN ('server', 'upload', 'safety')),
    restored_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS backup_artifacts_created_idx
    ON backup_artifacts (created_at DESC);
  CREATE INDEX IF NOT EXISTS backup_artifacts_user_created_idx
    ON backup_artifacts (created_by_user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS ai_action_settings (
    user_id text PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
    auto_execution_enabled boolean NOT NULL DEFAULT false,
    high_risk_auto_enabled boolean NOT NULL DEFAULT false,
    updated_by_user_id text REFERENCES app_users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS ai_action_events (
    id text PRIMARY KEY,
    job_id text REFERENCES app_jobs(id) ON DELETE SET NULL,
    actor_user_id text REFERENCES app_users(id) ON DELETE SET NULL,
    action text NOT NULL,
    status text NOT NULL CHECK (status IN ('planned', 'running', 'succeeded', 'failed', 'cancelled')),
    risk text NOT NULL CHECK (risk IN ('read', 'local-write', 'external-write', 'destructive')),
    target_kind text,
    target_id text,
    idempotency_key text,
    input jsonb NOT NULL DEFAULT '{}'::jsonb,
    result jsonb NOT NULL DEFAULT '{}'::jsonb,
    error_message text,
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
  );

  CREATE UNIQUE INDEX IF NOT EXISTS ai_action_events_actor_idempotency_unique_idx
    ON ai_action_events (actor_user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS ai_action_events_actor_created_idx
    ON ai_action_events (actor_user_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS mail_messages_search_idx ON mail_messages USING gin (
    to_tsvector('simple',
      coalesce(subject, '') || ' ' ||
      coalesce(snippet, '') || ' ' ||
      coalesce(text_body, '') || ' ' ||
      coalesce(html_body, '') || ' ' ||
      coalesce(from_address->>'name', '') || ' ' ||
      coalesce(from_address->>'address', '') || ' ' ||
      coalesce(attachments::text, '')
    )
  );
  CREATE INDEX IF NOT EXISTS tasks_search_idx ON tasks USING gin (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(notes, '') || ' ' || coalesce(project_name, ''))
  );
  CREATE INDEX IF NOT EXISTS notes_search_idx ON notes USING gin (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, ''))
  );
  CREATE INDEX IF NOT EXISTS projects_search_idx ON projects USING gin (
    to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(description, '') || ' ' || coalesce(area_name, ''))
  );
  CREATE INDEX IF NOT EXISTS calendar_events_search_idx ON calendar_events USING gin (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(location, ''))
  );
  CREATE INDEX IF NOT EXISTS ai_conversations_search_idx ON ai_conversations USING gin (
    to_tsvector('simple', coalesce(title, ''))
  );
  CREATE INDEX IF NOT EXISTS ai_messages_search_idx ON ai_messages USING gin (
    to_tsvector('simple', coalesce(content->>'text', ''))
  );
`;

const AUTOMATIC_BACKUP_SETTINGS_SCHEMA_SQL = String.raw`
  CREATE TABLE IF NOT EXISTS backup_settings (
    id text PRIMARY KEY DEFAULT 'workspace' CHECK (id = 'workspace'),
    enabled boolean NOT NULL DEFAULT false,
    interval_hours integer NOT NULL DEFAULT 24 CHECK (interval_hours BETWEEN 1 AND 720),
    retention_count integer NOT NULL DEFAULT 14 CHECK (retention_count BETWEEN 1 AND 365),
    encrypt_automatic boolean NOT NULL DEFAULT true,
    next_run_at timestamptz,
    last_enqueued_at timestamptz,
    last_completed_at timestamptz,
    updated_by_user_id text REFERENCES app_users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  INSERT INTO backup_settings (id, enabled, interval_hours, retention_count, encrypt_automatic, next_run_at)
  VALUES ('workspace', false, 24, 14, true, now() + interval '24 hours')
  ON CONFLICT (id) DO NOTHING;

  CREATE INDEX IF NOT EXISTS backup_artifacts_source_created_idx
    ON backup_artifacts (source, created_at DESC);
  CREATE INDEX IF NOT EXISTS app_jobs_finished_created_idx
    ON app_jobs (finished_at DESC, created_at DESC);
`;

const CALENDAR_RECURRENCE_SCHEMA_SQL = String.raw`
  ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS recurrence_rule jsonb;
  ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS recurrence_series_id text;
  ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS recurrence_id timestamptz;
  ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS recurrence_cancelled boolean NOT NULL DEFAULT false;

  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'calendar_events_recurrence_series_fk'
    ) THEN
      ALTER TABLE calendar_events
        ADD CONSTRAINT calendar_events_recurrence_series_fk
        FOREIGN KEY (recurrence_series_id) REFERENCES calendar_events(id) ON DELETE CASCADE;
    END IF;
  END $$;

  CREATE UNIQUE INDEX IF NOT EXISTS calendar_events_recurrence_exception_idx
    ON calendar_events (recurrence_series_id, recurrence_id)
    WHERE recurrence_series_id IS NOT NULL AND recurrence_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS calendar_events_recurrence_master_idx
    ON calendar_events (calendar_id, starts_at)
    WHERE recurrence_rule IS NOT NULL;
  CREATE INDEX IF NOT EXISTS calendar_events_recurrence_series_idx
    ON calendar_events (recurrence_series_id, recurrence_id)
    WHERE recurrence_series_id IS NOT NULL;
`;

const CALENDAR_RICH_DESCRIPTION_SCHEMA_SQL = String.raw`
  ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS description_content jsonb;
`;

const WORKSPACE_SYNC_SETTINGS_SCHEMA_SQL = String.raw`
  CREATE TABLE IF NOT EXISTS sync_settings (
    id text PRIMARY KEY DEFAULT 'workspace' CHECK (id = 'workspace'),
    mail_sync_enabled boolean NOT NULL DEFAULT true,
    mail_sync_interval_seconds integer NOT NULL DEFAULT 180
      CHECK (mail_sync_interval_seconds IN (60, 180, 300, 600, 900, 1800)),
    calendar_sync_enabled boolean NOT NULL DEFAULT true,
    calendar_sync_interval_seconds integer NOT NULL DEFAULT 180
      CHECK (calendar_sync_interval_seconds IN (60, 180, 300, 600, 900, 1800)),
    client_refresh_enabled boolean NOT NULL DEFAULT true,
    client_refresh_interval_seconds integer NOT NULL DEFAULT 15
      CHECK (client_refresh_interval_seconds IN (15, 30, 60, 120)),
    updated_by_user_id text REFERENCES app_users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );

`;

const MAIL_SIGNATURES_SCHEMA_SQL = String.raw`
  CREATE TABLE IF NOT EXISTS mail_signatures (
    id text PRIMARY KEY,
    account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    user_id text REFERENCES app_users(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
    full_text text NOT NULL DEFAULT '' CHECK (length(full_text) <= 20000),
    short_text text NOT NULL DEFAULT '' CHECK (length(short_text) <= 10000),
    is_default boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE UNIQUE INDEX IF NOT EXISTS mail_signatures_account_name_idx
    ON mail_signatures (account_id, lower(name));
  CREATE UNIQUE INDEX IF NOT EXISTS mail_signatures_account_default_idx
    ON mail_signatures (account_id) WHERE is_default = true;
  CREATE INDEX IF NOT EXISTS mail_signatures_user_account_idx
    ON mail_signatures (user_id, account_id, created_at);

  ALTER TABLE mail_drafts ADD COLUMN IF NOT EXISTS signature_id text;
  ALTER TABLE mail_drafts ADD COLUMN IF NOT EXISTS signature_variant text
    CHECK (signature_variant IS NULL OR signature_variant IN ('full', 'short'));

  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'mail_drafts_signature_fk'
    ) THEN
      ALTER TABLE mail_drafts
        ADD CONSTRAINT mail_drafts_signature_fk
        FOREIGN KEY (signature_id) REFERENCES mail_signatures(id) ON DELETE SET NULL;
    END IF;
  END $$;
`;

const CALENDAR_AVAILABILITY_SCHEMA_SQL = String.raw`
  ALTER TABLE calendar_events
    ADD COLUMN IF NOT EXISTS availability text NOT NULL DEFAULT 'busy'
    CHECK (availability IN ('free', 'tentative', 'busy', 'oof', 'working_elsewhere'));
`;

const MAIL_MESSAGE_BODY_CACHE_SCHEMA_SQL = String.raw`
  CREATE TABLE IF NOT EXISTS mail_message_bodies (
    message_id text PRIMARY KEY REFERENCES mail_messages(id) ON DELETE CASCADE,
    text_body text,
    html_body text,
    loaded_at timestamptz NOT NULL DEFAULT now(),
    cache_version integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  INSERT INTO mail_message_bodies (
    message_id, text_body, html_body, loaded_at, cache_version, updated_at
  )
  SELECT id, text_body, html_body,
         COALESCE(body_loaded_at, updated_at, now()),
         body_cache_version,
         updated_at
    FROM mail_messages
   WHERE body_loaded_at IS NOT NULL OR text_body IS NOT NULL OR html_body IS NOT NULL
  ON CONFLICT (message_id) DO UPDATE SET
    text_body = EXCLUDED.text_body,
    html_body = EXCLUDED.html_body,
    loaded_at = EXCLUDED.loaded_at,
    cache_version = EXCLUDED.cache_version,
    updated_at = EXCLUDED.updated_at;

  DROP INDEX IF EXISTS mail_messages_search_idx;
  ALTER TABLE mail_messages DROP COLUMN IF EXISTS text_body;
  ALTER TABLE mail_messages DROP COLUMN IF EXISTS html_body;
  ALTER TABLE mail_messages DROP COLUMN IF EXISTS body_loaded_at;
  ALTER TABLE mail_messages DROP COLUMN IF EXISTS body_cache_version;

  CREATE INDEX IF NOT EXISTS mail_message_bodies_loaded_idx
    ON mail_message_bodies (loaded_at, message_id);
  CREATE INDEX IF NOT EXISTS mail_message_bodies_search_idx ON mail_message_bodies USING gin (
    to_tsvector('simple', coalesce(text_body, '') || ' ' || coalesce(html_body, ''))
  );
  CREATE INDEX IF NOT EXISTS mail_messages_search_idx ON mail_messages USING gin (
    to_tsvector('simple',
      coalesce(subject, '') || ' ' ||
      coalesce(snippet, '') || ' ' ||
      coalesce(from_address->>'name', '') || ' ' ||
      coalesce(from_address->>'address', '') || ' ' ||
      coalesce(attachments::text, '')
    )
  );
`;

const MAIL_MESSAGE_METADATA_COMPACTION_SQL = String.raw`
  CLUSTER mail_messages USING mail_messages_pkey;
  ANALYZE mail_messages;
`;

const REALTIME_EVENTS_SCHEMA_SQL = String.raw`
  CREATE OR REPLACE FUNCTION kalender_notify_realtime_topic()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    PERFORM pg_notify(
      'kalender_realtime',
      json_build_object(
        'topic', TG_ARGV[0],
        'action', lower(TG_OP)
      )::text
    );
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END;
  $$;

  CREATE OR REPLACE FUNCTION kalender_notify_realtime_job()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    job app_jobs%ROWTYPE;
  BEGIN
    IF TG_OP = 'DELETE' THEN
      job := OLD;
    ELSE
      job := NEW;
    END IF;
    PERFORM pg_notify(
      'kalender_realtime',
      json_build_object(
        'topic', 'job',
        'action', lower(TG_OP),
        'entityId', job.id,
        'userId', job.user_id,
        'kind', job.kind,
        'status', job.status,
        'progress', job.progress
      )::text
    );
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END;
  $$;

  DROP TRIGGER IF EXISTS kalender_realtime_accounts ON accounts;
  CREATE TRIGGER kalender_realtime_accounts
    AFTER INSERT OR UPDATE OR DELETE ON accounts
    FOR EACH ROW EXECUTE FUNCTION kalender_notify_realtime_topic('mail');

  DROP TRIGGER IF EXISTS kalender_realtime_mail_folders ON mail_folders;
  CREATE TRIGGER kalender_realtime_mail_folders
    AFTER INSERT OR UPDATE OR DELETE ON mail_folders
    FOR EACH ROW EXECUTE FUNCTION kalender_notify_realtime_topic('mail');

  DROP TRIGGER IF EXISTS kalender_realtime_mail_threads ON mail_threads;
  CREATE TRIGGER kalender_realtime_mail_threads
    AFTER INSERT OR UPDATE OR DELETE ON mail_threads
    FOR EACH ROW EXECUTE FUNCTION kalender_notify_realtime_topic('mail');

  DROP TRIGGER IF EXISTS kalender_realtime_mail_messages ON mail_messages;
  CREATE TRIGGER kalender_realtime_mail_messages
    AFTER INSERT OR UPDATE OR DELETE ON mail_messages
    FOR EACH ROW EXECUTE FUNCTION kalender_notify_realtime_topic('mail');

  DROP TRIGGER IF EXISTS kalender_realtime_mail_drafts ON mail_drafts;
  CREATE TRIGGER kalender_realtime_mail_drafts
    AFTER INSERT OR UPDATE OR DELETE ON mail_drafts
    FOR EACH ROW EXECUTE FUNCTION kalender_notify_realtime_topic('mail');

  DROP TRIGGER IF EXISTS kalender_realtime_mail_signatures ON mail_signatures;
  CREATE TRIGGER kalender_realtime_mail_signatures
    AFTER INSERT OR UPDATE OR DELETE ON mail_signatures
    FOR EACH ROW EXECUTE FUNCTION kalender_notify_realtime_topic('mail');

  DROP TRIGGER IF EXISTS kalender_realtime_sync_runs ON sync_runs;
  CREATE TRIGGER kalender_realtime_sync_runs
    AFTER INSERT OR UPDATE OR DELETE ON sync_runs
    FOR EACH ROW EXECUTE FUNCTION kalender_notify_realtime_topic('mail');

  DROP TRIGGER IF EXISTS kalender_realtime_calendar_accounts ON calendar_accounts;
  CREATE TRIGGER kalender_realtime_calendar_accounts
    AFTER INSERT OR UPDATE OR DELETE ON calendar_accounts
    FOR EACH ROW EXECUTE FUNCTION kalender_notify_realtime_topic('calendar');

  DROP TRIGGER IF EXISTS kalender_realtime_calendars ON calendars;
  CREATE TRIGGER kalender_realtime_calendars
    AFTER INSERT OR UPDATE OR DELETE ON calendars
    FOR EACH ROW EXECUTE FUNCTION kalender_notify_realtime_topic('calendar');

  DROP TRIGGER IF EXISTS kalender_realtime_calendar_events ON calendar_events;
  CREATE TRIGGER kalender_realtime_calendar_events
    AFTER INSERT OR UPDATE OR DELETE ON calendar_events
    FOR EACH ROW EXECUTE FUNCTION kalender_notify_realtime_topic('calendar');

  DROP TRIGGER IF EXISTS kalender_realtime_tasks ON tasks;
  CREATE TRIGGER kalender_realtime_tasks
    AFTER INSERT OR UPDATE OR DELETE ON tasks
    FOR EACH ROW EXECUTE FUNCTION kalender_notify_realtime_topic('task');

  DROP TRIGGER IF EXISTS kalender_realtime_projects ON projects;
  CREATE TRIGGER kalender_realtime_projects
    AFTER INSERT OR UPDATE OR DELETE ON projects
    FOR EACH ROW EXECUTE FUNCTION kalender_notify_realtime_topic('project');

  DROP TRIGGER IF EXISTS kalender_realtime_project_phases ON project_phases;
  CREATE TRIGGER kalender_realtime_project_phases
    AFTER INSERT OR UPDATE OR DELETE ON project_phases
    FOR EACH ROW EXECUTE FUNCTION kalender_notify_realtime_topic('project');

  DROP TRIGGER IF EXISTS kalender_realtime_project_milestones ON project_milestones;
  CREATE TRIGGER kalender_realtime_project_milestones
    AFTER INSERT OR UPDATE OR DELETE ON project_milestones
    FOR EACH ROW EXECUTE FUNCTION kalender_notify_realtime_topic('project');

  DROP TRIGGER IF EXISTS kalender_realtime_project_members ON project_members;
  CREATE TRIGGER kalender_realtime_project_members
    AFTER INSERT OR UPDATE OR DELETE ON project_members
    FOR EACH ROW EXECUTE FUNCTION kalender_notify_realtime_topic('project');

  DROP TRIGGER IF EXISTS kalender_realtime_notes ON notes;
  CREATE TRIGGER kalender_realtime_notes
    AFTER INSERT OR UPDATE OR DELETE ON notes
    FOR EACH ROW EXECUTE FUNCTION kalender_notify_realtime_topic('note');

  DROP TRIGGER IF EXISTS kalender_realtime_entity_links ON entity_links;
  CREATE TRIGGER kalender_realtime_entity_links
    AFTER INSERT OR UPDATE OR DELETE ON entity_links
    FOR EACH ROW EXECUTE FUNCTION kalender_notify_realtime_topic('relation');

  DROP TRIGGER IF EXISTS kalender_realtime_app_jobs ON app_jobs;
  CREATE TRIGGER kalender_realtime_app_jobs
    AFTER INSERT OR UPDATE OR DELETE ON app_jobs
    FOR EACH ROW EXECUTE FUNCTION kalender_notify_realtime_job();

  DROP TRIGGER IF EXISTS kalender_realtime_backup_artifacts ON backup_artifacts;
  CREATE TRIGGER kalender_realtime_backup_artifacts
    AFTER INSERT OR UPDATE OR DELETE ON backup_artifacts
    FOR EACH ROW EXECUTE FUNCTION kalender_notify_realtime_topic('backup');

  DROP TRIGGER IF EXISTS kalender_realtime_backup_settings ON backup_settings;
  CREATE TRIGGER kalender_realtime_backup_settings
    AFTER INSERT OR UPDATE OR DELETE ON backup_settings
    FOR EACH ROW EXECUTE FUNCTION kalender_notify_realtime_topic('backup');

  DROP TRIGGER IF EXISTS kalender_realtime_sync_settings ON sync_settings;
  CREATE TRIGGER kalender_realtime_sync_settings
    AFTER INSERT OR UPDATE OR DELETE ON sync_settings
    FOR EACH ROW EXECUTE FUNCTION kalender_notify_realtime_topic('settings');
`;

const REALTIME_ENTITY_EVENTS_SCHEMA_SQL = String.raw`
  CREATE OR REPLACE FUNCTION kalender_notify_realtime_topic()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    row_data jsonb;
  BEGIN
    IF TG_OP = 'DELETE' THEN
      row_data := to_jsonb(OLD);
    ELSE
      row_data := to_jsonb(NEW);
    END IF;
    PERFORM pg_notify(
      'kalender_realtime',
      json_strip_nulls(json_build_object(
        'topic', TG_ARGV[0],
        'action', lower(TG_OP),
        'entityType', TG_TABLE_NAME,
        'entityId', row_data->>'id',
        'userId', row_data->>'user_id'
      ))::text
    );
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END;
  $$;

  CREATE OR REPLACE FUNCTION kalender_notify_realtime_job()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    job app_jobs%ROWTYPE;
  BEGIN
    IF TG_OP = 'DELETE' THEN
      job := OLD;
    ELSE
      job := NEW;
    END IF;
    PERFORM pg_notify(
      'kalender_realtime',
      json_build_object(
        'topic', 'job',
        'action', lower(TG_OP),
        'entityType', TG_TABLE_NAME,
        'entityId', job.id,
        'userId', job.user_id,
        'kind', job.kind,
        'status', job.status,
        'progress', job.progress
      )::text
    );
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END;
  $$;
`;

const AUTOMATIC_BACKUP_RETENTION_THREE_SQL = String.raw`
  ALTER TABLE backup_settings
    ALTER COLUMN retention_count SET DEFAULT 3;

  UPDATE backup_settings
     SET retention_count = 3,
         updated_at = now()
   WHERE id = 'workspace'
     AND retention_count = 14;
`;

const AUTOMATIC_BACKUP_ENCRYPTION_OPT_IN_SQL = String.raw`
  ALTER TABLE backup_settings
    ALTER COLUMN encrypt_automatic SET DEFAULT false;

  UPDATE backup_settings
     SET encrypt_automatic = false,
         updated_at = now()
   WHERE id = 'workspace'
     AND enabled = false
     AND encrypt_automatic = true
     AND updated_by_user_id IS NULL
     AND last_enqueued_at IS NULL
     AND last_completed_at IS NULL;
`;

const USER_PREFERENCES_SCHEMA_SQL = String.raw`
  CREATE TABLE IF NOT EXISTS user_preferences (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    preference_key text NOT NULL CHECK (length(preference_key) BETWEEN 1 AND 120),
    preference_value jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, preference_key)
  );

  CREATE INDEX IF NOT EXISTS user_preferences_user_key_idx
    ON user_preferences (user_id, preference_key);

  DROP TRIGGER IF EXISTS kalender_realtime_user_preferences ON user_preferences;
  CREATE TRIGGER kalender_realtime_user_preferences
    AFTER INSERT OR UPDATE OR DELETE ON user_preferences
    FOR EACH ROW EXECUTE FUNCTION kalender_notify_realtime_topic('settings');
`;

const PROJECT_SORT_ORDER_SCHEMA_SQL = String.raw`
  ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;

  WITH ordered AS (
    SELECT id, row_number() OVER (
      PARTITION BY user_id, status, coalesce(area_name, '')
      ORDER BY (status = 'archived'), updated_at DESC, name, id
    ) AS position
      FROM projects
  )
  UPDATE projects p
     SET sort_order = ordered.position * 1000
    FROM ordered
   WHERE p.id = ordered.id
     AND p.sort_order = 0;

  CREATE INDEX IF NOT EXISTS projects_sidebar_order_idx
    ON projects (user_id, status, coalesce(area_name, ''), sort_order, name);
`;

const PROJECT_MILESTONE_PHASES_SCHEMA_SQL = String.raw`
  ALTER TABLE project_milestones
    ADD COLUMN IF NOT EXISTS phase_id text REFERENCES project_phases(id) ON DELETE SET NULL;

  CREATE INDEX IF NOT EXISTS project_milestones_project_phase_due_idx
    ON project_milestones (project_id, phase_id, status, due_on, sort_order);
`;

const PROJECT_GANTT_ITEM_ORDER_SCHEMA_SQL = String.raw`
  ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS gantt_sort_order integer NOT NULL DEFAULT 0;

  WITH ordered AS (
    SELECT id, row_number() OVER (
      PARTITION BY project_id, phase_id
      ORDER BY planned_start ASC NULLS LAST, created_at, id
    ) AS position
      FROM tasks
     WHERE project_id IS NOT NULL
  )
  UPDATE tasks t
     SET gantt_sort_order = ordered.position * 1000
    FROM ordered
   WHERE t.id = ordered.id
     AND t.gantt_sort_order = 0;

  WITH ordered AS (
    SELECT id, row_number() OVER (
      PARTITION BY project_id, phase_id
      ORDER BY due_on ASC NULLS LAST, created_at, id
    ) AS position
      FROM project_milestones
  )
  UPDATE project_milestones milestone
     SET sort_order = ordered.position * 1000
    FROM ordered
   WHERE milestone.id = ordered.id
     AND milestone.sort_order = 0;

  CREATE INDEX IF NOT EXISTS tasks_project_phase_gantt_order_idx
    ON tasks (project_id, phase_id, gantt_sort_order, created_at);
`;

const EDITOR_ASSETS_SCHEMA_SQL = String.raw`
  CREATE TABLE IF NOT EXISTS editor_assets (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    filename text NOT NULL,
    mime_type text NOT NULL,
    size_bytes integer NOT NULL CHECK (size_bytes > 0),
    content bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS editor_assets_user_created_idx
    ON editor_assets (user_id, created_at DESC);
`;

const CALENDAR_EVENT_REMINDERS_SCHEMA_SQL = String.raw`
  ALTER TABLE calendar_events
    ADD COLUMN IF NOT EXISTS reminder_minutes_before integer;

  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'calendar_events_reminder_minutes_check'
    ) THEN
      ALTER TABLE calendar_events
        ADD CONSTRAINT calendar_events_reminder_minutes_check
        CHECK (reminder_minutes_before IS NULL OR reminder_minutes_before IN (0, 5, 15, 30, 60, 1440));
    END IF;
  END $$;
`;

// Keep this definition identical to the migration already released by the
// German UI branch so databases upgraded there remain readable by main.
const GERMAN_DEFAULT_CALENDAR_NAME_SQL = String.raw`
  UPDATE calendars
     SET name = 'Persönlicher Kalender'
   WHERE provider_id = 'local-calendar'
     AND provider_calendar_id = 'personal'
     AND name = '个人日历';
`;

export const DATABASE_MIGRATIONS = [
  { version: 1, name: "initial-workspace-schema", sql: INITIAL_SCHEMA_SQL },
  { version: 2, name: "exchange-ai-and-relations", sql: FEATURE_SCHEMA_SQL },
  { version: 3, name: "mail-sync-deep-reconciliation", sql: SYNC_STABILITY_SCHEMA_SQL },
  { version: 4, name: "project-task-links", sql: PROJECT_TASK_LINKS_SCHEMA_SQL },
  { version: 5, name: "project-milestones", sql: PROJECT_MILESTONES_SCHEMA_SQL },
  { version: 6, name: "project-gantt", sql: PROJECT_GANTT_SCHEMA_SQL },
  { version: 7, name: "project-entity-links", sql: PROJECT_ENTITY_LINKS_SCHEMA_SQL },
  { version: 8, name: "project-phases-and-auto-schedule", sql: PROJECT_PHASES_AND_AUTO_SCHEDULE_SCHEMA_SQL },
  { version: 9, name: "mail-query-performance", sql: MAIL_QUERY_PERFORMANCE_SCHEMA_SQL },
  { version: 10, name: "workspace-query-performance", sql: WORKSPACE_QUERY_PERFORMANCE_SCHEMA_SQL },
  { version: 11, name: "app-auth-users", sql: APP_AUTH_SCHEMA_SQL },
  { version: 12, name: "user-data-isolation", sql: USER_DATA_ISOLATION_SCHEMA_SQL },
  { version: 13, name: "auth-security-and-audit", sql: AUTH_SECURITY_SCHEMA_SQL },
  { version: 14, name: "roles-invitations-and-project-collaboration", sql: COLLABORATION_SCHEMA_SQL },
  { version: 15, name: "operations-backup-ai-search", sql: OPERATIONS_BACKUP_AI_SEARCH_SCHEMA_SQL },
  { version: 16, name: "automatic-backup-settings", sql: AUTOMATIC_BACKUP_SETTINGS_SCHEMA_SQL },
  { version: 17, name: "local-calendar-recurrence", sql: CALENDAR_RECURRENCE_SCHEMA_SQL },
  { version: 18, name: "calendar-rich-description", sql: CALENDAR_RICH_DESCRIPTION_SCHEMA_SQL },
  { version: 19, name: "workspace-sync-settings", sql: WORKSPACE_SYNC_SETTINGS_SCHEMA_SQL },
  { version: 20, name: "mail-signature-versions", sql: MAIL_SIGNATURES_SCHEMA_SQL },
  { version: 21, name: "calendar-event-availability", sql: CALENDAR_AVAILABILITY_SCHEMA_SQL },
  { version: 22, name: "mail-message-body-cache", sql: MAIL_MESSAGE_BODY_CACHE_SCHEMA_SQL },
  { version: 23, name: "compact-mail-message-metadata", sql: MAIL_MESSAGE_METADATA_COMPACTION_SQL },
  { version: 24, name: "workspace-realtime-events", sql: REALTIME_EVENTS_SCHEMA_SQL },
  { version: 25, name: "workspace-realtime-entity-events", sql: REALTIME_ENTITY_EVENTS_SCHEMA_SQL },
  { version: 26, name: "automatic-backup-retention-three", sql: AUTOMATIC_BACKUP_RETENTION_THREE_SQL },
  { version: 27, name: "user-ui-preferences", sql: USER_PREFERENCES_SCHEMA_SQL },
  { version: 28, name: "project-sort-order", sql: PROJECT_SORT_ORDER_SCHEMA_SQL },
  { version: 29, name: "project-milestone-phases", sql: PROJECT_MILESTONE_PHASES_SCHEMA_SQL },
  { version: 30, name: "project-gantt-item-order", sql: PROJECT_GANTT_ITEM_ORDER_SCHEMA_SQL },
  { version: 31, name: "automatic-backup-encryption-opt-in", sql: AUTOMATIC_BACKUP_ENCRYPTION_OPT_IN_SQL },
  { version: 32, name: "persistent-editor-assets", sql: EDITOR_ASSETS_SCHEMA_SQL },
  { version: 33, name: "calendar-event-reminders", sql: CALENDAR_EVENT_REMINDERS_SCHEMA_SQL },
  { version: 34, name: "german-default-calendar-name", sql: GERMAN_DEFAULT_CALENDAR_NAME_SQL },
] as const satisfies readonly DatabaseMigration[];

export const LATEST_DATABASE_SCHEMA_VERSION = DATABASE_MIGRATIONS.at(-1)!.version;

export async function getSchemaMigrationStatus(): Promise<DatabaseMigrationStatus> {
  return inspectDatabaseMigrationStatus(await getDatabase(), DATABASE_MIGRATIONS);
}

async function ensureLatestSchema(database: KalenderDatabase): Promise<void> {
  await runDatabaseMigrations(database, DATABASE_MIGRATIONS);
}

async function initializeDatabase(): Promise<KalenderDatabase> {
  loadLocalEnvFile();
  await configureTestDatabase();
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is required. Dayline uses PostgreSQL only.");
  return initializePostgresDatabase(connectionString);
}

async function configureTestDatabase(): Promise<void> {
  if (globalThis.kalenderTestDatabase) return;
  const root = process.env.KALENDER_DATA_DIR;
  if (!root) return;
  const basename = path.basename(root);
  if (!basename.startsWith("kalender-") || !basename.includes("-test-")) return;
  const templateUrl = process.env.DATABASE_URL?.trim();
  if (!templateUrl) return;
  const databaseName = `kalender_test_${createHash("sha1").update(path.resolve(root)).digest("hex")}`;
  const adminUrl = databaseUrlWithName(templateUrl, "postgres");
  const admin = new Pool({ connectionString: adminUrl });
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  } catch (error) {
    if (!isDuplicateDatabaseError(error)) throw error;
  } finally {
    await admin.end();
  }
  process.env.DATABASE_URL = databaseUrlWithName(templateUrl, databaseName);
  globalThis.kalenderTestDatabase = { adminUrl, databaseName };
}

async function dropTestDatabaseIfNeeded(): Promise<void> {
  const testDatabase = globalThis.kalenderTestDatabase;
  if (!testDatabase) return;
  globalThis.kalenderTestDatabase = undefined;
  const admin = new Pool({ connectionString: testDatabase.adminUrl });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(testDatabase.databaseName)} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

function databaseUrlWithName(value: string, databaseName: string): string {
  const url = new URL(value);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function isDuplicateDatabaseError(error: unknown): boolean {
  return (error as { readonly code?: unknown }).code === "42P04";
}

function loadLocalEnvFile(): void {
  const envPath = path.join(workspaceRoot(), ".env");
  let content: string;
  try {
    content = readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

async function initializePostgresDatabase(connectionString: string): Promise<KalenderDatabase> {
  const pool = new Pool({
    connectionString,
    max: Number(process.env.KALENDER_DATABASE_POOL_MAX ?? 10),
  });
  const database = new PostgresKalenderDatabase(pool);
  try {
    await database.query("SELECT 1");
    return database;
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
}

class PostgresKalenderDatabase implements KalenderDatabase {
  readonly engine = "postgres" as const;
  #closed = false;

  constructor(private readonly pool: pg.Pool) {}

  get closed(): boolean {
    return this.#closed;
  }

  async query<T>(query: string, params: readonly unknown[] = []): Promise<DatabaseQueryResult<T>> {
    const result = await this.pool.query(query, [...params]);
    return { rows: result.rows as T[], affectedRows: result.rowCount ?? undefined };
  }

  async exec(query: string): Promise<unknown> {
    return this.pool.query(query);
  }

  async transaction<T>(callback: (transaction: DatabaseExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(new PostgresTransaction(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.pool.end();
  }
}

class PostgresTransaction implements DatabaseExecutor {
  constructor(private readonly client: pg.PoolClient) {}

  async query<T>(query: string, params: readonly unknown[] = []): Promise<DatabaseQueryResult<T>> {
    const result = await this.client.query(query, [...params]);
    return { rows: result.rows as T[], affectedRows: result.rowCount ?? undefined };
  }

  async exec(query: string): Promise<unknown> {
    return this.client.query(query);
  }
}

function registerDatabaseExitHandlers(): void {
  if (globalThis.kalenderDatabaseExitHandlersRegistered) return;
  globalThis.kalenderDatabaseExitHandlersRegistered = true;
  const shutdown = (signal: "SIGINT" | "SIGTERM") => {
    void closeDatabaseForRestore()
      .catch(() => undefined)
      .finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}
