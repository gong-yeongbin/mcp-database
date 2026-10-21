// SQL Server 에 접속해 스키마 조회와 쿼리 실행을 담당하는 드라이버

import sql from 'mssql';
import type { Column, Driver, QueryResult, TableRef } from './driver.ts';
import { assertReadOnly } from './driver.ts';

const LIST_TABLES = `
SELECT TABLE_SCHEMA AS [schema], TABLE_NAME AS [name], TABLE_TYPE AS [type]
FROM INFORMATION_SCHEMA.TABLES
ORDER BY TABLE_SCHEMA, TABLE_NAME
`;

const DESCRIBE_TABLE = `
SELECT
  c.COLUMN_NAME AS [name],
  c.DATA_TYPE   AS [type],
  CASE c.IS_NULLABLE WHEN 'YES' THEN 1 ELSE 0 END AS [nullable],
  c.CHARACTER_MAXIMUM_LENGTH AS [maxLength],
  c.COLUMN_DEFAULT           AS [colDefault],
  CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS [isPrimaryKey]
FROM INFORMATION_SCHEMA.COLUMNS c
LEFT JOIN (
  SELECT ku.TABLE_SCHEMA, ku.TABLE_NAME, ku.COLUMN_NAME
  FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
  JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
    ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
   AND tc.TABLE_SCHEMA    = ku.TABLE_SCHEMA
  WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
) pk
  ON pk.TABLE_SCHEMA = c.TABLE_SCHEMA
 AND pk.TABLE_NAME   = c.TABLE_NAME
 AND pk.COLUMN_NAME  = c.COLUMN_NAME
WHERE c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @table
ORDER BY c.ORDINAL_POSITION
`;

/** arrayRowMode 의 컬럼 메타데이터(이름 → {index, name})를 순서대로 이름 배열로 바꾼다. */
function columnNames(meta: sql.IColumnMetadata): string[] {
    return Object.values(meta).sort((a, b) => a.index - b.index).map((c) => c.name);
}

export class MssqlDriver implements Driver {
    private pool?: Promise<sql.ConnectionPool>;
    private readonly cfg: sql.config;

    constructor(cfg: sql.config) {
        this.cfg = cfg;
    }

    /**
     * 첫 호출에서 연결한다.
     *
     * MCP 클라이언트는 서버를 시작 시 즉시 spawn 하므로, 시작 시점에
     * 연결하면 DB 장애가 프로세스 크래시로 나타나 원인을 알기 어렵다.
     * 지연 연결이면 평범한 tool 에러가 되고 DB 복구 후 회복된다.
     *
     * 실패한 promise 는 캐시하지 않는다. 한 번의 장애가 프로세스를
     * 영구히 오염시키지 않게 하기 위한 것이다.
     */
    private getPool(): Promise<sql.ConnectionPool> {
        this.pool ??= new sql.ConnectionPool(this.cfg).connect().catch((e: unknown) => {
            this.pool = undefined;
            throw e;
        });
        return this.pool;
    }

    async listTables(): Promise<TableRef[]> {
        const pool = await this.getPool();
        const result = await pool.request().query<TableRef>(LIST_TABLES);
        return result.recordset;
    }

    async describeTable(schema: string, table: string): Promise<Column[]> {
        const pool = await this.getPool();
        const result = await pool
            .request()
            .input('schema', sql.NVarChar, schema)
            .input('table', sql.NVarChar, table)
            .query<{
                name: string;
                type: string;
                nullable: number;
                maxLength: number | null;
                colDefault: string | null;
                isPrimaryKey: number;
            }>(DESCRIBE_TABLE);

        return result.recordset.map((r) => ({
            name: r.name,
            type: r.type,
            nullable: r.nullable === 1,
            maxLength: r.maxLength,
            default: r.colDefault,
            isPrimaryKey: r.isPrimaryKey === 1,
        }));
    }

    /**
     * 스트리밍으로 받다가 maxRows 를 넘는 행이 오면 요청을 취소한다.
     *
     * 전체를 받은 뒤 자르면 큰 테이블에서 수백만 행이 네트워크를 탄다.
     * cancel() 은 ECANCEL 에러를 'error' 이벤트로 보내고 'done' 으로 끝나며
     * 커넥션은 풀로 돌아간다. 우리가 낸 취소이므로 그 에러는 무시한다.
     *
     * 쿼리는 트랜잭션 안에서 실행하고 항상 되돌린다. SQL Server 에는 읽기 전용
     * 트랜잭션 모드가 없어 pg/mysql 처럼 거부하지는 못하지만, 문자열 가드를 지난
     * 쓰기가 있어도 반영되지는 않는다.
     */
    async query(
        text: string,
        params: Record<string, unknown>,
        maxRows: number,
    ): Promise<QueryResult> {
        assertReadOnly(text, 'mssql');

        const pool = await this.getPool();
        const tx = new sql.Transaction(pool);
        await tx.begin();
        const request = tx.request();
        request.stream = true;
        request.arrayRowMode = true;
        for (const [k, v] of Object.entries(params)) {
            request.input(k, v);
        }

        return new Promise<QueryResult>((resolve, reject) => {
            let columns: string[] = [];
            const rows: unknown[][] = [];
            let truncated = false;
            let error: Error | undefined;

            request.on('recordset', (meta: sql.IColumnMetadata) => {
                columns = columnNames(meta);
            });
            request.on('row', (row: unknown[]) => {
                if (truncated) return;
                if (rows.length < maxRows) {
                    rows.push(row);
                    return;
                }
                truncated = true;
                request.cancel();
            });
            request.on('error', (e: Error & { code?: string }) => {
                if (truncated && e.code === 'ECANCEL') return;
                error ??= e;
            });
            request.on('done', () => {
                // 서버가 먼저 중단한 트랜잭션(EABORT)은 라이브러리가 커넥션을 이미 돌려놓았다. 롤백 실패는 무시한다.
                void tx.rollback().catch(() => {}).then(() => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve({ columns, rows, rowCount: rows.length, truncated });
                });
            });
            // stream 모드에서는 promise 가 거부되지 않고 'error' 이벤트로만 온다.
            void request.query(text);
        });
    }

    async close(): Promise<void> {
        if (!this.pool) return;
        const pending = this.pool;
        this.pool = undefined;
        try {
            const pool = await pending;
            await pool.close();
        } catch {
            // 연결 자체가 실패했다면 닫을 것도 없다.
        }
    }
}
