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
import { MssqlDriver } from './mssql.ts';
import { PostgresDriver } from './postgres.ts';
import { MysqlDriver } from './mysql.ts';
import type { DialectName, Driver } from './driver.ts';
import {
    formatColumns,
    formatParameters,
    formatProcedureList,
    formatProcedureResult,
    formatQueryResult,
    formatTableList,
} from './format.ts';

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
    dialect: DialectName;
}

export function buildServer(driver: Driver, opts: ServerOpts): McpServer {
    const server = new McpServer({ name: '@dudqls816/database-mcp', version });

    // 프로시저 호출 문법이 방언마다 다르다. T-SQL 은 EXEC, 나머지는 CALL.
    const procKeyword = opts.dialect === 'mssql' ? 'EXEC' : 'CALL';
    const procExample = opts.dialect === 'mssql' ? 'EXEC dbo.GetOrders @userId = 42' : 'CALL get_orders(42)';

    server.registerTool(
        'list_tables',
        {
            title: '테이블 목록',
            description: '데이터베이스의 모든 테이블과 뷰를 스키마와 함께 나열합니다.',
            annotations: { readOnlyHint: true },
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
            annotations: { readOnlyHint: true },
        },
        ({ table, schema }) =>
            guard(async () => formatColumns(schema, table, await driver.describeTable(schema, table))),
    );

    server.registerTool(
        'query',
        {
            title: '읽기 전용 쿼리',
            description:
                'SELECT 문 하나를 실행합니다. 여러 문장, 쓰기, 프로시저 실행은 거부됩니다. ' +
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
            annotations: { readOnlyHint: true },
        },
        ({ sql, params, maxRows }) =>
            guard(async () =>
                formatQueryResult(await driver.query(sql, params ?? {}, maxRows ?? opts.maxRows)),
            ),
    );

    server.registerTool(
        'list_procedures',
        {
            title: '프로시저 목록',
            description: '저장 프로시저를 스키마와 최종 수정일과 함께 나열합니다.',
            annotations: { readOnlyHint: true },
        },
        () => guard(async () => formatProcedureList(await driver.listProcedures())),
    );

    server.registerTool(
        'describe_procedure',
        {
            title: '프로시저 파라미터',
            description: '프로시저의 파라미터 이름, 자료형, 입출력 방향을 조회합니다.',
            inputSchema: z.object({
                name: z.string().describe('프로시저 이름'),
                schema: z
                    .string()
                    .default(opts.defaultSchema)
                    .describe(`스키마 이름. 기본값 ${opts.defaultSchema}`),
            }),
            annotations: { readOnlyHint: true },
        },
        ({ name, schema }) =>
            guard(async () =>
                formatParameters(schema, name, await driver.describeProcedure(schema, name)),
            ),
    );

    server.registerTool(
        'call_procedure',
        {
            title: '프로시저 실행',
            description:
                `${procKeyword} 문장 하나로 저장 프로시저를 실행합니다. 여러 문장과 동적 SQL 은 거부됩니다. ` +
                '프로시저 본문이 데이터를 바꿀 수 있으므로 되돌릴 수 없습니다. ' +
                `파라미터 값은 ${procKeyword} 문장 안에 직접 써야 하니 문자열은 따옴표를 이스케이프하세요. ` +
                `예: ${procExample}`,
            inputSchema: z.object({
                sql: z.string().describe(`실행할 ${procKeyword} 문장 하나. 예: ${procExample}`),
                maxRows: z
                    .number()
                    .int()
                    .min(1)
                    .optional()
                    .describe(`반환할 최대 행 수. 기본값 ${opts.maxRows}`),
            }),
            // 프로시저 본문이 무엇을 하는지 알 수 없어 읽기 전용이라고 할 수 없다.
            annotations: { destructiveHint: true },
        },
        ({ sql, maxRows }) =>
            guard(async () =>
                formatProcedureResult(await driver.callProcedure(sql, maxRows ?? opts.maxRows)),
            ),
    );

    return server;
}

function createDriver(config: Config): Driver {
    switch (config.kind) {
        case 'mssql':
            return new MssqlDriver(config.db);
        case 'postgres':
            return new PostgresDriver(config.db);
        case 'mysql':
            return new MysqlDriver(config.db);
    }
}

async function main() {
    const config = loadConfig();
    const driver = createDriver(config);
    const server = buildServer(driver, {
        maxRows: config.maxRows,
        defaultSchema: config.defaultSchema,
        dialect: config.kind,
    });

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.on(signal, () => {
            void driver.close().finally(() => process.exit(0));
        });
    }

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
