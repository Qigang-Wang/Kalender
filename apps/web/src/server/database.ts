import { readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";

import {
  getDatabaseMigrationStatus as inspectDatabaseMigrationStatus,
  runDatabaseMigrations,
  type DatabaseMigration,
  type DatabaseMigrationContext,
  type DatabaseMigrationStatus,
} from "./database-migrations";

declare global {
  var kalenderDatabase: Promise<PGlite> | undefined;
  var kalenderDatabaseMigrations: Promise<void> | undefined;
  var kalenderDatabaseProcessLock: DatabaseProcessLock | undefined;
  var kalenderDatabaseExitHandlersRegistered: boolean | undefined;
}

interface DatabaseProcessLock {
  readonly path: string;
  readonly token: string;
  readonly pid: number;
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

export async function getDatabase(): Promise<PGlite> {
  try {
    globalThis.kalenderDatabase ??= initializeDatabase();
    const database = await globalThis.kalenderDatabase;
    globalThis.kalenderDatabaseMigrations ??= ensureLatestSchema(database);
    await globalThis.kalenderDatabaseMigrations;
    return database;
  } catch (error) {
    globalThis.kalenderDatabase = undefined;
    globalThis.kalenderDatabaseMigrations = undefined;
    await releaseDatabaseProcessLock();
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
    await releaseDatabaseProcessLock();
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
] as const satisfies readonly DatabaseMigration[];

export const LATEST_DATABASE_SCHEMA_VERSION = DATABASE_MIGRATIONS.at(-1)!.version;

export async function getSchemaMigrationStatus(): Promise<DatabaseMigrationStatus> {
  return inspectDatabaseMigrationStatus(await getDatabase(), DATABASE_MIGRATIONS);
}

async function ensureLatestSchema(database: PGlite): Promise<void> {
  await runDatabaseMigrations(database, DATABASE_MIGRATIONS, {
    beforeMigrate: async (context) => createMigrationRecoveryPoint(database, context),
  });
}

async function createMigrationRecoveryPoint(
  database: PGlite,
  context: DatabaseMigrationContext,
): Promise<void> {
  if (!context.hadExistingSchema) return;
  const createdAt = new Date().toISOString();
  const stamp = createdAt.replace(/[:.]/g, "-");
  const directory = path.join(dataRoot(), "automatic-backups");
  const basename = `pre-migration-v${context.currentVersion}-to-v${context.latestVersion}-${stamp}`;
  const archivePath = path.join(directory, `${basename}.tgz`);
  const manifestPath = path.join(directory, `${basename}.json`);
  await mkdir(directory, { recursive: true });
  try {
    const dump = await database.dumpDataDir("gzip");
    const bytes = Buffer.from(await dump.arrayBuffer());
    await writeFile(archivePath, bytes, { flag: "wx", mode: 0o600 });
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        format: "kalender-database-migration-recovery",
        createdAt,
        fromVersion: context.currentVersion,
        toVersion: context.latestVersion,
        pendingVersions: context.pending.map((migration) => migration.version),
        databaseArchive: `${basename}.tgz`,
      }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    await Promise.all([
      rm(archivePath, { force: true }),
      rm(manifestPath, { force: true }),
    ]);
    throw error;
  }
}

async function initializeDatabase(): Promise<PGlite> {
  const root = dataRoot();
  await mkdir(root, { recursive: true });
  await acquireDatabaseProcessLock(root);
  try {
    return await PGlite.create(path.join(root, "postgres"));
  } catch (error) {
    await releaseDatabaseProcessLock();
    throw error;
  }
}

async function acquireDatabaseProcessLock(root: string): Promise<void> {
  if (globalThis.kalenderDatabaseProcessLock) return;
  const lockPath = path.join(root, "kalender-database.lock");
  const token = randomUUID();
  const lock = { path: lockPath, token, pid: process.pid } satisfies DatabaseProcessLock;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({
          pid: lock.pid,
          token: lock.token,
          createdAt: new Date().toISOString(),
          workspace: workspaceRoot(),
        })}\n`);
      } finally {
        await handle.close();
      }
      globalThis.kalenderDatabaseProcessLock = lock;
      registerDatabaseExitHandlers();
      return;
    } catch (error) {
      if (!isFileAlreadyExistsError(error)) throw error;
      const existing = await readDatabaseProcessLock(lockPath);
      if (existing?.pid && isProcessAlive(existing.pid)) {
        throw new Error(`数据库正在被另一个 Kalender 进程使用（PID ${existing.pid}）`);
      }
      await rm(lockPath, { force: true });
    }
  }
  throw new Error("无法获取 Kalender 数据库单实例锁");
}

async function releaseDatabaseProcessLock(): Promise<void> {
  const lock = globalThis.kalenderDatabaseProcessLock;
  if (!lock) return;
  globalThis.kalenderDatabaseProcessLock = undefined;
  try {
    const existing = await readDatabaseProcessLock(lock.path);
    if (existing?.token === lock.token) await rm(lock.path, { force: true });
  } catch {
    // The process is shutting down; a stale lock is safely reclaimed on the next start.
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
  process.once("exit", releaseDatabaseProcessLockSync);
}

function releaseDatabaseProcessLockSync(): void {
  const lock = globalThis.kalenderDatabaseProcessLock;
  if (!lock) return;
  try {
    const existing = JSON.parse(readFileSync(lock.path, "utf8")) as { token?: unknown };
    if (existing.token === lock.token) unlinkSync(lock.path);
  } catch {
    // The lock may already be gone after a graceful shutdown.
  }
  globalThis.kalenderDatabaseProcessLock = undefined;
}

async function readDatabaseProcessLock(lockPath: string): Promise<{ readonly pid?: number; readonly token?: string } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as { readonly pid?: unknown; readonly token?: unknown };
    return {
      pid: typeof parsed.pid === "number" && Number.isInteger(parsed.pid) ? parsed.pid : undefined,
      token: typeof parsed.token === "string" ? parsed.token : undefined,
    };
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isFileAlreadyExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}
