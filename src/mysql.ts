// MySQL 에 접속해 스키마 조회와 쿼리 실행을 담당하는 드라이버

import mysql from 'mysql2/promise';
import type { FieldPacket, Pool, PoolOptions, RowDataPacket } from 'mysql2/promise';
import type { Connection as CoreConnection } from 'mysql2';
import type { Column, Driver, QueryResult, TableRef } from './driver.ts';
import { assertReadOnly, toPositionalParams } from './driver.ts';

// MySQL 은 schema = database 라서 접속한 DB 로 제한한다.
// 제한하지 않으면 mysql / sys / performance_schema 노이즈가 섞인다.
const LIST_TABLES = `
SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS \`name\`, TABLE_TYPE AS \`type\`
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
ORDER BY TABLE_NAME
`;

const DESCRIBE_TABLE = `
SELECT
  COLUMN_NAME              AS \`name\`,
  DATA_TYPE                AS \`type\`,
  IS_NULLABLE              AS \`nullable\`,
  CHARACTER_MAXIMUM_LENGTH AS \`maxLength\`,
  COLUMN_DEFAULT           AS \`colDefault\`,
  COLUMN_KEY               AS \`columnKey\`
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
ORDER BY ORDINAL_POSITION
`;

/** SELECT 한 문장의 서버 측 실행 시간 상한. config.ts 의 mssql / pg 30초와 맞춘다. */
const STATEMENT_TIMEOUT_MS = 30_000;

export class MysqlDriver implements Driver {
    private pool?: Pool;
    private readonly cfg: PoolOptions;

    constructor(cfg: PoolOptions) {
        this.cfg = cfg;
    }

    /**
     * mysql2 풀은 첫 쿼리에서 연결하므로 지연 연결이 기본이다.
     *
     * 새 커넥션마다 SELECT 실행 시간 상한을 건다. mssql requestTimeout / pg
     * statement_timeout 과 같은 30초다. mysql2 의 query timeout 옵션은 에러만
     * 내고 서버 쿼리를 멈추지 않아 서버 쪽 세션 변수로 건다. 'connection'
     * 이벤트는 커넥션을 요청자에게 넘기기 전에 오므로 SET 이 먼저 실행된다.
     */
    private getPool(): Pool {
        if (!this.pool) {
            this.pool = mysql.createPool(this.cfg);
            this.pool.on('connection', (conn) => {
                // 이벤트 인자는 core 커넥션이다. 콜백 형태라야 실패가 'error' 이벤트로 새지 않는다.
                (conn as unknown as CoreConnection).query(
                    `SET SESSION max_execution_time = ${STATEMENT_TIMEOUT_MS}`,
                    (err) => {
                        if (err) console.error(`max_execution_time 설정 실패: ${err.message}`);
                    },
                );
            });
        }
        return this.pool;
    }

    async listTables(): Promise<TableRef[]> {
        const [rows] = await this.getPool().query<RowDataPacket[]>(LIST_TABLES);
        return rows as TableRef[];
    }

    async describeTable(schema: string, table: string): Promise<Column[]> {
        const [rows] = await this.getPool().query<RowDataPacket[]>(DESCRIBE_TABLE, [schema, table]);

        return rows.map((r) => ({
            name: String(r.name),
            type: String(r.type),
            nullable: r.nullable === 'YES',
            maxLength: r.maxLength === null ? null : Number(r.maxLength),
            default: r.colDefault === null ? null : String(r.colDefault),
            isPrimaryKey: r.columnKey === 'PRI',
        }));
    }

    async query(
        text: string,
        params: Record<string, unknown>,
        maxRows: number,
    ): Promise<QueryResult> {
        assertReadOnly(text, 'mysql');
        const bound = toPositionalParams(text, params, 'mysql');

        // MySQL 프로토콜에는 결과 집합을 중간에 끊는 방법이 없다. maxRows 를 넘으면
        // 커넥션을 destroy 해서 전송을 끊는다. 풀에서 빠지고 다음 호출이 새로 연다.
        // promise 래퍼의 .connection 은 core 커넥션인데 타입이 promise 쪽으로 잡혀 있어 캐스팅한다.
        const conn = await this.getPool().getConnection();
        const core = conn.connection as unknown as CoreConnection;

        return new Promise<QueryResult>((resolve, reject) => {
            let columns: string[] = [];
            const rows: unknown[][] = [];
            let settled = false;

            const finish = (truncated: boolean) => {
                if (settled) return;
                settled = true;
                if (truncated) conn.destroy();
                else conn.release();
                resolve({ columns, rows, rowCount: rows.length, truncated });
            };

            const q = core.query({ sql: bound.text, rowsAsArray: true }, bound.values);
            q.on('fields', (fields: FieldPacket[]) => {
                columns = fields.map((f) => f.name);
            });
            q.on('result', (row: unknown) => {
                if (settled) return;
                if (rows.length < maxRows) rows.push(row as unknown[]);
                else finish(true);
            });
            q.on('end', () => finish(false));
            q.on('error', (e: Error) => {
                if (settled) return;
                settled = true;
                conn.release();
                reject(e);
            });
        });
    }

    async close(): Promise<void> {
        if (!this.pool) return;
        const pool = this.pool;
        this.pool = undefined;
        await pool.end();
    }
}
