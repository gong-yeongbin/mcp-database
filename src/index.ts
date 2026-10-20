#!/usr/bin/env node
// MCP 서버 엔트리. tool 을 등록하고 stdio 로 요청을 받는다.

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod';
import { loadConfig } from './config.ts';
import type { Config } from './config.ts';
import type { Driver } from './driver.ts';
import { formatColumns, formatQueryResult, formatTableList } from './format.ts';

// serverInfo.version 은 패키지 버전과 같아야 한다. 하드코딩하면 릴리스마다 어긋난다.
// dist/index.js 와 src/index.ts 모두 상위 디렉터리가 패키지 루트다.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

/** tool 핸들러의 예외를 MCP 에러 응답으로 바꾼다. DB 오류가 프로세스를 죽이면 안 된다. */
async function guard(fn: () => Promise<string>) {
    try {
        return { content: [{ type: 'text' as const, text: await fn() }] };
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text' as const, text: `오류: ${message}` }], isError: true };
    }
}

export interface ServerOpts {
    maxRows: number;
    /** describe 계열 tool 의 기본 스키마. mssql=dbo, postgres=public, mysql=접속 DB */
    defaultSchema: string;
}

export function buildServer(driver: Driver, opts: ServerOpts): McpServer {
    const server = new McpServer({ name: '@dudqls816/database-mcp', version });

    server.registerTool(
        'list_tables',
        {
            title: '테이블 목록',
            description: '데이터베이스의 모든 테이블과 뷰를 스키마와 함께 나열합니다.',
            inputSchema: z.object({}),
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        () => guard(async () => formatTableList(await driver.listTables())),
    );

    server.registerTool(
        'describe_table',
        {
            title: '테이블 구조',
            description: '테이블의 컬럼, 자료형, NULL 허용 여부, 기본값, 기본키를 조회합니다.',
            inputSchema: z.object({
                table: z.string().describe('테이블 이름'),
                schema: z
                    .string()
                    .default(opts.defaultSchema)
                    .describe(`스키마 이름. 기본값 ${opts.defaultSchema}`),
            }),
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        ({ table, schema }) =>
            guard(async () => formatColumns(schema, table, await driver.describeTable(schema, table))),
    );

    server.registerTool(
        'query',
        {
            title: '읽기 전용 쿼리',
            description:
                'SELECT 문 하나를 실행합니다. 여러 문장과 쓰기는 거부됩니다. ' +
                '파라미터는 @이름 형태로 쓰고 params 로 값을 넘기세요. ' +
                '파라미터는 값만 바인딩할 수 있어 테이블명이나 컬럼명에는 쓸 수 없습니다.',
            inputSchema: z.object({
                sql: z.string().describe('실행할 SELECT 문 하나'),
                params: z
                    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
                    .optional()
                    .describe('@이름 파라미터에 바인딩할 값'),
                maxRows: z
                    .number()
                    .int()
                    .min(1)
                    .optional()
                    .describe(`반환할 최대 행 수. 기본값 ${opts.maxRows}`),
            }),
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        ({ sql, params, maxRows }) =>
            guard(async () =>
                formatQueryResult(await driver.query(sql, params ?? {}, maxRows ?? opts.maxRows)),
            ),
    );

    return server;
}

/** 쓰는 방언의 드라이버만 로드한다. mssql(tedious) 하나가 나머지 둘을 합친 것보다 무겁다. */
async function createDriver(config: Config): Promise<Driver> {
    switch (config.kind) {
        case 'mssql':
            return new (await import('./mssql.ts')).MssqlDriver(config.db);
        case 'postgres':
            return new (await import('./postgres.ts')).PostgresDriver(config.db);
        case 'mysql':
            return new (await import('./mysql.ts')).MysqlDriver(config.db);
    }
}

async function main() {
    const config = loadConfig();
    const driver = await createDriver(config);
    const server = buildServer(driver, {
        maxRows: config.maxRows,
        defaultSchema: config.defaultSchema,
    });

    const shutdown = () => {
        void driver.close().finally(() => process.exit(0));
    };
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.on(signal, shutdown);
    }
    // 클라이언트가 시그널 없이 stdin 만 닫아도 풀의 유휴 커넥션이 프로세스를 붙잡지 않게 한다.
    // SDK 의 StdioServerTransport 는 stdin 의 'data' 와 'error' 만 듣고 'end' 는 듣지 않아
    // onclose 가 오지 않는다. EOF 는 직접 잡는다. onclose 는 stdout 오류 등 나머지 경로용이다.
    process.stdin.on('end', shutdown);
    server.server.onclose = shutdown;

    await server.connect(new StdioServerTransport());
    // stdout 은 JSON-RPC 전용이다. 로그는 반드시 stderr 로 보낸다.
    console.error(
        `database-mcp 시작. [${config.kind}] ${config.label} (최대 ${config.maxRows}행)`,
    );
}

/** 심볼릭 링크(npx, node_modules/.bin)를 지나 실제 경로로 맞춘다. */
function canonical(p: string): string {
    try {
        return realpathSync(p);
    } catch {
        // 경로를 확인할 수 없으면 비교라도 되게 절대경로로 맞춘다.
        return path.resolve(p);
    }
}

/**
 * 이 파일이 직접 실행된 엔트리인지 판단한다.
 * import.meta.main 은 최신 Node 에만 있어 Node 22 에서는 undefined 가 되고,
 * 그러면 main() 이 호출되지 않아 서버가 조용히 종료된다.
 */
function isEntryPoint(): boolean {
    const entry = process.argv[1];
    if (!entry) return false;
    return canonical(entry) === canonical(fileURLToPath(import.meta.url));
}

// 직접 실행할 때만 서버를 띄운다. 테스트는 buildServer 만 import 한다.
if (isEntryPoint()) {
    main().catch((e: unknown) => {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
    });
}
