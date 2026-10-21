// PostgreSQL 에 접속해 스키마 조회와 쿼리 실행을 담당하는 드라이버

import pg from 'pg';
import Cursor from 'pg-cursor';
import type { Column, Driver, QueryResult, TableRef } from './driver.ts';
import { assertReadOnly, toPositionalParams } from './driver.ts';

const LIST_TABLES = `
SELECT table_schema AS "schema", table_name AS "name", table_type AS "type"
FROM information_schema.tables
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY table_schema, table_name
`;

const DESCRIBE_TABLE = `
SELECT
  c.column_name               AS "name",
  c.data_type                 AS "type",
  c.is_nullable               AS "nullable",
  c.character_maximum_length  AS "maxLength",
  c.column_default            AS "colDefault",
  (pk.column_name IS NOT NULL) AS "isPrimaryKey"
FROM information_schema.columns c
LEFT JOIN (
  SELECT ku.table_schema, ku.table_name, ku.column_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage ku
    ON tc.constraint_name = ku.constraint_name
   AND tc.table_schema    = ku.table_schema
  WHERE tc.constraint_type = 'PRIMARY KEY'
) pk
  ON pk.table_schema = c.table_schema
 AND pk.table_name   = c.table_name
 AND pk.column_name  = c.column_name
WHERE c.table_schema = $1 AND c.table_name = $2
ORDER BY c.ordinal_position
`;

/** 최대 maxRows+1 행을 받은 결과를 QueryResult 로 변환한다. */
function toQueryResult(all: unknown[][], fields: pg.FieldDef[], maxRows: number): QueryResult {
    const truncated = all.length > maxRows;
    const rows = truncated ? all.slice(0, maxRows) : all;

    return {
        columns: fields.map((f) => f.name),
        rows,
        rowCount: rows.length,
        truncated,
    };
}

export class PostgresDriver implements Driver {
    private pool?: pg.Pool;
    private readonly cfg: pg.PoolConfig;

    constructor(cfg: pg.PoolConfig) {
        this.cfg = cfg;
    }

    /**
     * pg.Pool 은 첫 쿼리에서 연결하므로 지연 연결이 기본이다.
     * 연결 실패는 쿼리별 에러로 나타나고 풀 자체는 재사용 가능하다.
     */
    private getPool(): pg.Pool {
        if (!this.pool) {
            this.pool = new pg.Pool(this.cfg);
            // 유휴 커넥션의 네트워크 오류가 프로세스를 죽이지 않게 한다.
            this.pool.on('error', () => {});
        }
        return this.pool;
    }

    async listTables(): Promise<TableRef[]> {
        const result = await this.getPool().query<TableRef>(LIST_TABLES);
        return result.rows;
    }

    async describeTable(schema: string, table: string): Promise<Column[]> {
        const result = await this.getPool().query<{
            name: string;
            type: string;
            nullable: string;
            maxLength: number | null;
            colDefault: string | null;
            isPrimaryKey: boolean;
        }>(DESCRIBE_TABLE, [schema, table]);

        return result.rows.map((r) => ({
            name: r.name,
            type: r.type,
            nullable: r.nullable === 'YES',
            maxLength: r.maxLength,
            default: r.colDefault,
            isPrimaryKey: r.isPrimaryKey,
        }));
    }

    async query(
        text: string,
        params: Record<string, unknown>,
        maxRows: number,
    ): Promise<QueryResult> {
        assertReadOnly(text, 'postgres');
        const bound = toPositionalParams(text, params, 'postgres');

        // 커서로 maxRows+1 행만 요청한다. 서버는 그만큼만 보내고 close 에서 포털을 닫는다.
        // pg 내장 Query 의 rows 옵션은 suspended 되면 스스로 다시 받아서 멈출 수 없다.
        const client = await this.getPool().connect();
        try {
            // 읽기 전용 트랜잭션. 문자열 가드가 놓친 "SELECT 모양의 쓰기"(부수 효과 함수 등)를 엔진이 거부한다.
            // 세션 설정(default_transaction_read_only)은 set_config 로 뒤집힐 수 있어 쿼리마다 명시적으로 연다.
            await client.query('BEGIN READ ONLY');
            const cursor = client.query(new Cursor<unknown[]>(bound.text, bound.values, { rowMode: 'array' }));
            const { rows, fields } = await new Promise<{ rows: unknown[][]; fields: pg.FieldDef[] }>(
                (resolve, reject) => {
                    cursor.read(maxRows + 1, (err, rows, result) => {
                        if (err) reject(err);
                        else resolve({ rows, fields: result.fields });
                    });
                },
            );
            await cursor.close();
            return toQueryResult(rows, fields, maxRows);
        } finally {
            // 성공이든 실패든 되돌린다. ROLLBACK 자체가 실패하면 커넥션이 망가진 것이라 풀에서 버린다.
            try {
                await client.query('ROLLBACK');
                client.release();
            } catch (e) {
                client.release(e instanceof Error ? e : new Error(String(e)));
            }
        }
    }

    async close(): Promise<void> {
        if (!this.pool) return;
        const pool = this.pool;
        this.pool = undefined;
        await pool.end();
    }
}
