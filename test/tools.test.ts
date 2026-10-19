// tool 등록과 핸들러 동작을 Driver 스텁으로 검증하는 테스트

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { buildServer } from '../src/index.ts';
import type { ServerOpts } from '../src/index.ts';
import type { Column, Driver, QueryResult, TableRef } from '../src/driver.ts';

function stubDriver(over: Partial<Driver> = {}): Driver {
    return {
        listTables: async (): Promise<TableRef[]> => [
            { schema: 'dbo', name: 'users', type: 'BASE TABLE' },
        ],
        describeTable: async (): Promise<Column[]> => [
            { name: 'id', type: 'int', nullable: false, maxLength: null, default: null, isPrimaryKey: true },
        ],
        query: async (): Promise<QueryResult> => ({
            columns: ['id'],
            rows: [[1]],
            rowCount: 1,
            truncated: false,
        }),
        close: async () => {},
        ...over,
    };
}

/** 서버를 메모리 트랜스포트로 클라이언트에 연결한다. */
async function connect(driver: Driver, opts: Partial<ServerOpts> = {}) {
    const server = buildServer(driver, {
        maxRows: 1000,
        defaultSchema: 'dbo',
        ...opts,
    });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    return { client, close: () => client.close() };
}

test('tool 3개를 노출한다', async () => {
    const { client, close } = await connect(stubDriver());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
        'describe_table',
        'list_tables',
        'query',
    ]);
    await close();
});

test('list_tables 가 테이블을 렌더링한다', async () => {
    const { client, close } = await connect(stubDriver());
    const r = await client.callTool({ name: 'list_tables', arguments: {} });
    assert.match(JSON.stringify(r.content), /dbo \| users \| BASE TABLE/);
    await close();
});

test('describe_table 의 schema 기본값은 dbo 다', async () => {
    let seen = '';
    const { client, close } = await connect(
        stubDriver({
            describeTable: async (schema) => {
                seen = schema;
                return [];
            },
        }),
    );
    await client.callTool({ name: 'describe_table', arguments: { table: 'users' } });
    assert.equal(seen, 'dbo');
    await close();
});

test('query 가 params 와 maxRows 를 드라이버로 전달한다', async () => {
    let seenParams: Record<string, unknown> = {};
    let seenMax = 0;
    const { client, close } = await connect(
        stubDriver({
            query: async (_sql, params, maxRows) => {
                seenParams = params;
                seenMax = maxRows;
                return {
                    columns: [], rows: [], rowCount: 0,
                    truncated: false,
                };
            },
        }),
    );
    await client.callTool({
        name: 'query',
        arguments: { sql: 'SELECT * FROM t WHERE id = @id', params: { id: 7 }, maxRows: 50 },
    });
    assert.deepEqual(seenParams, { id: 7 });
    assert.equal(seenMax, 50);
    await close();
});

test('maxRows 를 생략하면 설정값을 쓴다', async () => {
    let seenMax = 0;
    const { client, close } = await connect(
        stubDriver({
            query: async (_sql, _params, maxRows) => {
                seenMax = maxRows;
                return {
                    columns: [], rows: [], rowCount: 0,
                    truncated: false,
                };
            },
        }),
    );
    await client.callTool({ name: 'query', arguments: { sql: 'SELECT 1' } });
    assert.equal(seenMax, 1000);
    await close();
});

test('드라이버 예외는 프로세스를 죽이지 않고 isError 로 온다', async () => {
    const { client, close } = await connect(
        stubDriver({
            listTables: async () => {
                throw new Error('Failed to connect to localhost:1433');
            },
        }),
    );
    const r = await client.callTool({ name: 'list_tables', arguments: {} });
    assert.equal(r.isError, true);
    assert.match(JSON.stringify(r.content), /Failed to connect/);
    await close();
});

// execute tool 은 제거되었다. 되살아나지 않아야 한다.
test('execute tool 은 등록되지 않는다', async () => {
    const { client, close } = await connect(stubDriver());
    const { tools } = await client.listTools();
    assert.equal(tools.some((t) => t.name === 'execute'), false);
    await assert.rejects(() =>
        client.callTool({ name: 'execute', arguments: { sql: 'DELETE FROM t' } }),
    );
    await close();
});

test('defaultSchema 가 describe_table 의 기본값이 된다', async () => {
    let seenTable = '';
    const { client, close } = await connect(
        stubDriver({
            describeTable: async (schema) => {
                seenTable = schema;
                return [];
            },
        }),
        { defaultSchema: 'public' },
    );
    await client.callTool({ name: 'describe_table', arguments: { table: 'users' } });
    assert.equal(seenTable, 'public');
    await close();
});
