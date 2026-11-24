// Catalog queries (PostgreSQL). All user-supplied names are bound as Data API parameters.

export const SQL_SCHEMAS = `
SELECT n.nspname AS name
FROM pg_namespace n
WHERE n.nspname NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
  AND n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast_temp%'
  AND has_schema_privilege(n.oid, 'USAGE')
ORDER BY 1`;

/** Top-level relations; partitions are folded under their parent with a summed row estimate. */
export const SQL_RELATIONS = `
SELECT c.relname AS name,
       c.relkind::text AS kind,
       CASE WHEN c.relkind = 'p' THEN
              (SELECT COALESCE(sum(GREATEST(ch.reltuples, 0)), 0) FROM pg_inherits i JOIN pg_class ch ON ch.oid = i.inhrelid WHERE i.inhparent = c.oid)
            ELSE GREATEST(c.reltuples, 0) END::bigint AS estimate,
       (SELECT count(*) FROM pg_inherits i WHERE i.inhparent = c.oid)::int AS partitions,
       obj_description(c.oid, 'pg_class') AS comment
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = :schema AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition
ORDER BY c.relname`;

export const SQL_PARTITIONS = `
SELECT cn.nspname AS schema, ch.relname AS name, ch.relkind::text AS kind,
       GREATEST(ch.reltuples, 0)::bigint AS estimate,
       pg_get_expr(ch.relpartbound, ch.oid) AS bound
FROM pg_inherits i
JOIN pg_class ch ON ch.oid = i.inhrelid
JOIN pg_namespace cn ON cn.oid = ch.relnamespace
JOIN pg_class p ON p.oid = i.inhparent
JOIN pg_namespace n ON n.oid = p.relnamespace
WHERE n.nspname = :schema AND p.relname = :table
ORDER BY ch.relname`;

export const SQL_COLUMNS = `
SELECT a.attname AS name,
       format_type(a.atttypid, a.atttypmod) AS type,
       a.attnotnull AS not_null,
       pg_get_expr(d.adbin, d.adrelid) AS default_value,
       EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'p' AND a.attnum = ANY (k.conkey)) AS is_pk,
       EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'f' AND a.attnum = ANY (k.conkey)) AS is_fk,
       col_description(c.oid, a.attnum) AS comment
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE n.nspname = :schema AND c.relname = :table AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum`;

export const SQL_RELATION_INFO = `
SELECT c.relkind::text AS kind,
       CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END AS partition_key,
       CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) END AS view_definition,
       obj_description(c.oid, 'pg_class') AS comment
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = :schema AND c.relname = :table`;

export const SQL_CONSTRAINTS = `
SELECT k.conname AS name, k.contype::text AS type, pg_get_constraintdef(k.oid, true) AS definition
FROM pg_constraint k
JOIN pg_class c ON c.oid = k.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = :schema AND c.relname = :table AND k.contype IN ('p', 'u', 'f', 'c', 'x')
ORDER BY k.contype, k.conname`;

/** Indexes that are not already implied by a PRIMARY KEY / UNIQUE / EXCLUDE constraint. */
export const SQL_INDEXES = `
SELECT pg_get_indexdef(i.indexrelid) AS definition
FROM pg_index i
JOIN pg_class c ON c.oid = i.indrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = :schema AND c.relname = :table
  AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid AND k.contype IN ('p', 'u', 'x'))
ORDER BY 1`;

export const SQL_IDENTITY = `
SELECT current_user AS db_user, current_database() AS database, split_part(version(), ' on ', 1) AS version`;

// ---- Database health (runs with the connection's own database privileges; no extra IAM) ----

export const SQL_DB_OVERVIEW = `
SELECT pg_database_size(current_database())::bigint AS size_bytes,
       (SELECT round(100.0 * blks_hit / NULLIF(blks_hit + blks_read, 0), 2) FROM pg_stat_database WHERE datname = current_database()) AS cache_hit_pct,
       (SELECT xact_commit + xact_rollback FROM pg_stat_database WHERE datname = current_database())::bigint AS transactions,
       (SELECT deadlocks FROM pg_stat_database WHERE datname = current_database())::bigint AS deadlocks,
       current_setting('max_connections')::int AS max_connections,
       split_part(version(), ' on ', 1) AS version`;

export const SQL_DB_SESSIONS = `
SELECT COALESCE(state, 'background') AS state, count(*)::int AS sessions
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY 1
ORDER BY 2 DESC`;

export const SQL_DB_LONG_RUNNING = `
SELECT pid, usename AS db_user, state,
       EXTRACT(EPOCH FROM now() - query_start)::int AS seconds,
       wait_event_type AS waiting_on,
       left(regexp_replace(query, '\\s+', ' ', 'g'), 300) AS query
FROM pg_stat_activity
WHERE datname = current_database() AND state <> 'idle' AND pid <> pg_backend_pid() AND query_start IS NOT NULL
ORDER BY query_start
LIMIT 10`;

export const SQL_DB_LARGEST_TABLES = `
SELECT n.nspname AS schema, c.relname AS name,
       pg_total_relation_size(c.oid)::bigint AS bytes,
       GREATEST(c.reltuples, 0)::bigint AS estimate
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'm') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
ORDER BY pg_total_relation_size(c.oid) DESC
LIMIT 10`;

export const SQL_DB_TOP_STATEMENTS = `
SELECT left(regexp_replace(query, '\\s+', ' ', 'g'), 300) AS query, calls::bigint AS calls,
       round(total_exec_time::numeric, 1) AS total_ms, round(mean_exec_time::numeric, 2) AS mean_ms, rows::bigint AS rows
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
ORDER BY total_exec_time DESC
LIMIT 10`;

// ---------------- Aurora MySQL (information_schema / performance_schema) ----------------
// Column aliases are lower case so results map onto the same shapes as PostgreSQL.

const MY_SYSTEM = "('mysql', 'information_schema', 'performance_schema', 'sys')";

export const MY_SCHEMAS = `
SELECT schema_name AS name FROM information_schema.schemata
WHERE schema_name NOT IN ${MY_SYSTEM}
ORDER BY 1`;

/** MySQL partitions are not separate tables, so the parent's partition count comes from information_schema.partitions. */
export const MY_RELATIONS = `
SELECT t.table_name AS name,
       CASE WHEN t.table_type = 'VIEW' THEN 'v'
            WHEN (SELECT COUNT(*) FROM information_schema.partitions p
                  WHERE p.table_schema = t.table_schema AND p.table_name = t.table_name AND p.partition_name IS NOT NULL) > 0 THEN 'p'
            ELSE 'r' END AS kind,
       COALESCE(t.table_rows, 0) AS estimate,
       (SELECT COUNT(*) FROM information_schema.partitions p
        WHERE p.table_schema = t.table_schema AND p.table_name = t.table_name AND p.partition_name IS NOT NULL) AS partitions,
       NULLIF(t.table_comment, '') AS comment
FROM information_schema.tables t
WHERE t.table_schema = :schema
ORDER BY t.table_name`;

export const MY_PARTITIONS = `
SELECT table_schema AS \`schema\`, partition_name AS name, 'x' AS kind, COALESCE(table_rows, 0) AS estimate,
       CONCAT(partition_method, ' ', COALESCE(partition_description, '')) AS bound
FROM information_schema.partitions
WHERE table_schema = :schema AND table_name = :table AND partition_name IS NOT NULL
ORDER BY partition_ordinal_position`;

export const MY_COLUMNS = `
SELECT c.column_name AS name,
       c.column_type AS type,
       c.is_nullable = 'NO' AS not_null,
       c.column_default AS default_value,
       c.column_key = 'PRI' AS is_pk,
       EXISTS (SELECT 1 FROM information_schema.key_column_usage k
               WHERE k.table_schema = c.table_schema AND k.table_name = c.table_name
                 AND k.column_name = c.column_name AND k.referenced_table_name IS NOT NULL) AS is_fk,
       NULLIF(c.column_comment, '') AS comment
FROM information_schema.columns c
WHERE c.table_schema = :schema AND c.table_name = :table
ORDER BY c.ordinal_position`;

export const MY_IDENTITY = `
SELECT CURRENT_USER() AS db_user, DATABASE() AS \`database\`, CONCAT('MySQL ', VERSION()) AS version`;

export const MY_DB_OVERVIEW = `
SELECT (SELECT COALESCE(SUM(data_length + index_length), 0) FROM information_schema.tables WHERE table_schema = DATABASE()) AS size_bytes,
       (SELECT ROUND(100 * (1 - r.variable_value / NULLIF(q.variable_value, 0)), 2)
          FROM performance_schema.global_status r, performance_schema.global_status q
         WHERE r.variable_name = 'Innodb_buffer_pool_reads' AND q.variable_name = 'Innodb_buffer_pool_read_requests') AS cache_hit_pct,
       (SELECT SUM(variable_value) FROM performance_schema.global_status WHERE variable_name IN ('Com_commit', 'Com_rollback')) AS transactions,
       NULL AS deadlocks,
       @@max_connections AS max_connections,
       CONCAT('MySQL ', VERSION()) AS version`;

export const MY_DB_SESSIONS = `
SELECT CASE command WHEN 'Sleep' THEN 'idle' WHEN 'Query' THEN 'active' ELSE LOWER(command) END AS state, COUNT(*) AS sessions
FROM information_schema.processlist
GROUP BY 1
ORDER BY 2 DESC`;

export const MY_DB_LONG_RUNNING = `
SELECT id AS pid, user AS db_user, command AS state, time AS seconds, state AS waiting_on, LEFT(info, 300) AS query
FROM information_schema.processlist
WHERE command <> 'Sleep' AND id <> CONNECTION_ID() AND info IS NOT NULL
ORDER BY time DESC
LIMIT 10`;

export const MY_DB_LARGEST_TABLES = `
SELECT table_schema AS \`schema\`, table_name AS name, data_length + index_length AS bytes, COALESCE(table_rows, 0) AS estimate
FROM information_schema.tables
WHERE table_schema NOT IN ${MY_SYSTEM} AND table_type = 'BASE TABLE'
ORDER BY data_length + index_length DESC
LIMIT 10`;

/** Timers in performance_schema are picoseconds: divide by 1e9 for milliseconds. */
export const MY_DB_TOP_STATEMENTS = `
SELECT LEFT(digest_text, 300) AS query, count_star AS calls,
       ROUND(sum_timer_wait / 1e9, 1) AS total_ms, ROUND(avg_timer_wait / 1e9, 2) AS mean_ms, sum_rows_sent AS \`rows\`
FROM performance_schema.events_statements_summary_by_digest
WHERE schema_name = DATABASE()
ORDER BY sum_timer_wait DESC
LIMIT 10`;

export interface Catalog {
  schemas: string;
  relations: string;
  partitions: string;
  columns: string;
  identity: string;
  overview: string;
  sessions: string;
  running: string;
  largest: string;
  topStatements: string;
}

export const CATALOG: Record<'postgres' | 'mysql', Catalog> = {
  postgres: {
    schemas: SQL_SCHEMAS,
    relations: SQL_RELATIONS,
    partitions: SQL_PARTITIONS,
    columns: SQL_COLUMNS,
    identity: SQL_IDENTITY,
    overview: SQL_DB_OVERVIEW,
    sessions: SQL_DB_SESSIONS,
    running: SQL_DB_LONG_RUNNING,
    largest: SQL_DB_LARGEST_TABLES,
    topStatements: SQL_DB_TOP_STATEMENTS,
  },
  mysql: {
    schemas: MY_SCHEMAS,
    relations: MY_RELATIONS,
    partitions: MY_PARTITIONS,
    columns: MY_COLUMNS,
    identity: MY_IDENTITY,
    overview: MY_DB_OVERVIEW,
    sessions: MY_DB_SESSIONS,
    running: MY_DB_LONG_RUNNING,
    largest: MY_DB_LARGEST_TABLES,
    topStatements: MY_DB_TOP_STATEMENTS,
  },
};
