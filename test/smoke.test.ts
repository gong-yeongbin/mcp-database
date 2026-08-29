// 서버를 자식 프로세스로 띄워 실제로 stdio 를 듣는지 확인하는 스모크 테스트.
// 다른 테스트는 buildServer 만 import 해서 엔트리 실행 가드를 지나가지 않았고,
// 그 탓에 Node 22 에서 서버가 조용히 종료되는 버그가 배포까지 나갔다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));

const INITIALIZE = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'smoke-test', version: '0' },
    },
};

/** 접속하지 않는 설정. 드라이버는 첫 쿼리 때 접속하므로 initialize 는 DB 없이도 성공한다. */
const ENV = { ...process.env, DATABASE_URL: 'mssql://user:pass@localhost:1433/testdb' };

/** 부모가 타입 스트리핑 플래그로 돌고 있으면 자식도 같은 플래그가 필요하다. */
const FLAGS = process.execArgv.filter((a) => a.startsWith('--experimental-'));

/** 엔트리를 실행해 initialize 응답 한 줄을 받는다. */
function initialize(entry: string): Promise<unknown> {
    const child = spawn(process.execPath, [...FLAGS, entry], { env: ENV, stdio: 'pipe' });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    return new Promise<unknown>((resolve, reject) => {
        let out = '';
        let err = '';
        const timer = setTimeout(() => {
            reject(new Error(`5초 안에 응답이 없습니다. stderr: ${err}`));
        }, 5_000);

        child.stderr.on('data', (chunk: string) => {
            err += chunk;
        });
        child.stdout.on('data', (chunk: string) => {
            out += chunk;
            const nl = out.indexOf('\n');
            if (nl === -1) return;
            clearTimeout(timer);
            resolve(JSON.parse(out.slice(0, nl)));
        });
        // 응답 없이 종료 = 실행 가드가 main() 을 부르지 않은 것이다.
        child.on('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`서버가 응답 없이 종료되었습니다. exit=${code} stderr: ${err}`));
        });

        // stdin 은 닫지 않는다. 닫으면 정상 서버도 종료되어 오탐이 난다.
        child.stdin.write(`${JSON.stringify(INITIALIZE)}\n`);
    }).finally(() => {
        child.kill('SIGKILL');
    });
}

function assertInitialized(response: unknown) {
    const { result } = response as { result?: { serverInfo?: { name?: string } } };
    assert.equal(result?.serverInfo?.name, '@dudqls816/database-mcp');
}

test('직접 실행하면 stdio 로 initialize 에 응답한다', async () => {
    assertInitialized(await initialize(ENTRY));
});

test('심볼릭 링크(npx, node_modules/.bin)로 실행해도 응답한다', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'database-mcp-bin-'));
    const link = path.join(dir, 'dudqls816-database-mcp');
    symlinkSync(ENTRY, link);
    try {
        assertInitialized(await initialize(link));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
